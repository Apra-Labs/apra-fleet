# Sprint Workflow -- User Guide

A deterministic, multi-cycle sprint workflow that takes a prioritised backlog,
plans and implements work, verifies it through integration testing, and delivers
a reviewed pull request. Each cycle repeats until a user-defined quality bar is
met or the cycle limit is reached.

---

## How it works

The workflow drives specialised agents through a repeating loop:

```
while (open issues above goal threshold > 0):
  Plan     -- decompose open sprint goals into a verified feature+task DAG
  Develop  -- implement tasks in model streaks, reviewed after each iteration
  Test     -- deploy build, run integration tests, file bugs for failures
  Check    -- has the goal been met? any progress since last cycle?

Harvest  -- update documentation, CHANGELOG, raise PR
```

The workflow never writes code or makes decisions. It dispatches agents,
reads beads to determine progress, and routes work accordingly. All routing
is deterministic JavaScript -- no agent decides whether to continue.

---

## Key concepts

**Sprint goal** -- a business requirement to implement this sprint. Sprint goals come from the backlog.
One sprint may target several related sprint goals.

**Feature** -- a concrete deliverable the planner derives from a sprint goal. Each
feature is verifiable: integration tests either pass or fail against it.

**Task** -- the smallest unit of work. A task belongs to exactly one feature
and is sized to complete in a single agent session (roughly 1-3 file changes).
Tasks carry an assigned model chosen by the planner based on complexity.

**Sprint goal** -- the exit criterion, expressed as a priority threshold:
- `P1` -- exits when no P1 issues remain open
- `P1/P2` -- exits when no P1 or P2 issues remain open (default)
- `P1/P2/P3` -- tightest bar; exits only when no P1-P3 issues remain

Lower-priority issues found during testing are tracked in beads and carried
forward to a future sprint.

**Cycle** -- one full pass through the loop. A sprint may run multiple cycles
if integration testing finds defects that require further development.

---

## What teams must prepare

### 1. A beads backlog

Beads (`bd`) is the task database. All sprint goals, features, tasks, bugs, and
enhancements live there. Before triggering a sprint, the target sprint goals must
exist in beads with enough description for the planner to decompose them.

Minimum per sprint goal:
- A clear title
- A description: what it does, who uses it, what done looks like
- A priority (P0-P4)

The planner creates features and tasks from the sprint goal descriptions. If a
description is too thin, the plan-reviewer will send the planner back to refine.

### 2. deploy.md

A runbook describing how to deploy the build to a test environment. The workflow
follows this file step by step without making assumptions about the target.

Required sections:

```markdown
## Permissions

List every shell command prefix the deployer agent needs, one per line.
The workflow reads this section and merges entries into .claude/settings.json
before any agent runs.

Example:
  Bash(docker *)
  Bash(npm run *)

## Deploy

Step-by-step commands to deploy the build.

## Smoke test

A single command that confirms the deployment is alive. Exit 0 = healthy.

## CI

trigger: auto         # CI fires on push (default)
# or:
trigger: manual
manual_command: gh workflow run ci.yml --ref <branch>
```

If CI is not configured, the workflow creates a beads task to add it and
notifies the team. CI setup enters the normal develop loop like any other task.

### 3. integ-test-playbook.md

A runbook for the integration test environment -- separate from the application
deployment. Teams write this once per project; the integ-test-runner agent
(not the deployer, which only follows deploy.md) executes it every cycle.

Required sections:

```markdown
## Permissions

Same format as deploy.md Permissions.

## Setup

Commands to bring the test environment up from scratch.

## Reset

Commands to restore pristine state between cycles (faster than Setup).

## Teardown

Commands to fully shut down and clean up.
```

If the playbook does not exist, the workflow skips integration testing and
proceeds to harvest. The team will not receive integration test feedback.

### 4. .claude/settings.json permissions

The workflow reads the `## Permissions` sections from both `deploy.md` and
`integ-test-playbook.md` at startup and merges them into `.claude/settings.json`
before any agent is dispatched. If a `## Permissions` section is missing or
incomplete, the executing agent (deployer for `deploy.md`, integ-test-runner
for the playbook) will hit interactive prompts and block.

```bash
cat .claude/settings.json | jq '.permissions.allow'
```

---

## Loading a backlog from an external system

### From GitHub Issues

```bash
gh issue list --label sprint-candidate --json number,title,body \
  | jq -r '.[] | "bd create --title=\"\(.title)\" --description=\"\(.body)\" --type=feature --priority=2"' \
  | bash
```

### From Azure DevOps

```bash
az boards query --wiql "SELECT [Id],[Title],[Description] FROM WorkItems WHERE [State]='Active'" \
  --output json \
  | jq -r '.workItems[] | "bd create --title=\"\(.fields["System.Title"])\" --description=\"\(.fields["System.Description"] // "")\" --type=feature --priority=2"' \
  | bash
```

### From Jira

Export to CSV (summary, description, priority columns), then:

```bash
tail -n +2 jira-export.csv | while IFS=, read -r summary description priority; do
  bd create --title="$summary" --description="$description" --priority=2
done
```

### From a plain list

```bash
bd create --title="User can reset password via email" \
          --description="Send a time-limited reset link. Expires in 1 hour." \
          --type=feature --priority=1
```

The description is the most important field. A one-line title with no
description produces a weak plan.

---

## Triggering a sprint

From a Claude Code session in the project repository:

```
/auto-sprint {"branch": "feat/auth-overhaul", "issues": ["BD-12", "BD-15"], "goal": "P1"}
```

| Argument | Required | Default | Description |
|---|---|---|---|
| `branch` | yes | -- | Sprint branch. Created if it does not exist. |
| `issues` | yes | -- | Beads sprint goal IDs to implement this sprint. |
| `goal` | no | `P1/P2` | Exit criterion: `P1`, `P1/P2`, or `P1/P2/P3`. |
| `max_cycles` | no | `5` | Hard ceiling on cycles. |
| `requirementsFile` | no | none | Additional context file for the planner. |
| `base_branch` | no | `main` | PR target branch. |

---

## What happens in each phase

### Plan

The planner inspects the sprint goals and builds a feature+task DAG in beads:

- One or more **features** per sprint goal (concrete deliverables)
- **Implementation tasks** and **`[test]` tasks** per feature
- Dependencies wired so test tasks are blocked until implementation is complete
- Each task assigned an exact model based on complexity (see Model assignment)

After building the DAG, the planner runs `bd ready` to verify correctness: if
features rather than tasks are unblocked, dependencies are wired backwards and
the planner must fix them before continuing.

The plan-reviewer then inspects the full DAG:
- Does `bd ready` return only tasks (not features or sprint goals)?
- Does every feature have both an impl task and a `[test]` task?
- Does every task have clear acceptance criteria?
- Is every task sized to 1-3 file changes?
- Does every task appear in exactly one feature's subtree?
- Does every task have a model assignment?

The loop repeats until the reviewer approves. If the reviewer requests changes,
the feedback is committed to `feedback.md` on the branch and the planner reads
it before the next attempt.

On cycle 2+, the planner focuses only on unresolved issues. It does not re-plan
completed work.

### Develop

The develop loop works through tasks in dependency order until no ready tasks
remain. Within each iteration:

1. **Model streaks** -- ready tasks are grouped by assigned model (all haiku
   tasks together, all sonnet tasks together, etc.). One developer agent is
   dispatched per group. This minimises model-switching cost while preserving
   dependency order.

2. **Developer agent** -- works its assigned tasks, runs fast tests after each,
   and stops at a VERIFY checkpoint. A task is only closed by the developer
   once its acceptance criteria are met.

3. **Reviewer agent** -- inspects the diff against each task's acceptance
   criteria. `APPROVED` advances the loop. `CHANGES NEEDED` writes specific
   feedback to `feedback.md`, reopens the relevant tasks in beads, and the
   develop loop picks them up in the next iteration.

The reviewer model is matched to the work: if any task in the iteration ran on
opus, the reviewer uses opus; otherwise sonnet. Haiku work is always reviewed
by at least sonnet.

### Test

When integration testing is configured:

1. **Deploy** -- the deployer follows `deploy.md` to build and push to the test
   environment, then confirms the smoke test passes. If it fails, the cycle
   skips testing and proceeds to the exit check.

2. **Integration test run** -- the test runner executes tests feature by feature:
   - All pass -> feature closed in beads
   - Any fail -> a bug or enhancement is created in beads with a priority
     reflecting severity; feature stays open
   - Inconclusive -> feature stays open; notes updated

3. **Teardown** -- the test environment is reset. Cycle 2+ uses the faster
   `Reset` path rather than a full teardown and setup.

Defects filed during testing flow into the next cycle's plan phase.

### Exit check

After each cycle, the workflow counts all open issues within the sprint's scope
(the sprint goals and their full subtrees, plus any bugs filed during testing) at or
above the goal priority. If the count is zero, the sprint succeeds. If the
identical set of issues remains open from the previous cycle, the sprint aborts --
something structural needs human attention.

---

## Resume and crash recovery

If a sprint is interrupted mid-cycle, simply re-trigger it with the same
arguments. At the top of each cycle, the workflow inspects beads to determine
what has already been done:

- If planning is already complete (features and tasks are in place with
  acceptance criteria), the plan loop is skipped entirely.
- Any tasks left in `in_progress` state from a crashed agent are reset to
  `open` so they re-enter the develop queue cleanly.

No state is stored in memory -- everything is reconstructed from beads and git.

---

## Model assignment

Matching model power to task complexity is a core capability, not an option.
The planner assigns an exact model to every task when it builds the DAG:

| Model | When the planner uses it |
|---|---|
| haiku | Mechanical work: rename, config tweak, move file, simple wiring |
| sonnet | Standard work: new function, test suite, API endpoint, refactor |
| opus | Hard work: architecture, multi-file design, ambiguous requirements |

The planner tries to group tasks so consecutive tasks in dependency order share
a model -- this forms a streak that runs in a single agent dispatch rather than
switching models between each task.

Reviewers and planners always use the strongest model. Only developer tasks run
on the planner-assigned model.

---

## CI integration

The workflow records the git HEAD SHA at the end of the develop phase. CI is
expected to trigger automatically from the push. After the PR is created,
the ci-watcher polls `gh run list --pr N` until CI reports green or red and
annotates the PR with the result if CI is not green.

The ci-watcher runs after PR creation because CI run queries require a PR
number. If runs exist for the branch but none match the current HEAD SHA,
the watcher classifies the result as `pending` (CI is in progress), not
`not_configured`. `not_configured` is reserved for the case where no CI
runs exist at all for the PR.

If CI is not configured, a P2 beads task `Add CI pipeline to project` is
created and enters the normal develop loop in the next cycle.

---

## Cost tracking

Every agent dispatch is measured using actual output token counts. After each
dispatch, the workflow logs:

```
$0.0312 doer-c1-i0 -- tasks BD-5, BD-6
$0.0145 reviewer-c1-i1 -- reviewing tasks BD-5, BD-6
```

At the end of each cycle, the full dispatch ledger is written as JSONL to
`sprint-logs/<branch>-<timestamp>.jsonl` and committed to the branch. The branch name is
sanitized (path separators and special characters replaced with dashes) and a
`yyyymmdd_hhmmss` timestamp is appended, so that parallel sprints on the same or different
branches never write to the same file. Each line records:

```json
{"cycle":1,"phase":"Develop","label":"doer-c1-i0","model":"claude-sonnet-4-6","context":"tasks BD-5, BD-6","outTokens":967,"costUsd":0.0145}
```

At sprint end, a cost summary is printed grouped by role:

```
=== Sprint cost summary (output tokens only) ===
  doer                  $0.1823     2431 tok  8 call(s)
  reviewer              $0.0967     6447 tok  4 call(s)
  planner               $0.0312      416 tok  2 call(s)
  TOTAL                 $0.3102
```

To query the log after a sprint (replace `<branch>` with the sanitized branch name,
e.g. `feat-auth-overhaul` for branch `feat/auth-overhaul`):

```bash
# cost by role -- all runs on this branch
jq -r '[(.label | gsub("-c[0-9].*$"; "")), (.costUsd | tostring)] | @tsv' sprint-logs/<branch>-*.jsonl \
  | awk '{sum[$1]+=$2} END {for(r in sum) printf "%s\t$%.4f\n", r, sum[r]}'

# what each dollar was spent on -- one specific run
jq -r '"$\(.costUsd)  \(.label)  \(.context)"' sprint-logs/<branch>-<timestamp>.jsonl

# aggregate across all sprints in the repo
cat sprint-logs/*.jsonl | jq -r '"$\(.costUsd)  \(.label)  \(.context)"'
```

Costs reflect output tokens only -- input tokens are not exposed by the workflow
harness. The true cost will be higher, typically 2-4x depending on model and
context size.

---

## What you get at the end

When the sprint goal is met:

- All targeted features are closed in beads
- Beads state is synced to the Dolt remote via `bd dolt push` (non-fatal -- a
  missing remote logs a warning but does not abort harvest)
- A reviewed pull request is open against `base_branch`
- `docs/` is updated with architecture decisions and feature documentation
- `CHANGELOG.md` has a new entry summarising the sprint
- `sprint-logs/<branch>.jsonl` is committed to the branch with per-dispatch cost data
- `sprint-logs/<branch>-<timestamp>.analysis.md` is written with a Sprint Execution
  Summary: cycles, per-phase token/cost/dispatch table, failures/retries, and
  remaining risks at close
- A cost summary table is printed in the workflow output

If the sprint exits via `max_cycles` without meeting the goal:

- A PR is still raised, clearly marked as partial
- All open issues remain in beads for the next sprint
- The PR description explains what was completed and what remains

---

## Failure modes and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| Plan loop does not converge | Sprint goal descriptions too thin | Add detail to the beads issue descriptions before re-triggering |
| `bd ready` shows features, not tasks | Dependencies wired backwards | The plan-reviewer should catch this; if it recurs, inspect `bd graph --compact <sprint-id>` -- tasks should be at layer 0 |
| Smoke test fails every cycle | Deploy steps broken | Fix `deploy.md` and test manually before re-triggering |
| Same issues open across two cycles | Defects deeper than tasks can fix | Review the open issues; consider re-scoping the sprint goal |
| CI always red | CI config broken | Address the CI beads task first; it blocks harvest |
| `max_cycles` reached | Sprint is too large | Split the sprint goals into smaller targeted sprints |

---

## Working with the beads backlog between sprints

```bash
bd list --status=open          # see everything pending
bd list --priority=1           # P1 items only
bd show BD-42                  # inspect one issue
bd update BD-42 --priority=2   # re-prioritise
bd create --title="..."        # add new items
bd close BD-42                 # remove resolved items
```

P3/P4 items carried forward from a sprint are visible alongside new work items.
Prioritise before triggering the next sprint so the planner has a clear signal
about what matters most.
