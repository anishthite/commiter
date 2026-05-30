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
#   Optional Twitter source (pick at most one — see .env.example):
#   - X_DATA_URL:    URL serving a pre-built [{date,count}] JSON
#   - X_NITTER_HOST: hostname of your self-hosted Nitter (see docs/SELF_HOST_NITTER.md)
#
#   With neither set, the Twitter panel is hidden and the GitHub panel
#   fills the row — a valid GitHub-only setup.

# 3. Run
pnpm dev
# → http://localhost:3000
```

That's the whole setup. No migrations, no ingest cron, no second machine.

## How it works

On each cache miss (every ~1 hour) the Next.js SSR pipeline pulls:

- **GitHub** — GraphQL `contributionsCollection` (365-day calendar, private contribs included with `read:user`).
- **X / Twitter** — read from `X_DATA_URL` if set (your scraper writes JSON, commiter reads it). Falls back to self-hosted Nitter via `X_NITTER_HOST`, then to the public Nitter pool. If all four tiers fail, the Twitter panel is hidden entirely so the dashboard degrades to a clean GitHub-only view rather than showing fake zeros. See `docs/SELF_HOST_NITTER.md` for the self-host path.

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

Push to a Vercel project. Required env vars: `GITHUB_TOKEN`, `GITHUB_LOGIN`. Optional: `X_LOGIN` + (`X_DATA_URL` OR `X_NITTER_HOST`) to enable the Twitter panel. `NERV_TZ` to override the default `America/Los_Angeles` bucketing. No other setup.

## Status

| Item | State |
|---|---|
| GitHub heatmap + streak | done |
| X / Twitter heatmap + streak (Nitter RSS) | done |
| NERV skin (scanlines, hex panels, glow) | minimal Phase-1 skin in place; full Phase-3 deferred |
| Nudge mechanism (Cron + push/email) | **deferred** |
| Manual `/api/ship` fallback | **deferred** |
| Upstash KV for long-term X history | **deferred** |
