import "server-only";
import { fetchGithubDays } from "./github";
import { fetchTwitterDays, TwitterFeedOfflineError } from "./twitter";
import {
  addDays,
  combineDays,
  computeStreak,
  dateKey,
  fillMissingDays,
  type Day,
} from "./streak";

/**
 * Stateless snapshot composer.
 *
 * Fetches GitHub + Twitter in parallel (each cached 1h at the fetch
 * layer), runs the streak math in-memory, and returns the wire-compatible
 * `Snapshot` shape that `MagiPanel` and `Heatmap` already consume (D-006).
 *
 * "Combined AND" streak is preserved per D-009 — UI revision (D-003) is a
 * separable follow-up.
 */

export type ChannelSnapshot = {
  days: Day[];
  streak_current: number;
  streak_longest: number;
  today_count: number;
  /**
   * True when this channel has no live data source wired up and all the
   * counts below are zero-fill placeholders. Consumers (page.tsx) use
   * this to hide the panel entirely and avoid the AND-streak collapsing
   * to permanent zero. Omitted (undefined) when the channel rendered
   * from real data.
   */
  offline?: boolean;
};

export type Snapshot = {
  generated_at: string; // ISO
  tz: string;
  range: { from: string; to: string; days: number };
  channels: {
    github: ChannelSnapshot;
    twitter: ChannelSnapshot;
  };
  combined: {
    streak_current: number;
    streak_longest: number;
    mode: "and" | "or";
  };
};

const DEFAULT_TZ = "America/Los_Angeles";

export async function getSnapshot(daysRequested = 365): Promise<Snapshot> {
  const tz = process.env.NERV_TZ ?? DEFAULT_TZ;
  const githubLogin = process.env.GITHUB_LOGIN ?? "anishthite";
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const xLogin = process.env.X_LOGIN ?? "";

  // Preserve S13: clamp to [7, 365] at the composer (route/page also clamp).
  const days = Math.min(Math.max(daysRequested, 7), 365);
  const now = new Date();
  const today = dateKey(now, tz);
  const from = addDays(today, -(days - 1));

  const [ghDays, twResult] = await Promise.all([
    fetchGithubDays({ login: githubLogin, token: githubToken, from, to: today }),
    fetchTwitterDaysSafe(xLogin, tz, from, today),
  ]);

  const todayIndex = ghDays.length - 1;
  const ghStreak = computeStreak(ghDays, { today_index: todayIndex });
  const twStreak = computeStreak(twResult.days, { today_index: todayIndex });

  // When the Twitter source is offline (no scraper wired up, fallbacks
  // all failed), the AND-streak across both channels would collapse to
  // permanent zero. That's misleading — GitHub kept shipping, we just
  // can't see Twitter. Degrade gracefully to a github-only combined.
  const combinedDays = twResult.offline
    ? ghDays
    : combineDays(ghDays, twResult.days, "and");
  const combinedStreak = computeStreak(combinedDays, { today_index: todayIndex });

  return {
    generated_at: now.toISOString(),
    tz,
    range: { from, to: today, days },
    channels: {
      github: {
        days: ghDays,
        streak_current: ghStreak.current,
        streak_longest: ghStreak.longest,
        today_count: ghStreak.today_count,
      },
      twitter: {
        days: twResult.days,
        streak_current: twStreak.current,
        streak_longest: twStreak.longest,
        today_count: twStreak.today_count,
        ...(twResult.offline ? { offline: true } : {}),
      },
    },
    combined: {
      streak_current: combinedStreak.current,
      streak_longest: combinedStreak.longest,
      mode: twResult.offline ? "or" : "and",
    },
  };
}

/**
 * Catch `TwitterFeedOfflineError` and substitute a zero-filled day list
 * so the rest of the snapshot still renders. `X_LOGIN` missing surfaces
 * the same way — we log + treat as offline so the GitHub panel keeps
 * working in a fresh setup.
 */
type TwitterFetchResult = { days: Day[]; offline: boolean };

async function fetchTwitterDaysSafe(
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<TwitterFetchResult> {
  if (!login) {
    console.warn(
      "[snapshot] X_LOGIN not set — Twitter panel will be hidden (set X_LOGIN to enable; data file is bundled at apps/web/src/data/x-days.json)"
    );
    return { days: fillMissingDays([], from, to), offline: true };
  }
  try {
    const days = await fetchTwitterDays({ login, tz, from, to });
    return { days, offline: false };
  } catch (err) {
    if (err instanceof TwitterFeedOfflineError) {
      console.warn(
        `[snapshot] Twitter feed offline; attempts=${JSON.stringify(err.attempts)}`
      );
      return { days: fillMissingDays([], from, to), offline: true };
    }
    console.warn("[snapshot] Twitter fetch threw — treating as offline:", err);
    return { days: fillMissingDays([], from, to), offline: true };
  }
}
