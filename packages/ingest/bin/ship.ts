#!/usr/bin/env tsx
/**
 * `ship` — manual self-report CLI.
 *
 * Phase 1 stub. Phase 2 wires this to also bump daily_count for the
 * current `NERV_TZ` date and write an `event` row.
 *
 * Usage:
 *   ship tweet "<url>"
 *   ship note  "<text>"
 *   ship commit "<repo>" "<sha>"
 */

function printHelp() {
  console.log(`
ship — manual self-report when the auto-ingestor can't see something

Usage:
  ship tweet  "<url>"          Log a tweet you posted (Twitter channel)
  ship note   "<text>"         Free-form note (Twitter channel)
  ship commit "<repo>" "<sha>" Log a commit (GitHub channel)

Not implemented yet — Phase 2.
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  printHelp();
  process.exit(0);
}

console.error("ship: not implemented yet (Phase 2). See PLAN.md §6.");
process.exit(1);
