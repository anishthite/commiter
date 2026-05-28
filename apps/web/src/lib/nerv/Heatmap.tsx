import type { Day } from "ingest/src/streak";
import { intensity, toWeeksGrid } from "@/lib/heatmap";

/**
 * Bare heatmap — Phase 1.
 * 53x7 grid, orange-amber gradient, sharp squares.
 * No tooltips yet, no labels yet — Phase 3 will skin it.
 */
const CELL_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "#1a0a00", // dim — no activity
  1: "#3a1a00",
  2: "#8a3500",
  3: "#ff6600",
  4: "#ffaa33",
};

export function Heatmap({ days }: { days: Day[] }) {
  const weeks = toWeeksGrid(days);
  return (
    <div className="flex gap-[2px]" role="grid" aria-label="contribution heatmap">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[2px]" role="row">
          {week.map((cell, di) => {
            const level = cell ? intensity(cell.count) : 0;
            return (
              <div
                key={di}
                role="gridcell"
                title={cell ? `${cell.date} · ${cell.count}` : ""}
                className="w-[11px] h-[11px]"
                style={{ backgroundColor: CELL_COLORS[level] }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
