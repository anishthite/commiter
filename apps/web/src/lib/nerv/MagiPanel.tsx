import type { ChannelSnapshot } from "../snapshot";
import { Heatmap } from "./Heatmap";

/**
 * One channel panel. Borderless, on the same horizontal baseline as
 * everything else on the page. Stats sit on one row (streak | today |
 * longest) on every viewport — no mobile column stack — to honor the
 * "keep everything on the same horizontal line" directive.
 */
export function MagiPanel({
  label,
  unit,
  data,
}: {
  label: string;
  unit: string;
  data: ChannelSnapshot;
}) {
  const today = data.today_count;
  const live = today > 0;

  return (
    <section className="bg-transparent p-2 sm:p-3 min-w-0">
      <header className="mb-3">
        <div className="text-nerv-orange text-xs tracking-widest uppercase">
          {label}
        </div>
      </header>

      <div className="flex flex-col gap-4">
        {/* All three stat blocks share one baseline; each block keeps its
            big number, its unit, and its small caption on a single row.
            `nowrap` on the inner row prevents the unit from wrapping under
            the number on narrow viewports. */}
        <dl className="flex flex-row items-baseline gap-4 sm:gap-6 flex-wrap">
          <div className="min-w-0 flex items-baseline gap-2 flex-nowrap whitespace-nowrap">
            <dd className="text-nerv-orange text-3xl sm:text-5xl leading-none tabular-nums">
              {data.streak_current}
            </dd>
            <dt className="text-[10px] uppercase tracking-widest text-nerv-text/70">
              day streak
            </dt>
          </div>

          <div className="min-w-0 flex items-baseline gap-2 flex-nowrap whitespace-nowrap">
            <dd
              className={
                "text-3xl sm:text-5xl leading-none tabular-nums " +
                (live ? "text-nerv-amber" : "text-nerv-text/80")
              }
            >
              {today}
            </dd>
            <span className="text-xs sm:text-sm normal-case text-nerv-text/80">{unit}</span>
            <dt className="text-[10px] uppercase tracking-widest text-nerv-text/70">
              today
            </dt>
          </div>

          <div className="min-w-0 flex items-baseline gap-2 flex-nowrap whitespace-nowrap">
            <dd className="text-3xl sm:text-5xl leading-none tabular-nums text-nerv-text">
              {data.streak_longest}
            </dd>
            <span className="text-xs sm:text-sm normal-case text-nerv-text/80">days</span>
            <dt className="text-[10px] uppercase tracking-widest text-nerv-text/70">
              longest
            </dt>
          </div>
        </dl>

        {/* Center the contribution heatmap horizontally within the panel
            column. The heatmap itself is inline-flex so it intrinsically
            sizes to its content; flex justify-center handles the centering. */}
        <div className="flex justify-center w-full">
          <Heatmap days={data.days} />
        </div>
      </div>
    </section>
  );
}
