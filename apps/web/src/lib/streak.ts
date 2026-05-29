/**
 * Pure streak math. No I/O. Unit-testable.
 *
 * A `Day` is { date: 'YYYY-MM-DD', count: number }.
 * Days must be sorted ascending and cover a contiguous range (caller's
 * responsibility — see `fillMissingDays` below).
 */

export type Day = { date: string; count: number };

export type ChannelStreak = {
  current: number;
  longest: number;
  today_count: number;
};

export type Channel = "github" | "twitter";

/** A day "ships" when count >= threshold (default 1). */
export function isShipDay(d: Day, threshold = 1): boolean {
  return d.count >= threshold;
}

/**
 * Compute current + longest streak for a sorted-ascending day list.
 *
 * `now` and `cutoff_hour_local` together implement the grace rule:
 *   if today hasn't shipped yet and the local clock is before cutoff,
 *   treat today as "pending" — don't break the streak on today, walk
 *   from yesterday.
 *
 * For v1 the PLAN says no grace period, so cutoff defaults to 0 (off).
 */
export function computeStreak(
  days: Day[],
  opts: {
    threshold?: number;
    /** index in `days` that represents "today" (0..days.length-1). */
    today_index: number;
    /** if true, today is allowed to be a non-ship without breaking the streak. */
    today_pending?: boolean;
  }
): ChannelStreak {
  const threshold = opts.threshold ?? 1;
  const ti = opts.today_index;
  const today = days[ti];
  if (!today) {
    return { current: 0, longest: 0, today_count: 0 };
  }

  // Current streak: walk backward from today (or yesterday if pending).
  let i = ti;
  if (!isShipDay(today, threshold) && opts.today_pending) {
    i = ti - 1; // skip today entirely
  }
  let current = 0;
  for (; i >= 0; i--) {
    const d = days[i]!;
    if (isShipDay(d, threshold)) current++;
    else break;
  }

  // Longest streak: single pass over the visible window.
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (isShipDay(d, threshold)) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  return { current, longest, today_count: today.count };
}

/**
 * Combine two channels day-by-day under AND/OR.
 * `a` and `b` must be the same length and aligned (same dates).
 */
export function combineDays(
  a: Day[],
  b: Day[],
  mode: "and" | "or" = "and",
  threshold = 1
): Day[] {
  if (a.length !== b.length) {
    throw new Error(`combineDays: length mismatch (${a.length} vs ${b.length})`);
  }
  const out: Day[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const da = a[i]!;
    const db = b[i]!;
    if (da.date !== db.date) {
      throw new Error(`combineDays: date mismatch at ${i}: ${da.date} vs ${db.date}`);
    }
    const shipA = da.count >= threshold;
    const shipB = db.count >= threshold;
    const ship = mode === "and" ? shipA && shipB : shipA || shipB;
    out[i] = { date: da.date, count: ship ? 1 : 0 };
  }
  return out;
}

// ----------------------------------------------------------------------------
// Calendar helpers (TZ-aware)
// ----------------------------------------------------------------------------

/** Returns 'YYYY-MM-DD' for the given Date in the given IANA tz. */
export function dateKey(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD natively.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Add `n` days to a 'YYYY-MM-DD' string. Pure date math, no tz. */
export function addDays(yyyymmdd: string, n: number): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number) as [number, number, number];
  // Use UTC math to dodge DST.
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const nd = new Date(t);
  const yy = nd.getUTCFullYear();
  const mm = String(nd.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(nd.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Build a contiguous ascending day list covering [from, to] inclusive. */
export function fillMissingDays(
  rows: Array<{ date: string; count: number }>,
  from: string,
  to: string
): Day[] {
  // String comparison works for 'YYYY-MM-DD'. Reject inverted ranges
  // explicitly — the 800-iteration safety cap below would otherwise
  // silently fabricate a year of garbage.
  if (to < from) {
    throw new Error(`fillMissingDays: to (${to}) is before from (${from})`);
  }

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.date, r.count);

  const out: Day[] = [];
  let cursor = from;
  // Guard against pathological ranges.
  for (let i = 0; i < 800; i++) {
    out.push({ date: cursor, count: map.get(cursor) ?? 0 });
    if (cursor === to) break;
    cursor = addDays(cursor, 1);
  }
  return out;
}
