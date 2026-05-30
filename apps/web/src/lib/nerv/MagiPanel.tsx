import type { ChannelSnapshot } from "../snapshot";
import { Heatmap } from "./Heatmap";

/**
 * One channel panel.
 *
 * Mobile: stats stack vertically (column) above the heatmap.
 * Desktop (sm:+): the three stats sit on one horizontal row —
 * `streak | today | longest` — sharing a single text baseline so the
 * numbers visually align. All three numbers use the same size on
 * desktop (text-5xl) so the row reads as one clean horizontal line
 * instead of a stair-step (the previous text-5xl/4xl/4xl split made
 * `streak` sit higher than the other two). The wider page container
 * (max-w-6xl) gives us the room to spread out.
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

      <div className="flex flex-col gap-5 sm:gap-6">
        <dl className="flex flex-col gap-4 sm:flex-row sm:items-baseline sm:gap-10">
          <div className="min-w-0">
            <dd className="text-nerv-orange text-4xl sm:text-5xl leading-none tabular-nums">
              {data.streak_current}
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/40">
              day streak
            </dt>
          </div>

          <div className="min-w-0">
            <dd
              className={
                "text-4xl sm:text-5xl leading-none tabular-nums " +
                (live ? "text-nerv-amber" : "text-nerv-text/50")
              }
            >
              {today}{" "}
              <span className="text-sm normal-case align-baseline">{unit}</span>
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/40">
              today
            </dt>
          </div>

          <div className="min-w-0">
            <dd className="text-4xl sm:text-5xl leading-none tabular-nums text-nerv-text/80">
              {data.streak_longest}{" "}
              <span className="text-sm normal-case align-baseline">days</span>
            </dd>
            <dt className="mt-1 text-[10px] uppercase tracking-widest text-nerv-text/40">
              longest
            </dt>
          </div>
        </dl>

        <div className="overflow-x-auto">
          <Heatmap days={data.days} />
        </div>
      </div>
    </section>
  );
}
