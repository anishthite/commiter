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
import { USERS, getUserBySlug, type UserConfig } from "@/config/users";

/**
 * Stateless snapshot composer.
 *
 * Fetches GitHub + Twitter in parallel (each cached 1h at the fetch
 * layer), runs the streak math in-memory, and returns the wire-compatible
 * `Snapshot` shape that `MagiPanel` and `Heatmap` already consume (D-006).
 *
 * Multi-user (D-026, 2026-06-01): the composer now takes an explicit user
 * (slug + GH login + X login) instead of reading env. The legacy single-
 * arg call `getSnapshot(days)` resolves the user from `GITHUB_LOGIN` /
 * `X_LOGIN` env vars to keep the old API/route working as a fallback.
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
  user: {
    slug: string;
    displayName: string;
    githubLogin: string;
    xLogin: string;
  };
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

export type GetSnapshotOpts = {
  user: UserConfig;
  days?: number;
};

/**
 * Resolve a user from a slug, or from `GITHUB_LOGIN` / `X_LOGIN` env as a
 * fallback when no slug is given. Falls back to the first user in the
 * roster if all else fails — keeps a misconfigured `/` (legacy path) from
 * crashing.
 */
export function resolveUser(slug?: string): UserConfig {
  if (slug) {
    const u = getUserBySlug(slug);
    if (u) return u;
  }
  const envGh = process.env.GITHUB_LOGIN?.trim() || "";
  const envX = process.env.X_LOGIN?.trim() || "";
  if (envGh) {
    const match = USERS.find((u) => u.githubLogin === envGh);
    if (match) return match;
    return {
      slug: "env",
      displayName: envGh,
      githubLogin: envGh,
      xLogin: envX,
    };
  }
  if (USERS.length === 0) {
    // Empty roster: nothing to render and no env match either. Throw a
    // clear error rather than the misleading `Cannot read properties of
    // undefined` we'd get from `USERS[0]!`. Reviewer-flagged 2026-06-01.
    throw new Error(
      "user roster is empty (apps/web/src/config/users.json must have at least one user)"
    );
  }
  return USERS[0]!;
}

export async function getSnapshot(arg: number | GetSnapshotOpts = 365): Promise<Snapshot> {
  const opts: GetSnapshotOpts =
    typeof arg === "number" ? { user: resolveUser(), days: arg } : arg;
  const user = opts.user;
  const daysRequested = opts.days ?? 365;

  const tz = process.env.NERV_TZ ?? DEFAULT_TZ;
  const githubToken = process.env.GITHUB_TOKEN ?? "";

  // Preserve S13: clamp to [7, 365] at the composer (route/page also clamp).
  const days = Math.min(Math.max(daysRequested, 7), 365);
  const now = new Date();
  const today = dateKey(now, tz);
  const from = addDays(today, -(days - 1));

  const [ghDays, twResult] = await Promise.all([
    fetchGithubDays({ login: user.githubLogin, token: githubToken, from, to: today }),
    fetchTwitterDaysSafe(user.slug, user.xLogin, tz, from, today),
  ]);

  const todayIndex = ghDays.length - 1;
  const ghStreak = computeStreak(ghDays, { today_index: todayIndex, today_pending: true });
  const twStreak = computeStreak(twResult.days, { today_index: todayIndex, today_pending: true });

  const combinedDays = twResult.offline
    ? ghDays
    : combineDays(ghDays, twResult.days, "and");
  const combinedStreak = computeStreak(combinedDays, { today_index: todayIndex, today_pending: true });

  return {
    generated_at: now.toISOString(),
    tz,
    range: { from, to: today, days },
    user: {
      slug: user.slug,
      displayName: user.displayName,
      githubLogin: user.githubLogin,
      xLogin: user.xLogin,
    },
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

type TwitterFetchResult = { days: Day[]; offline: boolean };

async function fetchTwitterDaysSafe(
  slug: string,
  login: string,
  tz: string,
  from: string,
  to: string
): Promise<TwitterFetchResult> {
  if (!login) {
    console.warn(
      `[snapshot] xLogin not set for slug=${slug} — Twitter panel will be hidden`
    );
    return { days: fillMissingDays([], from, to), offline: true };
  }
  try {
    const days = await fetchTwitterDays({ slug, login, tz, from, to });
    return { days, offline: false };
  } catch (err) {
    if (err instanceof TwitterFeedOfflineError) {
      console.warn(
        `[snapshot] Twitter feed offline for slug=${slug}; attempts=${JSON.stringify(err.attempts)}`
      );
      return { days: fillMissingDays([], from, to), offline: true };
    }
    console.warn(`[snapshot] Twitter fetch threw for slug=${slug} — treating as offline:`, err);
    return { days: fillMissingDays([], from, to), offline: true };
  }
}
