import "server-only";
import { db } from "ingest/src/db.js";
import { migrate } from "ingest/src/schema.js";
import { buildSnapshot, type Snapshot } from "ingest/src/snapshot.js";
import { env } from "ingest/src/env.js";

let migrated = false;

export async function getSnapshot(days = 365): Promise<Snapshot> {
  const client = db();
  if (!migrated) {
    await migrate(client);
    migrated = true;
  }
  return buildSnapshot(client, { tz: env.NERV_TZ, days });
}
