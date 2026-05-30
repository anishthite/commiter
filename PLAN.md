# NERV OS — Shipping Tracker

> _"Patterns blue and orange. Synchronization holding."_

A two-panel MAGI dashboard that tracks daily "did I ship?" output on GitHub and on X. Heatmaps, streaks, NERV chrome. Single Vercel deploy, no database, no second machine.

---

## §1. Mission

Make falling off the wagon visible enough that I don't.

- One screen, two panels (MAGI-01 GitHub, MAGI-02 X).
- 53×7 contribution heatmap per panel.
- Current streak, longest streak, today count per panel.
- All data lives upstream — GitHub + X — and we pull from them on demand.
- Time zone: `America/Los_Angeles` (configurable via `NERV_TZ`).

Out of scope (deferred):

- Push / SMS / OS-level nudges (see Followups L-002).
- Manual `/api/ship` fallback for when the X data file is stale (L-001).
- Real-time X refresh (currently bounded by the daily GH Action; L-003).

---

## §2. Architecture — stateless, Vercel-only

```
┌──── ON VERCEL ────────────────────────────────────────────────┐
│                                                                │
│   Next.js 14 App Router                                        │
│     ▸ GET /                                                    │
│         page.tsx                                               │
│           getSnapshot(365)                                     │
│             ├ fetchGithubDays    next:{revalidate:3600}        │
│             └ fetchTwitterDays   import "./data/x-days.json"   │
│           computeStreak × 2 + combineDays                      │
│           render <MagiPanel/> × 2                              │
│                                                                │
│     ▸ GET /api/snapshot?days=N                                 │
│         same plumbing, returned as JSON                        │
│         cache-control: public, s-maxage=3600, swr=600          │
│                                                                │
│   No DB. No cron. No Mac. No pi-chrome.                        │
└────────────────────────────────────────────────────────────────┘
```

One upstream fetch (GitHub GraphQL) cached at the Next.js fetch layer for 1 hour; X day-counts are imported from a bundled JSON file refreshed daily by `.github/workflows/refresh-x-days.yml`. Streak math runs in-memory each SSR. The page itself is ISR (`export const revalidate = 3600`) so static visitors hit a CDN edge cache and rehydrate at most once per hour.

> Supersedes 2026-05-23 plan (Mac ingestor + Turso + pi-chrome). See `implementation-notes/2026-05-28-stateless-refactor.html` for the decision log.

---

## §3. Sources

### GitHub — GraphQL `contributionsCollection`

- Endpoint: `POST https://api.github.com/graphql`
- Auth: PAT with `read:user` (private contribs included).
- Window: 365 days, calendar-aligned to PT. We send an ISO window with a 1-day leading/trailing buffer (so PT midnights are fully covered), then trim back to the displayed `[from, to]` PT range in-memory.
- Cache: `next: { revalidate: 3600 }`.
- Cost: 1 GraphQL call per cache miss. GitHub limits = 5000/hr per token — irrelevant at this volume.

### X / Twitter — bundled JSON, refreshed daily by GitHub Action

- Render path: `apps/web/src/lib/twitter.ts` does `import xDaysData from "../data/x-days.json"`. No network at request time.
- Refresh path: `.github/workflows/refresh-x-days.yml` runs nightly (`cron: "0 9 * * *"` ≈ 01:00–02:00 PT), invokes `pnpm tsx scripts/refresh-x-days.ts`, and commits the new counts back to `main`. Vercel rebuild ships the new data.
- Refresh script: looks up the numeric `user_id` from `https://api.socialdata.tools/twitter/user/{handle}` (cached in the JSON), then paginates `GET /twitter/search?query=from:<handle>%20since:<date>&type=Latest`. Each tweet's `tweet_created_at` is bucketed via `Intl.DateTimeFormat("en-CA", { timeZone: NERV_TZ })` — matches `dateKey()` in `streak.ts` exactly. Incremental runs re-pull the last 2 days to absorb late-arriving tweets; older days are never decremented.
- Auth: `SOCIALDATA_API_KEY` in GitHub repo secrets. Runtime app never reads it.
- Failure: malformed/empty JSON → `TwitterFeedOfflineError` → panel hidden, combined streak drops to OR mode and reports GitHub only.
- **Tradeoff:** data freshness is bounded by the daily Action + Vercel deploy. Today's tweets show up tomorrow. Re-run the workflow with `workflow_dispatch` for an ad-hoc refresh.

The earlier live-scrape approaches (now removed) were blocked from Vercel egress IPs or returned stale curated data. See `implementation-notes/2026-05-29-socialdata-migration.html` for the decision log.

---

## §4. Streak rules

- A day "ships" when `count >= 1`.
- Day keys are `YYYY-MM-DD` in `NERV_TZ` (default `America/Los_Angeles`).
- Per-channel:
  - `current` — walks backward from today across consecutive ship days. Today not yet shipped breaks the streak (no grace period).
  - `longest` — single pass over the visible window.
- Combined (`combined.mode = "and"`): a day counts only if **both** channels shipped.
- All math lives in `apps/web/src/lib/streak.ts` (pure, zero I/O).

---

## §5. Files

```
apps/web/
├── next.config.mjs         # tiny — reactStrictMode only
├── package.json            # next, react, tailwind. no libsql, no workspace deps
├── postcss.config.js
├── tailwind.config.ts      # NERV palette
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx        # SSR; export const revalidate = 3600
    │   ├── globals.css     # CRT scanlines, palette
    │   └── api/
    │       └── snapshot/
    │           └── route.ts  # GET /api/snapshot?days=N
    └── lib/
        ├── streak.ts       # pure math + tz helpers
        ├── github.ts       # GraphQL fetch + buffer/trim
        ├── twitter.ts      # reads bundled apps/web/src/data/x-days.json
        ├── snapshot.ts     # composes everything; returns wire shape
        ├── heatmap.ts      # toWeeksGrid, intensity
        └── nerv/
            ├── MagiPanel.tsx
            └── Heatmap.tsx
```

No `packages/`. Single-app workspace.

---

## §6. Environment variables

| Var | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN` | **yes** | PAT with `read:user`. Private contribs require it. |
| `GITHUB_LOGIN` | optional | Defaults to `anishthite`. |
| `X_LOGIN` | optional | Handle without `@`. If unset, X panel renders empty. |
| `NERV_TZ` | optional | IANA tz. Defaults to `America/Los_Angeles`. |
| `NERV_PILOT_TOKEN` | optional | Reserved for future cookie-gated dashboard auth. |

Set in `apps/web/.env.local` for dev. Set as Vercel project env vars for prod.

---

## §7. Followups (deferred, not part of v0)

- **L-001** — Manual ship fallback: `POST /api/ship` + an in-dashboard button. Useful when you want to mark "yes I posted" without waiting for the next daily refresh to ship.
- **L-002** — Nudge mechanism: Vercel Cron at e.g. 18:00 + 23:00 PT hitting an `/api/nudge` route that pings Pushover / Resend / a Slack webhook when today is empty.
- **L-003** — Sub-daily X freshness: run the refresh workflow on a tighter cron, or move the fetch into a Vercel Cron route that writes to KV. Pure additive change.
- **L-004** — Build-time prerender wart: page is statically generated at build time with whatever data the build environment can reach. If `GITHUB_TOKEN` isn't set during the Vercel build, the SYS:FAULT branch gets baked in for up to an hour after deploy. Mitigations: set env at build, or flip `page.tsx` back to `force-dynamic` (fetch caching still works).

---

_Plan supersedes the 2026-05-23 Turso/pi-chrome architecture. Decision log: `implementation-notes/2026-05-28-stateless-refactor.html`._
