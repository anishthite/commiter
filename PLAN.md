# NERV OS — Shipping Tracker

> "PATTERN: BLUE. Daily output confirmed."

A two-panel MAGI-style dashboard that watches your GitHub commits and your X/Twitter posts, renders GitHub-style heatmaps for each, tracks streaks, and yells at you if you haven't shipped by end of day.

---

## 0. The vision (what you'll be looking at)

A fullscreen, black-background, orange-on-black terminal-feel dashboard. Two large hexagon-cornered panels side by side:

```
┌─ NERV // CENTRAL DOGMA ────────────────────────────── 2026-05-23 14:07:33 ─┐
│                                                                            │
│  ╱╲  MAGI-01 :: GITHUB                ╱╲  MAGI-02 :: X / TWITTER          │
│ ╱  ╲  ─────────────────              ╱  ╲  ───────────────────             │
│ PATTERN: BLUE                        PATTERN: ORANGE                       │
│ STREAK: 042                          STREAK: 007                           │
│ TODAY:  ▓▓▓▓▓ 7 commits              TODAY:  ▓ 0 posts  [WARNING]          │
│                                                                            │
│  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢                ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢                  │
│  ▢▢▣▣▢▣▣▣▢▣▢▢▣▣▣▢▢▢▢▢   [52 wk]      ▢▣▢▢▢▢▣▢▢▢▢▢▢▣▢▢▢▢▢▢   [52 wk]       │
│  ▢▣▣▣▢▢▣▣▣▢▢▢▣▣▢▣▢▢▢▢                ▢▢▢▢▢▣▢▢▢▢▢▢▢▢▣▢▢▢▢▢▢                │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│ SYS:OK  · LAST SYNC 14:07:01  · COMBINED STREAK 042  · ONE OF YOU IS LYING │
└────────────────────────────────────────────────────────────────────────────┘
```

Heatmap cells: sharp squares, orange-amber gradient (`#3a1a00 → #ff6600 → #ffaa33`). NERV hex logo top-left. Subtle CRT scanlines. Numbers in `VT323` / `IBM Plex Mono`. Status bar at the bottom with timestamps, sync state, and a rotating MAGI-style status line.

---

## 1. Aesthetic spec

| Layer | Spec |
|---|---|
| Palette | `bg #000`, `nerv-orange #ff6600`, `amber #ffaa33`, `warn-red #ff0033`, `grid-dim #2a1500`, `text #ffd9a8` |
| Font | `VT323` for big numbers · `IBM Plex Mono` / `JetBrains Mono` for everything else |
| Decor | Hex-clipped panel corners, scanline overlay (1px @ 6% opacity), subtle CRT vignette |
| Heatmap | 53 × 7 grid, 11px squares, 2px gap, sharp corners, amber gradient on missing-day `#1a0a00` |
| Big number | Streak count rendered ≥120px, slight glow, monospace |
| Sounds (opt) | Boot beep on load, alarm tone if no ship by 20:00 |
| Status text | All-caps, narrow tracking, rotates: `PATTERN ANALYSIS`, `SYNCHRONIZING`, `WAITING FOR INPUT` |

---

## 2. Data sources

### GitHub — solved
Use the **GraphQL `contributionsCollection`** query. Returns a day-by-day count for the past 365 days *exactly* matching what github.com shows on your profile. Public + private (if you set `read:user`). Free, official, one HTTP call.

```graphql
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}
```

### Twitter / X — solved via pi-chrome
We use **your already signed-in Chrome session** via `pi-chrome`'s loopback bridge (`127.0.0.1:17318`). No X API, no scraper subscription, no fragile reverse-auth — your real authenticated profile, driven locally.

**Flow per ingest tick (every 15 min):**
```
  Node ingestor
    → POST 127.0.0.1:17318           # pi-chrome bridge
        chrome_navigate("https://x.com/anishthite")
        chrome_wait_for("article[data-testid='tweet']")
        chrome_evaluate(scrape.js)   # scrape DOM → [{id, ts}, ...]
    → if scrape returns 0 OR DOM shape changed:
        chrome_snapshot()
        → POST to small LLM (Claude Haiku via API, or local Ollama qwen2.5:7b)
            "extract tweet IDs and timestamps from this snapshot, return JSON"
    → upsert into event + daily_count tables
```

Two-tier ingestion:

| Tier | Mechanism | Cost | When used |
|---|---|---|---|
| **Fast path** | `chrome_evaluate` with a deterministic DOM scraper (`article[data-testid="tweet"]`, parse `<time datetime=...>`, `status/<id>` href) | Free | Default every tick |
| **LLM fallback** | `chrome_snapshot` → Claude Haiku (~$0.001/call) or local Ollama | Cents/month or free | When fast path returns 0 / X changes the DOM |

Pi-chrome is already installed at `~/.nvm/.../node_modules/pi-chrome`. The bridge is local-only, refuses browser-origin requests, and is locked until `/chrome authorize` from a Pi session. For unattended cron, options are:

- **Option 1:** Bridge auto-authorizes after onboard if `indefinite`; verify with `/chrome status`.
- **Option 2:** Spawn `pi` with a one-shot prompt from the cron (cleanest, lets pi-chrome handle auth) — `pi --prompt "<script>" --json`.
- **Option 3:** Reverse-engineer the bridge HTTP protocol and call it directly from Node (fastest, no Pi process needed).

Start with **Option 2** for Phase 2 (zero plumbing, just shell out to `pi`), move to Option 3 in Phase 5 if the per-call latency matters.

**Backstop:** still ship the `ship` self-report CLI so you can log a tweet manually when Chrome isn't running (laptop closed, traveling, etc.).

*Constraint:* the ingestor must run on the Mac that has your Chrome session. It cannot move to Vercel. See §4 for how the DB bridges the two sides.

---

## 3. Architecture

The ingestor must run locally (needs your Chrome), but you want phone access. Solution: **hosted libSQL** (Turso) as the shared store. Same SQLite schema; libSQL gives us a remote endpoint the local ingestor writes to and the Vercel app reads from.

```
┌──── ON YOUR MAC (always-on while laptop is awake) ──────────────┐
│                                                                  │
│  launchd  ──every 15m──▶  ingest CLI                            │
│                              │                                   │
│                              ├─▶ GitHub GraphQL (PAT)            │
│                              │                                   │
│                              └─▶ pi-chrome bridge :17318         │
│                                     ↕                            │
│                                  your signed-in Chrome           │
│                                     ↕                            │
│                                   x.com/anishthite               │
│                                                                  │
│  ship CLI (manual fallback) ──────┐                              │
│                                   ▼                              │
│                              writes to ──────────────────▶ Turso │
└─────────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌──── ON VERCEL (the dashboard) ──────────────────────────────────┐
│                                                                  │
│  Next.js  ◀── reads ──── Turso (libSQL HTTP, edge replicated)   │
│  /        → SSR dashboard (NERV skin)                            │
│  /api/snapshot → days[], streaks{}                               │
│                                                                  │
│  Auth: simple shared-secret cookie (it's just you).              │
└─────────────────────────────────────────────────────────────────┘
```

**Stack:**
- **Frontend:** Next.js App Router + Tailwind + NERV theme. Deployed to **Vercel** (free hobby tier). SSR every request from Turso, no client polling needed.
- **DB:** **Turso** (libSQL). Free tier = 9 GB storage, 1B row reads/mo. Same SQL as SQLite. Local dev points at a local libSQL file; prod points at the Turso URL via env.
- **Ingestor:** TypeScript CLI on the Mac. Uses `@libsql/client` to write directly to Turso. Idempotent — re-fetches the full 365-day GitHub window + last 30 days of tweets each tick, upserts.
- **Cron:** local `launchd` job every 15 min. Optional second nudge cron at 18:00 local that runs a no-op ingest then checks shipping status and fires a macOS notification.
- **Auth:** Vercel app is gated by a single shared secret in a cookie (`NERV_PILOT_TOKEN`). It's only ever you.
- **Phone access:** open the Vercel URL on your phone. Bookmark it. Done.

---

## 4. Data model

Same schema, hosted on Turso instead of a local file. All dates bucketed in `America/Los_Angeles`.

```sql
CREATE TABLE daily_count (
  channel    TEXT NOT NULL,    -- 'github' | 'twitter'
  date       TEXT NOT NULL,    -- 'YYYY-MM-DD' in America/Los_Angeles
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel, date)
);

CREATE TABLE event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  ts         INTEGER NOT NULL, -- unix ms
  ref        TEXT,             -- commit sha / tweet id
  payload    TEXT,             -- json: { url, text, title, repo }
  UNIQUE(channel, ref)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- last_sync, schema_version, ingestor_health
```

Streaks are computed at read-time from `daily_count` — no denormalization.

---

## 5. Streak engine

Configurable per channel + a **combined streak in AND mode** (both channels required to keep the combined streak alive — your call, the harder mode).

```
ship_day(channel, date) := daily_count[channel][date] >= 1
combined_ship_day(date) := ship_day('github', date) AND ship_day('twitter', date)
current_streak(channel) := count consecutive ship_days ending at today,
                           ignoring today if it's before cutoff_time (default 06:00 LA).
longest_streak(channel) := max run in the last 365 days.
```

Day boundary = midnight `America/Los_Angeles`. No grace period in v1 — miss a day on either channel, combined streak resets to 0. Gym discipline.

---

## 6. Build phases

### Phase 1 — Skeleton + GitHub (Day 1, ~3-4h)
- [ ] `pnpm create next-app`, Tailwind, NERV theme tokens
- [ ] SQLite schema, migrations runner
- [ ] GitHub ingestor (GraphQL `contributionsCollection`) + `pnpm ingest:github`
- [ ] `/api/snapshot` returns `{ github: { days, streak, longest } }`
- [ ] Bare heatmap component (correct shape, no skin yet)

### Phase 2 — Twitter ingestor via pi-chrome (Day 2, ~3-4h)
- [ ] Confirm pi-chrome is onboarded + you're signed into x.com in that Chrome profile.
- [ ] Write `packages/ingest/src/twitter/scrape.js` — the `chrome_evaluate` payload that reads `article[data-testid="tweet"]` from `https://x.com/anishthite`, returns `[{id, ts_iso, text_snippet}]`.
- [ ] Wire `packages/ingest/src/twitter/pi-chrome.ts` — spawns `pi --prompt` with a one-shot script that runs the scrape and emits JSON to stdout. Parse → upsert.
- [ ] LLM fallback: when fast path returns 0 results twice in a row, escalate to `chrome_snapshot` + Claude Haiku extraction. Keep prompt + schema in `twitter/llm-extract.ts`.
- [ ] Always wire the **`ship` CLI** (`ship tweet "<url>"`, `ship note "<text>"`) for manual entries when Chrome's not available.
- [ ] Health row in `meta`: `twitter_last_ok_ts`, `twitter_consecutive_failures`. Surface in dashboard status bar.

### Phase 3 — NERV skin (Day 2-3, ~4-6h)
- [ ] Layout: dual MAGI panels, top bar, bottom status bar
- [ ] Heatmap recolor + cell tooltip (date · count · refs)
- [ ] Big streak numbers, glow effect
- [ ] CRT scanlines + vignette overlay
- [ ] Hex-clipped panel borders (SVG mask or `clip-path`)
- [ ] Rotating status messages, ticking clock

### Phase 4 — Nudge system (Day 3, ~1-2h)
- [ ] launchd job fires at 18:00 PT — runs ingest + checks `combined_ship_day(today)`.
- [ ] If false: macOS notification (`terminal-notifier` or `osascript`) — `PATTERN RED // SHIPMENT REQUIRED`.
- [ ] Second check at 23:00 PT — if still false, escalate: louder notification + dashboard auto-renders full-screen red takeover.
- [ ] If shipped on both: quiet `SYNCHRONIZATION COMPLETE` line at the bottom of the status bar. No confetti.

### Phase 5 — Polish (later)
- [ ] Tauri wrap → always-on-top widget mode
- [ ] Per-day drill-down panel (list of commits + tweets for that day)
- [ ] Longest-streak history graph
- [ ] Optional: weekly Sunday email "MAGI Weekly Synopsis"

---

## 7. Repo layout (target)

```
commiter/
  apps/web/                       # Next.js app → Vercel
    src/app/page.tsx              # NERV dashboard
    src/app/api/snapshot/route.ts # reads Turso, returns Snapshot
    src/lib/nerv/{Heatmap,Streak,StatusBar,RedAlert,ScanlineOverlay}.tsx
    src/lib/nerv/theme.ts         # NERV color tokens, scanline CSS
  packages/ingest/                # Node CLI, runs on Mac
    src/github.ts                 # GraphQL contributionsCollection
    src/twitter/
      pi-chrome.ts                # spawns `pi --prompt`, parses JSON
      scrape.js                   # chrome_evaluate payload (DOM → JSON)
      llm-extract.ts              # snapshot → LLM → JSON (fallback)
      self-report.ts              # ship CLI handler
    src/streak.ts                 # pure streak math (unit-tested)
    src/db.ts                     # libSQL client (local file OR Turso)
    bin/ingest.ts                 # `ingest [--channel=github|twitter|all]`
    bin/ship.ts                   # `ship tweet|note|commit "..."`
  scripts/launchd/
    com.nerv.ingest.plist         # 15-min ingest cron
    com.nerv.nudge.plist          # 18:00 + 23:00 PT checks
  data/ship.local.db              # local dev only, gitignored
  .env.example                    # GITHUB_TOKEN, TURSO_URL, TURSO_TOKEN, NERV_PILOT_TOKEN, ANTHROPIC_API_KEY (optional)
  implementation-notes/
  PLAN.md
```

---

## 8. Resolved decisions (from your input)

| # | Decision |
|---|---|
| Twitter source | **pi-chrome** driving your signed-in Chrome session. DOM scrape primary, small-LLM fallback. `ship` CLI as manual backstop. |
| GitHub identity | `anishthite`. Private contribs counted → need PAT with `read:user`. |
| Deploy | **Vercel** (frontend) + **Turso** (libSQL, hosted). Ingestor stays local on Mac. |
| Combined streak | **AND** — both channels must ship that day to keep the combined streak alive. |
| Timezone | `America/Los_Angeles`. |
| Nudge | macOS notification at 18:00 PT; full-screen red takeover at 23:00 PT if still nothing. |
| Grace period | **None** in v1. |

## 9. Still need from you

Before Phase 1 I need:

1. **GitHub PAT** — create one at https://github.com/settings/tokens?type=beta with `read:user` + `repo` (for private contrib visibility). Drop it in a `.env` once we have the repo scaffolded; no need to share it in chat.
2. **`/chrome onboard` complete** — confirm `/chrome doctor` is green in a Pi session and you're signed into x.com on that Chrome profile.
3. **Anthropic API key** (optional, only if you want the LLM fallback path; can also use local Ollama or skip).
4. **Turso account** — sign up at turso.tech (free), I'll generate the DB and give you the two env vars to set in Vercel.
5. **Go-ahead** to start Phase 1.

The moment you've got #1, #2, and #5 I start scaffolding the repo and writing the GitHub ingestor.
