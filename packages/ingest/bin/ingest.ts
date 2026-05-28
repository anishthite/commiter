#!/usr/bin/env tsx
import { db } from "../src/db";
import { migrate } from "../src/schema";
import { ingestGithub } from "../src/github";
import { env } from "../src/env";

type Channel = "github" | "twitter" | "all";

function parseArgs(argv: string[]): { channel: Channel; days: number } {
  let channel: Channel = "all";
  let days = 365;
  for (const a of argv) {
    if (a.startsWith("--channel=")) {
      const v = a.slice("--channel=".length) as Channel;
      if (v === "github" || v === "twitter" || v === "all") channel = v;
      else throw new Error(`unknown --channel value: ${v}`);
    } else if (a.startsWith("--days=")) {
      days = Math.min(Math.max(parseInt(a.slice("--days=".length), 10) || 365, 7), 365);
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  return { channel, days };
}

function printHelp() {
  console.log(`
ingest — pull daily counts into the shipping tracker DB

Usage:
  pnpm ingest [--channel=github|twitter|all] [--days=N]

Options:
  --channel  Which channel to ingest. Default: all
  --days     How many days of history to fetch (7..365). Default: 365

Env:
  GITHUB_TOKEN   PAT with read:user  (required for --channel=github|all)
  GITHUB_LOGIN   GitHub handle to track. Default: anishthite
  DATABASE_URL   file:./data/ship.local.db (dev) or libsql://...turso.io (prod)
`);
}

async function main() {
  const { channel, days } = parseArgs(process.argv.slice(2));
  console.log(`[ingest] channel=${channel} days=${days} url=${env.DATABASE_URL}`);

  const client = db();
  const { from, to } = await migrate(client);
  if (from !== to) console.log(`[ingest] migrated schema v${from} -> v${to}`);

  if (channel === "github" || channel === "all") {
    try {
      const r = await ingestGithub(client, { days });
      console.log(
        `[ingest] github: login=${r.login} total=${r.total} days=${r.days_processed}`
      );
    } catch (e) {
      console.error(`[ingest] github FAILED:`, (e as Error).message);
      if (channel === "github") process.exit(1);
    }
  }

  if (channel === "twitter" || channel === "all") {
    // Phase 2 — pi-chrome scraper.
    console.log(`[ingest] twitter: not implemented yet (Phase 2)`);
  }

  console.log(`[ingest] done`);
}

main().catch((e) => {
  console.error("[ingest] failed:", e);
  process.exit(1);
});
