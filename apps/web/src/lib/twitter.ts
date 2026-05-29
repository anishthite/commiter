import "server-only";
import * as https from "node:https";
import { dateKey, fillMissingDays, type Day } from "./streak";

/**
 * Twitter source ladder — self-hosted Nitter PRIMARY, syndication fallback.
 *
 * D-027 (2026-05-29, evening): rolled back the rettiwt-api primary from
 * D-024. Putting a live X account's auth cookies into a Vercel env var
 * is a brittle threat model (env-var dumps, build-log leaks, Vercel team
 * member access all become real-account-takeover surfaces). The cleaner
 * answer is to host our own Nitter instance with a *burner* X account's
 * cookies — same mechanism, but the credential lives on a server we own
 * and represents a throwaway account, not our real one.
 *
 * Ladder:
 *   1. X_NITTER_HOST   — user's self-hosted instance (set in env, no slash)
 *   2. Public Nitter pool (nitter.net etc) — works on residential IPs,
 *      usually blocked from datacenter IPs
 *   3. syndication.twitter.com — stale curated widget feed (6–7mo lag),
 *      kept as a "better than zero" last resort for forks who haven't
 *      set up self-hosting yet. Verified 2026-05-29 against @paulg /
 *      @sama / @dhh — their newest entries from this endpoint were all
 *      6–7 months stale even though they tweet daily.
 *   4. throw TwitterFeedOfflineError → snapshot.ts substitutes zero-fill
 *
 * See docs/SELF_HOST_NITTER.md for the Fly.io deployment walkthrough.
 */

// Nitter host order — fallback only. From Vercel egress these are
// usually all blocked (see TwitterFeedOfflineError attempts in prod
// logs 2026-05-29), but they sometimes work from local dev and we keep
// them as defense in depth.
//   nitter.net      → 200 + 20-item RSS unauth from residential IPs.
//   nitter.poast.org→ sometimes 200, sometimes Cloudflare challenge.
//   xcancel.com     → RSS reader allowlist; otherwise 1971 stub.
//   nitter.privacyredirect.com → Cloudflare anti-bot HTML.
const HOSTS = [
  "nitter.net",
  "nitter.poast.org",
  "xcancel.com",
  "nitter.privacyredirect.com",
] as const;

const SYNDICATION_HOST = "syndication.twitter.com";

// A normal-looking browser UA. Some Nitter operators 403 obvious bot UAs.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 10_000;

export class TwitterFeedOfflineError extends Error {
  attempts: Array<{ host: string; reason: string }>;
  constructor(attempts: Array<{ host: string; reason: string }>) {
    super(`Twitter feed offline; all Nitter hosts failed (${attempts.length})`);
    this.name = "TwitterFeedOfflineError";
    this.attempts = attempts;
  }
}

export type FetchTwitterOpts = {
  /** Handle, no leading @. */
  login: string;
  /** IANA tz used to bucket each tweet's UTC timestamp into a day. */
  tz: string;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to: string;
  /** Revalidate window for the cached fetch. Default 3600s. */
  revalidate?: number;
};

export async function fetchTwitterDays(opts: FetchTwitterOpts): Promise<Day[]> {
  const { login, tz, from, to } = opts;
  if (!login) {
    throw new Error(
      "Twitter fetch: X_LOGIN is empty. Set X_LOGIN=<your handle> in apps/web/.env.local."
    );
  }
  if (to < from) {
    throw new Error(`fetchTwitterDays: to (${to}) is before from (${from})`);
  }

  const attempts: Array<{ host: string; reason: string }> = [];

  // ---- 1. self-hosted Nitter (X_NITTER_HOST, see docs/SELF_HOST_NITTER.md) -
  const selfHostRaw = process.env.X_NITTER_HOST?.trim();
  if (selfHostRaw) {
    // Accept "my-nitter.fly.dev" or "https://my-nitter.fly.dev" — strip
    // protocol + trailing slash + any path, leave bare host:port.
    const selfHost = selfHostRaw
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    const parsed = await tryNitterHost(selfHost, login, tz, from, to);
    if (parsed.kind === "ok") {
      console.log(
        `[twitter] using self-hosted Nitter host=${selfHost} for login=${login} ` +
          `(items=${parsed.value.parsedItems}, in_window=${parsed.value.inWindowItems})`
      );
      return parsed.value.days;
    }
    attempts.push({ host: selfHost, reason: parsed.reason });
  }

  // ---- 2. syndication.twitter.com (stale fallback for forks w/o self-host) -
  try {
    const synParsed = await fetchSyndicationProfile(
      login,
      tz,
      from,
      to,
      opts.revalidate ?? 3600
    );
    if (synParsed.inWindowItems === 0 && synParsed.parsedItems === 0) {
      attempts.push({
        host: SYNDICATION_HOST,
        reason: "0 tweets parsed (empty timeline or auth-gated)",
      });
    } else {
      console.log(
        `[twitter] using host=${SYNDICATION_HOST} for login=${login} ` +
          `(parsed=${synParsed.parsedItems}, in_window=${synParsed.inWindowItems})`
      );
      return synParsed.days;
    }
  } catch (err) {
    attempts.push({
      host: SYNDICATION_HOST,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- 3. public Nitter RSS pool (residential-IP-only fallback) ----
  for (const host of HOSTS) {
    const parsed = await tryNitterHost(host, login, tz, from, to);
    if (parsed.kind === "ok") {
      console.log(
        `[twitter] using public host=${host} for login=${login} ` +
          `(parsed=${parsed.value.parsedItems}, in_window=${parsed.value.inWindowItems})`
      );
      return parsed.value.days;
    }
    attempts.push({ host, reason: parsed.reason });
  }

  throw new TwitterFeedOfflineError(attempts);
}

/**
 * Try one Nitter host (self-hosted or public). Returns an OK with parsed
 * data on success, or an Err with a human-readable reason on any failure.
 * Reasons fall into three buckets:
 *   1. Transport (HTTP 4xx/5xx, timeout, DNS) — `fetchHostRss` throws.
 *   2. Layout (Cloudflare challenge / RSS allowlist stub) — body fails the
 *      `<item>`/`<entry>` marker regex.
 *   3. Window-empty (e.g. xcancel's 1971-01-01 stub item) — every parsed
 *      timestamp falls outside [from, to].
 * Bucket (3) is the subtle one: the host responded with plausible RSS
 * but the data is structurally useless, so we treat it as a host failure.
 */
async function tryNitterHost(
  host: string,
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<{ kind: "ok"; value: ParsedRss } | { kind: "err"; reason: string }> {
  const url = `https://${host}/${encodeURIComponent(login)}/rss`;
  let body: string | null;
  try {
    body = await fetchHostRss(url, 3600);
  } catch (err) {
    return { kind: "err", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!body) return { kind: "err", reason: "empty body" };
  if (!/<item[\s>]/.test(body) && !/<entry[\s>]/.test(body)) {
    return { kind: "err", reason: "no <item> in response" };
  }
  const parsed = parseRssToDays(body, tz, from, to);
  if (parsed.inWindowItems === 0) {
    return {
      kind: "err",
      reason: `0 items in window (parsed=${parsed.parsedItems}); likely stub/whitelist sentinel`,
    };
  }
  return { kind: "ok", value: parsed };
}

async function fetchHostRss(url: string, revalidate: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // NOTE: we intentionally do NOT pass `next: { revalidate }` here.
    // Observed on Next.js 14.2 / Node 20: combining `next.revalidate` with
    // some Nitter responses produces an empty 200 body (cache-wrapper edge
    // case). The route-level `export const revalidate = 3600` on /api/snapshot
    // and /page already gives us the 1-hour CDN cache; this fetch can run
    // uncached on the rare cache miss without losing the user-visible win.
    void revalidate;
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.text();
    // Content-type can be empty, text/html (Cloudflare challenge), or xml.
    // Trust the BODY shape, not the header: if it contains a recognizable
    // feed marker, parse it. Otherwise reject and let the next host try.
    if (!/<rss\b|<feed\b|<item\b|<entry\b/.test(body)) {
      const ct = res.headers.get("content-type") ?? "";
      const preview = body.slice(0, 60).replace(/\s+/g, " ");
      throw new Error(`no feed markers in body (ct=${ct}, head=${preview})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

type ParsedRss = {
  days: Day[];
  /** Items whose pubDate parsed to a valid Date. */
  parsedItems: number;
  /** Subset of parsedItems whose bucket day falls inside [from, to]. */
  inWindowItems: number;
};

/**
 * Fetch the X profile timeline via `syndication.twitter.com`. This is the
 * post-2024 syndication endpoint that ships timeline JSON inside a
 * `__NEXT_DATA__` script tag. As of 2026-05-29 it returns ~101 entries
 * for a public handle with no cookies required (live curl verified).
 *
 * IMPORTANT: we use `node:https` here, NOT `fetch`. Node's built-in
 * `fetch` (undici) presents a TLS fingerprint that syndication.twitter.com
 * rejects with HTTP 429 ("Rate limit exceeded" body, length 20) on the
 * FIRST request from any IP — it's a TLS-fingerprint block, not a true
 * rate limit. Verified 2026-05-29: same machine, same IP, same second:
 * curl=200, `node -e "https.get(...)"` = 200, but `node -e "fetch(...)"` =
 * 429 every time. `node:https` uses Node core OpenSSL bindings which
 * present a different (more permissive) JA3 to Twitter.
 *
 * Side effect: we bypass Next.js' fetch-level cache for this call. The
 * page-level `revalidate = 3600` (in /api/snapshot and /page.tsx) still
 * caches the rendered output, so we only actually hit the endpoint once
 * per region per hour, well under any plausible quota.
 *
 * Throws on transport / parse failure so the outer loop can fall through
 * to Nitter.
 */
async function fetchSyndicationProfile(
  login: string,
  tz: string,
  from: string,
  to: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _revalidate: number
): Promise<ParsedRss> {
  const path = `/srv/timeline-profile/screen-name/${encodeURIComponent(login)}`;
  const body = await httpsGetText(SYNDICATION_HOST, path);

  // The Next.js page embeds initial props in this exact script tag.
  const m = body.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) {
    throw new Error("no __NEXT_DATA__ script tag (auth wall or layout change)");
  }
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch (err) {
    throw new Error(
      `__NEXT_DATA__ JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Walk: data.props.pageProps.timeline.entries[].content.tweet.created_at
  const entries = (
    data as {
      props?: {
        pageProps?: {
          timeline?: {
            entries?: Array<{
              type?: string;
              content?: { tweet?: { created_at?: string } };
            }>;
          };
        };
      };
    }
  )?.props?.pageProps?.timeline?.entries;

  if (!Array.isArray(entries)) {
    throw new Error("timeline.entries missing in __NEXT_DATA__ payload");
  }

  const counts = new Map<string, number>();
  let parsedItems = 0;
  let inWindowItems = 0;

  for (const e of entries) {
    if (e?.type !== "tweet") continue;
    const raw = e.content?.tweet?.created_at;
    if (!raw) continue;
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) continue;
    parsedItems++;
    const key = dateKey(t, tz);
    if (key >= from && key <= to) inWindowItems++;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rows = Array.from(counts, ([date, count]) => ({ date, count }));
  return {
    days: fillMissingDays(rows, from, to),
    parsedItems,
    inWindowItems,
  };
}

/**
 * Promise wrapper around `https.get` so we can use a TLS fingerprint that
 * isn't undici's. Throws on non-2xx, timeouts, or socket errors. Body is
 * always returned as a UTF-8 string — the response is small enough
 * (~430KB) to materialize fully.
 */
function httpsGetText(host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: host,
        path,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          // Drain the body to free the socket, then reject.
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
  });
}

/**
 * Extract `<pubDate>` (RSS) or `<published>` (Atom) per item, bucket each
 * into a tz-keyed day, and return a contiguous ascending `Day[]` over
 * [from, to] plus parse stats used for stub detection.
 */
function parseRssToDays(body: string, tz: string, from: string, to: string): ParsedRss {
  const counts = new Map<string, number>();
  let parsedItems = 0;
  let inWindowItems = 0;

  const addBucket = (raw: string) => {
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) return;
    parsedItems++;
    const key = dateKey(t, tz);
    if (key >= from && key <= to) inWindowItems++;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  // RSS 2.0 path — Nitter uses this exclusively today.
  const rssItems = body.match(/<item\b[\s\S]*?<\/item>/g) ?? [];
  for (const item of rssItems) {
    const m = item.match(/<pubDate>([^<]+)<\/pubDate>/);
    if (m) addBucket(m[1]!);
  }

  // Atom path — defensive, in case a future host serves Atom.
  if (rssItems.length === 0) {
    const atomEntries = body.match(/<entry\b[\s\S]*?<\/entry>/g) ?? [];
    for (const entry of atomEntries) {
      const m = entry.match(/<published>([^<]+)<\/published>/);
      if (m) addBucket(m[1]!);
    }
  }

  const rows = Array.from(counts, ([date, count]) => ({ date, count }));
  return {
    days: fillMissingDays(rows, from, to),
    parsedItems,
    inWindowItems,
  };
}

