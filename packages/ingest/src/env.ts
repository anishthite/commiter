import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

// Load a .env at repo root if we're being run from a subdir.
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  resolve(here, "../../../.env"),
  resolve(here, "../../.env"),
  resolve(here, "../.env"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate, override: false });
    break;
  }
}

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string, fallback?: string): string | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

export const env = {
  GITHUB_TOKEN: optional("GITHUB_TOKEN"),
  GITHUB_LOGIN: required("GITHUB_LOGIN", "anishthite"),
  DATABASE_URL: required("DATABASE_URL", "file:./data/ship.local.db"),
  DATABASE_AUTH_TOKEN: optional("DATABASE_AUTH_TOKEN"),
  NERV_TZ: required("NERV_TZ", "America/Los_Angeles"),
};

export function requireGithubToken(): string {
  if (!env.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is required for the GitHub ingestor. Set it in .env (scope: read:user)."
    );
  }
  return env.GITHUB_TOKEN;
}
