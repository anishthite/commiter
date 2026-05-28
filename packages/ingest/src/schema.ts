import type { Client } from "@libsql/client";

/**
 * Schema version. Bump when the migration list changes.
 * Stored in `meta.schema_version`.
 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Array<{ version: number; sql: string[] }> = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS daily_count (
         channel    TEXT NOT NULL,
         date       TEXT NOT NULL,
         count      INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (channel, date)
       )`,
      `CREATE TABLE IF NOT EXISTS event (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         channel    TEXT NOT NULL,
         ts         INTEGER NOT NULL,
         ref        TEXT,
         payload    TEXT,
         UNIQUE(channel, ref)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_event_channel_ts ON event(channel, ts DESC)`,
      `CREATE TABLE IF NOT EXISTS meta (
         k TEXT PRIMARY KEY,
         v TEXT
       )`,
    ],
  },
];

export async function migrate(client: Client): Promise<{ from: number; to: number }> {
  // Bootstrap meta table separately so we can read the current version.
  await client.execute(
    `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`
  );
  const row = await client.execute({
    sql: `SELECT v FROM meta WHERE k = 'schema_version'`,
    args: [],
  });
  const current = row.rows.length > 0 ? Number(row.rows[0]!.v) || 0 : 0;
  const target = SCHEMA_VERSION;

  if (current >= target) return { from: current, to: current };

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    for (const stmt of m.sql) {
      await client.execute(stmt);
    }
  }

  await client.execute({
    sql: `INSERT INTO meta(k, v) VALUES('schema_version', ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    args: [String(target)],
  });

  return { from: current, to: target };
}
