# Worker: socialdata migration — review fixes F1–F10

> Applied all ten fixes from the brief. One small deviation on F7 (added `--autostash`) for it to actually work in the race scenario; details below. All seven validation steps green.

---

## Files changed

| File | Fixes | Notes |
|---|---|---|
| `scripts/refresh-x-days.ts` | F1, F2, F3, F4, F5, F8, F10 | ~140 LOC added net. Adds `sleep`, restructures `apiGet` to a retry loop with envelope sniffing, adds first-page `tweets`-required check + post-loop truncation check, adds `bucketed_tz` to `DataFile` + `loadData` + the written payload, atomic temp-then-rename in `saveData`, no-op-write skip in `main()`, shrink guard in `main()`, F1 guard in `mergeCounts`. Raised `MAX_PAGES` 200 → 500. |
| `apps/web/src/lib/twitter.ts` | F9, F10 | `bucketed_tz` validation block (mismatch → throw, absent → one-time stderr warn). Split shape-valid from window-filtered row counting; throw `TwitterFeedOfflineError` when every entry fails shape validation. |
| `apps/web/src/data/x-days.json` | F10 | Seed now carries `"bucketed_tz": "America/Los_Angeles"`. |
| `.github/workflows/refresh-x-days.yml` | F6, F7 | SHA-pinned `pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda  # v3.0.0`. Added `git pull --rebase --autostash origin "${GITHUB_REF_NAME}"` between `git add` and `git commit`. |
| `implementation-notes/2026-05-29-socialdata-migration.html` | docs | Added "Review Fixes (post-merge)" section with D-037..D-046 entries (one per fix, reviewer cited). Added "Deferred LOW/NIT followups" section with L-019..L-027 entries from the three reviewers. |

---

## Fix-by-fix landing notes

- **F1 [HIGH] — `mergeCounts` boundary corruption.** Guarded the fresh-copy loop with `if (fullBackfill || date >= since) merged.set(date, count)`. Full-backfill path is exempt from the guard because the post-clear merge needs to seed every fresh entry regardless of date. Comment explains the boundary rationale.

- **F2 [BLOCKER] — silent data loss on 200 + missing `tweets`.** Three layers:
  - `apiGet` reads body as text, parses, and throws on `{status:"error"}` / `{error:…}` envelopes before returning.
  - `fetchTweetDayCounts` throws on the first page when `body.tweets === undefined` (distinguishing "field absent" from "empty array").
  - `main()` refuses to write when `!fullBackfill && mergedDays.length < existing.days.length`. Verified the first-backfill case is exempted (fullBackfill = true on empty seed) — escalation note in the brief confirmed this is intended.

- **F3 [HIGH] — retry-with-backoff.** `apiGet` now runs up to 4 attempts. 429 honors `Retry-After`-seconds when present, else 1s/4s/16s exponential. 5xx uses 1s/4s/16s. Network-level fetch throws also retry on the same backoff schedule. 4xx (non-429) throws immediately. Each retry logs status + wait time to stderr. The 4th failure throws with attempt count in the message.

- **F4 [HIGH] — silent `MAX_PAGES` truncation.** Pagination loop now tracks `lastBodyNextCursor` and `stoppedAtEnd`. Post-loop, if `!stoppedAtEnd && lastBodyNextCursor`, throws "hit MAX_PAGES=500 but next_cursor still present — dataset is truncated. Increase MAX_PAGES or split the backfill window." Raised cap to 500 per brief.

- **F5 [MED] — no-op-write skip.** Computes `daysSame` (sorted JSON.stringify equality), `idSame`, `handleSame`, `tzSame`. If all four hold, logs "no data changes — skipping write" and exits 0 without rewriting `generated_at`. On any change, `generated_at = now` and full write proceeds. Spot-checked the skip path manually against the seed JSON: all four checks return `true`, `willSkip: true` (see Validation step 5 below).

- **F6 [MED] — SHA-pin third-party action.** `pnpm/action-setup@v3` → `pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda  # v3.0.0`. `actions/checkout@v4` and `actions/setup-node@v4` intentionally left as major-tag pins per brief.

- **F7 [MED] — schedule-after-dispatch race.** Added `git pull --rebase --autostash origin "${GITHUB_REF_NAME}"` between `git add` and `git commit`.
  - **Deviation:** brief specified plain `git pull --rebase`. Without `--autostash`, the rebase runs with a staged-but-uncommitted `x-days.json` in the index; if `origin/<branch>` has advanced (the exact race the fix targets), `git pull --rebase` would refuse with "cannot pull with rebase: You have unstaged/staged changes." `--autostash` stashes the staged file, performs the rebase/FF, then re-applies the stash on top — which is precisely the "replay our result on a newer base" semantics the brief described. Behavioral intent preserved; mechanism slightly more robust. Flagged as D-043 in the implementation-notes HTML.

- **F8 [MED] — atomic write.** `saveData` writes to `DATA_PATH + ".tmp"` then `rename()`s. Added `rename` to the `node:fs/promises` import.

- **F9 [MED] — all-malformed-rows offline detection.** `twitter.ts` now counts shape-valid rows separately from window-filtered rows. If `rawDays.length > 0 && shapeOk === 0`, throws `TwitterFeedOfflineError([{host:"bundled-json", reason:"all days[] entries failed shape validation"}])`. The empty-`rawDays` first-deploy throw is preserved as a distinct earlier branch.

- **F10 [MED] — TZ consistency.** Producer stamps `bucketed_tz: TZ` into every written payload. Seed JSON updated. Consumer reads `file.bucketed_tz`: present + mismatch → `TwitterFeedOfflineError` with reason `"tz mismatch: file=…, runtime=…"`; absent → one-time stderr warning gated by a module-level boolean (so the warning fires at most once per process, not per request).

---

## Validation — all seven steps green

| # | Step | Result |
|---|---|---|
| 1 | `pnpm install` | `Already up to date`. Lockfile didn't move. |
| 2 | `pnpm --filter web typecheck` | OK, no errors. |
| 3 | `pnpm --filter web build` | OK. Static prerender succeeds; build-time logs still show the expected `[snapshot] Twitter feed offline; attempts=[{"host":"bundled-json","reason":"x-days.json has empty days[] — GH Action has not run yet"}]` — empty seed → `TwitterFeedOfflineError` → snapshot degrades → panel hidden. Identical no-data-state behavior to pre-fix. |
| 4 | `SOCIALDATA_API_KEY="" pnpm tsx scripts/refresh-x-days.ts` | Exits **2** with `FATAL: SOCIALDATA_API_KEY is required`. Env-validation path unchanged. |
| 5 | Ad-hoc no-op-write spot check (replayed F5's compare against the seed JSON with empty fresh + fullBackfill=true) | `{ daysSame: true, idSame: true, handleSame: true, tzSame: true, willSkip: true, mergedLen: 0 }`. Skip path confirmed. (The scratch script was deleted; not committed.) |
| 6 | `grep -n "merged.set(date, count)" scripts/refresh-x-days.ts` | Matches at the F1-guarded site inside the `if (fullBackfill \|\| date >= since)` branch. No bare unconditional call. |
| 7 | `git status` | Expected set present: `M apps/web/src/lib/twitter.ts`, `?? apps/web/src/data/` (seed), `?? .github/` (workflow), `?? scripts/` (refresh script), `?? implementation-notes/2026-05-29-socialdata-migration.html`. (The other modifications shown are from the prior worker's session, not regressions from this pass.) |

Bonus: re-ran the prior worker's regression greps —
- `grep -rn "nitter\|Nitter\|NITTER\|xcancel" apps/web/src scripts .github .env.example README.md PLAN.md` → no matches.
- `grep -rn "X_NITTER_HOST\|X_DATA_URL" apps/web/src .env.example README.md PLAN.md` → no matches.

---

## Deviations / open notes

- **D-1 (F7 ordering / mechanism).** Added `--autostash`. Rationale + intent-preservation argued above; flagged in the HTML log as D-043. If you want strict literal brief execution, drop `--autostash`; the workflow will then fail in the race scenario instead of recovering from it.
- **D-2 (F5 also compares `bucketed_tz`).** Brief listed `days[]`, `user_id`, `handle` as the change-detection inputs. I added `bucketed_tz` to that comparison so legacy JSON files (no `bucketed_tz` field, loaded as `""`) get re-written on the first run after F10 lands to stamp the tz. Otherwise the legacy file would stay unstamped forever and the consumer would keep emitting the one-time legacy warning across deploys. Trivial extension; flagged here for visibility.
- No other deviations. None of the escalation guards in the brief tripped (F1 didn't reveal a deeper bug; F2's shrink-guard does not falsely reject the first backfill; F3's retry loop integrates cleanly with both the user-lookup and search callsites since they share `apiGet`).

---

## Open risks

- The same `GITHUB_TOKEN` push permission question (Q-006) remains unresolved — first scheduled run will surface whether branch protection blocks the unsigned-bot push. Captured as L-024 in the HTML log (escalation plan: PR-based commit / deploy key / GitHub App).
- F7's `--autostash` is the right tool for "git add → pull --rebase → commit" sequencing, but if the worktree somehow ends up with unstaged-not-just-staged changes (shouldn't happen in this workflow, but possible if a future step modifies other files), autostash still works — `--autostash` stashes both staged and unstaged.
- Spot-check #5 is ad-hoc, not a committed test. L-018 in the original notes already flags "no test convention yet"; L-019 (added in this pass) calls for a `dateKey` drift test as the seed of that convention.

---

## Recommended next step

Same as the prior worker: user runs `workflow_dispatch` once after `SOCIALDATA_API_KEY` is in repo secrets. That run will now (a) hit the real retry-with-backoff path if socialdata throttles, (b) refuse to silently truncate if the user has >500 pages of history (won't happen today; flagged for posterity), and (c) write a properly-stamped `bucketed_tz` into the JSON. If `GITHUB_TOKEN` push fails because of branch protection, escalate per L-024.
