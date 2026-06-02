import Link from "next/link";
import { getSnapshot } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/snapshot";
import { MiniHeatmap } from "@/lib/nerv/MiniHeatmap";
import { ThemeToggle } from "@/lib/nerv/ThemeToggle";
import { USERS, type UserConfig } from "@/config/users";

// Summary page — both/all users at a glance (D-027/D-028, 2026-06-01).
// SSR with the same 1h revalidate as the per-user route; the underlying
// fetches are cached at the fetch layer so two users = ~2× GH calls, not
// 2× per-render compute.
export const revalidate = 3600;

type UserCardData = {
  user: UserConfig;
  snapshot: Snapshot | null;
  error: string | null;
};

async function loadAll(): Promise<UserCardData[]> {
  return Promise.all(
    USERS.map(async (user): Promise<UserCardData> => {
      try {
        const snapshot = await getSnapshot({ user, days: 365 });
        return { user, snapshot, error: null };
      } catch (e) {
        return {
          user,
          snapshot: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })
  );
}

export default async function SummaryPage() {
  const cards = await loadAll();
  const generated = cards.find((c) => c.snapshot)?.snapshot?.generated_at ?? "";

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 sm:py-12 max-w-4xl mx-auto">
      <header className="mb-6 sm:mb-10 flex items-baseline justify-between gap-3">
        <h1 className="text-nerv-amber text-xl sm:text-3xl lowercase font-mono tracking-tight">
          did we ship today?
        </h1>
        <ThemeToggle />
      </header>

      <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <UserCard key={card.user.slug} card={card} />
        ))}
      </div>

      {generated && (
        <footer className="mt-8 text-[10px] uppercase tracking-widest text-nerv-text/60">
          {generated.slice(0, 10)} · {generated.slice(11, 16)}Z
        </footer>
      )}
    </main>
  );
}

function isShipped(snapshot: Snapshot | null): boolean {
  if (!snapshot) return false;
  const ghToday = snapshot.channels.github.today_count;
  const xToday = snapshot.channels.twitter.today_count;
  const xOffline = snapshot.channels.twitter.offline === true;
  return xOffline ? ghToday > 0 : ghToday > 0 && xToday > 0;
}

function UserCard({ card }: { card: UserCardData }) {
  const { user, snapshot, error } = card;
  const shipped = isShipped(snapshot);
  const streak = snapshot?.combined.streak_current ?? 0;

  // The combined-days series is the right input for the heatmap on the
  // summary: it's the visual answer to "did they ship that day?" matching
  // the same yes/no question this card is asking. When Twitter's offline
  // the snapshot already degrades combined to github-only.
  // We approximate by intersecting per-channel days here so we don't have
  // to widen the Snapshot wire shape just for the summary view.
  const heatmapDays = snapshot ? deriveCombinedDays(snapshot) : [];

  return (
    <Link
      href={`/${user.slug}`}
      // Whole card is a tap target. min-h on mobile so the tap zone is
      // generous even before the heatmap row. focus-visible ring rather
      // than a 1px border swap so keyboard focus is actually perceivable
      // (reviewer-flagged 2026-06-01).
      className={
        "block p-4 sm:p-5 rounded-md transition-colors " +
        "border border-nerv-text/25 hover:border-nerv-amber/60 " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-nerv-amber focus-visible:border-nerv-amber " +
        "active:border-nerv-amber min-h-[8rem]"
      }
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-nerv-amber text-sm sm:text-base lowercase font-mono tracking-tight truncate">
          {user.displayName}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-nerv-text/50 shrink-0">
          {user.githubLogin}
        </span>
      </div>

      {error ? (
        <div className="text-nerv-warn text-xs font-mono mt-2 whitespace-pre-wrap break-words">
          sys:fault — {error.slice(0, 80)}
          {error.length > 80 ? "…" : ""}
        </div>
      ) : snapshot ? (
        <>
          <div className="flex items-baseline gap-3 sm:gap-4">
            <span
              className={
                "text-4xl sm:text-5xl font-mono leading-none tabular-nums " +
                (shipped ? "text-nerv-amber" : "text-nerv-orange")
              }
            >
              {shipped ? "yes." : "no."}
            </span>
            <span className="text-nerv-text/90 font-mono lowercase text-sm sm:text-base">
              <span className="text-nerv-amber text-lg sm:text-xl tabular-nums">
                {streak}
              </span>
              <span className="text-nerv-text/70"> day streak</span>
            </span>
          </div>

          <div className="mt-3 sm:mt-4">
            {/* 25d at 8px+2px = 248px — fits inside the 320px-viewport card */}
            {/* content area (~256px). Avoids the swipe-vs-tap conflict that */}
            {/* an overflowing horizontal-scroll heatmap inside a <Link> would */}
            {/* cause. Bumped from 5px/42d (2026-06-02 round 2) — still too */}
            {/* small to read at a glance; ~3.5 weeks is the recent-rhythm cue, */}
            {/* full history lives on /[user]. */}
            <MiniHeatmap days={heatmapDays} windowDays={25} cellPx={8} gapPx={2} />
          </div>

          {snapshot.channels.twitter.offline && (
            <p className="mt-2 text-[9px] uppercase tracking-widest text-nerv-text/40">
              x offline · github-only streak
            </p>
          )}
        </>
      ) : (
        <div className="text-nerv-text/40 text-xs">no data</div>
      )}
    </Link>
  );
}

/**
 * Approximate the same combined-days series the per-channel composer uses.
 * Aligned by date: same date arrays come out of `fillMissingDays` for both
 * channels, so a zip-AND is faithful to the snapshot's combined view.
 * When Twitter is offline, fall back to github-only — same degradation
 * mode as `snapshot.ts`.
 */
function deriveCombinedDays(snapshot: Snapshot) {
  const gh = snapshot.channels.github.days;
  const tw = snapshot.channels.twitter.days;
  if (snapshot.channels.twitter.offline) return gh;
  if (gh.length !== tw.length) {
    // Defensive: gh/tw days come from the same fillMissingDays(from, to)
    // call, so this is currently unreachable. Logging makes future
    // regressions surface in dev rather than silently degrading to GH-only.
    // eslint-disable-next-line no-console
    console.warn(
      `[summary] gh/tw day-array length mismatch for ${snapshot.user.slug}: ${gh.length} vs ${tw.length}`
    );
    return gh;
  }
  return gh.map((d, i) => ({
    date: d.date,
    count: d.count > 0 && (tw[i]?.count ?? 0) > 0 ? Math.min(d.count, tw[i]!.count) : 0,
  }));
}
