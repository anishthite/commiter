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
      <header className="flex items-center justify-between mb-3 gap-3">
        <div className="text-nerv-orange text-xs tracking-widest uppercase">
          {label}
        </div>
        <div
          aria-hidden
          className={
            "w-2 h-2 rounded-full " +
            (live ? "bg-nerv-amber" : "bg-nerv-text/40")
          }
          title={live ? `shipped today` : `no activity today`}
        />
      </header>

      <div className="flex flex-col gap-4">
        <dl className="flex flex-row items-baseline gap-4 sm:gap-8 flex-wrap">
          <div className="min-w-0">
            <dd className="text-nerv-orange text-3xl sm:text-5xl leading-none tabular-nums">
              {data.streak_current}
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/70">
              day streak
            </dt>
          </div>

          <div className="min-w-0">
            <dd
              className={
                "text-3xl sm:text-5xl leading-none tabular-nums " +
                (live ? "text-nerv-amber" : "text-nerv-text/80")
              }
            >
              {today}{" "}
              <span className="text-xs sm:text-sm normal-case align-baseline">{unit}</span>
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/70">
              today
            </dt>
          </div>

          <div className="min-w-0">
            <dd className="text-3xl sm:text-5xl leading-none tabular-nums text-nerv-text">
              {data.streak_longest}{" "}
              <span className="text-xs sm:text-sm normal-case align-baseline">days</span>
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/70">
              longest
            </dt>
          </div>
        </dl>

        {/* No overflow wrapper here — that's what introduced the second
            scrollbar inside the panel. The heatmap is narrow enough to
            sit in the column on mobile; if it ever overflows it can
            spill into the page's natural scroll instead. */}
        <Heatmap days={data.days} />
      </div>
    </section>
  );
}
