import type { Day } from "../streak";
import { intensity, toWeeksGrid } from "@/lib/heatmap";

/**
 * Vertical heatmap, reverse-chronological.
 *   - Day-of-week initials along the top.
 *   - Month tick labels along the left (only when a new month begins).
 *   - Each cell shows a styled tooltip on hover: "YYYY-MM-DD · N".
 */

const CELL_PX = 14;
const GAP_PX = 2;
const LABEL_COL_PX = 30; // room for "Jan", "Feb", etc.

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_ABBR = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Backgrounds keyed by intensity level (0..4).
const CELL_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "#1a0a00",
  1: "#3a1a00",
  2: "#8a3500",
  3: "#ff6600",
  4: "#ffaa33",
};

/**
 * For each week (already in reverse-chrono order), produce either a month
 * abbreviation (when this week introduces a new month vs the previous one)
 * or null.
 */
function buildMonthTicks(reversedWeeks: ReturnType<typeof toWeeksGrid>): (string | null)[] {
  const ticks: (string | null)[] = [];
  let prevMonth = -1;
  for (const week of reversedWeeks) {
    const first = week.find((c) => c !== null);
    if (!first) {
      ticks.push(null);
      continue;
    }
    // date is "YYYY-MM-DD"; month index is chars 5..7 minus 1
    const m = Number(first.date.slice(5, 7)) - 1;
    if (m !== prevMonth) {
      ticks.push(MONTH_ABBR[m] ?? null);
      prevMonth = m;
    } else {
      ticks.push(null);
    }
  }
  return ticks;
}

export function Heatmap({ days }: { days: Day[] }) {
  const weeks = toWeeksGrid(days).slice().reverse();
  const ticks = buildMonthTicks(weeks);

  return (
    <div
      className="inline-flex flex-col font-mono text-[9px] text-nerv-text/70"
      role="grid"
      aria-label="contribution heatmap (newest first)"
    >
      {/* Day-of-week header row, offset to align with the heatmap cells. */}
      <div
        className="flex mb-1.5"
        style={{ paddingLeft: LABEL_COL_PX + GAP_PX, gap: GAP_PX }}
      >
        {DAY_INITIALS.map((d, i) => (
          <div
            key={i}
            className="text-center uppercase tracking-widest"
            style={{ width: CELL_PX }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Heatmap rows: [month label] [7 day cells]. */}
      <div className="flex flex-col" style={{ gap: GAP_PX }}>
        {weeks.map((week, wi) => (
          <div
            key={wi}
            className="flex items-center"
            style={{ gap: GAP_PX }}
            role="row"
          >
            <div
              className="text-right uppercase tracking-widest text-nerv-orange/80 pr-1.5"
              style={{ width: LABEL_COL_PX }}
            >
              {ticks[wi] ?? ""}
            </div>
            {week.map((cell, di) => {
              const level = cell ? intensity(cell.count) : 0;
              return (
                <div
                  key={di}
                  className="relative group"
                  role="gridcell"
                  style={{ width: CELL_PX, height: CELL_PX }}
                >
                  <div
                    className="w-full h-full"
                    style={{ backgroundColor: CELL_COLORS[level] }}
                  />
                  {cell && (
                    <div
                      className={
                        "absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1.5 " +
                        "px-2 py-1 bg-black border border-nerv-orange/70 " +
                        "text-[10px] font-mono uppercase tracking-widest text-nerv-orange " +
                        "whitespace-nowrap opacity-0 group-hover:opacity-100 " +
                        "transition-opacity pointer-events-none"
                      }
                    >
                      {cell.date} · {cell.count}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
