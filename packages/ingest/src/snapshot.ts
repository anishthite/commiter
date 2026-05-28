import type { Client } from "@libsql/client";
import {
  addDays,
  combineDays,
  computeStreak,
  dateKey,
  fillMissingDays,
  type Channel,
  type Day,
} from "./streak.js";

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

export async function loadChannelDays(
  client: Client,
  channel: Channel,
  from: string,
  to: string
): Promise<Day[]> {
  const res = await client.execute({
    sql: `SELECT date, count FROM daily_count
          WHERE channel = ? AND date >= ? AND date <= ?
          ORDER BY date ASC`,
    args: [channel, from, to],
  });
  const rows = res.rows.map((r) => ({
    date: String(r.date),
    count: Number(r.count) || 0,
  }));
  return fillMissingDays(rows, from, to);
}

export async function buildSnapshot(
  client: Client,
  opts: { tz: string; days?: number; now?: Date }
): Promise<Snapshot> {
  const days = Math.min(Math.max(opts.days ?? 365, 7), 365);
  const now = opts.now ?? new Date();
  const today = dateKey(now, opts.tz);
  const from = addDays(today, -(days - 1));

  const [ghDays, twDays] = await Promise.all([
    loadChannelDays(client, "github", from, today),
    loadChannelDays(client, "twitter", from, today),
  ]);

  const todayIndex = ghDays.length - 1;
  const ghStreak = computeStreak(ghDays, { today_index: todayIndex });
  const twStreak = computeStreak(twDays, { today_index: todayIndex });

  const combined = combineDays(ghDays, twDays, "and");
  const combinedStreak = computeStreak(combined, { today_index: todayIndex });

  return {
    generated_at: now.toISOString(),
    tz: opts.tz,
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
