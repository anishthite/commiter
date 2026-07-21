# Shipping Tracker

Next.js/Vercel dashboard for “did we ship today?” per person. It combines GitHub contributions and X posts, with file-backed data and no database.

## Run locally

Requires Node 20+ and pnpm 9.

```bash
pnpm install
cp .env.example apps/web/.env.local
# set GITHUB_TOKEN in apps/web/.env.local
pnpm dev   # http://localhost:3000
```

Runtime env:

- `GITHUB_TOKEN` — required GitHub PAT with `read:user`.
- `NERV_TZ` — optional timezone; defaults to `America/Los_Angeles`.

No X API key is needed at runtime; the app reads bundled X data.

## App

- `/` — all tracked people.
- `/[slug]` — one person’s heatmaps/streaks.
- `/about` — public explanation.
- `/join` — add-person GitHub issue form.
- `/api/snapshot?user=anish&days=365` — JSON snapshot; `days` clamps to 7–365.

A day counts as shipped when GitHub and X both have activity. If X data is missing, that user falls back to GitHub-only.

## Data

- People: `apps/web/src/config/users.json`
- X day counts: `apps/web/src/data/x-days-by-slug.json`
- X refresh workflow: `.github/workflows/refresh-x-days.yml`
- Full spec: `PLAN.md`
- Decisions: `implementation-notes/`

To add someone, edit `users.json` with handles only, no `@`:

```json
{
  "slug": "anish",
  "displayName": "anish",
  "githubLogin": "anishthite",
  "xLogin": "anishthite"
}
```

## Checks

```bash
pnpm typecheck
pnpm tsx scripts/check-people.ts
```

## Deploy

Set Vercel runtime env:

- `GITHUB_TOKEN`
- `NERV_TZ` optional

Set GitHub Actions secrets:

- `SOCIALDATA_API_KEY` for X refresh
- `VERCEL_DEPLOY_HOOK_URL` optional deploy hook
