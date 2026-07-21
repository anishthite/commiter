import "server-only";
import { fillMissingDays, type Day } from "./streak";
import xDaysBySlug from "../data/x-days-by-slug.json";

/**
 * Twitter source — bundled static JSON, refreshed daily by a GitHub Action.
 *
 * The dashboard reads tweet day-counts from one slug-keyed JSON file checked
 * into this repo. Missing slug data is treated as offline, so adding a new
 * person only needs a roster entry; the refresh workflow creates their X
 * payload on the next run.
 */

type XDaysFile = {
  days?: unknown;
  generated_at?: unknown;
  user_id?: unknown;
  handle?: unknown;
  bucketed_tz?: unknown;
};

const X_DAYS_BY_SLUG = xDaysBySlug as Record<string, XDaysFile | undefined>;

// Per-slug latch so the legacy-file warning fires at most once per slug
// per process, not once per request.
const bucketedTzLegacyWarned = new Set<string>();

export class TwitterFeedOfflineError extends Error {
  attempts: Array<{ host: string; reason: string }>;
  constructor(attempts: Array<{ host: string; reason: string }>) {
    super(`Twitter feed offline; bundled JSON unusable (${attempts.length})`);
    this.name = "TwitterFeedOfflineError";
    this.attempts = attempts;
  }
}

export type FetchTwitterOpts = {
  /** Roster slug — picks the bundled data under `x-days-by-slug.json`. */
  slug: string;
  /** Handle, no leading @. */
  login: string;
  /** IANA tz; bundled JSON is pre-bucketed by the refresh script. */
  tz: string;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to: string;
  /** Retained for signature stability; bundled reads don't revalidate. */
  revalidate?: number;
};

export async function fetchTwitterDays(opts: FetchTwitterOpts): Promise<Day[]> {
  const { slug, login, from, to } = opts;
  if (!login) {
    throw new Error(
      `Twitter fetch: xLogin is empty for slug=${slug}. Configure it in apps/web/src/config/users.json.`
    );
  }
  if (to < from) {
    throw new Error(`fetchTwitterDays: to (${to}) is before from (${from})`);
  }

  const file = X_DAYS_BY_SLUG[slug];
  if (!file) {
    throw new TwitterFeedOfflineError([
      { host: "bundled-json", reason: `no bundled x-days data for slug=${slug}` },
    ]);
  }
  const rawDays = file.days;
  if (!Array.isArray(rawDays)) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: `x-days-by-slug.json missing/invalid days[] for slug=${slug}`,
      },
    ]);
  }

  // If the file declares the tz it was bucketed in and it disagrees with
  // runtime tz, the heatmap would silently misalign by up to a day.
  const bucketedTz = typeof file.bucketed_tz === "string" ? file.bucketed_tz : "";
  if (bucketedTz) {
    if (bucketedTz !== opts.tz) {
      throw new TwitterFeedOfflineError([
        {
          host: "bundled-json",
          reason: `tz mismatch for slug=${slug}: file=${bucketedTz}, runtime=${opts.tz}`,
        },
      ]);
    }
  } else if (!bucketedTzLegacyWarned.has(slug)) {
    bucketedTzLegacyWarned.add(slug);
    // eslint-disable-next-line no-console
    console.warn(
      `[twitter] x-days-by-slug.json has no \`bucketed_tz\` for slug=${slug} — ` +
        "cannot validate tz consistency. Re-run scripts/refresh-x-days.ts."
    );
  }

  let shapeOk = 0;
  const rows: Array<{ date: string; count: number }> = [];
  for (const item of rawDays) {
    if (!item || typeof item !== "object") continue;
    const d = (item as { date?: unknown }).date;
    const c = (item as { count?: unknown }).count;
    if (typeof d !== "string" || typeof c !== "number") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    shapeOk++;
    if (d < from || d > to) continue;
    rows.push({ date: d, count: c });
  }

  if (rawDays.length === 0) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: `x-days data is empty for slug=${slug} — GH Action has not run yet for this user`,
      },
    ]);
  }

  if (shapeOk === 0) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: `all days[] entries failed shape validation for slug=${slug}`,
      },
    ]);
  }

  return fillMissingDays(rows, from, to);
}
