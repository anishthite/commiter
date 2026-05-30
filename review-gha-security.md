# Adversarial GHA / CI Security Review — `refresh-x-days`

Scope: `.github/workflows/refresh-x-days.yml`, `scripts/refresh-x-days.ts`, `.env.example`, root `package.json`, `pnpm-lock.yaml`. Read `worker-socialdata-migration.md` for intent.

Verdict: **no BLOCKERs, no HIGHs.** Workflow is well-scoped; secret is step-scoped; never logged; not exposed to fork PRs. Real issues are around (a) mutable third-party action tag and (b) push-race on queued schedule-after-dispatch. Everything else is small.

Findings ranked by severity.

---

## [MED] M-1 — Third-party action pinned to mutable major tag

`refresh-x-days.yml:31` — `uses: pnpm/action-setup@v3`

`pnpm/action-setup` is third-party (the pnpm org, but still outside `actions/*`). `@v3` is a moving tag — the owner of the tag can repoint it to a malicious commit at any time, and your next workflow run pulls and executes that code on the runner that already has:
- The default `GITHUB_TOKEN` persisted in `.git/config` with `contents: write` (set by `actions/checkout@v4` with `persist-credentials: true` default).
- `SOCIALDATA_API_KEY` available in the immediately-following step's env.

A compromised `pnpm/action-setup` runs as a job step on the same runner. While it isn't in the step that sets `SOCIALDATA_API_KEY`, it CAN read `.git/config` and exfiltrate the `GITHUB_TOKEN`, and it CAN tamper with the installed `pnpm`/`tsx` binaries so they exfiltrate the API key when the next step runs.

**Fix:** SHA-pin to a known-good commit, e.g.

```yaml
- uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda  # v3.0.0
```

Apply the same to the other three actions even though they're GitHub-owned, so the policy is "every `uses:` is a SHA + comment with the human-readable version". GitHub Security itself recommends this for any workflow touching secrets / `contents: write`. See [hardening guide](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions).

Apply to:
- `refresh-x-days.yml:25` `actions/checkout@v4`
- `refresh-x-days.yml:31` `pnpm/action-setup@v3`  ← **highest priority, third-party**
- `refresh-x-days.yml:35` `actions/setup-node@v4`

---

## [MED] M-2 — Branch-protection / signed-commits failure mode is uncaught and not announced

`refresh-x-days.yml:49-58` — commit + push step.

The worker doc (`worker-socialdata-migration.md` → Q-006) already flagged this as an open question. Some specifics worth pinning down before the first scheduled run:

1. The default `GITHUB_TOKEN` pushing via `git push` is **not** GPG-signed. (Commits made via the REST API by `github-actions[bot]` are signed; commits made via the workflow's checkout token + `git push` are not.) If `main` has "Require signed commits" enabled, push will fail with `GH006`.
2. If `main` requires status checks or PR review, push to `main` is rejected outright; default `GITHUB_TOKEN` cannot bypass branch protection (only admins/PATs/Apps with explicit bypass can).
3. The step has no fallback — it just fails the workflow with a generic git error. No alert is sent (no Slack/email), so silent staleness is the failure mode unless the user is reading Actions logs.

**Recommendations:**
- Add a comment in the YAML calling out the assumption ("requires `main` to be unprotected or to allow `github-actions[bot]` to bypass").
- Optionally swap `git push` for a PR-based flow (`peter-evans/create-pull-request@<sha>`) if branch protection turns out to be on; that side-steps both signing and protection.
- If you want belt-and-braces: add an `if: failure()` step that pings a webhook so a failed push doesn't go silent for weeks (also addresses `T-018` from the worker doc).

---

## [MED] M-3 — Schedule-after-dispatch can lose data via non-fast-forward push

`refresh-x-days.yml:17-19` — `concurrency: { group: refresh-x-days, cancel-in-progress: false }`.

The concurrency group correctly serializes runs — no double-commit race. But:

1. A `workflow_dispatch` is running.
2. The cron fires at 09:00 UTC mid-dispatch; the schedule run queues.
3. The dispatch finishes, commits, and pushes a new SHA to `main`.
4. The queued schedule run starts. `actions/checkout@v4` checks out **the SHA recorded at trigger time** (i.e., the SHA before the dispatch's push), not the current `main`.
5. The schedule run re-fetches socialdata, builds a new JSON, and tries `git push`. Push is rejected as non-fast-forward because local `HEAD` is behind `origin/main`.

Net effect: the second run's work is discarded, workflow shows a red ✗, and the user has to manually re-trigger. Not a security hole, but a correctness one.

**Fix (one-liner in the commit step):**

```yaml
- name: commit if changed
  run: |
    git diff --quiet apps/web/src/data/x-days.json || (
      git config user.name "x-refresh-bot" &&
      git config user.email "noreply@github.com" &&
      git pull --rebase origin "${GITHUB_REF_NAME}" &&
      git add apps/web/src/data/x-days.json &&
      git commit -m "data: refresh x-days $(date -u +%Y-%m-%d)" &&
      git push
    )
```

The rebase is safe because the change is a single JSON file the script regenerated from scratch; if the prior run already wrote a newer version we'd just replay our overlap-merged result on top.

---

## [LOW] L-1 — `today` is structurally undercounted, but worker doc + plan both acknowledge it

`refresh-x-days.yml:7-9`, `scripts/refresh-x-days.ts:339-343`.

Cron is `0 9 * * *` = 01:00 PST / 02:00 PDT. At trigger, the PT day is 1–2 hours old. The script unconditionally computes `today = dateKey(new Date())` in PT and reports `today_count` — which will almost always be 0 even when the prior day was active.

This is **not** an off-by-one bug — `decideSince` walks back `OVERLAP_DAYS=2` from `max(existing.days)`, so the next day's run re-fetches today's PT window and corrects the count. The dashboard's "today" tile will read 0 until the *following* morning's run.

`PLAN.md §3` explicitly calls this out as a known tradeoff ("Today's tweets show up tomorrow"). So this is intended; flagging only because the review prompt asked.

**Optional improvement:** run twice a day — `cron: "0 9,21 * * *"` (01/02 PT and 13/14 PT). The afternoon run catches most of today's posts before they're a day stale. Doubles socialdata cost but only marginally (incremental fetch with 2-day overlap is small per call). Pure UX gain.

If you stick with daily, the printed `today_count=0` line at `scripts/refresh-x-days.ts:343` is misleading-by-design — consider renaming the field in stdout to `today_partial_count` or adding a clarifying comment so a future maintainer doesn't think the script is broken on day-of.

---

## [LOW] L-2 — `workflow_dispatch` is unbounded; no rate-guard against quota burn

`refresh-x-days.yml:11` — `workflow_dispatch:` with no inputs, no actor gate.

Anyone with `write` on the repo can dispatch. For a single-owner personal repo, that's just you. But:

- `MAX_PAGES = 200` (`scripts/refresh-x-days.ts:73`) with a forced full backfill (delete `x-days.json`, dispatch) could fire up to 200 paginated requests in one go.
- No `concurrency` cap *across days* — only same-group serialization. Nothing stops 20 dispatches in 20 minutes if you typo a loop.
- Quota burn lands on `SOCIALDATA_API_KEY`, which is yours. The blast radius is "$$$ to socialdata", not "secret exfiltrated".

**Recommendations (any subset):**
- Add an explicit actor check if collaborators are ever added:
  ```yaml
  jobs:
    refresh:
      if: github.event_name != 'workflow_dispatch' || github.actor == github.repository_owner
  ```
- Add a `workflow_dispatch.inputs.confirm` boolean and require it for full backfills.
- Lower `MAX_PAGES` (or make it env-configurable from the workflow) so dispatch can't accidentally trigger the 200-page path.

---

## [LOW] L-3 — Error path in `apiGet` echoes upstream response bodies into stderr/Actions log

`scripts/refresh-x-days.ts:128-131`:

```ts
if (!res.ok) {
  const body = await res.text().catch(() => "");
  throw new Error(`HTTP ${res.status} for ${path}: ${body.slice(0, 200)}`);
}
```

The `Authorization` header is never logged — request never has its headers printed, and the script never `console.log`s `API_KEY`. **That part is correct.** Two adjacent risks worth noting:

1. The error body comes from socialdata. If socialdata ever echoes the auth header back (some APIs do "Invalid token: sk_…"), 200 chars is enough to leak the prefix. GitHub Actions auto-masks values that came from `secrets.*`, so even a leaked key would render as `***` in the public log — **but** if you ever copy the log to a third place (issue body, paste-bin) without the masking, the raw text is there. Very unlikely socialdata does this; flagging for completeness.
2. `main().catch(err => die(2, ...err.stack...))` (`refresh-x-days.ts:362-364`) prints the full stack. No argument values are in the stack (API key is read inline as `process.env.SOCIALDATA_API_KEY`, not passed as a parameter), so stack-trace leak path is closed by construction. Good.

**Recommendation:** add an explicit redactor to `apiGet`'s error message, e.g.
```ts
const safeBody = body.replace(API_KEY, "[REDACTED]").slice(0, 200);
```
Pure defense in depth; cheap.

---

## [LOW] L-4 — `pnpm/action-setup@v3` has no `run_install` flag; harmless duplication only

Just an FYI: `pnpm/action-setup@v3` accepts `run_install: false` (default) — current YAML is fine. Calling it out only because if a future maintainer adds `run_install: true` here, that runs an install BEFORE `actions/setup-node@v4` registers the pnpm cache and the cache will silently miss. Worth a comment.

No fix required.

---

## [NIT] N-1 — `actions/checkout@v4` explicit `token:` is redundant

`refresh-x-days.yml:25-30`:

```yaml
- uses: actions/checkout@v4
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
```

`actions/checkout@v4` defaults `token` to `${{ github.token }}` already (same value). The explicit line isn't wrong — it's documented behavior — just noise. Keep if you want it self-documenting; either way.

---

## [NIT] N-2 — `tsx` supply-chain: fine

`package.json:13` — `tsx: ^4.19.0`, lockfile resolves to `tsx@4.22.3` (integrity hash present, `pnpm-lock.yaml:700-704`). Maintainer: `privatenumber` (Hiroki Osame), prolific and well-regarded; project has ~7M weekly downloads. No known recent compromise events. `--frozen-lockfile` + the integrity hash give you tamper-evidence on each install.

Could pin to exact `4.22.3` in `package.json` for a tiny extra signal, but the lockfile already does that operationally. No change required.

---

## Per-probe summary (mapped to the 8 prompts)

| # | Probe | Verdict | Pointer |
|---|---|---|---|
| 1 | Action pinning | **All four `uses:` are major-tag pins.** `pnpm/action-setup@v3` (third-party) is the riskiest. | M-1 |
| 2a | Secret scoped to step? | **Yes.** `SOCIALDATA_API_KEY` is on the step `env:` block (`yml:42-44`), not job-level. | clean |
| 2b | Script logs key? | **No.** `API_KEY` is referenced only in the `Authorization:` header inside `apiGet`. No `console.log`, no error path includes headers or the key by name. | L-3 (defense-in-depth) |
| 2c | `set -x` echo? | **No.** Steps run with default `bash -eo pipefail`; no `set -x`. Workflow has no `ACTIONS_STEP_DEBUG` or `ACTIONS_RUNNER_DEBUG`. | clean |
| 2d | Error path echo curl-equivalent? | **No.** `apiGet`'s error message includes `path` and the response **body**, never headers/URL with auth. Top-level catch prints stack; stack doesn't contain auth. | L-3 |
| 3a | Branch protection / push? | Untestable from here; flagged as risk. | M-2 |
| 3b | Commits signed? | **No** — workflow uses `git push` with the default token. If `main` requires signing, fail. | M-2 |
| 3c | No-changes case? | **Correctly handled.** `git diff --quiet … \|\| ( … )` short-circuits to success when there's no diff. Verified the subshell semantics under `set -e`. | clean |
| 3d | Fork-PR trigger? | **No.** Workflow triggers only on `schedule` and `workflow_dispatch`. No `pull_request` / `pull_request_target`. Secrets cannot be reached from fork PRs. | clean |
| 4 | concurrency double-commit race | Serialized correctly, but queued schedule can lose its push as non-fast-forward. | M-3 |
| 5 | Cron alignment with PT bucketing | "Today" is structurally undercounted at run time; corrected on next day's run via 2-day overlap. Documented in `PLAN.md §3` as expected. | L-1 |
| 6 | `workflow_dispatch` guardrails | Unbounded for repo-write users; quota DoS possible (yours). | L-2 |
| 7 | `tsx` supply chain | Fine. Reputable maintainer, lockfile pins exact version with integrity hash. | N-2 |
| 8 | Lockfile matches `package.json` | **Match.** `pnpm-lock.yaml:11-13` records `specifier: ^4.19.0 / version: 4.22.3`. `--frozen-lockfile` will succeed. | clean |

---

## Recommended action ordering

1. SHA-pin `pnpm/action-setup`, then `actions/checkout` and `actions/setup-node` (M-1). Highest security win for least effort.
2. Add `git pull --rebase` before push (M-3). One line, removes the queued-run data-loss footgun.
3. Decide on branch-protection plan now, not after the first failed run (M-2). If protection is ON: switch to a PR-based commit step or document the bypass. If OFF: add a comment to that effect at the top of the YAML.
4. Twice-daily cron + rename `today_count` to `today_partial_count` in the script's stdout (L-1). Cosmetic but improves operability.
5. Add an explicit `API_KEY` redaction in `apiGet`'s error string (L-3). Trivial defense in depth.

Everything else is NIT.

---

_Reviewer's note: nothing was edited. All findings are evidence-cited from the files at HEAD. If anything is fixed, ask for a re-review against the diff alone._
