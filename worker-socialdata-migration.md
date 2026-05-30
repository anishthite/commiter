# Worker: X data source migration — Nitter ladder → bundled JSON via daily GH Action

> Executed against the scout's spec at `scout-socialdata-migration.md`. All eight validation steps green. No coordination escalations needed; one open question about `GITHUB_TOKEN` push permission deferred to the first scheduled Action run (Q-006).

---

## Files changed

| Action | Path | Notes |
|---|---|---|
| REWRITE | `apps/web/src/lib/twitter.ts` | 311 lines → 99 lines. Deleted Nitter pool, `tryNitterHost`, `fetchHostRss`, `parseRssToDays`, `fetchTwitterDataUrl`, `HOSTS`, `USER_AGENT`, `FETCH_TIMEOUT_MS`, `ParsedRss`. Replaced with `import xDaysData from "../data/x-days.json"` + tolerant validator. Public surface unchanged: `fetchTwitterDays`, `TwitterFeedOfflineError`, `FetchTwitterOpts`. |
| EDIT | `apps/web/src/lib/snapshot.ts` | One change: extended the empty-`X_LOGIN` warn message to mention the new bundled-JSON architecture. |
| EDIT | `apps/web/src/app/page.tsx` | Rewrote the `xOffline` env-hint copy: `X_DATA_URL` / `X_NITTER_HOST` → `X_LOGIN` + `refresh-x-days` action + `SOCIALDATA_API_KEY` + bundled JSON path. |
| REWRITE | `.env.example` | Dropped `X_NITTER_HOST` block and `X_DATA_URL` block. Kept `X_LOGIN`. Added a new `SOCIALDATA_API_KEY` section flagged as GH-Action-only (not for `.env.local`). |
| DELETE | `docs/SELF_HOST_NITTER.md` | `git rm`. Entire `docs/` dir now empty and removed. |
| EDIT | `README.md` | Quickstart copy, "How it works" Twitter paragraph, Deploy section, status table row — all rewritten to the new architecture. Tradeoff (data freshness ↔ deploy cycle) called out honestly. |
| EDIT | `PLAN.md` | Architecture diagram, §3 (Sources / X), §5 (files), §7 (followups) all updated. Out-of-scope L-001/L-003 reworded. Reference to removed scout doc rephrased. |
| NEW | `apps/web/src/data/x-days.json` | Seed: `{ "generated_at": "1970-01-01T00:00:00.000Z", "user_id": "", "handle": "anishthite", "days": [] }`. |
| NEW | `scripts/refresh-x-days.ts` | ~300 LOC. Node 20 built-in `fetch`. Resolves `user_id`, paginates `from:<handle> since:<date>`, buckets each tweet in `NERV_TZ` via the same `Intl.DateTimeFormat("en-CA", ...)` call as `streak.ts:dateKey()`, merges with 2-day overlap-replace + never-decrement-outside-overlap, writes sorted JSON with trailing newline. Exit codes 0 / 1 (API) / 2 (validation/IO). |
| NEW | `.github/workflows/refresh-x-days.yml` | `cron: "0 9 * * *"` + `workflow_dispatch`. `contents: write` top-level, concurrency group, `actions/checkout@v4`, `pnpm/action-setup@v3`, `actions/setup-node@v4` with `cache: pnpm`, `pnpm install --frozen-lockfile`, `pnpm tsx scripts/refresh-x-days.ts` (env: `SOCIALDATA_API_KEY` from secrets, `X_LOGIN: anishthite`), commit-if-changed step using the exact shell from the brief. |
| NEW | `implementation-notes/2026-05-29-socialdata-migration.html` | D-029..D-036 decisions, T-017..T-020 tradeoffs, X-001..X-004 deviations, Q-006..Q-008 open questions, L-016..L-018 followups, R-005..R-006 reversibility, validation table. |
| EDIT | `package.json` (root) | Added `tsx: ^4.19.0` to `devDependencies`. pnpm resolved it to 4.22.3. |
| EDIT | `pnpm-lock.yaml` | Auto-updated by `pnpm install`. |

---

## Validation (in the order from the brief)

| # | Step | Result |
|---|---|---|
| 1 | `pnpm install` after adding `tsx` | `+ tsx 4.22.3`. No other diffs. |
| 2 | `pnpm --filter web typecheck` | No errors. (The workspace package is named `web`, not `@nerv/web` — confirmed against `apps/web/package.json:2`.) |
| 3 | `pnpm --filter web lint` | No `lint` script exists in either `package.json`. Skipped (brief said "if a lint script exists"). |
| 4 | `pnpm --filter web build` | Succeeds. Static prerender of `/` and `/api/snapshot`. Build-time logs show `[snapshot] Twitter feed offline; attempts=[{"host":"bundled-json","reason":"x-days.json has empty days[] — GH Action has not run yet"}]` — that's the **correct** path: empty seed JSON → `TwitterFeedOfflineError` → snapshot degrades → page hides X panel, combined mode flips to `or`. Exactly what the brief specified for first-deploy state. |
| 5 | `grep -rn "nitter\|Nitter\|NITTER\|xcancel" apps/web/src docs scripts .github .env.example README.md PLAN.md` | No matches. (Searched `apps/web/src` rather than `apps/web` to avoid the binary `.next/cache` false-positive from a stale build artifact.) |
| 6 | `grep -rn "X_NITTER_HOST\|X_DATA_URL" apps/web/src docs .env.example README.md PLAN.md` | No matches. |
| 7 | Exported surface of `apps/web/src/lib/twitter.ts` | Exactly `{ TwitterFeedOfflineError, FetchTwitterOpts, fetchTwitterDays }`. Verified via `grep -n "^export" apps/web/src/lib/twitter.ts`. |
| 8 | `git status` | Matches expected set: 1 deletion (`docs/SELF_HOST_NITTER.md`), 8 modifications, 4 new dirs (`.github/`, `apps/web/src/data/`, `scripts/`, plus the new HTML file in existing `implementation-notes/`). |

Additional checks I ran on top of the brief:
- Standalone `tsc` on `scripts/refresh-x-days.ts` (with `@types/node` from `apps/web`'s installation) — zero errors after switching `die` from arrow form to function declaration so TS's never-narrowing fires for downstream bindings (deviation X-002).
- `SOCIALDATA_API_KEY="" pnpm tsx scripts/refresh-x-days.ts` — exits 2 with `SOCIALDATA_API_KEY is required`. Env-validation path verified end-to-end without hitting the network.

---

## Key decisions (full log: `implementation-notes/2026-05-29-socialdata-migration.html`)

- **D-029** Delete Nitter pool + `X_NITTER_HOST` entirely; the new architecture has zero runtime network calls so "defense in depth" became net-negative dead code.
- **D-030** `import` the JSON (not `fs.readFile`, not `fetch`). `tsconfig.base.json` already has `resolveJsonModule: true`. The data IS the deploy — atomic versioning.
- **D-031** Treat empty `days[]` as offline → throw `TwitterFeedOfflineError`. First-deploy state degrades correctly through the existing catch path.
- **D-032** Preserve the exported surface signature-identical; `tz` param now unused at read time but kept for byte-identical call site.
- **D-033** `tsx` at workspace root, not per-package. The script is workspace glue.
- **D-034** Incremental refresh with 2-day overlap-replace; never decrement outside overlap. Bundled JSON is the cumulative source of truth, API is not.
- **D-035** Refresh script's `dateKey()` is a byte-identical copy of `streak.ts:dateKey()` — TZ boundary is the most fragile invariant in the system; copy-paste is intentional to keep the script self-contained.
- **D-036** Daily cron at 09:00 UTC (≈01:00–02:00 PT). Default `GITHUB_TOKEN` for the push, not a PAT.

---

## Deviations from the brief

- **X-001** Did NOT delete the `tz` param from `FetchTwitterOpts`. Brief says "Same signatures" wins over "now unused".
- **X-002** Refresh script uses `function die(): never { ... }` rather than `const die = (): never => { ... }`. Arrow form didn't trigger TS narrowing; function declaration does. No behavioral change.
- **X-003** Page env-hint copy is more explicit than the brief required — names `refresh-x-days` action and `SOCIALDATA_API_KEY` in GH Secrets so a fresh-clone reader can wire it without reading the README.
- **X-004** Scrubbed the lingering "Nitter" word from `twitter.ts` module comment and from `PLAN.md`'s historical note. Brief's validation step 5 phrasing was ambiguous on these (comments + PLAN.md aren't strictly "code"), and the implementation-notes carve-out only mentioned HTML files. Erred on the side of a clean grep.

---

## Open risks / questions (also Q-006..Q-008 in the HTML log)

- **Q-006 — `GITHUB_TOKEN` push permission.** Brief says default token with `contents: write` should work. Not testable from this session; first scheduled run on `main` will surface it. If branch protection requires signed/verified commits or status checks, will need to swap to a PAT or GitHub App. Brief authorized escalation for this case but it's not blocking now.
- **Q-007 — socialdata rate limits / cost.** Full backfill paginates up to `MAX_PAGES = 200`. First real run could be expensive. Worth verifying after the user runs it.
- **Q-008 — `since:` boundary semantics.** Treating inclusive in the merge logic; the 2-day overlap absorbs any off-by-one.
- **T-018 — silent staleness if `SOCIALDATA_API_KEY` lapses.** Action no-ops, JSON ages, dashboard renders stale data with no warning. Tracked as L-016 (data-age detection followup).

---

## Recommended next step

User runs the workflow manually once (`workflow_dispatch`) after adding `SOCIALDATA_API_KEY` to GitHub repo secrets. That single run:

1. Validates Q-006 (push permission).
2. Performs the initial backfill from `2024-01-01` (or wherever `BACKFILL_SINCE` ends up).
3. Surfaces socialdata's actual rate/quota behavior (Q-007).
4. Triggers the first Vercel rebuild with real data, at which point the X panel un-hides on the live dashboard.

If step 1 fails (branch-protection refuses the default-token push), escalate then with the concrete error and decide between PAT / deploy key / GitHub App.
