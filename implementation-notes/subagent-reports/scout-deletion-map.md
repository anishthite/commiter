# Commiter → Stateless Refactor Scout Report

Date: 2026-05-28. Recon only — no proposals.

---

## 1. Exact deletion list

### Whole-tree deletes
| Path | Reason |
|---|---|
| `packages/ingest/` (entire dir) | Workspace being dropped. Includes `bin/ingest.ts`, `bin/migrate.ts`, `bin/ship.ts`, `src/db.ts`, `src/schema.ts`, `src/snapshot.ts` (DB-bound version), `src/github.ts` (DB-bound version), `src/env.ts`, `package.json`, `tsconfig.json`. **Note:** `src/streak.ts` is pure and must be hoisted before delete (see §3). |

### Individual files
| Path | Reason |
|---|---|
| `apps/web/src/lib/snapshot-server.ts` | Calls `db()` + `migrate()` + `buildSnapshot(client, …)`. Entire body becomes obsolete; replaced by stateless lib. |

### Does not exist on disk (already absent — verify only)
| Path | Note |
|---|---|
| `data/` | Not present. Gitignored anyway (`**/data/*.db`). Nothing to delete. |
| `scripts/launchd/com.nerv.ingest.plist` | **Not present**. PLAN.md targets it but it was never created. |
| `scripts/launchd/com.nerv.nudge.plist` | Same — not on disk. |
| `packages/ingest/src/twitter/*` | Never created (Phase 2 not started). |
| Tauri wrapper | Not present. |

### Env vars to remove from `.env.example`
| Var | Currently at `.env.example` line |
|---|---|
| `DATABASE_URL` | line 11 |
| `DATABASE_AUTH_TOKEN` | line 13 |
| `ANTHROPIC_API_KEY` | line 19 (LLM fallback for the pi-chrome scrape — moot) |

### Root-level config edits that act as deletions
| File | What to remove |
|---|---|
| `package.json` (root) | `scripts.ingest`, `scripts.ingest:github`, `scripts.migrate`, `scripts.ship` (lines 9-12) |
| `pnpm-workspace.yaml` | `"packages/*"` entry (the only package was `ingest`) — or leave for future and just delete `packages/`. Either works; `packages/*` glob over empty dir is harmless. |
| `apps/web/next.config.mjs` | `transpilePackages: ["ingest"]`, `experimental.serverComponentsExternalPackages: ["@libsql/client","libsql"]`, the entire `webpack(config, …)` externals push (lines 11-34). |
| `apps/web/package.json` | dependency `"ingest": "workspace:*"` (line 11). |

---

## 2. Keep-but-modify list

| File | Current responsibility | Strip | Add |
|---|---|---|---|
| `apps/web/src/app/page.tsx` (60 lines) | SSR page, calls `getSnapshot(365)` from `@/lib/snapshot-server`, renders `MagiPanel × 2`. `export const dynamic = "force-dynamic"`. | Import path `@/lib/snapshot-server`. Possibly `dynamic = "force-dynamic"` (depends on 1h cache strategy). The "Did you run `pnpm migrate` and `pnpm ingest:github`?" error copy. | New import from `@/lib/snapshot` (stateless). Optional `export const revalidate = 3600`. |
| `apps/web/src/app/api/snapshot/route.ts` (22 lines) | GET handler, parses `?days=`, calls `getSnapshot`, returns JSON, `cache-control: no-store`. | `dynamic = "force-dynamic"`, `cache-control: no-store` (now we *want* caching). | Import from new lib; `export const revalidate = 3600` or `cache-control: s-maxage=3600`. |
| `apps/web/src/lib/nerv/MagiPanel.tsx` (75 lines) | Renders panel with streaks + heatmap. | Import path `import type { ChannelSnapshot } from "ingest/src/snapshot"` (line 1). | Re-import `ChannelSnapshot` from new `@/lib/snapshot` (or `@/lib/types`). |
| `apps/web/src/lib/nerv/Heatmap.tsx` (40 lines) | Renders 53×7 grid from `Day[]`. | Import `import type { Day } from "ingest/src/streak"` (line 1). | Re-import `Day` from new `@/lib/streak`. |
| `apps/web/src/lib/heatmap.ts` (45 lines) | `toWeeksGrid`, `intensity` — pure, no DB. | Import `import type { Day } from "ingest/src/streak"` (line 1). | Re-import `Day` from `@/lib/streak`. |
| `apps/web/next.config.mjs` | See §1 above. | `transpilePackages`, `experimental.serverComponentsExternalPackages`, entire `webpack` hook. | Empty config (or just `reactStrictMode: true`). |
| `apps/web/package.json` | web deps. | `"ingest": "workspace:*"`. | (nothing — fetch is built in). |
| `package.json` (root) | workspace scripts. | `ingest`, `ingest:github`, `migrate`, `ship` scripts. | (optional) keep only `dev`, `build`, `start`, `typecheck`. |
| `pnpm-workspace.yaml` | 2-entry workspace. | `"packages/*"` (optional, see §1). | — |
| `.env.example` | 7 vars listed. | `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, the "Database" block comments. | Optional: `X_LOGIN=anishthite`. Keep `GITHUB_TOKEN`, `GITHUB_LOGIN`, `NERV_PILOT_TOKEN`, `NERV_TZ`. |
| `PLAN.md` | Spec with Turso/pi-chrome/launchd. | Sections §2 Twitter-via-pi-chrome, §3 architecture diagram, §4 SQL schema, §6 Phase-2/4, §7 repo layout, §8 decision table rows, env-var list. | New stateless architecture description (or scrap and rewrite). |
| `README.md` | Quickstart with `pnpm migrate` + `pnpm ingest:github`. | Steps 2-3 (migrate/ingest), the "data/" layout entry, Phase 1/2/3/4 status table. | Just `pnpm install && pnpm dev`. |

---

## 3. Reusable pure code (hoist to `apps/web/src/lib/`)

### `packages/ingest/src/streak.ts` — **fully reusable, zero edits required**

165 lines, no I/O, no DB import. Exports:
- `type Day = { date: string; count: number }`
- `type ChannelStreak = { current; longest; today_count }`
- `type Channel = "github" | "twitter"`
- `isShipDay(d, threshold=1)`
- `computeStreak(days, opts)` — current + longest with optional `today_pending`
- `combineDays(a, b, mode, threshold=1)` — AND/OR per-day
- `dateKey(d, tz)` — `Intl.DateTimeFormat("en-CA", { timeZone: tz, … })` → `YYYY-MM-DD`
- `addDays(yyyymmdd, n)` — UTC math, DST-safe
- `fillMissingDays(rows, from, to)` — contiguous ascending list, 800-day safety cap

**Action:** copy to `apps/web/src/lib/streak.ts` verbatim. (Over 60 lines — not pasted here, but the file is intact at `packages/ingest/src/streak.ts:1-165`.)

### `packages/ingest/src/github.ts` — **GraphQL query + parsing is reusable; persistence is not**

Reusable pieces (lines 17-36 query, lines 38-52 response type, lines 65-99 fetch logic). Drop the libSQL `client.batch(…)` block (lines 102-135) and the `count++/stmts.push` accumulator; instead loop the calendar into a `Day[]`.

Code worth lifting (the GraphQL POST):

```ts
const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const QUERY = /* GraphQL */ `
  query ContribCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

const res = await fetch(GRAPHQL_ENDPOINT, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "nerv-shipping-tracker",
  },
  body: JSON.stringify({ query: QUERY, variables: { login, from, to } }),
  // ADD for stateless: next: { revalidate: 3600 }
});
```

`CalendarResponse` type at `packages/ingest/src/github.ts:38-52`:
```ts
type CalendarResponse = {
  data?: {
    user: {
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: number;
          weeks: Array<{
            contributionDays: Array<{ date: string; contributionCount: number }>;
          }>;
        };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
};
```

### `packages/ingest/src/snapshot.ts` — **shape reusable, body must be rewritten**

The `Snapshot` + `ChannelSnapshot` *types* (lines 11-31) are the wire contract — keep verbatim. The `buildSnapshot(client, opts)` body (lines 55-99) is the right shape but takes a libSQL client; rewrite to take pre-loaded `ghDays`/`twDays` arrays. `loadChannelDays(client, …)` is dead code in the stateless world.

### Twitter — **no code exists**

`packages/ingest/src/twitter/` is not on disk. PLAN.md describes it but Phase 2 was never started. New Twitter syndication-endpoint fetcher will be greenfield.

---

## 4. Dependency surface (becomes unused)

### `packages/ingest/package.json`
| Package | Used by | After refactor |
|---|---|---|
| `@libsql/client` | `db.ts`, `github.ts`, `snapshot.ts`, `schema.ts` | unused (delete with package) |
| `dotenv` | `env.ts` | unused (Next handles `.env` natively) |
| `tsx` (dev) | bin scripts | unused |

### `apps/web/package.json`
| Package | Used by | After refactor |
|---|---|---|
| `ingest` (workspace:*) | `page.tsx`, `snapshot-server.ts`, `MagiPanel.tsx`, `Heatmap.tsx`, `heatmap.ts` | unused (workspace gone) |

### Root `package.json`
Only `typescript` devDep — keep.

### pnpm-lock.yaml
Will regenerate; `@libsql/client`, `libsql`, `@libsql/hrana-client`, `dotenv` and transitive native bindings drop out. Need a `pnpm install` after.

### Not present (no need to remove)
No `pi-chrome` npm bridge package, no `@tursodatabase/*`, no `drizzle-orm`, no Tauri deps. The libSQL toolchain is the only DB surface.

---

## 5. Snapshot type contract (current wire shape)

Live at `packages/ingest/src/snapshot.ts:11-31` and `packages/ingest/src/streak.ts:9-15`. Reproduced verbatim:

```ts
// streak.ts
export type Day = { date: string; count: number };

export type ChannelStreak = {
  current: number;
  longest: number;
  today_count: number;
};

export type Channel = "github" | "twitter";

// snapshot.ts
export type ChannelSnapshot = {
  days: Day[];
  streak_current: number;
  streak_longest: number;
  today_count: number;
};

export type Snapshot = {
  generated_at: string; // ISO
  tz: string;
  range: { from: string; to: string; days: number };
  channels: {
    github: ChannelSnapshot;
    twitter: ChannelSnapshot;
  };
  combined: {
    streak_current: number;
    streak_longest: number;
    mode: "and" | "or";
  };
};
```

**No `HeatmapCell` exported type.** The closest equivalent is `GridCell = Day | null` (local to `apps/web/src/lib/heatmap.ts:11`). Page and components consume only `Snapshot`/`ChannelSnapshot`/`Day` — preserve those three and zero UI code needs to change.

---

## 6. Environment variables

### Read locations
| Var | Defined / Read | Status |
|---|---|---|
| `GITHUB_TOKEN` | `packages/ingest/src/env.ts:36` (optional), enforced by `requireGithubToken()` at `env.ts:47`; consumed by `packages/ingest/src/github.ts:60` | **KEEP** — moves to Next runtime env. |
| `GITHUB_LOGIN` | `env.ts:37` (required, fallback `"anishthite"`); used by `github.ts:61` | **KEEP** |
| `NERV_TZ` | `env.ts:40` (required, fallback `"America/Los_Angeles"`); used by `apps/web/src/lib/snapshot-server.ts:14` | **KEEP** |
| `DATABASE_URL` | `env.ts:38` | **DROP** |
| `DATABASE_AUTH_TOKEN` | `env.ts:39` | **DROP** |
| `ANTHROPIC_API_KEY` | listed in `.env.example:19` only; no code reference | **DROP** (Phase-2 vestigial) |
| `NERV_PILOT_TOKEN` | `.env.example:15` only; no code reference yet | **KEEP** (auth cookie planned, not wired) |
| `X_LOGIN` | not currently in `.env.example` or code | **ADD** (new — for Twitter syndication URL) |

### Notes
- `dotenv` loading at `env.ts:1-19` walks parent dirs — gone with the package.
- Next.js loads `.env*` natively; access via `process.env.GITHUB_TOKEN` in server code. No more shared `env` object.
- `requireGithubToken()` semantics (throw with friendly message) worth preserving in new lib.

---

## 7. Surprises / sharp edges

| # | Surprise |
|---|---|
| S1 | **Web app imports raw TS from `packages/ingest/src/*`** (e.g. `import { db } from "ingest/src/db"` in `snapshot-server.ts:2`, `import type { ChannelSnapshot } from "ingest/src/snapshot"` in `MagiPanel.tsx:1`, `import type { Day } from "ingest/src/streak"` in two files). This is why `next.config.mjs` has `transpilePackages: ["ingest"]`. Every import path changes when the workspace dies. |
| S2 | **`snapshot-server.ts` has a module-level `let migrated = false`** singleton flag. In Vercel serverless this would run `migrate()` on every cold start. No-op once you delete the file, but confirms current code isn't serverless-friendly. |
| S3 | **Route already says `dynamic = "force-dynamic"` and `cache-control: no-store`** at `route.ts:5,15`. Refactor must *invert* both. |
| S4 | **No `data/` directory exists** on disk. `.gitignore` covers it (`**/data/*.db`). Nothing to delete — just confirm. |
| S5 | **No `scripts/launchd/` directory exists.** PLAN.md §6 lists the plists but they were never written. No cron file to remove. |
| S6 | **No `packages/ingest/src/twitter/` subdir** — Phase 2 untouched. No pi-chrome wiring on disk at all. Only references are PLAN.md, README.md, and `bin/ingest.ts:66` (a `console.log("not implemented")`). |
| S7 | **No Tauri wrapper.** PLAN.md §6 Phase 5 mentions it as future; no code. |
| S8 | **`ship` CLI is a stub** (`bin/ship.ts` literally prints "not implemented yet" and exits 1, 30 lines). Symbolic delete only. |
| S9 | **`webpack` externals push in `next.config.mjs`** is non-trivial (lines 23-33) — there's a comment explaining empirically that `serverComponentsExternalPackages` alone was insufficient. Entire block goes when libsql goes; clean win. |
| S10 | **Schema migration uses `meta.schema_version`** at `schema.ts:42-58`. No external schema files / no Drizzle. Pure libSQL `client.execute` strings. Trivial delete. |
| S11 | **`buildSnapshot` hard-codes `combineDays(ghDays, twDays, "and")`** at `snapshot.ts:84`. Wire shape exposes `combined.mode` as `"and" | "or"` but only "and" is ever produced. New code can keep this constraint or expose it; either way `combined.mode` stays in the type. |
| S12 | **`tsconfig.base.json` has `"verbatimModuleSyntax": false`** — fine, but the `import type` calls in components rely on TS to elide. No issue. |
| S13 | **`days` clamp differs between layers.** Route clamps `[7, 365]` (`route.ts:11`), `buildSnapshot` also clamps `[7, 365]` (`snapshot.ts:60`), GraphQL fetcher clamps to `min(days, 365)` (`github.ts:62`). Redundant but consistent — preserve clamps. |
| S14 | **GraphQL `from` window** is `now - days * 86_400_000` (`github.ts:67`). That's a sliding 365-day ISO range, NOT calendar-aligned to LA midnight. `buildSnapshot` separately recomputes `from` via `addDays(today, -(days-1))` in LA tz. The two windows disagree by up to ~16h; current code "works" because `loadChannelDays` reads only the LA-aligned range from DB. **In the stateless world, you'll need to fetch a wider GitHub window than you display, or accept day-boundary skew.** Real consideration. |
| S15 | **`force-dynamic` on `page.tsx:4`** means `revalidate` is ignored. Have to remove it for fetch caching to apply. |

---

## TL;DR map

```
DELETE: packages/ingest/**  +  apps/web/src/lib/snapshot-server.ts
HOIST:  packages/ingest/src/streak.ts → apps/web/src/lib/streak.ts (verbatim)
        packages/ingest/src/snapshot.ts types only → apps/web/src/lib/snapshot.ts
        github.ts GraphQL fetch (sans libsql writes) → apps/web/src/lib/github.ts
NEW:    apps/web/src/lib/twitter.ts (syndication endpoint, greenfield)
EDIT:   page.tsx (1 import + dynamic flag) · route.ts (caching flags + import) ·
        MagiPanel.tsx + Heatmap.tsx + heatmap.ts (1 import each) ·
        next.config.mjs (gut) · apps/web/package.json (drop `ingest`) ·
        package.json root (drop ingest/migrate/ship scripts) ·
        pnpm-workspace.yaml (drop packages/*) · .env.example · PLAN.md · README.md
ENV:    keep GITHUB_TOKEN, GITHUB_LOGIN, NERV_TZ, NERV_PILOT_TOKEN
        drop DATABASE_URL, DATABASE_AUTH_TOKEN, ANTHROPIC_API_KEY
        add  X_LOGIN
DEPS:   drop @libsql/client, dotenv, tsx, ingest (workspace)
```
