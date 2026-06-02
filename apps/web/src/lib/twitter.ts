import "server-only";
import { fillMissingDays, type Day } from "./streak";
import xDaysAnish from "../data/x-days.anish.json";
import xDaysSubby from "../data/x-days.subby.json";

/**
 * Twitter source — bundled static JSON, refreshed daily by a GitHub Action.
 *
 * Final architecture (D-029, 2026-05-29):
 * the dashboard reads tweet day-counts from JSON files checked into this
 * repo at `apps/web/src/data/x-days.{slug}.json` (one per tracked user).
 * A daily GitHub Action calls socialdata.tools to paginate each user's
 * recent tweets, buckets them in `NERV_TZ`, merges into the JSON, and
 * commits → Vercel rebuild → fresh data ships.
 *
 * Multi-user (D-025, 2026-06-01): the bundled JSON is now keyed by `slug`
 * (the `users.json` roster slug). `fetchTwitterDays` requires an explicit
 * slug to pick the file. Statically importing both keeps Next bundling
 * deterministic — adding a third user is a one-line registry entry.
 */

type XDaysFile = {
  days?: unknown;
  generated_at?: unknown;
  user_id?: unknown;
  handle?: unknown;
  bucketed_tz?: unknown;
};

// Registry of bundled per-slug data files. Statically registered so the
// Next bundler picks them up at build time. Adding a user = one entry here
// plus a `x-days.{slug}.json` seed file plus a `users.json` roster row.
const X_DAYS_BY_SLUG: Record<string, XDaysFile> = {
  anish: xDaysAnish as XDaysFile,
  subby: xDaysSubby as XDaysFile,
};

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
  /** Roster slug — picks the bundled `x-days.{slug}.json` file. */
  slug: string;
  /** Handle, no leading @. Retained so the snapshot composer can refuse to
   *  render the panel when xLogin is unset (panel-presence logic). */
  login: string;
  /** IANA tz; ignored at read time — the bundled JSON is pre-bucketed by
   *  the refresh script. Retained for signature stability. */
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
      { host: "bundled-json", reason: `no bundled x-days file for slug=${slug}` },
    ]);
  }
  const rawDays = file.days;
  if (!Array.isArray(rawDays)) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: `x-days.${slug}.json missing/invalid \`days\` array`,
      },
    ]);
  }

  // F10: tz-consistency. If the file declares the tz it was bucketed in and
  // it disagrees with the runtime's tz, the heatmap would silently misalign
  // by up to a day. Throw rather than render the wrong picture. Absent
  // `bucketed_tz` (legacy files) is permitted with a one-time warning.
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
      `[twitter] x-days.${slug}.json has no \`bucketed_tz\` field — cannot validate tz ` +
        "consistency. Re-run scripts/refresh-x-days.ts to stamp it."
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

  // Empty days[] = first-deploy state (GH Action hasn't run for this slug
  // yet). Degrade the panel instead of pretending we have data.
  if (rawDays.length === 0) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: `x-days.${slug}.json has empty days[] — GH Action has not run yet for this user`,
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
