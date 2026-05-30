import "server-only";
import { dateKey, fillMissingDays, type Day } from "./streak";

/**
 * Twitter source ladder — bring-your-own-data (D-028, 2026-05-29 night).
 *
 * Final architecture after a day of failed scraping experiments:
 * stop trying to scrape X at render time. The dashboard reads a
 * pre-built JSON file (whoever produced it: a userscript on your
 * laptop, a hosted browser cron, a self-hosted Nitter, a paid API —
 * commiter doesn't care). The scraping concern is decoupled from the
 * rendering concern, permanently.
 *
 * Ladder:
 *   1. X_DATA_URL — GET this URL, expect `[{date:"YYYY-MM-DD", count:N}]`,
 *      use it verbatim. The Real Answer. Fueled by whatever you build
 *      (or by nothing, in which case we fall through).
 *   2. X_NITTER_HOST — user's self-hosted Nitter (see docs/SELF_HOST_NITTER.md).
 *   3. Public Nitter pool — residential-IP-only; works in dev, mostly
 *      blocked from Vercel egress.
 *   4. throw TwitterFeedOfflineError → snapshot.ts substitutes zero-fill,
 *      and page.tsx hides the Twitter panel entirely so the dashboard
 *      gracefully degrades to GitHub-only.
 *
 * Note: an earlier draft kept syndication.twitter.com as a soft
 * fallback. Removed in D-028 because it returns 6–7 month stale
 * curated data that LOOKS fresh — silently wrong is worse than
 * honestly empty. Verified empirically against @paulg / @sama / @dhh
 * (their syndication "newest" tweets were all from October 2025 even
 * though they post daily).
 */

// Nitter host order — fallback only. From Vercel egress these are
// usually all blocked, but they sometimes work from local dev and we
// keep them as defense in depth.
const HOSTS = [
  "nitter.net",
  "nitter.poast.org",
  "xcancel.com",
  "nitter.privacyredirect.com",
] as const;

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

  // ---- 1. X_DATA_URL: pre-built JSON from your scraper (the Real Answer) ---
  const dataUrl = process.env.X_DATA_URL?.trim();
  if (dataUrl) {
    try {
      const days = await fetchTwitterDataUrl(
        dataUrl,
        from,
        to,
        opts.revalidate ?? 3600
      );
      console.log(
        `[twitter] using X_DATA_URL (${dataUrl}) for login=${login} ` +
          `(days=${days.length}, today=${days.find((d) => d.date === to)?.count ?? 0})`
      );
      return days;
    } catch (err) {
      attempts.push({
        host: "X_DATA_URL",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- 2. self-hosted Nitter (X_NITTER_HOST, see docs/SELF_HOST_NITTER.md) -
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

  // ---- 3. public Nitter pool (residential-IP-only fallback) --------------
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
 * Fetch a pre-built tweet-counts JSON from X_DATA_URL.
 *
 * Expected wire format — a flat array of {date, count}, one per day:
 *   [{"date":"2026-05-29","count":3},{"date":"2026-05-28","count":0}, ...]
 *
 * The producer (your scraper of choice) is responsible for emitting
 * dates in the user's tz and using inclusive YYYY-MM-DD format. We do
 * NOT re-bucket UTC timestamps here — if the producer got the tz wrong
 * commiter has no way to fix it. Missing days inside [from, to] are
 * filled with count=0; days outside the window are dropped silently.
 *
 * Tolerant about shape: we accept an array directly OR an object with
 * a `days` field (so a producer can ship `{days, generated_at, ...}`).
 */
async function fetchTwitterDataUrl(
  url: string,
  from: string,
  to: string,
  revalidate: number
): Promise<Day[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let raw: unknown;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      next: { revalidate },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } finally {
    clearTimeout(timer);
  }

  // Shape unwrapping: prefer { days: [...] }, fall back to raw array.
  const candidate = Array.isArray(raw)
    ? raw
    : (raw as { days?: unknown })?.days;
  if (!Array.isArray(candidate)) {
    throw new Error(
      "X_DATA_URL JSON must be Day[] or { days: Day[] } (got: " +
        typeof raw +
        ")"
    );
  }

  const rows: Array<{ date: string; count: number }> = [];
  for (const item of candidate) {
    if (!item || typeof item !== "object") continue;
    const d = (item as { date?: unknown }).date;
    const c = (item as { count?: unknown }).count;
    if (typeof d !== "string" || typeof c !== "number") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (d < from || d > to) continue;
    rows.push({ date: d, count: c });
  }

  return fillMissingDays(rows, from, to);
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

