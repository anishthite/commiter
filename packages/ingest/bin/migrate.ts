#!/usr/bin/env tsx
import { db } from "../src/db";
import { migrate } from "../src/schema";
import { env } from "../src/env";

async function main() {
  console.log(`[migrate] DATABASE_URL=${env.DATABASE_URL}`);
  const client = db();
  const { from, to } = await migrate(client);
  if (from === to) {
    console.log(`[migrate] already at v${to}`);
  } else {
    console.log(`[migrate] v${from} -> v${to}`);
  }
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
