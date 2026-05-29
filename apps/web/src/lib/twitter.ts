import "server-only";
import { dateKey, fillMissingDays, type Day } from "./streak";

/**
 * Twitter source = Nitter RSS (D-002b).
 *
 * The official X read API is paywalled and the syndication profile endpoint
 * is cookie-gated / non-chronological in 2026. Nitter RSS remains the only
 * working unauth path that gives us recent tweet timestamps for a handle.
 *
 * We only need timestamps (heatmap counts per day); RSS gives us
 * `<pubDate>` per `<item>` directly. No JSON hydration, no token math, no
 * deps (D-010).
 *
 * Hosts are tried sequentially (Q-004); the first to respond with valid
 * XML wins. If all fail we throw `TwitterFeedOfflineError`, which the
 * caller catches and substitutes with a zero-filled day window.
 */

// Host order matters — verified by live probe 2026-05-29.
//   nitter.net      → reliably 200 + 20-item RSS unauth (primary).
//   nitter.poast.org→ sometimes 200, sometimes Cloudflare "Verifying your
//                    browser" challenge HTML (403). Useful when up.
//   xcancel.com     → RSS reader allowlist required; returns a 1971 STUB
//                    feed otherwise. Caught by in-window guard below.
//   nitter.privacyredirect.com → Cloudflare anti-bot HTML.
// If all 4 fail, snapshot.ts substitutes a zero-filled window and logs a
// warning; UI shows TWITTER STREAK=0 today=0 (honest).
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
