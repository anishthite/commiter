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

  const [ghDays, twDays] = await Promise.all([
    fetchGithubDays({ login: githubLogin, token: githubToken, from, to: today }),
    fetchTwitterDaysSafe(xLogin, tz, from, today),
  ]);

  const todayIndex = ghDays.length - 1;
  const ghStreak = computeStreak(ghDays, { today_index: todayIndex });
  const twStreak = computeStreak(twDays, { today_index: todayIndex });

  const combined = combineDays(ghDays, twDays, "and");
  const combinedStreak = computeStreak(combined, { today_index: todayIndex });

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
        days: twDays,
        streak_current: twStreak.current,
        streak_longest: twStreak.longest,
        today_count: twStreak.today_count,
      },
    },
    combined: {
      streak_current: combinedStreak.current,
      streak_longest: combinedStreak.longest,
      mode: "and",
    },
  };
}

/**
 * Catch `TwitterFeedOfflineError` and substitute a zero-filled day list
 * so the rest of the snapshot still renders. `X_LOGIN` missing surfaces
 * the same way — we log + treat as offline so the GitHub panel keeps
 * working in a fresh setup.
 */
async function fetchTwitterDaysSafe(
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<Day[]> {
  if (!login) {
    console.warn("[snapshot] X_LOGIN not set — Twitter panel will render empty");
    return fillMissingDays([], from, to);
  }
  try {
    return await fetchTwitterDays({ login, tz, from, to });
  } catch (err) {
    if (err instanceof TwitterFeedOfflineError) {
      console.warn(
        `[snapshot] Twitter feed offline; attempts=${JSON.stringify(err.attempts)}`
      );
      return fillMissingDays([], from, to);
    }
    console.warn("[snapshot] Twitter fetch threw — treating as offline:", err);
    return fillMissingDays([], from, to);
  }
}
