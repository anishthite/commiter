import type { ChannelSnapshot } from "ingest/src/snapshot";
import { Heatmap } from "./Heatmap";

/**
 * One MAGI panel — Phase 1 bare skin.
 * Phase 3 will add hex corners, scanlines, the big glowing streak number, etc.
 */
export function MagiPanel({
  name,
  subtitle,
  data,
}: {
  name: string;
  subtitle: string;
  data: ChannelSnapshot;
}) {
  const today = data.today_count;
  const pattern = today > 0 ? "BLUE" : "ORANGE";

  return (
    <section className="border border-nerv-grid p-6 bg-black">
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <div className="text-nerv-orange text-sm tracking-widest uppercase">
            {name}
          </div>
          <div className="text-xs text-nerv-text/60 uppercase tracking-wider">
            {subtitle}
          </div>
        </div>
        <div
          className={
            "text-xs tracking-widest " +
            (today > 0 ? "text-nerv-amber" : "text-nerv-warn")
          }
        >
          PATTERN: {pattern}
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-4 mb-6 text-sm">
        <div>
          <dt className="text-nerv-text/60 uppercase text-[10px] tracking-widest">
            Streak
          </dt>
          <dd className="text-nerv-orange text-3xl">
            {String(data.streak_current).padStart(3, "0")}
          </dd>
        </div>
        <div>
          <dt className="text-nerv-text/60 uppercase text-[10px] tracking-widest">
            Longest
          </dt>
          <dd className="text-nerv-text text-3xl">
            {String(data.streak_longest).padStart(3, "0")}
          </dd>
        </div>
        <div>
          <dt className="text-nerv-text/60 uppercase text-[10px] tracking-widest">
            Today
          </dt>
          <dd
            className={
              "text-3xl " + (today > 0 ? "text-nerv-amber" : "text-nerv-warn")
            }
          >
            {String(today).padStart(3, "0")}
          </dd>
        </div>
      </dl>

      <Heatmap days={data.days} />
    </section>
  );
}
