# Adversarial Robustness / Edge-Case Review — socialdata migration

**Scope:** `scripts/refresh-x-days.ts` (primary, ~280 LOC) and `apps/web/src/lib/twitter.ts` (secondary, 105 LOC). Probing for production failure modes the happy path misses.

**Verdict:** Two real silent-data-loss paths (error envelopes, MAX_PAGES truncation), one noisy-commit nit, plus several lesser issues. No build-blocking bugs, but the script is more brittle than the worker notes suggest. The read path in `twitter.ts` is solid.

---

## Findings (ranked)

### [BLOCKER] Silent data loss when API returns HTTP 200 + error envelope
**File:** `scripts/refresh-x-days.ts:151–158` (response parsing) + `:209–225` (merge)
**Trigger:** socialdata returns `200 OK` with a body like `{"status": "error", "message": "..."}` (or any shape that lacks a `tweets` array). The code does:
```ts
const tweets = Array.isArray(body.tweets) ? body.tweets : [];
```
…then on page 1, `newOnPage === 0` immediately breaks the loop and returns an **empty** counts Map. In the merge step (`mergeCounts`, lines 217–219):
```ts
for (const date of [...merged.keys()]) {
  if (date >= since) merged.delete(date);
}
```
…deletes every existing day inside the 2-day overlap window, and nothing is added back. **Exit code is 0**, commit step pushes the truncated JSON, dashboard goes (silently) wrong for the last 2 days. The CI run is green.

I confirmed the parser path empirically:
```
tweets array length: 0 — would set newOnPage=0 and silently stop pagination, returning empty Map
```

**Fix:** Distinguish "real empty page" from "API misbehaved":
- In `apiGet`, after `res.json()`, sniff for an error envelope (`body.status === "error"`, `body.error`, `body.message` without `tweets`) and throw.
- And/or: in `fetchTweetDayCounts`, if `body.tweets` is `undefined` (not just empty array) on the very first response, throw rather than treat it as "no tweets exist".
- Belt-and-braces: in `main()`, refuse to write a file where `mergedDays.length < existing.days.length` unless `fullBackfill === true`. Any merge that loses days should require an explicit re-seed.

---

### [HIGH] No retry/backoff on HTTP 429 or 5xx — single transient failure → 24h staleness
**File:** `scripts/refresh-x-days.ts:148–158` (`apiGet`)
**Trigger:** Any single non-2xx response (429 from rate-limit burst, 502 from socialdata's upstream, 503 from a momentary outage) anywhere in a ≤200-page pagination loop will:
1. `apiGet` throws `HTTP <status> for <path>: <body>`
2. `fetchTweetDayCounts`'s caller catches → `die(1, ...)`
3. Workflow exits non-zero → CI marks failed → no commit
4. Next attempt is 24h later (unless someone notices the red Action and re-runs)

The brief explicitly called this out: *"should ideally retry-with-backoff a small number of times before failing"*. Current code has zero retries.

For a script that hits the same endpoint up to 200 times per run, this is the most likely real failure mode in production. The error IS loud (red workflow, exit 1), but the recovery window is 24 hours.

**Fix:** Wrap `apiGet` in a retry loop: on 429 and 5xx, exponential backoff (e.g. 1s, 4s, 16s) with max 3 attempts. Honor `Retry-After` header if present. On 4xx other than 429 (auth, bad request), do NOT retry. Document the decision in a comment.

---

### [HIGH] MAX_PAGES = 200 silently truncates the dataset on success
**File:** `scripts/refresh-x-days.ts:36, 175, 199`
**Trigger:** A heavy backfill (BACKFILL_SINCE=2024-01-01) where the user posted >MAX_PAGES × page_size tweets. The loop hits `pages < MAX_PAGES`, exits normally, logs `pagination done: pages=200`, and `main()` writes a partial dataset with exit code 0. The oldest tweets are simply absent. There is no signal in stdout/stderr that this happened beyond the count being suspiciously round.

Worst real-world case from the worker notes (T-018): if `SOCIALDATA_API_KEY` lapses and the Action no-ops for 6 months, the next successful run computes `since = max(existing) − 2 days ≈ 6 months ago`. For a moderately active poster this is a real risk.

**Fix:** Detect "stopped because of MAX_PAGES, not because of a true end-of-pagination":
```ts
const hitCap = pages >= MAX_PAGES && nextCursor; // we'd have continued
if (hitCap) {
  throw new Error(`hit MAX_PAGES=${MAX_PAGES} but next_cursor still present — dataset is truncated`);
}
```
Make this exit 1, not exit 0. Also: raise the cap to e.g. 1000 for backfills, or make it env-configurable, so a once-per-year heavy backfill doesn't trip it.

---

### [MED] `generated_at` updates every run → daily noise commit even when days[] is unchanged
**File:** `scripts/refresh-x-days.ts:264` (`generated_at: new Date().toISOString()`) + `.github/workflows/refresh-x-days.yml:54` (`git diff --quiet ... || commit`)
**Trigger:** Every run rewrites `generated_at` to `now`. Verified empirically — two runs with identical `days[]` produce different bytes. `git diff --quiet` returns non-zero, the commit step always runs, `main` accumulates ~365 essentially-empty commits per year. Plan §3 promised "commits back to `main`" but didn't promise daily churn.

Worse: a Vercel rebuild fires for every push. So you pay for ~365 rebuilds/year of identical static output.

**Fix (cheapest):** Diff `days[]` (and `user_id`/`handle`) only, not `generated_at`. Two options:
1. In the workflow, `git diff --quiet apps/web/src/data/x-days.json` → replace with `jq` comparing only `.days` and `.user_id`. Awkward.
2. In `refresh-x-days.ts`, only update `generated_at` when something else materially changed. Compare the new `days` array against `existing.days` (deep-equal) and skip the write entirely when identical.

Option 2 is cleanest — also makes `git status` honest at the script level (the worker validation step #4 was misled by the always-changes behavior).

---

### [MED] No write-temp-then-rename — `writeFile` can leave a corrupted JSON file
**File:** `scripts/refresh-x-days.ts:142–146` (`saveData`)
**Trigger:** Script crashes mid-write (process killed, disk full mid-flush, OOM). `fs.writeFile` is **not** atomic — it truncates then writes. A killed write leaves a partially-truncated, syntactically-invalid file. The next build then fails because of the JSON import. The blast radius is "Vercel build is broken until a human fixes the file."

Practical risk is low (single short synchronous write on a CI runner), but the fix is cheap.

**Fix:**
```ts
const tmp = DATA_PATH + ".tmp";
await writeFile(tmp, json, "utf8");
await rename(tmp, DATA_PATH);
```

---

### [MED] Empty tweets array on full backfill silently wipes the file
**File:** `scripts/refresh-x-days.ts:209–215` (merge, `fullBackfill` branch)
**Trigger:** First run after a deploy where the API returns no tweets (whether legitimately or due to the [BLOCKER] above). `merged.clear()` runs, `fresh` is empty, `mergedDays` is `[]`. `saveData` writes an empty `days: []`. Next run sees `existing.days.length === 0` and full-backfills again. The Twitter panel stays offline indefinitely.

This is mostly redundant with the BLOCKER above, but it's also independently triggerable: a legitimate empty-window response in fullBackfill mode produces a "successful" empty write, which makes the next run also a fullBackfill. The script never converges to incremental mode if the first call returns zero tweets.

**Fix:** The "refuse to write a smaller days[] than existing" guard from the BLOCKER fix would address this. Additionally: if `fullBackfill === true` and `counts.size === 0`, log a warning and exit 1 — "first run returned zero tweets, refusing to seed an empty file" — and let a human re-run.

---

### [LOW] HTTP 200 + malformed JSON body produces an opaque stack trace
**File:** `scripts/refresh-x-days.ts:158`
**Trigger:** `await res.json()` throws `SyntaxError: Unexpected token ...`. The error propagates up to the `main()` `try`/`catch` → `die(1, "search pagination failed: SyntaxError: ...")`. The body bytes that caused it are gone (we already consumed the stream).

It's loud (exit 1), but undiagnosable — you can't tell whether socialdata served HTML, an empty body, or truncated JSON.

**Fix:** Read as text first, then `JSON.parse`:
```ts
const text = await res.text();
try { return JSON.parse(text) as T; }
catch { throw new Error(`HTTP ${res.status} non-JSON body at ${path}: ${text.slice(0, 200)}`); }
```

---

### [LOW] `next_cursor === 'null'` (string) wastes one API call before stopping
**File:** `scripts/refresh-x-days.ts:196–203`
**Trigger:** Some APIs return the literal string `"null"` for cursor termination. The current code:
```ts
const nextCursor = body.next_cursor;
if (!nextCursor) break;
```
…treats the truthy string `"null"` as a real cursor. The next call sends `cursor=null` to the API, which either errors (caught → exit 1) or returns the same response with the same cursor (caught by `nextCursor === cursor` guard → loop ends). Either way, one wasted call. Empty string `""` is correctly falsy. URL-special chars in cursors are correctly encoded via `URLSearchParams`.

**Fix:** `if (!nextCursor || nextCursor === "null") break;`. One line.

---

### [LOW] Future-dated tweets are accepted and persisted forever
**File:** `scripts/refresh-x-days.ts:185–190` + merge
**Trigger:** A tweet with `tweet_created_at` in the future (server clock skew, malformed API response, hand-crafted garbage). Verified: bucketing a year 3024 timestamp through `dateKey` produces `3024-01-15`. The read path in `twitter.ts` filters by `[from, to]`, so it doesn't render — but the file accumulates dead far-future entries.

**Fix:** In the pagination loop, reject tweets with `t.getTime() > Date.now() + 86_400_000` (1-day skew tolerance). One condition.

---

### [LOW] Invalid `NERV_TZ` value crashes with a cryptic Intl error
**File:** `scripts/refresh-x-days.ts:103–110` (`dateKey`)
**Trigger:** User sets `NERV_TZ=Not/Real`. `Intl.DateTimeFormat` throws `RangeError: Invalid time zone specified: Not/Real`. The script catches via `main().catch` → `die(2, "unhandled: RangeError: ...")`. Loud but the user can't easily tell why.

**Fix:** Validate TZ at startup (alongside `BACKFILL_SINCE`):
```ts
try { new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); }
catch { die(2, `Invalid NERV_TZ: ${TZ}`); }
```

---

### [LOW] dateKey() drift between `refresh-x-days.ts` and `streak.ts` has no test guard
**File:** `scripts/refresh-x-days.ts:103–110` vs `apps/web/src/lib/streak.ts:111–120`
**Trigger:** A future PR changes one `dateKey` (different locale, different timezone defaulting, different `formatToParts` use) without changing the other. The day buckets diverge silently. The dashboard renders subtly wrong numbers.

D-035 acknowledges the duplication is intentional ("copy-paste is intentional to keep the script self-contained"). Worker notes don't flag a guard for drift. There is no shared module, no test that imports both, no comment cross-reference in either file (just one direction).

**Fix (cheap):** Add a comment in `streak.ts:dateKey` that says "MUST stay byte-identical with `scripts/refresh-x-days.ts:dateKey`". Optional: a tiny vitest that imports both `dateKey`s and asserts equal output for ~20 fixture timestamps (including DST boundaries, microsecond precision, and `Date.UTC(2024, 2, 10, 9, 30)` ≈ first PT spring-forward of the year).

---

### [NIT] Log "tweets returned" counts dupes
**File:** `scripts/refresh-x-days.ts:184, 192`
`tweets.length` is logged as "returned", but `newOnPage` correctly excludes dupes. Minor log fidelity issue; debugging gets harder if a buggy cursor returns the same page repeatedly. Cosmetic.

---

### [NIT] `decideSince`'s reduce is overcomplicated
**File:** `scripts/refresh-x-days.ts:173`
Since `days[]` is sorted at save time, `max(date) === days[days.length - 1].date`. The `.reduce((acc, d) => d.date > acc ? d.date : acc, days[0].date)` works but is defensive against an invariant the code already enforces. Could be one indexed read.

---

## What I probed and found correct (with evidence)

| Probe | File:Line | Conclusion |
|---|---|---|
| DST handling in `dateKey` | `refresh-x-days.ts:103` | `Intl.DateTimeFormat({ timeZone })` handles DST natively. The tweet `2026-05-29T07:30:00Z` correctly buckets to `2026-05-29` under PDT (UTC−7). |
| Microsecond precision in `tweet_created_at` | `refresh-x-days.ts:188` | Verified empirically: `new Date('2026-05-29T07:30:00.000000Z')` parses to the correct ms-truncated Date. JS Date ignores sub-ms digits. |
| `git diff --quiet` no-op behavior | `.github/workflows/refresh-x-days.yml:53` | Trailing-newline policy is consistent (`+ "\n"` always). HOWEVER see [MED] above — `generated_at` makes every diff non-empty, so the no-op path is never hit. |
| Workflow concurrency | `.github/workflows/refresh-x-days.yml:18–20` | `concurrency.group` + `cancel-in-progress: false` queues, doesn't parallelize. No race between two `workflow_dispatch` runs. |
| `twitter.ts` read path: x-days.json missing | `apps/web/src/lib/twitter.ts:3` | `import xDaysData from "../data/x-days.json"` — TypeScript / next bundler resolves at **build time**. Missing file → build error, loud and at deploy time. ✓ |
| `twitter.ts` read path: malformed JSON | same | Same — JSON syntax error breaks the bundler, build fails loud. The hand-edit risk surfaces at deploy, not at runtime. ✓ |
| 365 → 30 day slice direction | `apps/web/src/lib/twitter.ts:83–87` | `d < from \|\| d > to` filter is direction-agnostic. The slice correctly drops both ends; `fillMissingDays` fills the [from, to] window. The user's specific worry ("first 30 vs last 30") doesn't apply because there's no slicing — it's range-filtering. ✓ |
| `next_cursor === ''` | `refresh-x-days.ts:197` | `if (!nextCursor) break` — empty string is falsy, correctly terminates. ✓ |
| URL-special chars in cursor | `refresh-x-days.ts:178` | `URLSearchParams.set("cursor", cursor)` URL-encodes `+`, `/`, `=` etc. ✓ |
| `writeFile` failure (disk full / EACCES) | `refresh-x-days.ts:253–257` | Wrapped in try/catch → `die(2, "write failed: ...")`. Exit 2 with clear message. ✓ |
| `fetch()` throws (DNS / network) | `refresh-x-days.ts:243–247` | Wrapped in main's try/catch around `fetchTweetDayCounts` → `die(1, "search pagination failed: ...")`. Exit 1, loud. ✓ User-lookup path also wrapped at `:237–241` ✓ |

---

## Summary

| Severity | Count | Examples |
|---|---|---|
| BLOCKER | 1 | Error envelope silent data loss |
| HIGH    | 2 | No retry/backoff; MAX_PAGES silent truncation |
| MED     | 3 | Daily noise commits; non-atomic write; empty-fullBackfill wipe |
| LOW     | 4 | Opaque JSON parse error; `"null"` cursor; future tweets; invalid TZ |
| NIT     | 2 | Log fidelity; over-defensive reduce |

**Top three to fix before scheduling the first real run:**
1. Detect HTTP 200 + missing `tweets` array as an error, not as "empty page". Refuse to commit a smaller days[] than existing.
2. Add retry-with-backoff (1s/4s/16s, ≤3 attempts) on 429 and 5xx in `apiGet`.
3. Either stop touching `generated_at` on no-op runs, or move the field into a sibling file the workflow doesn't diff — otherwise the repo gets ~365 garbage commits/year.

The read path in `twitter.ts` is solid and doesn't need changes.
