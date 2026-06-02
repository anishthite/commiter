# Scout: X/Twitter data-source migration handoff

> Goal of the consuming worker: replace the Nitter RSS fetcher in `apps/web/src/lib/twitter.ts` with a static-JSON-backed source plus a daily GitHub Action refresh. This document is the read-only recon — no files were modified.

---

## 0. TL;DR for the worker

- The X data layer is a **single module**: `apps/web/src/lib/twitter.ts`. One public export (`fetchTwitterDays`) + one error class (`TwitterFeedOfflineError`) + one input type (`FetchTwitterOpts`).
- It is called from **exactly one callsite**: `fetchTwitterDaysSafe()` inside `apps/web/src/lib/snapshot.ts` (line 132). Nothing else in the app imports `twitter.ts`.
- The module already has a **first-tier static-JSON path** (`X_DATA_URL`, lines 86–106), but it falls through to Nitter on miss/failure. The migration is largely "delete tiers 2 and 3, keep tier 1, make it authoritative."
- The downstream wire format is already `Day[] = { date: "YYYY-MM-DD", count: number }[]` (see `streak.ts:8`). The Nitter parser, the X_DATA_URL fetcher, and the snapshot composer all funnel into this same type. The worker should preserve it.
- Day-bucketing into the PT timezone happens at parse time inside `parseRssToDays()` via `dateKey(t, tz)` from `streak.ts`. A static-JSON producer must emit dates already-bucketed in `NERV_TZ` (default `America/Los_Angeles`).
- **No tests in the repo** — there is no `__tests__/`, `*.test.*`, or `*.spec.*` file anywhere outside `node_modules/`. The migration ships untested by precedent.
- **No GitHub Actions workflow exists yet** — `.github/` directory does not exist. The worker will be creating `.github/workflows/<name>.yml` from scratch.

---

## 1. Files Retrieved

1. `apps/web/src/lib/twitter.ts` (lines 1–311, full file) — the only Nitter fetcher; declares `TwitterFeedOfflineError`, `FetchTwitterOpts`, `fetchTwitterDays`, `tryNitterHost`, `fetchHostRss`, `fetchTwitterDataUrl`, `parseRssToDays`.
2. `apps/web/src/lib/snapshot.ts` (lines 1–148, full file) — sole consumer; reads `X_LOGIN`, calls `fetchTwitterDays`, catches `TwitterFeedOfflineError`, produces `Snapshot` wire object.
3. `apps/web/src/lib/streak.ts` (lines 1–148, full file) — defines `Day`, `dateKey(tz)`, `fillMissingDays`, `combineDays`, `computeStreak`. All bucketing math lives here.
4. `apps/web/src/app/api/snapshot/route.ts` (lines 1–28, full file) — App Router GET handler, `revalidate = 3600`, calls `getSnapshot`.
5. `apps/web/src/app/page.tsx` (lines 1–129) — SSR page, `revalidate = 3600`, also calls `getSnapshot`; hides X panel when `twitter.offline === true`.
6. `apps/web/src/lib/nerv/MagiPanel.tsx` (lines 1–88) — read side; consumes `ChannelSnapshot` (`days: Day[]`, streak fields).
7. `apps/web/src/lib/nerv/Heatmap.tsx` (lines 1–125) — renders `days: Day[]` into the 53×7 grid (oldest→newest), reversed at display time.
8. `apps/web/src/lib/heatmap.ts` (lines 1–46) — `toWeeksGrid(days: Day[]) → GridCell[][]`, `intensity(count) → 0..4`.
9. `apps/web/src/lib/oneliner.ts` (lines 1–166) — touches `snapshot.channels.twitter.today_count` (line 67) for prompt context. Not a Twitter fetcher, but a downstream consumer of the same shape.
10. `.env.example` (lines 8–45) — documents `X_LOGIN`, `X_DATA_URL`, `X_NITTER_HOST`. Ground truth for the env contract.

---

## 2. The current Nitter fetcher (Item #1)

**File:** `apps/web/src/lib/twitter.ts`
**Exported function:** `fetchTwitterDays`
**Hosts hit today** (constant `HOSTS`, lines 31–36):

```ts
const HOSTS = [
  "nitter.net",
  "nitter.poast.org",
  "xcancel.com",
  "nitter.privacyredirect.com",
] as const;
```

URL constructed at `twitter.ts:154`:
```ts
const url = `https://${host}/${encodeURIComponent(login)}/rss`;
```

**Exact signature** (lines 50–72):

```ts
export class TwitterFeedOfflineError extends Error {
  attempts: Array<{ host: string; reason: string }>;
  constructor(attempts: Array<{ host: string; reason: string }>) {
    super(`Twitter feed offline; all Nitter hosts failed (${attempts.length})`);
    this.name = "TwitterFeedOfflineError";
    this.attempts = attempts;
  }
}

export type FetchTwitterOpts = {
  /** Handle, no leading @. */
  login: string;
  /** IANA tz used to bucket each tweet's UTC timestamp into a day. */
  tz: string;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to: string;
  /** Revalidate window for the cached fetch. Default 3600s. */
  revalidate?: number;
};

export async function fetchTwitterDays(opts: FetchTwitterOpts): Promise<Day[]>
```

**Input contract:** `{ login, tz, from, to, revalidate? }` — `login` no leading `@`, `tz` IANA string, `from`/`to` inclusive `YYYY-MM-DD`. Throws if `login === ""` (line 76) or `to < from` (line 80).

**Output contract:** `Promise<Day[]>` — a **contiguous ascending** day list from `from` to `to` inclusive, every date present, missing days zero-filled by `fillMissingDays`. Throws `TwitterFeedOfflineError` if every tier in the fallback ladder fails.

**Tier ladder** (lines 85–140):

| Tier | Source | Trigger |
|---|---|---|
| 1 | `X_DATA_URL` static JSON | env var set, `fetchTwitterDataUrl()` lines 250–293 |
| 2 | `X_NITTER_HOST` self-hosted | env var set, `tryNitterHost()` |
| 3 | Public Nitter pool (4 hosts above) | always tried last |
| 4 | `throw TwitterFeedOfflineError` | all tiers exhausted |

**Internal helpers (all unexported):**

- `tryNitterHost(host, login, tz, from, to) → {kind:"ok", value: ParsedRss} | {kind:"err", reason: string}` — twitter.ts:148–174.
- `fetchHostRss(url, revalidate) → Promise<string | null>` — twitter.ts:176–210. 10 s `AbortController` timeout (`FETCH_TIMEOUT_MS = 10_000`, line 47). Uses `cache: "no-store"` (NOT `next.revalidate`, per inline comment at line 184).
- `fetchTwitterDataUrl(url, from, to, revalidate) → Promise<Day[]>` — twitter.ts:250–293. **This is the only tier that uses Next's fetch cache** (`next: { revalidate }`, line 261). Accepts either a bare `Day[]` array or `{ days: Day[] }` wrapper.
- `parseRssToDays(body, tz, from, to) → ParsedRss` — twitter.ts:299–332. RSS-or-Atom; buckets each `<pubDate>`/`<published>` via `dateKey(t, tz)`.

**`ParsedRss` type (line 213):**

```ts
type ParsedRss = {
  days: Day[];
  /** Items whose pubDate parsed to a valid Date. */
  parsedItems: number;
  /** Subset of parsedItems whose bucket day falls inside [from, to]. */
  inWindowItems: number;
};
```

---

## 3. Every callsite of the Nitter fetcher (Item #2)

Grep confirms `fetchTwitterDays` and `TwitterFeedOfflineError` are referenced from **exactly one production file**:

| File | Line | What it does |
|---|---|---|
| `apps/web/src/lib/snapshot.ts` | 3 | `import { fetchTwitterDays, TwitterFeedOfflineError } from "./twitter";` |
| `apps/web/src/lib/snapshot.ts` | 70 | `fetchTwitterDaysSafe(xLogin, tz, from, today)` — called inside `Promise.all` |
| `apps/web/src/lib/snapshot.ts` | 121 | `async function fetchTwitterDaysSafe(login, tz, from, to)` declaration |
| `apps/web/src/lib/snapshot.ts` | 132 | `const days = await fetchTwitterDays({ login, tz, from, to });` (actual invocation) |
| `apps/web/src/lib/snapshot.ts` | 135 | `if (err instanceof TwitterFeedOfflineError) { ... }` (catch site) |

Everything else (`worker-stateless-refactor.md`, `implementation-notes/*.html`, `PLAN.md`) is documentation, not code.

---

## 4. PT-timezone bucketing pipeline (Item #3)

The day-bucket pipeline is **two layers**:

### Layer A — UTC timestamp → tz day-key (per tweet)

- **File:** `apps/web/src/lib/streak.ts` lines 116–124
- **Function:** `dateKey(d: Date, tz: string): string`

```ts
export function dateKey(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD natively.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
```

Called from `twitter.ts:307` inside `parseRssToDays`:
```ts
const addBucket = (raw: string) => {
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return;
  parsedItems++;
  const key = dateKey(t, tz);
  if (key >= from && key <= to) inWindowItems++;
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
```

### Layer B — sparse map → contiguous ascending Day[]

- **File:** `apps/web/src/lib/streak.ts` lines 135–158
- **Function:** `fillMissingDays(rows, from, to): Day[]`

```ts
export function fillMissingDays(
  rows: Array<{ date: string; count: number }>,
  from: string,
  to: string
): Day[]
```

Builds a contiguous `Day[]` from `from` to `to` inclusive, zero-filling gaps. Cap of 800 iterations to guard against pathological ranges. Throws on inverted ranges (`to < from`).

### Where `tz` comes from

- `snapshot.ts:58`: `const tz = process.env.NERV_TZ ?? DEFAULT_TZ;`
- `snapshot.ts:55`: `const DEFAULT_TZ = "America/Los_Angeles";`
- Passed through `fetchTwitterDays({ login, tz, from, to })` (snapshot.ts:132).

### Window math (anchors the heatmap)

`snapshot.ts:61–65`:
```ts
const days = Math.min(Math.max(daysRequested, 7), 365);
const now = new Date();
const today = dateKey(now, tz);
const from = addDays(today, -(days - 1));
```

### Static-JSON producer contract (already in place, twitter.ts:218–293)

The X_DATA_URL path does **NOT** re-bucket. The doc comment at twitter.ts:218–227 spells out:

> Dates must be `YYYY-MM-DD` in the user's tz. We do NOT re-bucket UTC timestamps here — if the producer got the tz wrong commiter has no way to fix it. Missing days inside [from, to] are filled with count=0; days outside the window are dropped silently.

The validator (twitter.ts:271–284):
```ts
for (const item of candidate) {
  if (!item || typeof item !== "object") continue;
  const d = (item as { date?: unknown }).date;
  const c = (item as { count?: unknown }).count;
  if (typeof d !== "string" || typeof c !== "number") continue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
  if (d < from || d > to) continue;
  rows.push({ date: d, count: c });
}
return fillMissingDays(rows, from, to);
```

**Implication for the worker:** the GitHub Action must emit `{date, count}` rows whose `date` is already bucketed in `America/Los_Angeles` (or whatever `NERV_TZ` the deployment uses). The action should call X's API/scraper, group by PT day, emit JSON, commit. Server-side, the existing `fetchTwitterDataUrl` will read it as-is — no code change needed in `snapshot.ts`/`streak.ts` if the static path is kept and the Nitter tiers are removed.

---

## 5. Next.js route handlers surfacing X data (Item #4)

The X heatmap reaches the user through **two render paths** — both in App Router, both `revalidate = 3600`:

### Path A — Server-rendered HTML page

- **File:** `apps/web/src/app/page.tsx`
- **Directive (line 8):** `export const revalidate = 3600;`
- **No `export const dynamic`** — defaults to ISR-able static.
- **No `export const runtime`** — defaults to Node.
- Reads X via `await getSnapshot(365)` (line 14).
- Hides the X panel entirely when `snapshot.channels.twitter.offline === true` (lines 30, 95–100, 113–120).

### Path B — JSON API route

- **File:** `apps/web/src/app/api/snapshot/route.ts`
- **Directives:**
  - `export const runtime = "nodejs";` (line 4)
  - `export const revalidate = 3600;` (line 8)
- **Method:** GET only.
- **Query param:** `?days=` clamped to `[7, 365]`.
- **Response headers:** `cache-control: public, s-maxage=3600, stale-while-revalidate=600` (line 19).
- Calls `await getSnapshot(days)` (line 16).

### Inner fetch caching

- The Nitter HTTP fetch is **uncached** (`cache: "no-store"`, twitter.ts:198) — see the inline comment about Next 14.2 + Node 20 cache-wrapper bug.
- The X_DATA_URL fetch **uses Next's fetch cache** (`next: { revalidate }`, twitter.ts:261).
- The route/page `revalidate = 3600` is what the comment at twitter.ts:184–189 relies on as the actual cache layer.

---

## 6. Where `X_LOGIN` is read (Item #5)

**Single read site:** `apps/web/src/lib/snapshot.ts:60`

```ts
const xLogin = process.env.X_LOGIN ?? "";
```

Passed downstream to `fetchTwitterDaysSafe(xLogin, tz, from, today)` (line 70). If empty, `fetchTwitterDaysSafe` (lines 126–129) warns and returns offline without calling `fetchTwitterDays`:

```ts
if (!login) {
  console.warn("[snapshot] X_LOGIN not set — Twitter panel will be hidden");
  return { days: fillMissingDays([], from, to), offline: true };
}
```

`twitter.ts:75–77` also defends in depth (would throw a hard error if reached with empty login), but it never is — `snapshot.ts` short-circuits first.

Documented in `.env.example:10` (`X_LOGIN=anishthite`).

---

## 7. Tests touching Twitter/X/Nitter (Item #6)

**There are none.**

```bash
find /Users/anishthite/workspace/commiter -type f \( -name "*.test.*" -o -name "*.spec.*" \) -not -path "*/node_modules/*"
# (empty output)
```

No `__tests__/`, no `tests/`, no `*.test.ts`, no `*.spec.ts`. The worker has no tests to update; if the migration adds tests, it'll be establishing the testing convention for the repo.

---

## 8. `TwitterFeedOfflineError` definition + catch sites (Item #7)

**Definition** — `apps/web/src/lib/twitter.ts:50–57`:

```ts
export class TwitterFeedOfflineError extends Error {
  attempts: Array<{ host: string; reason: string }>;
  constructor(attempts: Array<{ host: string; reason: string }>) {
    super(`Twitter feed offline; all Nitter hosts failed (${attempts.length})`);
    this.name = "TwitterFeedOfflineError";
    this.attempts = attempts;
  }
}
```

**Throw site** — `apps/web/src/lib/twitter.ts:140`:
```ts
throw new TwitterFeedOfflineError(attempts);
```

**Catch sites — exactly one production catch:**

`apps/web/src/lib/snapshot.ts:121–143`:
```ts
async function fetchTwitterDaysSafe(
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<TwitterFetchResult> {
  if (!login) {
    console.warn("[snapshot] X_LOGIN not set — Twitter panel will be hidden");
    return { days: fillMissingDays([], from, to), offline: true };
  }
  try {
    const days = await fetchTwitterDays({ login, tz, from, to });
    return { days, offline: false };
  } catch (err) {
    if (err instanceof TwitterFeedOfflineError) {
      console.warn(
        `[snapshot] Twitter feed offline; attempts=${JSON.stringify(err.attempts)}`
      );
      return { days: fillMissingDays([], from, to), offline: true };
    }
    console.warn("[snapshot] Twitter fetch threw — treating as offline:", err);
    return { days: fillMissingDays([], from, to), offline: true };
  }
}
```

Note the second `catch` arm (line 139) also swallows non-`TwitterFeedOfflineError` exceptions and degrades to offline — so the snapshot will degrade gracefully for *any* throw, not just the named sentinel.

---

## 9. The canonical "tweet/x-post" read-side type (Item #8)

There is **no** `Tweet`, `XPost`, or `Status` type in the codebase. The X data crosses the wire as the same `Day` type used for GitHub commits.

**`Day`** — `apps/web/src/lib/streak.ts:8` (quoted verbatim):

```ts
export type Day = { date: string; count: number };
```

**`ChannelSnapshot`** (per-channel wrapper) — `apps/web/src/lib/snapshot.ts:23–37` (verbatim):

```ts
export type ChannelSnapshot = {
  days: Day[];
  streak_current: number;
  streak_longest: number;
  today_count: number;
  /**
   * True when this channel has no live data source wired up and all the
   * counts below are zero-fill placeholders. Consumers (page.tsx) use
   * this to hide the panel entirely and avoid the AND-streak collapsing
   * to permanent zero. Omitted (undefined) when the channel rendered
   * from real data.
   */
  offline?: boolean;
};
```

**`Snapshot`** (top-level wire object) — `apps/web/src/lib/snapshot.ts:39–52` (verbatim):

```ts
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

**`Channel`** literal union — `apps/web/src/lib/streak.ts:17` (verbatim):

```ts
export type Channel = "github" | "twitter";
```

**Static-JSON wire shape** (accepted by `fetchTwitterDataUrl`):

```ts
// Either:
Day[]                           // = Array<{ date: string; count: number }>
// or wrapped:
{ days: Day[]; /* extra fields allowed (e.g. generated_at) */ }
```

Date strings must match `/^\d{4}-\d{2}-\d{2}$/` and rows outside `[from, to]` are dropped silently (twitter.ts:271–283).

---

## Architecture

```
                ┌───────────────────────────────────────────────────────┐
                │ apps/web/src/app/page.tsx          revalidate = 3600  │
                │ apps/web/src/app/api/snapshot/route.ts   "    "    "  │
                └─────────────────────┬─────────────────────────────────┘
                                      │ await getSnapshot(days)
                                      ▼
                ┌───────────────────────────────────────────────────────┐
                │ apps/web/src/lib/snapshot.ts                          │
                │   reads NERV_TZ, GITHUB_LOGIN, GITHUB_TOKEN, X_LOGIN  │
                │   Promise.all([ fetchGithubDays(…), fetchTwitterDaysSafe(…) ])
                │   ── fetchTwitterDaysSafe catches TwitterFeedOfflineError
                │      and substitutes zero-filled Day[] + offline:true │
                │   computes streaks via streak.ts, AND/OR combine      │
                └─────────────────────┬─────────────────────────────────┘
                                      │ fetchTwitterDays({login, tz, from, to})
                                      ▼
                ┌───────────────────────────────────────────────────────┐
                │ apps/web/src/lib/twitter.ts                           │
                │  Tier 1: X_DATA_URL  → fetchTwitterDataUrl → Day[]    │ ← keep
                │  Tier 2: X_NITTER_HOST → tryNitterHost     → Day[]    │ ← remove
                │  Tier 3: 4 public Nitter hosts (xcancel etc.)→ Day[]  │ ← remove
                │  Tier 4: throw TwitterFeedOfflineError                │ ← keep
                │  ───                                                  │
                │  parseRssToDays → dateKey(tz) → fillMissingDays       │
                └───────────────────────────────────────────────────────┘
                                      │ Day[]
                                      ▼
                ┌───────────────────────────────────────────────────────┐
                │ Heatmap render side (read-only consumers of Day[]):   │
                │  apps/web/src/lib/nerv/MagiPanel.tsx                  │
                │  apps/web/src/lib/nerv/Heatmap.tsx (via toWeeksGrid)  │
                │  apps/web/src/lib/heatmap.ts (toWeeksGrid, intensity) │
                │  apps/web/src/lib/oneliner.ts (today_count only)      │
                └───────────────────────────────────────────────────────┘
```

Key invariants the worker must preserve:

- `fetchTwitterDays` returns a **contiguous** `Day[]` from `from` to `to` inclusive (otherwise `combineDays` in `streak.ts:75` will throw on length mismatch).
- The set of `Day.date` strings must match GitHub's set element-for-element (`streak.ts:84` enforces `da.date !== db.date` throw).
- Dates are PT-bucketed (or whatever `NERV_TZ` is).
- The `TwitterFeedOfflineError` sentinel pathway must keep working — `snapshot.ts:135` and `page.tsx:30, 95` rely on `channels.twitter.offline === true` to hide the panel and switch combined-streak mode from `"and"` to `"or"`.

---

## Migration shape (suggested, not prescriptive)

Files the worker will likely touch:

| Action | Path | Why |
|---|---|---|
| MOD | `apps/web/src/lib/twitter.ts` | Strip tiers 2 and 3 (Nitter). Either (a) commit the JSON path-to-file fetcher in tier 1, or (b) read a checked-in file under `apps/web/public/x-days.json` via `fs/promises`. Keep `TwitterFeedOfflineError` and `FetchTwitterOpts`. |
| MAYBE-MOD | `apps/web/src/lib/snapshot.ts` | Probably untouched if `fetchTwitterDays` signature is preserved. Watch the warn message in line 128 referencing `X_LOGIN`. |
| MOD | `.env.example` | Drop `X_NITTER_HOST` block (lines 36–45). Possibly drop `X_LOGIN` if the static file is the only source (login is no longer used at render time — it'd move to the Action's env). |
| MOD | `apps/web/src/app/page.tsx` line 117 | Update the "x panel hidden" subscript referencing `X_NITTER_HOST`. |
| MOD | `README.md`, `PLAN.md`, `docs/SELF_HOST_NITTER.md` | Doc updates. SELF_HOST_NITTER.md becomes obsolete. |
| NEW | `.github/workflows/<name>.yml` | Daily cron, scrapes X, writes `days.json`, commits. Repo currently has no `.github/` dir at all. |
| NEW | `apps/web/public/x-days.json` (or wherever the Action writes) | The actual data file consumed at render time. |

Caching constraint to watch: if the worker reads a same-repo JSON file via `fs` instead of `fetch`, the Next route's `revalidate = 3600` no longer auto-stales the data on deploy. The Action committing → Vercel rebuild path is what refreshes it. Document this in the implementation notes.

---

## Constraints / Risks / Open Questions

- **No tests.** The migration won't break tests because there aren't any. Worker may want to add minimal smoke coverage for `fetchTwitterDataUrl` if they go that route.
- **`X_LOGIN` deletion blast radius.** If the worker removes `X_LOGIN` entirely (moves it to Action-only), check that `snapshot.ts:60` and `page.tsx:40` (the error-state hint) update together. Right now `X_LOGIN` empty == panel hidden, which is desired behavior — but the *page* still mentions `X_LOGIN` in its env-hint copy.
- **TZ boundary.** The static-JSON producer (the Action) MUST bucket in `America/Los_Angeles` (or whatever the deployment's `NERV_TZ` is). If the Action emits UTC days the heatmap will silently misalign — there is no re-bucketing on the server side.
- **Window length.** The default is 365 days; the route clamps to `[7, 365]`. The Action should publish at least the most recent year. Days outside `[from, to]` are silently dropped (twitter.ts:282), so over-publishing is fine.
- **Static file freshness on Vercel.** A daily Action commit triggers a Vercel rebuild → the new JSON ships with the deployment. The `revalidate = 3600` on the route is irrelevant for `fs`-read files. If the worker keeps the `X_DATA_URL` fetch path (pointing at a raw.githubusercontent.com URL of the committed JSON), Next's `next: { revalidate }` (twitter.ts:261) caches it 1 h, which is fine.
- **No GitHub Actions infrastructure exists.** `.github/` doesn't exist. Worker is greenfielding.

---

## Start Here

Open **`apps/web/src/lib/twitter.ts`** first. The entire fetcher lives in one ~310-line file. The `X_DATA_URL` tier (lines 85–106 calling `fetchTwitterDataUrl` lines 250–293) is already the architectural target — the migration is largely "promote tier 1 to authoritative, delete tiers 2 and 3, leave tier 4 in place." Then read `snapshot.ts:120–143` to confirm the one callsite still works against the trimmed module.
