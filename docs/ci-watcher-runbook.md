# CI Watcher Runbook

Portable procedure for an autonomous loop that watches CI for
`Apra-Labs/apra-fleet` on GitHub, diagnoses failures, and fixes them. Written
so any fleet device can pick this up: copy this file's procedure, re-run the
setup steps below on that device, and the loop resumes with no other shared
state.

## Scope

- Repo: `Apra-Labs/apra-fleet` (GitHub Actions CI).
- Watches: the `main` branch, and every open pull request's head branch.
- Detection: the `ci-watcher` agent definition
  (`packages/apra-fleet-se/apra-pm/agents/ci-watcher.md`), dispatched
  per-branch in its branch-scoped form (`branch` + `expectedHeadSha`).
- Fixing: done by the orchestrator (or a `doer`-style agent it dispatches),
  not by `ci-watcher` itself -- `ci-watcher` only polls and reports
  green/red/pending/not_configured, per its own "do not modify files" rule.

## Rules (non-negotiable)

1. **Cadence**: check at most once every 2 hours. Never poll more often.
2. **Latest failure only**: for a given branch, only react to a CI run whose
   head SHA has not already been seen and acted on. If the branch's newest
   run is for a SHA already recorded in state, skip it -- do not re-diagnose
   or re-fix a failure that was already addressed (or explicitly deferred)
   on a previous cycle.
3. **`main` is priority**: a red run on `main` is handled before any PR
   branch, and is always fixed via a pull request (branch off `main`,
   `fix/ci-<short-sha>` naming, push, open PR) -- never a direct push to
   `main`.
4. **No full test suites locally**: identify the exact failing test file(s)
   / test name(s) from the CI log first (`gh run view <id> --log-failed`),
   then run only that narrow scope locally to reproduce and verify the fix
   (e.g. a single `vitest run <file>` or `node --test <file>` invocation,
   matching how the failing step actually invoked it in
   `.github/workflows/`). Never run `npm test` / `scripts/run-all-tests.mjs`
   as part of diagnosis or verification.
5. **Dedicated worktree**: all fixing happens in one persistent git worktree
   reserved for this loop (see Setup below), never in the primary checkout
   or in a throwaway `.claude/worktrees/*` agent worktree. It is safe to
   `git fetch` + hard-reset this worktree to whatever branch/SHA the cycle
   needs, because nothing else uses it.

## Setup (per device)

1. Pick a sibling directory next to your `apra-fleet` checkout, e.g.
   `<parent>/apra-fleet-ci-watcher`, and create the worktree detached at
   `origin/main`:
   ```bash
   cd <path-to-apra-fleet>
   git fetch origin main
   git worktree add --detach ../apra-fleet-ci-watcher origin/main
   ```
2. In that worktree directory, create `.ci-watcher-state.json` (gitignored,
   never committed -- it is per-device operational state, not repo state):
   ```json
   {
     "repo": "Apra-Labs/apra-fleet",
     "worktreePath": "<absolute path to the worktree>",
     "lastCycleAt": null,
     "branches": {}
   }
   ```
3. Ensure `gh auth status` is authenticated for this device with a token
   that can read Actions runs and push branches / open PRs on the repo.
4. Schedule the loop to fire on a cadence no tighter than 2 hours (a cron
   job, a Claude Code scheduled/cron agent, or an OS scheduled task all
   work -- whatever the device supports). Each firing runs the cycle below.
   If your scheduler's own interval limit is shorter than 2 hours (e.g. a
   1-hour clamp), fire more often but gate the actual work on
   `lastCycleAt` in state -- skip the cycle body unless at least 2 hours
   have elapsed.

## Per-cycle procedure

1. Load `.ci-watcher-state.json` from the dedicated worktree. If
   `lastCycleAt` is less than 2 hours ago, stop (rule 1).
2. **Check `main` first**:
   ```bash
   gh run list --repo Apra-Labs/apra-fleet --branch main --limit 1 \
     --json databaseId,status,conclusion,headSha,url
   ```
   - If `conclusion` is `failure`/`cancelled` and `headSha` differs from
     `state.branches.main.lastSeenSha` (or no prior action was recorded for
     it): this is a new `main` failure. Go to **Diagnose & fix**, then
     **Ship a fix via PR** (never push `main` directly). This step takes
     priority over the PR sweep below -- do it first.
   - Update `state.branches.main` with the observed run regardless.
3. **Sweep open PRs**:
   ```bash
   gh pr list --repo Apra-Labs/apra-fleet --state open \
     --json number,headRefName,headRefOid
   ```
   For each PR, dispatch `ci-watcher` (or run the equivalent `gh run list
   --branch <headRefName> --limit 1 ...` directly) with `branch` =
   `headRefName` and `expectedHeadSha` = `headRefOid`.
   - If status is `red` and `headSha` differs from
     `state.branches[headRefName].lastSeenSha` (or no prior action is
     recorded for that SHA): new failure on this branch. Go to
     **Diagnose & fix**, then **Ship a fix directly to the branch**.
   - If the SHA matches a SHA already recorded (already fixed, already
     rerun, or explicitly deferred with a note) -- skip it (rule 2). This
     is what prevents re-litigating a failure every cycle.
   - Update `state.branches[headRefName]` with the observed run regardless
     of whether action was taken.
4. Write `lastCycleAt` = now, persist `.ci-watcher-state.json`.

### Diagnose & fix

1. `gh run view <runId> --repo Apra-Labs/apra-fleet --log-failed` to get the
   failing step's log. Identify the exact failing test file(s) and
   assertion text. Delegate this (and the log reading) to a subagent when
   the log is large, to keep the orchestrator's context clean.
2. Read the PR's / branch's diff (`gh pr diff <n>` or `git diff
   origin/main...<branch>`) to judge whether the failure is caused by the
   change itself, or is a pre-existing/flaky/environment issue unrelated to
   it.
3. If it looks like a transient/environment flake (timing, load-sensitive
   assertions, infra hiccups) and this is the *first* time this SHA has
   failed: try `gh run rerun <runId> --failed` once before editing any
   code. Record `actionTaken: "rerun-failed-jobs"` in state and stop for
   this cycle -- let the next cycle observe the rerun's outcome before
   deciding whether to actually change code.
4. Otherwise (a real bug, or a rerun already failed the same way twice): in
   the dedicated worktree, `git fetch origin` then check out the target
   branch at its current tip. Reproduce the narrow failing test locally
   (rule 4), make the minimal fix, and re-run the same narrow test(s) to
   confirm green. Do not run the full suite.

### Ship a fix via PR (for `main`)

```bash
git checkout -b fix/ci-<short-sha> origin/main
# ... commit the fix ...
git push -u origin fix/ci-<short-sha>
gh pr create --repo Apra-Labs/apra-fleet --base main \
  --title "fix(ci): <short description>" \
  --body "Fixes the CI failure on main at <runUrl>. <diagnosis summary>."
```
Never merge this PR automatically -- it waits for normal review, per the
conservative default git policy (`CLAUDE.md`).

### Ship a fix directly to the branch (for a PR's own CI)

```bash
git fetch origin
git checkout <headRefName>
git reset --hard origin/<headRefName>
# ... commit the fix ...
git push origin <headRefName>
```
This is fine even though it's a push (not a PR) because the target is
already a non-`main` feature/fix/chore branch under an open PR -- pushing
to it just updates that PR, it does not touch `main`.

## What NOT to do

- Do not run `npm test` / the full workspace suite as part of this loop.
- Do not touch `main` directly; failures there only ever go out through a
  PR.
- Do not re-diagnose a SHA that state already has a recorded action for.
- Do not poll more than once per 2 hours, regardless of how many branches
  are red.
- Do not let `ci-watcher` (the agent) edit files -- it only reports status.
