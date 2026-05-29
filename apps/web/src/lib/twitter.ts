import "server-only";
import * as https from "node:https";
import { dateKey, fillMissingDays, type Day } from "./streak";

/**
 * Twitter source ladder — rettiwt-api PRIMARY, syndication + Nitter fallbacks.
 *
 * D-024 (2026-05-29, late): the syndication.twitter.com source landed in
 * D-018 "worked" but returned a curated/embed-widget timeline that lags
 * the real feed by weeks-to-months. Cross-checked on @paulg / @sama /
 * @dhh: their syndication "newest" tweets were 6–7 months stale even
 * though they post daily. Endpoint behavior, not our bug — the endpoint
 * exists to power embed widgets, not to serve a live chronological feed.
 *
 * Replacement primary: `rettiwt-api` v7 with a user-supplied API_KEY
 * (base64'd auth cookies, obtained via the X Auth Helper browser
 * extension and stored in the `X_RETTIWT_KEY` env var). It calls X's
 * real internal `/UserTweets` GraphQL endpoint, returning the actual
 * chronological timeline. Guest-mode was confirmed dead 2026-05-29 —
 * returns "Not authorized" for `tweet.search` and a DataValidationError
 * for `user.timeline` without an apiKey.
 *
 * Fallback ladder if rettiwt fails (or X_RETTIWT_KEY isn't set):
 *   2. syndication.twitter.com (stale-but-something — better than zero)
 *   3. Nitter RSS pool (rarely works from Vercel, but works in dev)
 *   4. throw TwitterFeedOfflineError → snapshot.ts substitutes zero-fill
 *
 * Why keep syndication despite the staleness: when rettiwt is unset
 * (e.g., fresh fork, no API_KEY) the dashboard still shows *something*
 * meaningful instead of an empty heatmap. The choice is between "a few
 * popular tweets from months ago" and "all zeros" — popular-tweets-only
 * is honestly more useful than nothing.
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

  // ---- 1. rettiwt-api (primary, chronological, needs X_RETTIWT_KEY) ----
  const rettiwtKey = process.env.X_RETTIWT_KEY;
  if (rettiwtKey) {
    try {
      const r = await fetchRettiwtDays(
        rettiwtKey,
        login,
        tz,
        from,
        to
      );
      console.log(
        `[twitter] using rettiwt-api for login=${login} ` +
          `(parsed=${r.parsedItems}, in_window=${r.inWindowItems}, pages=${r.pages})`
      );
      return r.days;
    } catch (err) {
      attempts.push({
        host: "rettiwt-api",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    attempts.push({
      host: "rettiwt-api",
      reason: "X_RETTIWT_KEY env var not set (see README, falling through)",
    });
  }

  // ---- 2. syndication.twitter.com (stale but unauth fallback) ----
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

  // ---- 2. Nitter RSS hosts (fallback pool) ----
  for (const host of HOSTS) {
    const url = `https://${host}/${encodeURIComponent(login)}/rss`;
    try {
      const body = await fetchHostRss(url, opts.revalidate ?? 3600);
      if (!body) {
        attempts.push({ host, reason: "empty body" });
        continue;
      }
      // Sanity: any plausible RSS or Atom feed contains "<item" or "<entry".
      if (!/<item[\s>]/.test(body) && !/<entry[\s>]/.test(body)) {
        attempts.push({ host, reason: "no <item> in response" });
        continue;
      }
      const parsed = parseRssToDays(body, tz, from, to);
      // Stub/whitelist-sentinel guard: a host like xcancel.com may return
      // a valid-looking RSS containing a single item dated 1971-01-01.
      // If literally none of the parsed items fall inside our display
      // window, the host is useless to us — fall through.
      if (parsed.inWindowItems === 0) {
        attempts.push({
          host,
          reason: `0 items in window (parsed=${parsed.parsedItems}); likely stub/whitelist sentinel`,
        });
        continue;
      }
      console.log(
        `[twitter] using host=${host} for login=${login} ` +
          `(parsed=${parsed.parsedItems}, in_window=${parsed.inWindowItems})`
      );
      return parsed.days;
    } catch (err) {
      attempts.push({
        host,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  throw new TwitterFeedOfflineError(attempts);
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

// ---------------------------------------------------------------------------
// rettiwt-api (chronological, authenticated)
// ---------------------------------------------------------------------------

type RettiwtParsed = ParsedRss & { pages: number };

/**
 * Pull a user's chronological timeline via the rettiwt-api package,
 * which under the hood calls X's internal `/UserTweets` GraphQL
 * endpoint with the auth cookies encoded in `apiKey`.
 *
 * We paginate up to `MAX_PAGES` (or until we exceed the `from` window),
 * whichever comes first. That bounds worst-case latency and X API cost
 * for heavy tweeters while still covering the ~365-day heatmap window
 * for normal tweet cadence.
 */
async function fetchRettiwtDays(
  apiKey: string,
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<RettiwtParsed> {
  // Dynamic import keeps rettiwt-api off the cold-start path when
  // X_RETTIWT_KEY is unset (the surrounding code never calls in here).
  const { Rettiwt } = await import("rettiwt-api");
  const r = new Rettiwt({ apiKey });

  // Step 1: resolve handle → numeric user id.
  const userDetails = await r.user.details(login);
  const userId = userDetails?.id;
  if (!userId) {
    throw new Error(`user.details returned no id for handle=${login}`);
  }

  // Step 2: paginate the timeline. Stop early once the oldest item in a
  // page is already older than our `from` cutoff.
  const MAX_PAGES = 5;
  const fromBoundary = new Date(`${from}T00:00:00Z`).getTime();

  const counts = new Map<string, number>();
  let parsedItems = 0;
  let inWindowItems = 0;
  let cursor: string | undefined;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const tl = (await r.user.timeline(userId, undefined, cursor)) as {
      list?: Array<{ createdAt?: string }>;
      next?: { value?: string } | undefined;
    };
    const list = tl?.list ?? [];
    if (list.length === 0) break;

    let oldestInPageMs = Number.POSITIVE_INFINITY;
    for (const t of list) {
      const raw = t?.createdAt;
      if (!raw) continue;
      const d = new Date(raw);
      const ms = d.getTime();
      if (Number.isNaN(ms)) continue;
      parsedItems++;
      if (ms < oldestInPageMs) oldestInPageMs = ms;
      const key = dateKey(d, tz);
      if (key >= from && key <= to) inWindowItems++;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    pages++;

    if (oldestInPageMs <= fromBoundary) break;
    cursor = tl?.next?.value;
    if (!cursor) break;
  }

  if (parsedItems === 0) {
    throw new Error(
      `rettiwt-api returned 0 parseable tweets (pages=${pages}); ` +
        `likely expired X_RETTIWT_KEY or bad handle`
    );
  }

  const rows = Array.from(counts, ([date, count]) => ({ date, count }));
  return {
    days: fillMissingDays(rows, from, to),
    parsedItems,
    inWindowItems,
    pages,
  };
}
