# Adversarial Correctness Review — socialdata migration

> Scope: read-only correctness review of the worker's diff against `scout-socialdata-migration.md`. No edits applied (review-only). Probes 1–6 from the brief covered. One **[HIGH]** bug found that silently corrupts data on every daily refresh; everything else is **[MED]** or below.

---

## Ranked findings

### [HIGH] `mergeCounts` decrements counts OUTSIDE the overlap window — violates the "never decrement outside overlap" invariant

**Where:** `scripts/refresh-x-days.ts:262–280` (the `mergeCounts` body), specifically the unconditional `merged.set(date, count)` at line 277.

**The invariant (worker's own words, lines 22–23 and 268–269):**
> *Within the 2-day overlap window the new fetch is authoritative (replaces existing counts). Days strictly older than the overlap window are NEVER decremented.*

**The actual code:**

```ts
for (const date of [...merged.keys()]) {
  if (date >= since) merged.delete(date);        // line 271 — only clears in-window
}
for (const [date, count] of fresh) {
  merged.set(date, count);                       // line 277 — UNCONDITIONAL
}
```

`merged.set` overwrites for *any* date in `fresh`, including dates **before** `since`. Combined with the UTC↔PT boundary skew that `fetchTweetDayCounts` produces, this corrupts an older day's count on every single run.

**Concrete walk-through** (NERV_TZ = America/Los_Angeles, PDT = UTC-7; matches the worker's intent per `script` line 12 *"MUST match runtime tz"*):

1. Cron fires on May 30 at 09:00 UTC ≡ 02:00 PT.
2. `existing.maxDate = 2026-05-29` (PT). `decideSince` returns `since = "2026-05-27"`.
3. The query is literally `from:anishthite since:2026-05-27`. Per the worker's own comment at lines 203–205, socialdata's `since:` operator is **UTC-date-inclusive**, so it returns tweets posted ≥ `2026-05-27T00:00:00Z` ≡ `2026-05-26T17:00:00 PT`.
4. Each tweet is re-bucketed to PT via `dateKey()`. Tweets posted on May 26 PT between 17:00 and 23:59 (which are May 27 in UTC) bucket back to PT date **"2026-05-26"** — a date **strictly before `since`**.
5. So `fresh` has an entry for `2026-05-26`, but only the *late-evening* slice of that PT day. Say the user shipped four tweets on May 26 PT: 09:00, 14:00, 17:30, 18:00 PT. Only the 17:30 and 18:00 PT ones make it into `fresh["2026-05-26"]` — count = **2**.
6. In `mergeCounts`, since `"2026-05-26" < since ("2026-05-27")`, `merged.delete` is **not** called on it (line 271's guard rejects it). So `merged["2026-05-26"]` retains its previous-day value of **4**.
7. Then line 277 fires unconditionally: `merged.set("2026-05-26", 2)`. **Existing 4 is overwritten with the partial 2.**

The day before the `since` cutoff is corrupted every refresh. Today (D) corrupts D-3 (the day right outside the overlap window). Tomorrow's run will corrupt D-2 — *unless* yesterday's corruption already happened, in which case D-2 is corrupted using an already-corrupted base. End state: every day's count converges to "tweets posted in the 17:00-PT-onward window only" rather than the full-day total. Heatmap looks weak; streaks understate.

**Why the worker thought this was safe (lines 203–205):**
> *"socialdata's `since:` operator is inclusive on UTC date in the query; we re-bucket each tweet to NERV_TZ regardless, so any rounding noise is absorbed by the OVERLAP_DAYS window."*

The fallacy: the noise does **not** stay inside `[since, today]`. It propagates *backward* into the previous PT day, which is outside the overlap window. `OVERLAP_DAYS=2` does not absorb noise that lands before `since`.

**Fix candidates (any one of these closes it; I'm not applying because review-only):**

- **Cheapest:** in the merge loop, guard the write: `if (date >= since) merged.set(date, count);`. This keeps existing counts for any PT day older than `since`. Pre-`since` data is simply not authoritative for fresh anymore.
- **Or:** drop tweets older than `since` at bucket time inside `fetchTweetDayCounts`: `if (key < since) continue;`.
- **Or:** set the query `since:` two days earlier than the merge boundary (cover the full PT day before `since`) and let the same `merged.set(date, count)` ride — but then the *merge* boundary still has to clear `merged` for those dates, otherwise the same issue moves elsewhere. The first two options are cleaner.

**Severity rationale:** silent, no error log, runs on every cron tick, biases every heatmap cell to undercount. The dashboard exists specifically to show streaks; this systematically erodes them. Calling it HIGH not BLOCKER only because the live runtime still functions and the corruption is gradual rather than total. If the user runs the workflow once and ships, the bug will manifest from the second run onward.

---

### [MED] All-malformed-rows silently degrades to zero-fill instead of "offline"

**Where:** `apps/web/src/lib/twitter.ts:81–101`.

The throw conditions are:

```ts
if (!Array.isArray(rawDays)) throw new TwitterFeedOfflineError(...)  // line 79
// then filter loop populates rows[] from rawDays
if (rawDays.length === 0)    throw new TwitterFeedOfflineError(...)  // line 92
return fillMissingDays(rows, from, to);                              // line 99
```

If `rawDays.length > 0` but every entry fails the validator (e.g., a build step accidentally stringifies counts → all `typeof c !== "number"` → every row dropped, but `rawDays.length > 0`), the function returns `fillMissingDays([], from, to)` — a contiguous all-zero `Day[]`. **No throw, no offline flag.**

Effect downstream: combined streak is in AND mode (because `twResult.offline === false`), Twitter is treated as a real source with zero ships, AND-streak collapses to permanent zero, panel renders fully but blank for a year. The corruption is invisible at the validator layer.

**Suggested guard:** after the row-validation loop, if `rawDays.length > 0 && rows.length === 0`, throw `TwitterFeedOfflineError([{host:"bundled-json", reason:"all days[] entries failed shape validation"}])`. One extra branch; preserves the existing offline-flow contract.

**Severity:** MED because it requires an upstream bug (refresh script writing malformed rows). The script's `isValidDayList` is a fairly strong gate, so this is unlikely in practice — but the validator is asymmetric: the **producer** validates shape, the **consumer** silently zero-fills shape failures. Asymmetric validators rot.

---

### [MED] `MAX_PAGES=200` silently truncates pagination — no warning, no error

**Where:** `scripts/refresh-x-days.ts:60` (constant), used as `while (pages < MAX_PAGES)` at line 211.

The pagination loop has four exit conditions (lines 232–241):

```ts
if (!nextCursor) break;                              // natural end
if (nextCursor === cursor) { log(...); break; }      // stuck cursor
if (newOnPage === 0) { log(...); break; }            // empty page
// implicit: pages >= MAX_PAGES — top-of-loop guard
```

The first three log a reason. **Hitting `MAX_PAGES` is silent** — the `while` just terminates and `fetchTweetDayCounts` returns a truncated map. No exception, no `die()`, no log line distinguishing "exhausted" from "capped." The downstream `main()` writes the partial data and exits 0.

Real-world cases:
- **Initial backfill** (`existing.days.length === 0` ⇒ `since = BACKFILL_SINCE = "2024-01-01"`). If the user tweets more than ~`200 × pageSize` over that span, the backfill silently stops. `mergeCounts(fullBackfill: true)` clears merged and writes only the partial. Subsequent runs use that partial as authoritative; older days stay missing forever (since incremental never re-fetches them).
- **Cumulative re-pull after a long Action outage** — same hazard.

**Fix candidates:**
- Log a distinct line when `pages === MAX_PAGES` (cheapest).
- `die(1, "...")` on MAX_PAGES, to force a human to bump the cap or change the strategy.
- Add a `truncated: boolean` field to the JSON when hit and surface it in the snapshot.

**Severity:** MED. Daily runs absorb at most ~4 PT days; well under 200 pages at any plausible tweet velocity. The full-backfill path is the actual hazard, and that path runs at most once per user (or after any data-loss event).

---

### [MED] No tz-consistency check between producer (Action) and consumer (runtime)

**Where:** the JSON contract (`apps/web/src/data/x-days.json`) and `apps/web/src/lib/twitter.ts:64–66`.

The worker's deviation **X-001** keeps `tz` in the `FetchTwitterOpts` signature but admits it's unused at read time. The bundled JSON has no `tz` field — only `generated_at`, `user_id`, `handle`, `days`. The Action defaults to `NERV_TZ=America/Los_Angeles` (script line 82) but the workflow does NOT set it explicitly (per the worker report).

So: if a fresh-clone deployer sets `NERV_TZ=America/New_York` on Vercel and also sets the same in the GH Action, the system is consistent. If they set it on *only one side*, dates drift by up to a day depending on UTC offset and DST.

Failure surface: snapshot.ts computes `today = dateKey(now, "America/New_York")` and asks for `[from, to]` in NY. The JSON is keyed in LA. `combineDays` does **not** throw (lengths still match, dates are still `YYYY-MM-DD` strings) — but the LA-bucketed "2026-05-29" tweet is treated as NY's "2026-05-29", which off-by-one for any tweet posted near the day boundary.

Worse: `combineDays` will throw on date mismatch only if the GH series and Twitter series have *different* date strings. Both come out of `fillMissingDays(from, to)`, which is purely a string range. So the dates *align lexicographically* even though they refer to different real-world days. **The schema can't detect the drift.** It's a quiet semantic error.

**Suggested guard:** stamp `bucketed_tz: "America/Los_Angeles"` into the JSON in the refresh script. At read time in `twitter.ts`, if `file.bucketed_tz !== opts.tz`, throw `TwitterFeedOfflineError([{host:"bundled-json", reason:"tz mismatch: file=LA, runtime=NY"}])`. Two lines on each side.

**Severity:** MED. The default-tz path is fine. Anyone who deliberately changes `NERV_TZ` may not realize the JSON was bucketed in a different tz. The brief specifically listed this as a probe (#6) — calling it out per request.

---

### [LOW] Handle change doesn't reset `days[]` → mixed-user data

**Where:** `scripts/refresh-x-days.ts:184–191` (`resolveUserId`) and `scripts/refresh-x-days.ts:255–284` (`mergeCounts`).

`resolveUserId` re-resolves the API user_id when `existing.handle !== HANDLE`. Good. But `decideSince` and `mergeCounts` then keep using `existing.days` — which was *alice's* data — as the base for the merge. The query then fetches *bob's* tweets and merges them into alice's days[]. Result: an alice/bob hybrid in `days[]`, with alice's older days untouched (per the "never decrement outside overlap" rule).

**Fix:** if `existing.handle !== HANDLE`, force `fullBackfill = true` (and ideally reset `existing.days = []`).

**Severity:** LOW. Self-inflicted footgun, not a happy-path bug. The PLAN treats this as a single-user dashboard.

---

### [LOW] `user_id` is resolved, cached, and never used in the search query

**Where:** `scripts/refresh-x-days.ts:177–191` (resolves), `scripts/refresh-x-days.ts:213` (search query uses `from:${HANDLE}`, not user_id).

The query is `from:<handle> since:<date>`. `user_id` is recorded in the JSON header but never sent to the search endpoint. The user-lookup call is functionally a no-op other than letting the JSON header carry an ID.

If a handle is ever transferred between users on X (handles get recycled), the search will follow the *current* owner of the handle rather than the cached user_id. Worth knowing.

**Severity:** LOW / NIT. Hardening, not correctness.

---

### [LOW] Validator regex allows impossible dates (e.g., `9999-99-99`)

**Where:** `apps/web/src/lib/twitter.ts:88` — `/^\d{4}-\d{2}-\d{2}$/.test(d)`.

The regex accepts 99 as a month and 99 as a day. Combined with the `if (d < from || d > to) continue;` window check, the only damage is a row that survives validation but lexicographically falls outside the window → dropped. If `from <= "9999-99-99" <= to` (i.e., the window includes year 9999), it'd survive — not realistic.

The producer's `isValidDayList` (script:115–124) has the same regex; same observation.

**Severity:** NIT. No realistic exploit path; logged for completeness.

---

## Probes asked about — explicit answers

### Probe 1 — Contract preservation

**Verdict: ✓ correct.** `fetchTwitterDays` returns `fillMissingDays(rows, from, to)`. `fillMissingDays` (streak.ts:135) guarantees:
- ascending order (cursor walks from `from` forward),
- contiguous days (`addDays(cursor, 1)` each step, break only on `cursor === to`),
- `YYYY-MM-DD` format (composed by `addDays` from UTC math, fixed-width pad).

Both `fetchTwitterDays` and `fetchGithubDays` call the **same** `fillMissingDays` with the **same** `from` and `to` (from snapshot.ts:64). Therefore `a.length === b.length` and `a[i].date === b[i].date` for every i. `combineDays` will not throw.

### Probe 2 — `dateKey` byte-equivalence

**Verdict: ✓ byte-identical.** Diff:

| streak.ts (lines 116–124) | refresh-x-days.ts (lines 95–102) |
|---|---|
| `new Intl.DateTimeFormat("en-CA", {` | `new Intl.DateTimeFormat("en-CA", {` |
| `  timeZone: tz,`                    | `  timeZone: TZ,` |
| `  year: "numeric",`                 | `  year: "numeric",` |
| `  month: "2-digit",`                | `  month: "2-digit",` |
| `  day: "2-digit",`                  | `  day: "2-digit",` |
| `}).format(d);`                      | `}).format(d);` |

Identical `Intl` options, same locale, same `format(d)` call. Output bytes identical.

`addDays` / `addDaysISO` are also identical:

| streak.ts:128–134 | refresh-x-days.ts:104–109 |
|---|---|
| split → number → UTC ms → Date → UTC parts | split → number → UTC ms → Date → UTC parts |

Same UTC math, same padding. No drift.

### Probe 3 — Merge semantics

| Adversarial scenario | Expected | Actual | Status |
|---|---|---|---|
| Existing day=5, fresh=0 (deleted tweet) *inside overlap* | 0 (replace) | overlap-delete fires (date ≥ since), fresh has no entry, fillMissingDays zero-fills at read time → 0 | ✓ correct |
| Existing day=5, fresh=0 (deleted tweet) *outside overlap* | 5 (never decrement) | overlap-delete skipped, fresh has no entry → existing 5 retained | ✓ correct |
| Existing day=0 (gap), fresh=3 *inside overlap* | 3 | overlap-delete skipped (no key), fresh sets 3 | ✓ correct |
| Day in re-pull window split across pagination | depends — see [MED]#3 (MAX_PAGES) | partial count silently written | ✗ see MAX_PAGES finding |
| **Existing day-before-since=4, fresh contains it with partial count=2** | **4 (outside overlap, never decrement)** | **2 (fresh overwrites unconditionally — see [HIGH])** | **✗ HIGH bug** |
| maxDate = today (>7d gap impossible if cron healthy) | overlap covers today−2 → today | works | ✓ |
| maxDate = yesterday | overlap = [yesterday−2, today] | works | ✓ |
| maxDate = >7d old | overlap = [maxDate−2, today], 9+ days | works (fits in MAX_PAGES unless very heavy poster) | ✓ |

### Probe 4 — Pagination termination

| Failure mode | Outcome | Status |
|---|---|---|
| `next_cursor` non-null, identical to previous | `if (nextCursor === cursor) break;` (line 235) — logged | ✓ |
| `next_cursor` non-null, tweets empty | `if (newOnPage === 0) break;` (line 239) — logged | ✓ |
| `next_cursor` `""` (empty string) | falsy → `if (!nextCursor) break;` (line 233) | ✓ |
| `MAX_PAGES=200` hit | top-of-loop guard exits, **no log**, no error, partial map returned | ✗ see [MED] silent truncation |
| Cursor contains `+ / =` chars | `URLSearchParams.set("cursor", cursor).toString()` URL-encodes to `%2B %2F %3D`; server decodes back | ✓ |
| `MAX_PAGES` documented? | Constant + comment at line 60 (`// hard guard against infinite-cursor bugs`); value not surfaced in env or JSON | partial — see [MED] |

### Probe 5 — Validator behavior

| Input | `twitter.ts` validator behavior |
|---|---|
| `{date:"2026-05-29"}` (no count) | `typeof c !== "number"` → skipped silently |
| `{date:"2026-5-9", count:1}` (single-digit) | regex rejects → skipped silently |
| `{date:"2026-05-29", count:"5"}` (string count) | `typeof c !== "number"` → skipped silently |
| date outside `[from, to]` | dropped silently — matches the documented contract |
| `Array.isArray(rawDays) === false` | `throw TwitterFeedOfflineError` |
| `rawDays.length === 0` | `throw TwitterFeedOfflineError` |
| **all rows malformed but `rawDays.length > 0`** | **no throw, returns all-zero Day[] — see [MED]** |

### Probe 6 — `tz now unused` (X-001)

**Verdict: latent hazard.** Read-side ignores `tz`. The JSON does not record what tz it was bucketed in. If the runtime's `NERV_TZ` differs from the producer's, dates are off by one near the day boundary. The system cannot self-detect — `combineDays` only checks lexicographic equality, not semantic alignment.

This is correctly captured as **X-001** in the worker's implementation notes. The mitigation (stamp `bucketed_tz` into the JSON and validate at read time) is small and recommended; see [MED] above. Not BLOCKER because the default tz on both sides is the same.

---

## Correct things (briefly, for completeness)

- Public surface preserved: `fetchTwitterDays`, `TwitterFeedOfflineError`, `FetchTwitterOpts`. Verified by reading `twitter.ts:36, 47, 62` against the scout's expected signature.
- The `TwitterFeedOfflineError` constructor message changed but the `name` property still equals `"TwitterFeedOfflineError"`, so `err instanceof TwitterFeedOfflineError` at `snapshot.ts:135` still triggers correctly.
- Empty-`X_LOGIN` short-circuit at `snapshot.ts:126` still fires before reaching `fetchTwitterDays` — confirms no regression on the "no env" path.
- `revalidate` param kept on `FetchTwitterOpts` even though unused — no caller pain.
- Seed JSON (`x-days.json`) shape (`{generated_at, user_id, handle, days:[]}`) matches both the consumer's tolerant validator and the producer's `loadData` parser; the empty `days[]` correctly trips the `TwitterFeedOfflineError` first-deploy path.
- `pagination loop`'s `seenIds` dedupe correctly handles socialdata returning duplicate tweets across pages (script lines 219–222) — no double-counting.

---

## Recommended next moves

1. **Fix the [HIGH] before the first cron run lands real data.** One-line patch in `mergeCounts`: guard the fresh-write loop with `if (date >= since) merged.set(date, count);` (or symmetrically drop tweets older than `since` at bucket time).
2. **Address the [MED] silent failures.** Pick at least one of: MAX_PAGES surfacing, all-rows-malformed throw, bucketed-tz stamp. None are blockers individually; together they remove most "data is bad and I can't tell" failure modes.
3. **LOWs are deferrable** — track as followups in the implementation notes (the worker already has `L-016` for staleness; add similar entries).

---

If the [HIGH] is fixed and the [MED]s are at least logged into the implementation notes, the migration is mergeable. The contract preservation, `dateKey` byte-equivalence, pagination termination, and validator-throw-vs-return paths are all correct as-is.

— Reviewer note: the only [HIGH] is mechanically subtle but mechanically certain; happy to walk through the boundary-day arithmetic again if useful.
