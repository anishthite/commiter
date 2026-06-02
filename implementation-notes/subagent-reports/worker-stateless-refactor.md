# Worker report — stateless refactor

Status: **implemented**. All validation contract items pass except item 7 (full live snapshot with a valid `GITHUB_TOKEN`) which requires a real token the worker sandbox doesn't have — the underlying pipeline was verified by separate probes.

---

## TL;DR

- Dropped `packages/ingest/` entirely, dropped Turso/libSQL, dropped pi-chrome plans.
- Next.js app fetches GitHub GraphQL + Nitter RSS directly per SSR, cached 1h.
- 5 new lib files (`streak.ts`, `github.ts`, `twitter.ts`, `snapshot.ts`, + zero new deps), 9 modified files, 2 deletes (`packages/`, `snapshot-server.ts`), 2 doc rewrites (PLAN, README).
- Wire shape preserved exactly — `MagiPanel` / `Heatmap` consume the same `Snapshot` / `ChannelSnapshot` / `Day` types with only a one-line import change each.
- Twitter primary host **`xcancel.com` empirically returns valid RSS** for the configured handle. Two fallback hosts currently hit Cloudflare/bot challenges; the fallback chain correctly rejects them via content sanity check.

---

## Files touched

| Action | Path | Notes |
|---|---|---|
| NEW | `apps/web/src/lib/streak.ts` | Verbatim lift from `packages/ingest/src/streak.ts` (165 lines, pure). |
| NEW | `apps/web/src/lib/github.ts` | GraphQL fetcher + ±1d ISO buffer / PT-aligned trim (D-008 / D-011). `next: { revalidate: 3600 }`. |
| NEW | `apps/web/src/lib/twitter.ts` | Nitter RSS fallback chain, regex parse, content sanity check, 10s timeout, `TwitterFeedOfflineError` sentinel. Zero deps. |
| NEW | `apps/web/src/lib/snapshot.ts` | Wire shape preserved; combined AND streak preserved (D-009); `fetchTwitterDaysSafe` swallows offline / missing-handle and substitutes zero-filled days. |
| MOD | `apps/web/src/app/page.tsx` | `force-dynamic` → `revalidate = 3600`; error hint copy updated; import swap. |
| MOD | `apps/web/src/app/api/snapshot/route.ts` | `force-dynamic` → `revalidate = 3600`; `cache-control: public, s-maxage=3600, swr=600`; import swap. |
| MOD | `apps/web/src/lib/heatmap.ts` | `ingest/src/streak` → `./streak`. |
| MOD | `apps/web/src/lib/nerv/MagiPanel.tsx` | `ingest/src/snapshot` → `../snapshot`. |
| MOD | `apps/web/src/lib/nerv/Heatmap.tsx` | `ingest/src/streak` → `../streak`. |
| MOD | `apps/web/next.config.mjs` | Gutted from 36 lines to 4 (just `reactStrictMode`). |
| MOD | `apps/web/package.json` | Dropped `"ingest": "workspace:*"`. |
| MOD | `package.json` (root) | Dropped `ingest`, `ingest:github`, `migrate`, `ship` scripts. |
| MOD | `pnpm-workspace.yaml` | Removed `"packages/*"`. |
| MOD | `.env.example` | Added `X_LOGIN`; removed `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ANTHROPIC_API_KEY`. |
| MOD | `PLAN.md` | Full rewrite to stateless architecture (~7KB). |
| MOD | `README.md` | New 3-step quickstart, no migrate/ingest commands. |
| MOD | `implementation-notes/2026-05-28-stateless-refactor.html` | Appended worker report section. |
| DEL | `packages/ingest/` | Entire workspace package — bin/, src/, package.json, tsconfig.json. |
| DEL | `apps/web/src/lib/snapshot-server.ts` | Replaced by new `lib/snapshot.ts`. |

No new npm dependencies added; **20 packages removed** from the lockfile.

---

## Validation results

| # | Check | Result |
|---|---|---|
| 1 | `pnpm install` clean | ✅ Done in 1.6s, 20 packages removed. |
| 2 | `pnpm typecheck` | ✅ No errors. |
| 3 | `pnpm --filter web build` | ✅ Next 14.2.35 production build succeeds. Output: `/` static (ISR), `/api/snapshot` dynamic. Build did log `[snapshot] X_LOGIN not set` once during prerender — expected when env isn't injected at build time. |
| 4 | `grep -r "ingest/src" apps/web/src` | ✅ Empty. |
| 5 | `grep -rE "libsql\|@libsql\|drizzle\|TURSO\|DATABASE_URL" apps/web/src apps/web/package.json` | ✅ Empty. |
| 6 | `find packages -type d` | ✅ Directory does not exist. |
| 7 | `pnpm dev` + `curl /api/snapshot?days=30 | jq '.channels | keys'` with real env | ⚠️ **Partial**. Worker has no valid `GITHUB_TOKEN` so the deliberately-fake token caused GitHub to 401. Route correctly returned `{"error":"snapshot_failed"}` HTTP 500 with `[snapshot] error Error: GitHub GraphQL 401` logged server-side; no internals leaked. End-to-end shape verification requires user to run with a real token. |
| 7b | Twitter primary host alive | ✅ Independent probe: `xcancel.com/anishthite/rss` → HTTP 200, `application/rss+xml`, valid `<item>` + `<pubDate>`. |

### Concrete network observations during validation

```
xcancel.com               status=200  ct=application/rss+xml  items=1   pubDate=1   ✅ serves
nitter.privacyredirect.com status=200  ct=text/html           items=0   challenge   ❌ correctly rejected
nitter.poast.org          status=403  ct=text/html           items=0   challenge   ❌ correctly rejected
```

Fallback chain behaves exactly as designed: HTTP 200 alone is not enough; the body must contain `<item>` (RSS) or `<entry>` (Atom). Cloudflare challenge pages fail the sanity check and we proceed to the next host.

---

## Decisions made during implementation (not pre-specified)

- **D-011** — D-008's PT-alignment buffer is implemented inside `github.ts` (extend ISO window ±1 day, trim via `fillMissingDays`). `snapshot.ts` remains tz-clean and works with PT-aligned `[from, to]`.
- **D-012** — Empty `X_LOGIN` is treated as "feed offline" (warn + zero-fill), **not** as a hard error. Lets a fresh-clone repo render the GitHub panel with just GitHub creds. Missing `GITHUB_TOKEN` is still hard-fail because nothing else can render without it.
- **D-013** — RSS content sanity check (`/<item[\s>]/`-or-`/<entry[\s>]/`) added so Cloudflare-served 200 OK HTML pages don't falsely "succeed." Empirically necessary against `nitter.privacyredirect.com`.
- **D-014** — Followed spec literally on `page.tsx` `revalidate` choice. Build-time prerender wart flagged as **L-004** instead of silently picking `force-dynamic`.

All four logged in `implementation-notes/2026-05-28-stateless-refactor.html`.

## Deviations

None. Spec executed as written.

---

## Followups discovered (logged in notes file)

- **L-004** — Build-time prerender wart: if `GITHUB_TOKEN` is unset during the Vercel build, the SYS:FAULT page gets baked in as the ISR baseline for up to 1h post-deploy. Workarounds: set env at build, or flip page back to `force-dynamic` (fetch caching still works). Documented in `PLAN.md` §7.
- **L-005** — Restore longer error guidance message in `fetchGithubDays` when error UX is polished (the old `requireGithubToken` had a richer multi-line hint with scope guidance).
- **L-006** — Nitter RSS gives only the most recent ~20 tweets. The X heatmap will have a sharp "edge" past which all cells are grey by design. Consider a distinct color for "beyond-feed-window" cells, or add the L-003 Upstash rollup to extend history.

---

## Risks / open notes

- **Item 7 only partially validated.** First action when you next sit at the repo with a real `GITHUB_TOKEN`: run `pnpm dev`, hit `http://localhost:3000/api/snapshot?days=365`, confirm `.channels` has `["github","twitter"]` and `.channels.github.days.length === 365`. If anything's off, it's almost certainly the GitHub GraphQL `from/to` window math in `github.ts` — review `fillMissingDays(rows, from, to)` boundary.
- **Build-time ISR prerender (L-004)** is a real deployment foot-gun if env vars aren't set before the first build. If you don't want to manage that, change `page.tsx` line 6 back to `export const dynamic = "force-dynamic";` — the fetch-level cache still gives you 1h GitHub/Nitter caching.
- **Nitter dependency** — `xcancel.com` is currently the only one of the three hosts that's serving cleanly. If it drops, the dashboard's X panel goes empty until either (a) one of the other hosts wakes up, (b) you self-host Nitter, or (c) you switch to the deferred Upstash rollup. The `TwitterFeedOfflineError` path is in place so the GitHub panel keeps working.

---

## Recommended next steps

1. Run `pnpm dev` with a real `GITHUB_TOKEN` and confirm the snapshot round-trips. (Validation item 7.)
2. Commit. The diff is large but mechanically simple — most files are 1-line import changes.
3. Decide on **L-004** (ISR prerender wart). If you'll deploy to Vercel with env vars set at build time, leave as-is. If you might deploy without env, switch `page.tsx` to `force-dynamic`.
4. When ready, lift one of the deferred items: nudge mechanism (L-002) is the next user value win; Upstash KV (L-003) is the next architectural step if X history depth bothers you.
