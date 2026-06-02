# Shipping Tracker

A two-panel dashboard tracking GitHub commits and X posts with heatmaps and streaks. One Next.js app on Vercel. No database.

Spec: [`PLAN.md`](./PLAN.md) · Decisions: [`implementation-notes/`](./implementation-notes)

---

## Quickstart

```bash
pnpm install
cp .env.example apps/web/.env.local
pnpm dev   # http://localhost:3000
```

Set in `apps/web/.env.local`:

- `GITHUB_TOKEN` — PAT with `read:user`
- `GITHUB_LOGIN` — your GitHub handle
- `X_LOGIN` — *(optional)* your X handle, no `@`. Omit to hide the X panel; the GitHub panel takes the full row.

The X panel reads from `apps/web/src/data/x-days.json`, refreshed daily by GitHub Action. The repo ships with an empty file — GitHub-only deploys work out of the box.

## How it works

On each SSR cache miss (~1h), the page pulls:

- **GitHub** — GraphQL `contributionsCollection` (365-day calendar, includes private contribs with `read:user`).
- **X / Twitter** — reads `apps/web/src/data/x-days.json`. A daily Action (`.github/workflows/refresh-x-days.yml`) hits [socialdata.tools](https://socialdata.tools), buckets tweets by `NERV_TZ` day, merges, and commits — triggering a Vercel rebuild. The runtime never touches an X API. Malformed or empty JSON hides the panel cleanly.

  **Freshness tradeoff:** bounded by the daily Action + deploy cycle. Today's tweets land in tomorrow's snapshot. Fine for a "did I ship today?" tracker; run `workflow_dispatch` for sub-hour latency.

Streak math runs in-memory, server-rendered. The snapshot is also served at `GET /api/snapshot?days=N` (`s-maxage=3600`, SWR 10min).

## Layout

```
apps/web/              Next.js dashboard (Vercel target)
  src/app/             page.tsx + /api/snapshot route
  src/lib/             streak.ts · github.ts · twitter.ts · snapshot.ts · heatmap.ts
  src/lib/nerv/        Panel + Heatmap components
implementation-notes/  Decision log per task
PLAN.md                Master spec
```

## Deploy

Push to a Vercel project.

**Required:** `GITHUB_TOKEN`, `GITHUB_LOGIN`
**Optional:** `X_LOGIN` (enables Twitter panel), `NERV_TZ` (default `America/Los_Angeles`)
**GitHub Actions secret:** `SOCIALDATA_API_KEY` (workflow-only; runtime never sees it)

## Status

| Item | State |
|---|---|
| GitHub heatmap + streak | done |
| X / Twitter heatmap + streak | done |
| Nudge mechanism (Cron + push/email) | deferred |
| Manual `/api/ship` fallback | deferred |
| Upstash KV for long-term X history | deferred |
