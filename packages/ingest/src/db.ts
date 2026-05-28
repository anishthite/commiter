import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";

let _client: Client | null = null;

/**
 * Returns a singleton libSQL client.
 *
 * - `file:./data/...`     -> local SQLite file (auto-creates parent dir).
 * - `libsql://...`        -> hosted (Turso). Requires DATABASE_AUTH_TOKEN.
 * - `:memory:`            -> in-memory (tests).
 */
export function db(): Client {
  if (_client) return _client;

  const url = env.DATABASE_URL;

  // Ensure data dir exists for file URLs.
  if (url.startsWith("file:")) {
    const path = url.replace(/^file:/, "");
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* ignore */
    }
  }

  _client = createClient({
    url,
    authToken: env.DATABASE_AUTH_TOKEN,
  });
  return _client;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    _client.close();
    _client = null;
  }
}
