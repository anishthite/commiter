import type { Day } from "../streak";
import { intensity } from "../heatmap";

/**
 * Small horizontal strip heatmap for the summary page (D-029, 2026-06-01).
 *
 * Renders the trailing `windowDays` (default 90) as a single horizontal
 * row of small cells, oldest on the left, newest on the right. No axis
 * labels, no tooltips, no day-of-week alignment. The full Heatmap
 * component is still used on /[user] for the detail view.
 *
 * Mobile fit: 90 cells × 6px + 89 × 1px gap ≈ 629px. Capped at the parent
 * width with `overflow-x-auto` so it scrolls horizontally on a phone
 * narrower than that. The wrapper's max-width keeps it from spilling out
 * of the summary card.
 */

const CELL_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "#1a0a00",
  1: "#3a1a00",
  2: "#8a3500",
  3: "#ff6600",
  4: "#ffaa33",
};

export type MiniHeatmapProps = {
  days: Day[];
  windowDays?: number;
  cellPx?: number;
  gapPx?: number;
};

export function MiniHeatmap({
  days,
  windowDays = 90,
  cellPx = 6,
  gapPx = 1,
}: MiniHeatmapProps) {
  // Take the trailing `windowDays` so the visualization is "recent activity"
  // regardless of how long the input series is.
  const trimmed = days.slice(-windowDays);

  return (
    <div
      className="overflow-x-auto"
      style={{ WebkitOverflowScrolling: "touch" }}
      role="img"
      aria-label={`Last ${trimmed.length} days of activity`}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${trimmed.length}, ${cellPx}px)`,
          gap: `${gapPx}px`,
        }}
      >
        {trimmed.map((day) => {
          const level = intensity(day.count);
          return (
            <div
              key={day.date}
              style={{
                width: cellPx,
                height: cellPx,
                backgroundColor: CELL_COLORS[level],
                borderRadius: 1,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
