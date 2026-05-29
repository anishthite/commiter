import "server-only";
import { addDays, fillMissingDays, type Day } from "./streak";

/**
 * GitHub GraphQL `contributionsCollection` fetcher (stateless).
 *
 * Returns a contiguous ascending `Day[]` aligned to the caller's tz-keyed
 * window. The fetch is cached at the Next.js fetch layer with a 1h
 * revalidate window (D-004); per-request streak math is in `snapshot.ts`.
 *
 * Per D-008: we fetch one extra day on the leading edge so the tz-aligned
 * range is fully covered without day-boundary skew, then trim back to
 * `[from, to]` via `fillMissingDays`.
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

export type FetchGithubOpts = {
  /** GitHub login (handle). */
  login: string;
  /** PAT with `read:user` (private contribs require it). */
  token: string;
  /** Inclusive `YYYY-MM-DD` lower bound in the displayed tz. */
  from: string;
  /** Inclusive `YYYY-MM-DD` upper bound in the displayed tz. */
  to: string;
  /** Revalidate window for the cached fetch. Default 3600s. */
  revalidate?: number;
};

/** Returned shape matches the wire contract — contiguous, ascending. */
export async function fetchGithubDays(opts: FetchGithubOpts): Promise<Day[]> {
  const { login, token, from, to } = opts;
  if (!token) {
    throw new Error(
      "GitHub fetch: GITHUB_TOKEN is empty. Generate a PAT with `read:user` and set it in apps/web/.env.local."
    );
  }
  if (to < from) {
    throw new Error(`fetchGithubDays: to (${to}) is before from (${from})`);
  }

  // One-day leading buffer (D-008): GraphQL window in ISO UTC must straddle
  // PT midnight to guarantee the LA-aligned `from` day is present in the
  // response. We extend `from` by one day's worth of ISO time on the lead
  // and pin `to` to the next day's end so PT midnights on both ends are
  // covered.
  const isoFrom = `${addDays(from, -1)}T00:00:00Z`;
  const isoTo = `${addDays(to, 1)}T00:00:00Z`;

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nerv-shipping-tracker",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { login, from: isoFrom, to: isoTo },
    }),
    next: { revalidate: opts.revalidate ?? 3600 },
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

  // Flatten weeks/days into the row shape `fillMissingDays` expects, then
  // trim/pad to exactly [from, to]. Any extra leading/trailing days from
  // the buffered window are dropped here.
  const rows: Array<{ date: string; count: number }> = [];
  for (const w of cal.weeks) {
    for (const d of w.contributionDays) {
      rows.push({ date: d.date, count: d.contributionCount });
    }
  }
  return fillMissingDays(rows, from, to);
}
