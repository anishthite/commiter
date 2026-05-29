import type { ChannelSnapshot } from "../snapshot";
import { Heatmap } from "./Heatmap";

/**
 * One channel panel — internal layout is horizontal:
 *   [ stats (left) | heatmap (right) ]
 * Stats sit top-aligned so the streak number lands directly under the
 * panel header — that's the lede; the heatmap is supporting context.
 * Panels themselves are stacked on mobile and side-by-side on `sm:`
 * via the page-level grid.
 *
 * `unit` is the noun used after `today_count` ("commits" / "tweets" /
 * etc.) so the panel can speak the channel's language without the page
 * having to know about it.
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
    <section className="border border-nerv-grid bg-black p-3 sm:p-4">
      <header className="flex items-center justify-between mb-4 gap-3">
        <div className="text-nerv-orange text-xs tracking-widest uppercase">
          {label}
        </div>
        <div
          aria-hidden
          className={
            "w-2 h-2 rounded-full " +
            (live ? "bg-nerv-amber" : "bg-nerv-text/20")
          }
          title={live ? `shipped today` : `no activity today`}
        />
      </header>

      <div className="flex gap-4 sm:gap-5 items-start">
        <dl className="flex-1 flex flex-col gap-4 min-w-0">
          <div>
            <dd className="text-nerv-orange text-4xl sm:text-5xl leading-none tabular-nums">
              {String(data.streak_current).padStart(3, "0")}
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/40">
              day streak
            </dt>
          </div>

          <div>
            <dd
              className={
                "text-xl sm:text-2xl tabular-nums " +
                (live ? "text-nerv-amber" : "text-nerv-text/50")
              }
            >
              {today} <span className="text-sm normal-case">{unit}</span>
            </dd>
            <dt className="mt-0.5 text-[10px] uppercase tracking-widest text-nerv-text/40">
              today
            </dt>
          </div>

          <div>
            <dd className="text-xl sm:text-2xl tabular-nums text-nerv-text/80">
              {data.streak_longest}{" "}
              <span className="text-sm normal-case">days</span>
            </dd>
            <dt className="mt-0.5 text-[10px] uppercase tracking-widest text-nerv-text/40">
              longest
            </dt>
          </div>
        </dl>

        <Heatmap days={data.days} />
      </div>
    </section>
  );
}
