#!/usr/bin/env tsx
/**
 * refresh-x-days.ts — incremental refresh of apps/web/src/data/x-days.json.
 *
 * Pulls a user's recent tweets from socialdata.tools, buckets each into a
 * `YYYY-MM-DD` day key in NERV_TZ, merges into the bundled JSON, and writes
 * it back. Designed to be called once a day by .github/workflows/refresh-x-days.yml.
 *
 * Inputs (env):
 *   SOCIALDATA_API_KEY   — required. Bearer token for api.socialdata.tools.
 *   X_LOGIN              — default "anishthite". Handle without leading @.
 *   NERV_TZ              — default "America/Los_Angeles". MUST match runtime tz.
 *   BACKFILL_SINCE       — default "2024-01-01". Used only on first run when
 *                          the JSON has no existing days.
 *
 * Behavior:
 *   - Caches numeric user_id in the JSON; re-resolves only when the handle changes.
 *   - Incremental: since = max(existing day) − 2 days (overlap to absorb late
 *     tweets). Full backfill on empty days[].
 *   - Within the 2-day overlap window the new fetch is authoritative (replaces
 *     existing counts). Days strictly older than the overlap window are NEVER
 *     decremented — protects against socialdata's quota-trimmed responses.
 *
 * Exit codes:
 *   0  success (data written, or no changes needed)
 *   1  API error (auth/network/4xx/5xx from socialdata.tools)
 *   2  validation / IO error (malformed JSON, write failure, bad env, etc.)
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ----- types ----------------------------------------------------------------

type Day = { date: string; count: number };

type DataFile = {
  generated_at: string;
  user_id: string;
  handle: string;
  /** IANA tz used to bucket `days[]`. Stamped by this script so the runtime
   *  can refuse to render if the consumer's tz disagrees (F10). */
  bucketed_tz: string;
  days: Day[];
};

type UserLookupResponse = {
  id?: number | string;
  id_str?: string;
  screen_name?: string;
};

type SearchResponse = {
  tweets?: Array<{ tweet_created_at?: string; id_str?: string }>;
  next_cursor?: string | null;
};

// ----- config ---------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const DATA_PATH = resolve(REPO_ROOT, "apps/web/src/data/x-days.json");

const API_BASE = "https://api.socialdata.tools";
const OVERLAP_DAYS = 2;
// Hard guard against infinite-cursor bugs. Set high enough to handle full
// backfills (BACKFILL_SINCE=2024-01-01) for a heavy poster; if we hit this
// AND the API still has a cursor, we throw rather than silently truncate.
const MAX_PAGES = 500;

// ----- logging --------------------------------------------------------------

const log = (msg: string) => {
  process.stderr.write(`[refresh-x-days] ${msg}\n`);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function die(code: 1 | 2, msg: string): never {
  process.stderr.write(`[refresh-x-days] FATAL: ${msg}\n`);
  process.exit(code);
}

// ----- env ------------------------------------------------------------------

const API_KEY = process.env.SOCIALDATA_API_KEY?.trim() ?? "";
const HANDLE = (process.env.X_LOGIN?.trim() || "anishthite").replace(/^@/, "");
const TZ = process.env.NERV_TZ?.trim() || "America/Los_Angeles";
const BACKFILL_SINCE = (process.env.BACKFILL_SINCE?.trim() || "2024-01-01");

if (!API_KEY) {
  die(2, "SOCIALDATA_API_KEY is required");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(BACKFILL_SINCE)) {
  die(2, `BACKFILL_SINCE must be YYYY-MM-DD, got: ${BACKFILL_SINCE}`);
}

// ----- helpers --------------------------------------------------------------

/** Match streak.ts dateKey() exactly — same Intl call, same locale. */
const dateKey = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const addDaysISO = (yyyymmdd: string, n: number): string => {
  const [y, m, d] = yyyymmdd.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
};

const isValidDayList = (v: unknown): v is Day[] => {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (!item || typeof item !== "object") return false;
    const d = (item as { date?: unknown }).date;
    const c = (item as { count?: unknown }).count;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0) return false;
  }
  return true;
};

async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  // F3: retry on 429/5xx, exponential backoff 1s/4s/16s, max 3 retries.
  // 4xx other than 429 throw immediately (auth/bad-request — not transient).
  const maxAttempts = 4; // 1 initial attempt + 3 retries
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset). Treat as retryable.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const waitMs = Math.pow(4, attempt - 1) * 1000; // 1s, 4s, 16s
        log(
          `fetch threw for ${path} (attempt ${attempt}/${maxAttempts}): ` +
            `${lastErr.message} — retrying in ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      }
      break;
    }

    if (!res.ok) {
      const status = res.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (!isRetryable) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${status} for ${path}: ${body.slice(0, 200)}`);
      }
      if (attempt >= maxAttempts) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${status} for ${path} after ${attempt} attempts: ${body.slice(0, 200)}`
        );
      }
      let waitMs = Math.pow(4, attempt - 1) * 1000; // 1s, 4s, 16s
      if (status === 429) {
        const ra = res.headers.get("retry-after");
        if (ra) {
          const sec = parseInt(ra, 10);
          if (Number.isFinite(sec) && sec >= 0) waitMs = sec * 1000;
        }
      }
      log(
        `HTTP ${status} for ${path} (attempt ${attempt}/${maxAttempts}) — ` +
          `retrying in ${waitMs}ms`
      );
      await sleep(waitMs);
      continue;
    }

    // 2xx — read body as text first so a non-JSON / envelope-error body is
    // diagnosable. F2 layer 1: refuse 200 + error envelope.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} non-JSON body at ${path}: ${text.slice(0, 200)}`);
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj.status === "error" || obj.error !== undefined) {
        const msg =
          typeof obj.message === "string"
            ? obj.message
            : typeof obj.error === "string"
              ? obj.error
              : JSON.stringify(obj).slice(0, 200);
        throw new Error(`API returned error envelope at ${path}: ${msg}`);
      }
    }
    return parsed as T;
  }
  throw lastErr ?? new Error(`apiGet ${path} failed without a specific error`);
}

// ----- I/O ------------------------------------------------------------------

async function loadData(): Promise<DataFile> {
  let raw: string;
  try {
    raw = await readFile(DATA_PATH, "utf8");
  } catch (err) {
    die(2, `cannot read ${DATA_PATH}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(2, `${DATA_PATH} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    die(2, `${DATA_PATH} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const days = obj.days;
  if (!isValidDayList(days)) {
    die(2, `${DATA_PATH}: invalid days[] (must be Array<{date:YYYY-MM-DD, count:number}>)`);
  }
  return {
    generated_at: typeof obj.generated_at === "string" ? obj.generated_at : "1970-01-01T00:00:00.000Z",
    user_id: typeof obj.user_id === "string" ? obj.user_id : "",
    handle: typeof obj.handle === "string" ? obj.handle : "",
    bucketed_tz: typeof obj.bucketed_tz === "string" ? obj.bucketed_tz : "",
    days,
  };
}

async function saveData(data: DataFile): Promise<void> {
  const sorted = [...data.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: DataFile = { ...data, days: sorted };
  const json = JSON.stringify(out, null, 2) + "\n";
  // F8: write-temp-then-rename for atomicity. A crash mid-flush leaves the
  // real file intact; the tmp file is what's truncated.
  const tmp = DATA_PATH + ".tmp";
  await writeFile(tmp, json, "utf8");
  await rename(tmp, DATA_PATH);
}

// ----- main steps -----------------------------------------------------------

async function resolveUserId(existing: DataFile): Promise<string> {
  if (existing.user_id && existing.handle === HANDLE) {
    log(`user_id cached: ${existing.user_id} (handle=${HANDLE})`);
    return existing.user_id;
  }
  log(`looking up user_id for handle=${HANDLE}`);
  const u = await apiGet<UserLookupResponse>(`/twitter/user/${encodeURIComponent(HANDLE)}`);
  const id = u.id_str ?? (u.id != null ? String(u.id) : "");
  if (!id) {
    throw new Error(`socialdata /twitter/user/${HANDLE} returned no id (body: ${JSON.stringify(u).slice(0, 200)})`);
  }
  log(`resolved user_id=${id}`);
  return id;
}

function decideSince(existing: DataFile): { since: string; fullBackfill: boolean } {
  if (existing.days.length === 0) {
    return { since: BACKFILL_SINCE, fullBackfill: true };
  }
  // days[] is sorted at save time; take last entry's date.
  const maxDate = existing.days.reduce((acc, d) => (d.date > acc ? d.date : acc), existing.days[0]!.date);
  const since = addDaysISO(maxDate, -OVERLAP_DAYS);
  return { since, fullBackfill: false };
}

async function fetchTweetDayCounts(since: string): Promise<Map<string, number>> {
  // socialdata's `since:` operator is inclusive on UTC date in the query;
  // we re-bucket each tweet to NERV_TZ regardless. Any rounding noise that
  // lands at/after `since` is absorbed by OVERLAP_DAYS; noise landing
  // BEFORE `since` is filtered out by the F1 merge guard.
  const counts = new Map<string, number>();
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let totalTweets = 0;
  let lastBodyNextCursor: string | null = null;
  let stoppedAtEnd = false;

  while (pages < MAX_PAGES) {
    const query = `from:${HANDLE} since:${since}`;
    const params = new URLSearchParams({ query, type: "Latest" });
    if (cursor) params.set("cursor", cursor);
    const path = `/twitter/search?${params.toString()}`;
    pages++;
    log(`page ${pages}: GET ${path}`);

    const body = await apiGet<SearchResponse>(path);

    // F2 layer 2: first page MUST have a `tweets` field. An undefined value
    // (not just an empty array) means the API returned a non-search-shaped
    // body that snuck past apiGet's envelope sniffer — refuse to proceed
    // rather than silently treat it as "user posted nothing".
    if (pages === 1 && body.tweets === undefined) {
      throw new Error(
        "API returned no `tweets` field on first page — refusing to proceed"
      );
    }

    const tweets = Array.isArray(body.tweets) ? body.tweets : [];
    let newOnPage = 0;
    for (const tw of tweets) {
      const id = tw.id_str ?? "";
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      const raw = tw.tweet_created_at;
      if (typeof raw !== "string") continue;
      const t = new Date(raw);
      if (Number.isNaN(t.getTime())) continue;
      const key = dateKey(t);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      newOnPage++;
    }
    totalTweets += newOnPage;
    log(`  ${tweets.length} tweets returned (${newOnPage} new), days touched so far=${counts.size}`);

    const nextCursor = body.next_cursor ?? null;
    lastBodyNextCursor = nextCursor;
    if (!nextCursor) {
      stoppedAtEnd = true;
      break;
    }
    if (nextCursor === cursor) {
      log(`  cursor stopped advancing, stopping pagination`);
      stoppedAtEnd = true;
      break;
    }
    if (newOnPage === 0) {
      log(`  page had no new tweets, stopping pagination`);
      stoppedAtEnd = true;
      break;
    }
    cursor = nextCursor;
  }

  // F4: distinguish "reached end of cursor chain" from "hit MAX_PAGES with
  // more to fetch". The latter is silent truncation and must fail loudly.
  if (!stoppedAtEnd && lastBodyNextCursor) {
    throw new Error(
      `hit MAX_PAGES=${MAX_PAGES} but next_cursor still present — dataset is truncated. ` +
        `Increase MAX_PAGES or split the backfill window.`
    );
  }

  log(`pagination done: pages=${pages}, total_tweets=${totalTweets}, days_touched=${counts.size}`);
  return counts;
}

function mergeCounts(
  existing: Day[],
  fresh: Map<string, number>,
  since: string,
  fullBackfill: boolean
): Day[] {
  const merged = new Map<string, number>();
  for (const d of existing) merged.set(d.date, d.count);

  if (fullBackfill) {
    // Wipe and replace: existing was empty or we're seeding from scratch.
    merged.clear();
  } else {
    // Overlap window: REPLACE existing counts for dates >= since.
    // Outside the overlap: untouched (never decremented).
    for (const date of [...merged.keys()]) {
      if (date >= since) merged.delete(date);
    }
  }

  for (const [date, count] of fresh) {
    // F1: only write inside the overlap window. Tweets in the late-evening
    // PT slice of the day BEFORE `since` get UTC-bucketed into the `since:`
    // query window but re-bucketed back to a pre-since PT date — those are
    // partial-day counts that must NOT clobber the prior full-day total.
    // Days strictly older than `since` are never touched by the merge.
    if (fullBackfill || date >= since) {
      merged.set(date, count);
    }
  }

  return [...merged.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ----- run ------------------------------------------------------------------

async function main(): Promise<void> {
  const existing = await loadData();
  log(`loaded ${DATA_PATH}: handle=${existing.handle || "(none)"}, days=${existing.days.length}, user_id=${existing.user_id || "(none)"}`);

  let userId: string;
  try {
    userId = await resolveUserId(existing);
  } catch (err) {
    die(1, `user lookup failed: ${err instanceof Error ? err.message : err}`);
  }

  const { since, fullBackfill } = decideSince(existing);
  log(`since=${since}, full_backfill=${fullBackfill}`);

  let counts: Map<string, number>;
  try {
    counts = await fetchTweetDayCounts(since);
  } catch (err) {
    die(1, `search pagination failed: ${err instanceof Error ? err.message : err}`);
  }

  const mergedDays = mergeCounts(existing.days, counts, since, fullBackfill);

  // F2 layer 3: never let an incremental run shrink the historical record.
  // The overlap-merge can legitimately rewrite the last few days but cannot
  // produce a strictly shorter list unless `fresh` was suspiciously empty.
  // Any genuine shrink (deleted account, mass-delete) requires an explicit
  // re-backfill (wipe existing.days and let fullBackfill=true seed it).
  if (!fullBackfill && mergedDays.length < existing.days.length) {
    die(
      2,
      `merged days would shrink existing data ` +
        `(${existing.days.length} → ${mergedDays.length}) — refusing to commit. ` +
        `If this is intentional, clear apps/web/src/data/x-days.json's days[] and re-run.`
    );
  }

  // F5: skip the write entirely when nothing material changed. Avoids ~365
  // noise commits / Vercel rebuilds per year on quiet days. We update
  // `generated_at` only when there IS a substantive change.
  const existingSorted = [...existing.days].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const daysSame =
    JSON.stringify(existingSorted) === JSON.stringify(mergedDays);
  const idSame = existing.user_id === userId;
  const handleSame = existing.handle === HANDLE;
  const tzSame = existing.bucketed_tz === TZ;

  if (daysSame && idSame && handleSame && tzSame) {
    log("no data changes — skipping write");
    const today = dateKey(new Date());
    const todayCount = mergedDays.find((d) => d.date === today)?.count ?? 0;
    process.stdout.write(
      `ok handle=${HANDLE} user_id=${userId} since=${since} full_backfill=${fullBackfill} ` +
        `days=${mergedDays.length} today=${today} today_count=${todayCount} skipped=1\n`
    );
    return;
  }

  const next: DataFile = {
    generated_at: new Date().toISOString(),
    user_id: userId,
    handle: HANDLE,
    bucketed_tz: TZ,
    days: mergedDays,
  };

  try {
    await saveData(next);
  } catch (err) {
    die(2, `write failed: ${err instanceof Error ? err.message : err}`);
  }

  const today = dateKey(new Date());
  const todayCount = mergedDays.find((d) => d.date === today)?.count ?? 0;
  process.stdout.write(
    `ok handle=${HANDLE} user_id=${userId} since=${since} full_backfill=${fullBackfill} ` +
      `days=${mergedDays.length} today=${today} today_count=${todayCount}\n`
  );
}

main().catch((err) => {
  die(2, `unhandled: ${err instanceof Error ? err.stack ?? err.message : err}`);
});
