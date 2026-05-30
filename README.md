# NERV OS — Shipping Tracker

> "PATTERN: BLUE. Daily output confirmed."

Two-panel MAGI-style dashboard that watches GitHub commits + X posts, renders heatmaps and streaks. Single Next.js app on Vercel, no database, no second machine.

Full spec: [`PLAN.md`](./PLAN.md). Decision log: [`implementation-notes/`](./implementation-notes).

---

## Quickstart

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example apps/web/.env.local
#   - GITHUB_TOKEN:  PAT with `read:user`
#   - GITHUB_LOGIN:  your GitHub handle (default: anishthite)
#   - X_LOGIN:       your X / Twitter handle, no leading @
#
#   The X panel reads from a bundled JSON file at
#   apps/web/src/data/x-days.json. The repo ships with an empty
#   file; a daily GitHub Action refreshes it. Without X_LOGIN the
#   X panel is hidden and the GitHub panel fills the row — a valid
#   GitHub-only setup.

# 3. Run
pnpm dev
# → http://localhost:3000
```

That's the whole setup. No migrations, no ingest cron, no second machine.

## How it works

On each cache miss (every ~1 hour) the Next.js SSR pipeline pulls:

- **GitHub** — GraphQL `contributionsCollection` (365-day calendar, private contribs included with `read:user`).
- **X / Twitter** — read from the bundled `apps/web/src/data/x-days.json`. A daily GitHub Action (`.github/workflows/refresh-x-days.yml`) calls [socialdata.tools](https://socialdata.tools), buckets each tweet into a `NERV_TZ` day, merges into the JSON, and commits the result — which triggers a Vercel rebuild. The runtime app does **not** call any X API. If the JSON is malformed or empty (first deploy before the Action has run), the panel is hidden gracefully.

  **Tradeoff:** data freshness is bounded by the daily Action + deploy cycle, not real-time. Today's tweets land in tomorrow's snapshot. Acceptable for a "did I ship today?" tracker; if you want sub-hour latency, run the workflow with `workflow_dispatch` after each tweet.

Streak math runs in-memory and the result is rendered server-side. The JSON snapshot is also exposed at `GET /api/snapshot?days=N` (cached `s-maxage=3600`, SWR 10min) for any future client.

## Layout

```
apps/web/              Next.js dashboard (Vercel target)
  src/app/             page.tsx + /api/snapshot route
  src/lib/             streak.ts · github.ts · twitter.ts · snapshot.ts · heatmap.ts
  src/lib/nerv/        MagiPanel + Heatmap components
implementation-notes/  Decision log per task
PLAN.md                Master spec
```

## Deploy

Push to a Vercel project. Required env vars: `GITHUB_TOKEN`, `GITHUB_LOGIN`. Optional: `X_LOGIN` to enable the Twitter panel. `NERV_TZ` to override the default `America/Los_Angeles` bucketing.

For the daily X refresh, add `SOCIALDATA_API_KEY` to **GitHub** repo secrets (Settings → Secrets and variables → Actions). The runtime app never sees that key — only the workflow does.

## Status

| Item | State |
|---|---|
| GitHub heatmap + streak | done |
| X / Twitter heatmap + streak (socialdata.tools daily refresh) | done |
| NERV skin (scanlines, hex panels, glow) | minimal Phase-1 skin in place; full Phase-3 deferred |
| Nudge mechanism (Cron + push/email) | **deferred** |
| Manual `/api/ship` fallback | **deferred** |
| Upstash KV for long-term X history | **deferred** |
