---
name: fleet-integrator
description: How to run the merge gate for pull requests into an integration branch -- a watching Claude agent loop (not a GitHub Action, not a supervisor step) that squash-merges passing sprint PRs, requests one repair per stuck PR, and reports everything else to the owner. Trigger whenever asked to watch, gate, or merge PRs into an integration branch.
---

# fleet-integrator (integration-branch merge gate)

## Scope

This skill is the merge gate for pull requests opened by sprint branches into
a single **integration branch** -- never the repository's default branch.
It is an agent loop you run on a member: repeatedly call the status script
below, then take exactly one action per candidate PR based on its computed
decision. It is not a GitHub Action and not a step the supervisor runs for
you; nothing about it fires automatically on a push or a schedule other than
your own loop.

## Parameters

The operator supplies these from the target repo's own deploy.md or
CLAUDE.md -- never hardcode a specific project's values here:

| Parameter | Example shape | Notes |
|---|---|---|
| integration branch | `<integration-branch>` | the base branch candidate PRs merge into |
| required check names | `<check-1>,<check-2>,...` | must all report success before a merge |
| PR title prefix | `Auto-sprint [PASS]: ` | the engine's own convention (mirrors the `[ABORTED]` sibling prefix the engine's abort path raises); a PR without it is never touched |
| owner/repo | `<owner>/<repo>` | passed straight through to `gh` |

## Prerequisites and token

- The member running this loop needs `gh` installed and on `PATH`.
- Authenticate with a short-lived GitHub App installation token minted by
  `provision_vcs_auth`, attributed to the app bot identity -- never a human
  operator's personal token. This keeps every merge attributable to the gate,
  not a person.
- Confirm the identity before trusting the loop: `gh auth status` must show
  the app bot identity, not a personal account. If it shows anything else,
  stop and re-provision before merging.
- The token is short-lived by design. If any `gh` call in the loop fails with
  a 401/authentication error, call `provision_vcs_auth` again to mint a fresh
  token and retry; do not fall back to a personal credential.

## The loop

One status-script invocation per iteration, followed by exactly one action
per decision it reports.

Invocation (the script is `scripts/integration-gate-status.mjs`, relative to
the fleet-sprint engine package this skill ships with -- run it from a
checkout of that package):

```bash
node scripts/integration-gate-status.mjs \
  --repo <owner>/<repo> \
  --base <integration-branch> \
  --title-prefix "<title-prefix>" \
  --required-checks <check-1>,<check-2>,...
```

It prints one JSON object per candidate PR, each with a `decision` field.
Take exactly one action per PR, per iteration:

- **merge** -- `mergeStateStatus` is CLEAN or BEHIND, every required check is
  success, and the title carries the configured prefix. Run:
  ```bash
  gh pr merge <number> --squash --delete-branch --subject '<title> (#<number>)'
  ```
- **repair** -- exactly once per head sha. Send the repair prompt (below) via
  `execute_prompt` to the sprint's own doer member, then record that head sha
  in a local ledger file (a small JSON file mapping head sha to timestamp is
  enough) so a later iteration does not re-send it for the same commit. After
  sending it, wait for the PR to synchronize (a new commit lands and the
  script reports a new head sha) before treating that PR again.
- **wait** -- required checks are still pending or otherwise non-terminal.
  Take no action this iteration; re-check next loop.
- **skip** -- the title carries `[FAIL]` or `[ABORTED]`, or lacks the
  configured prefix. Never merge this PR. Add it to the owner report (below)
  and move on.

Sleep interval guidance: poll on an interval that matches how often sprint
branches push to their PRs -- a steady default (for example, once a minute)
is reasonable absent other guidance from the target; back off when every
candidate is idle/waiting, and tighten briefly right after sending a repair
prompt so the resulting synchronize is picked up promptly.

## Repair prompt

Send this verbatim (with `<branch>` and `<integration-branch>` filled in) via
`execute_prompt` to the sprint's own doer member when a PR's decision is
`repair`:

```
This PR's branch <branch> cannot merge cleanly into <integration-branch>.
Please:
1. Fetch the latest <integration-branch>.
2. Merge <integration-branch> into <branch>, resolving any conflicts by
   keeping both sides' features (do not drop either side's changes).
3. Run this target's own test command exactly as documented in its deploy.md.
4. Push <branch> once the merge is resolved and tests pass.
Do not force-push, and do not touch <integration-branch> directly.
```

## Owner report format

One line per PR reported to the owner, in this shape:

```
<number> <decision> <reason>
```

Report every PR whose decision is `skip`, and any PR that has been sitting in
`repair` or `wait` long enough to be worth a human look. Never omit a `skip`
from the report -- a silently skipped PR is exactly the failure mode this
gate exists to prevent.

## Never

- Never merge into the repository's default branch -- only the configured
  integration branch.
- Never force-push, to any branch.
- Never bypass the branch's merge ruleset or use an admin-merge override.
- Never edit engine code as part of running this loop.
- Never touch a PR whose title lacks the configured prefix -- treat it as
  not this gate's business, not as an implicit skip-and-merge-anyway case.
