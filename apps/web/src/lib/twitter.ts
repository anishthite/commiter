import "server-only";
import { fillMissingDays, type Day } from "./streak";
import xDaysData from "../data/x-days.json";

/**
 * Twitter source — bundled static JSON, refreshed daily by a GitHub Action.
 *
 * Final architecture (D-029, 2026-05-29):
 * after a day of failed live-scraping experiments (public RSS mirrors
 * blocked from Vercel egress, syndication.twitter.com returning stale
 * curated data), the dashboard now reads tweet day-counts from a JSON
 * file checked into this repo at `apps/web/src/data/x-days.json`. A
 * daily GitHub Action
 * (`.github/workflows/refresh-x-days.yml`) calls socialdata.tools to
 * paginate the user's recent tweets, buckets them in `NERV_TZ`, merges
 * into the JSON, and commits → Vercel rebuild → fresh data ships.
 *
 * Tradeoff: data freshness is tied to the daily Action + deploy cycle,
 * not real-time. Acceptable: the dashboard is a "did I ship today?"
 * tracker, not a live feed; one-day latency is invisible to the user.
 *
 * If the bundled JSON is malformed or empty, throw `TwitterFeedOfflineError`
 * so snapshot.ts's existing catch-and-degrade path hides the panel.
 */

/**
 * Wire shape of `x-days.json`. The shape is intentionally tolerant — we
 * only require `days` to be an array of `{date, count}`; extra fields
 * (`generated_at`, `handle`, `user_id`) are ignored at render time and
 * exist purely for the refresh script's bookkeeping.
 */
type XDaysFile = {
  days?: unknown;
  generated_at?: unknown;
  user_id?: unknown;
  handle?: unknown;
  /** IANA tz the refresh script used to bucket `days[]`. Required for
   *  tz-consistency validation at read time (F10). Absent on legacy files
   *  pre-dating the consistency check — a warning is logged once. */
  bucketed_tz?: unknown;
};

// Module-level flag so the legacy-file warning fires at most once per
// process, not once per request.
let bucketedTzLegacyWarned = false;

export class TwitterFeedOfflineError extends Error {
  attempts: Array<{ host: string; reason: string }>;
  constructor(attempts: Array<{ host: string; reason: string }>) {
    super(`Twitter feed offline; bundled JSON unusable (${attempts.length})`);
    this.name = "TwitterFeedOfflineError";
    this.attempts = attempts;
  }
}

export type FetchTwitterOpts = {
  /** Handle, no leading @. Retained so the snapshot composer can refuse to
   *  render the panel when X_LOGIN is unset (panel-presence logic). */
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
  const { login, from, to } = opts;
  if (!login) {
    throw new Error(
      "Twitter fetch: X_LOGIN is empty. Set X_LOGIN=<your handle> in apps/web/.env.local."
    );
  }
  if (to < from) {
    throw new Error(`fetchTwitterDays: to (${to}) is before from (${from})`);
  }

  const file = xDaysData as XDaysFile;
  const rawDays = file.days;
  if (!Array.isArray(rawDays)) {
    throw new TwitterFeedOfflineError([
      { host: "bundled-json", reason: "x-days.json missing/invalid `days` array" },
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
          reason: `tz mismatch: file=${bucketedTz}, runtime=${opts.tz}`,
        },
      ]);
    }
  } else if (!bucketedTzLegacyWarned) {
    bucketedTzLegacyWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[twitter] x-days.json has no `bucketed_tz` field — cannot validate tz " +
        "consistency. Re-run scripts/refresh-x-days.ts to stamp it."
    );
  }

  // Track shape-valid rows separately from window-filtered rows so we can
  // distinguish "file rotted" (every row failed validation) from "window
  // legitimately empty" (rows exist but fall outside [from, to]).
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

  // An empty days array is a legitimate first-deploy state (the GH Action
  // hasn't run yet). Degrade the panel instead of pretending we have data.
  if (rawDays.length === 0) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: "x-days.json has empty days[] — GH Action has not run yet",
      },
    ]);
  }

  // F9: rawDays is non-empty but every row failed shape validation. The
  // producer (refresh script) validates shape on write; if the consumer
  // sees a populated file where nothing validates, the file is corrupt or
  // the wire shape drifted — surface as offline, not as silent zero-fill.
  if (shapeOk === 0) {
    throw new TwitterFeedOfflineError([
      {
        host: "bundled-json",
        reason: "all days[] entries failed shape validation",
      },
    ]);
  }

  return fillMissingDays(rows, from, to);
}
