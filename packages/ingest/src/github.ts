import type { Client } from "@libsql/client";
import { env, requireGithubToken } from "./env.js";

/**
 * GitHub GraphQL `contributionsCollection` ingestor.
 *
 * Pulls the 365-day contribution calendar exactly as it appears on the
 * user's github.com profile (private contribs included when the PAT has
 * `read:user`).
 *
 * Idempotent: re-running upserts on (channel, date), so cron repeats are
 * safe.
 */

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const QUERY = /* GraphQL */ `
  query ContribCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

type CalendarResponse = {
  data?: {
    user: {
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: number;
          weeks: Array<{
            contributionDays: Array<{ date: string; contributionCount: number }>;
          }>;
        };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
};

export type GithubIngestResult = {
  login: string;
  from: string;
  to: string;
  total: number;
  days_upserted: number;
};

export async function ingestGithub(
  client: Client,
  opts?: { login?: string; days?: number; now?: Date }
): Promise<GithubIngestResult> {
  const token = requireGithubToken();
  const login = opts?.login ?? env.GITHUB_LOGIN;
  const days = Math.min(opts?.days ?? 365, 365);
  const now = opts?.now ?? new Date();

  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nerv-shipping-tracker",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { login, from, to },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GraphQL ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as CalendarResponse;
  if (json.errors && json.errors.length) {
    throw new Error(
      `GitHub GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) {
    throw new Error(`No contribution calendar returned for login=${login}`);
  }

  const updatedAt = Date.now();
  let count = 0;

  // libSQL batch is faster than N round-trips.
  const stmts = [];
  for (const w of cal.weeks) {
    for (const d of w.contributionDays) {
      stmts.push({
        sql: `INSERT INTO daily_count (channel, date, count, updated_at)
              VALUES ('github', ?, ?, ?)
              ON CONFLICT(channel, date)
              DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
        args: [d.date, d.contributionCount, updatedAt],
      });
      count++;
    }
  }

  // Stamp last sync.
  stmts.push({
    sql: `INSERT INTO meta(k, v) VALUES('github_last_sync_ms', ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    args: [String(updatedAt)],
  });
  stmts.push({
    sql: `INSERT INTO meta(k, v) VALUES('github_login', ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    args: [login],
  });

  await client.batch(stmts, "write");

  return {
    login,
    from: from.slice(0, 10),
    to: to.slice(0, 10),
    total: cal.totalContributions,
    days_upserted: count,
  };
}
