import type { Day } from "ingest/src/streak";

/**
 * Reshape a flat ascending day list into a GitHub-style 53x7 grid:
 *   columns = weeks (oldest -> newest, left -> right)
 *   rows    = day-of-week (Sun -> Sat, top -> bottom)
 *
 * Leading cells (before `days[0]`'s weekday) and trailing cells (after the
 * last day's weekday) are null so callers can render an empty cell.
 */
export type GridCell = Day | null;

export function toWeeksGrid(days: Day[]): GridCell[][] {
  if (days.length === 0) return [];

  // Day-of-week (0=Sun..6=Sat) for the first date, computed in UTC to dodge DST.
  const first = days[0]!.date;
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  const firstDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  // Build flat sequence with leading nulls so day 0 lands at row=firstDow.
  const flat: GridCell[] = [];
  for (let i = 0; i < firstDow; i++) flat.push(null);
  for (const day of days) flat.push(day);
  // Pad to a multiple of 7 for a clean rectangle.
  while (flat.length % 7 !== 0) flat.push(null);

  const weeks: GridCell[][] = [];
  for (let i = 0; i < flat.length; i += 7) {
    weeks.push(flat.slice(i, i + 7));
  }
  return weeks;
}

/** Bucket a count into 0..4 for the gradient. */
export function intensity(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count < 2) return 1;
  if (count < 5) return 2;
  if (count < 10) return 3;
  return 4;
}
