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

// ----- multi-user roster ---------------------------------------------------
// Source of truth: apps/web/src/config/users.json (D-024). The script reads
// it directly rather than importing the .ts wrapper so it stays runnable
// without a TS path-alias resolver in Node.

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
const USERS_PATH = resolve(REPO_ROOT, "apps/web/src/config/users.json");
const dataPathFor = (slug: string): string =>
  resolve(REPO_ROOT, `apps/web/src/data/x-days.${slug}.json`);

type RosterUser = {
  slug: string;
  displayName: string;
  githubLogin: string;
  xLogin: string;
};

async function loadRoster(): Promise<RosterUser[]> {
  let raw: string;
  try {
    raw = await readFile(USERS_PATH, "utf8");
  } catch (err) {
    die(2, `cannot read ${USERS_PATH}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(2, `${USERS_PATH} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const users = (parsed as { users?: unknown })?.users;
  if (!Array.isArray(users) || users.length === 0) {
    die(2, `${USERS_PATH} must have a non-empty users[] array`);
  }
  const out: RosterUser[] = [];
  for (const u of users) {
    if (!u || typeof u !== "object") continue;
    const o = u as Record<string, unknown>;
    if (
      typeof o.slug === "string" &&
      typeof o.displayName === "string" &&
      typeof o.githubLogin === "string" &&
      typeof o.xLogin === "string"
    ) {
      out.push({
        slug: o.slug,
        displayName: o.displayName,
        githubLogin: o.githubLogin,
        xLogin: o.xLogin,
      });
    }
  }
  if (out.length === 0) die(2, `${USERS_PATH}: no valid user entries`);
  return out;
}

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
// X_LOGIN env retained as an override for single-user runs (e.g. local
// testing of one slug). When set + USERS_FILTER is unset, the multi-user
// loop is bypassed in favor of the legacy single-user behavior.
const LEGACY_X_LOGIN = (process.env.X_LOGIN?.trim() || "").replace(/^@/, "");
// USERS_FILTER="anish,subby" → only refresh those slugs (debugging). Empty
// = refresh every slug in users.json.
const USERS_FILTER = (process.env.USERS_FILTER?.trim() || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TZ = process.env.NERV_TZ?.trim() || "America/Los_Angeles";
const BACKFILL_SINCE = (process.env.BACKFILL_SINCE?.trim() || "2024-01-01");
// LATEST_ONLY: fetch only the most recent tweet and stamp its day as count>=1.
// Cost per run: ~1 API call (~$0.0002). Heatmap fills out one day at a time,
// binary signal ("tweeted that day?"). Merge is additive — never decrements.
const LATEST_ONLY = process.env.LATEST_ONLY === "1";

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

async function loadData(dataPath: string): Promise<DataFile> {
  let raw: string;
  try {
    raw = await readFile(dataPath, "utf8");
  } catch (err) {
    die(2, `cannot read ${dataPath}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(2, `${dataPath} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    die(2, `${dataPath} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const days = obj.days;
  if (!isValidDayList(days)) {
    die(2, `${dataPath}: invalid days[] (must be Array<{date:YYYY-MM-DD, count:number}>)`);
  }
  return {
    generated_at: typeof obj.generated_at === "string" ? obj.generated_at : "1970-01-01T00:00:00.000Z",
    user_id: typeof obj.user_id === "string" ? obj.user_id : "",
    handle: typeof obj.handle === "string" ? obj.handle : "",
    bucketed_tz: typeof obj.bucketed_tz === "string" ? obj.bucketed_tz : "",
    days,
  };
}

async function saveData(dataPath: string, data: DataFile): Promise<void> {
  const sorted = [...data.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: DataFile = { ...data, days: sorted };
  const json = JSON.stringify(out, null, 2) + "\n";
  // F8: write-temp-then-rename for atomicity.
  const tmp = dataPath + ".tmp";
  await writeFile(tmp, json, "utf8");
  await rename(tmp, dataPath);
}

// ----- main steps -----------------------------------------------------------

async function resolveUserId(handle: string, existing: DataFile): Promise<string> {
  if (existing.user_id && existing.handle === handle) {
    log(`user_id cached: ${existing.user_id} (handle=${handle})`);
    return existing.user_id;
  }
  log(`looking up user_id for handle=${handle}`);
  const u = await apiGet<UserLookupResponse>(`/twitter/user/${encodeURIComponent(handle)}`);
  const id = u.id_str ?? (u.id != null ? String(u.id) : "");
  if (!id) {
    throw new Error(`socialdata /twitter/user/${handle} returned no id (body: ${JSON.stringify(u).slice(0, 200)})`);
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

async function fetchTweetDayCounts(handle: string, since: string): Promise<Map<string, number>> {
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
    const query = `from:${handle} since:${since}`;
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

    let tweets = Array.isArray(body.tweets) ? body.tweets : [];
    // LATEST_ONLY: keep only the most recent tweet (Latest sort puts it first)
    // and force the loop to terminate after this page.
    if (LATEST_ONLY) tweets = tweets.slice(0, 1);
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
    if (LATEST_ONLY) {
      log(`  LATEST_ONLY=1, stopping after first tweet`);
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
  fullBackfill: boolean,
  latestOnly: boolean
): Day[] {
  const merged = new Map<string, number>();
  for (const d of existing) merged.set(d.date, d.count);

  if (latestOnly) {
    // Additive-only: stamp each fresh date as max(existing, fresh). Never
    // decrements, never erases historical data. Idempotent across reruns of
    // the same tweet (re-fetching today's latest tweet leaves today at 1).
    // This is the mode the daily workflow runs in.
    for (const [date, count] of fresh) {
      const prev = merged.get(date) ?? 0;
      merged.set(date, Math.max(prev, count));
    }
  } else {
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
  }

  return [...merged.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ----- run ------------------------------------------------------------------

async function processUser(target: { slug: string; handle: string }): Promise<void> {
  const { slug, handle } = target;
  const dataPath = dataPathFor(slug);
  log(`=== ${slug} (handle=${handle}) ===`);

  const existing = await loadData(dataPath);
  log(`loaded ${dataPath}: handle=${existing.handle || "(none)"}, days=${existing.days.length}, user_id=${existing.user_id || "(none)"}`);

  // Per-user failures THROW (not die/exit) so a transient socialdata error
  // for one user doesn't poison the whole roster's commit step. main()
  // catches and continues to the next user. Reviewer-flagged 2026-06-01.
  let userId: string;
  try {
    userId = await resolveUserId(handle, existing);
  } catch (err) {
    throw new Error(`[${slug}] user lookup failed: ${err instanceof Error ? err.message : err}`);
  }

  const { since, fullBackfill } = decideSince(existing);
  log(`since=${since}, full_backfill=${fullBackfill}`);

  let counts: Map<string, number>;
  try {
    counts = await fetchTweetDayCounts(handle, since);
  } catch (err) {
    throw new Error(`[${slug}] search pagination failed: ${err instanceof Error ? err.message : err}`);
  }

  const mergedDays = mergeCounts(existing.days, counts, since, fullBackfill, LATEST_ONLY);

  if (!fullBackfill && mergedDays.length < existing.days.length) {
    throw new Error(
      `[${slug}] merged days would shrink existing data ` +
        `(${existing.days.length} → ${mergedDays.length}) — refusing to commit. ` +
        `If this is intentional, clear ${dataPath}'s days[] and re-run.`
    );
  }

  const existingSorted = [...existing.days].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const daysSame =
    JSON.stringify(existingSorted) === JSON.stringify(mergedDays);
  const idSame = existing.user_id === userId;
  const handleSame = existing.handle === handle;
  const tzSame = existing.bucketed_tz === TZ;

  if (daysSame && idSame && handleSame && tzSame) {
    log("no data changes — skipping write");
    const today = dateKey(new Date());
    const todayCount = mergedDays.find((d) => d.date === today)?.count ?? 0;
    process.stdout.write(
      `ok slug=${slug} handle=${handle} user_id=${userId} since=${since} full_backfill=${fullBackfill} ` +
        `days=${mergedDays.length} today=${today} today_count=${todayCount} skipped=1\n`
    );
    return;
  }

  const next: DataFile = {
    generated_at: new Date().toISOString(),
    user_id: userId,
    handle,
    bucketed_tz: TZ,
    days: mergedDays,
  };

  try {
    await saveData(dataPath, next);
  } catch (err) {
    throw new Error(`[${slug}] write failed: ${err instanceof Error ? err.message : err}`);
  }

  const today = dateKey(new Date());
  const todayCount = mergedDays.find((d) => d.date === today)?.count ?? 0;
  process.stdout.write(
    `ok slug=${slug} handle=${handle} user_id=${userId} since=${since} full_backfill=${fullBackfill} ` +
      `days=${mergedDays.length} today=${today} today_count=${todayCount}\n`
  );
}

async function main(): Promise<void> {
  // Build the list of targets. Priority:
  //   1. LEGACY_X_LOGIN env set + USERS_FILTER empty → single-user legacy mode
  //      (preserves the old `X_LOGIN=foo pnpm tsx scripts/refresh-x-days.ts`
  //      invocation for local testing of a one-off handle that may not even
  //      be in users.json yet). Maps the env handle to whichever roster slug
  //      shares it, or falls back to slug="env".
  //   2. Otherwise → walk users.json, optionally filtered by USERS_FILTER.
  let targets: Array<{ slug: string; handle: string }>;
  if (LEGACY_X_LOGIN && USERS_FILTER.length === 0) {
    const roster = await loadRoster();
    const match = roster.find((u) => u.xLogin === LEGACY_X_LOGIN);
    if (match) {
      log(`legacy single-user mode: X_LOGIN=${LEGACY_X_LOGIN} → slug=${match.slug}`);
      targets = [{ slug: match.slug, handle: LEGACY_X_LOGIN }];
    } else {
      log(`legacy single-user mode: X_LOGIN=${LEGACY_X_LOGIN} not in roster, using slug="env"`);
      targets = [{ slug: "env", handle: LEGACY_X_LOGIN }];
    }
  } else {
    const roster = await loadRoster();
    const filtered = USERS_FILTER.length
      ? roster.filter((u) => USERS_FILTER.includes(u.slug))
      : roster;
    if (filtered.length === 0) {
      die(
        2,
        `no users to refresh (USERS_FILTER=${USERS_FILTER.join(",")} matched none of ${roster.map((u) => u.slug).join(",")})`
      );
    }
    targets = filtered.map((u) => ({ slug: u.slug, handle: u.xLogin }));
  }

  // Sequential: socialdata.tools has a shared rate limit per API key.
  // For n=2 the wall time is fine (~10s total worst case); we can revisit
  // bounded parallelism if the roster grows past ~5.
  //
  // Partial-success policy: a per-user failure throws but main() catches
  // and continues to the next user. Only when ALL users fail do we exit
  // non-zero, which is what blocks the workflow's commit step. This way a
  // single transient socialdata error doesn't gate everyone else's daily
  // refresh (reviewer-flagged 2026-06-01).
  const failures: Array<{ slug: string; err: unknown }> = [];
  for (const t of targets) {
    try {
      await processUser(t);
    } catch (err) {
      failures.push({ slug: t.slug, err });
      log(`[${t.slug}] FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (failures.length === targets.length) {
    die(
      1,
      `all ${targets.length} user(s) failed; nothing to commit. ` +
        `Last error: ${failures[failures.length - 1]?.err}`
    );
  }
  if (failures.length > 0) {
    // Partial success: print a clear summary line. We exit 0 so the
    // workflow's commit step still runs on the survivors' data.
    process.stdout.write(
      `partial slugs_failed=${failures.length}/${targets.length} failed=${failures.map((f) => f.slug).join(",")}\n`
    );
  }
}

main().catch((err) => {
  die(2, `unhandled: ${err instanceof Error ? err.stack ?? err.message : err}`);
});
