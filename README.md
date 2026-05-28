# NERV OS — Shipping Tracker

> "PATTERN: BLUE. Daily output confirmed."

Two-panel MAGI-style dashboard that watches GitHub commits + X posts, renders heatmaps and streaks, and yells when no shipping has happened by EOD.

Full spec: [`PLAN.md`](./PLAN.md). Implementation log: [`implementation-notes/`](./implementation-notes).

---

## Quickstart

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env
#   - GITHUB_TOKEN: PAT with `read:user`
#   - GITHUB_LOGIN: your handle
#   - DATABASE_URL stays as file:./data/ship.local.db for local dev

# 3. Migrate + ingest
pnpm migrate
pnpm ingest:github

# 4. Run the dashboard
pnpm dev
# → http://localhost:3000
```

## Layout

```
apps/web/              Next.js dashboard (Vercel target)
packages/ingest/       Local CLI: GitHub + Twitter ingest, ship-CLI, streak math
data/                  Local libSQL file (gitignored)
implementation-notes/  Decision log per task
PLAN.md                Master spec
```

## Status

Phase 1 (skeleton + GitHub ingest + bare heatmap) — **done**.
Phase 2 (Twitter via pi-chrome) — pending.
Phase 3 (NERV skin) — pending.
Phase 4 (nudge cron) — pending.
