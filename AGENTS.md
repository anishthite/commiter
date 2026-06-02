# Repo-Local Agent Instructions

> Read this **before** following any global `~/.agents/AGENTS.md` rules. Repo-local rules override globals on conflict.

## Subagent output location — STRICT

When orchestrating subagents (`scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, validators, etc.) via the `pi-subagents` skill or any equivalent recipe, **every child's `output:` file MUST be written under `implementation-notes/subagent-reports/`**, never at the repo root.

Examples:

```js
// ✅ correct
subagent({
  tasks: [
    { agent: "scout",    task: "...", output: "implementation-notes/subagent-reports/scout-foo.md" },
    { agent: "reviewer", task: "...", output: "implementation-notes/subagent-reports/review-correctness.md" },
  ],
});

// ❌ wrong — pollutes repo root
subagent({
  tasks: [
    { agent: "scout", task: "...", output: "scout-foo.md" },
  ],
});
```

For chain steps, set `output` on each step the same way. For `progress: true` tracking files, route them into `implementation-notes/subagent-reports/<run-slug>/` as well — keep the root clean.

Naming convention inside `implementation-notes/subagent-reports/`:
- `scout-<slug>.md`, `researcher-<slug>.md`
- `planner-<slug>.md`
- `worker-<slug>.md`
- `review-<angle>.md` (e.g. `review-security.md`, `review-robustness.md`)
- For multi-round work, prefix with a date or round: `2026-06-02-worker-fixes.md`

## Curated implementation notes

The global `implementation-notes` skill still owns the **curated, append-only** task log at `implementation-notes/*.html` (one file per task, `YYYY-MM-DD-<slug>.html`). That's distinct from subagent raw outputs:

| Location | Purpose | Format | Author |
|---|---|---|---|
| `implementation-notes/*.html` | Curated decision/deviation/tradeoff log per task | HTML, dense tabular | Parent agent (you) |
| `implementation-notes/subagent-reports/*.md` | Raw subagent handoff artifacts | Markdown, freeform | Child subagents |

Don't conflate them. Children write under `subagent-reports/`. The parent synthesizes findings into the curated `.html` per the `implementation-notes` skill.

## Why this exists

Earlier runs left `scout-*.md`, `worker-*.md`, `review-*.md`, and `progress.md` sprinkled at the repo root. They were moved into `implementation-notes/subagent-reports/` on 2026-06-02. Don't recreate the mess.

## What stays at the root

- `README.md`, `PLAN.md` — real project docs.
- Standard tooling files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, etc.).
- Nothing else.
