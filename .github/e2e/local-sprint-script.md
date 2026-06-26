# Fleet-less Sprint -- Local Subagents Only

Fleet-less sprint -- local subagents only. Do NOT use any fleet server, fleet MCP tools, member registration, member pairing, or remote prompt dispatch. Use your installed planner/plan-reviewer/doer/reviewer subagents directly.

## Setup

The repo is already cloned at `{{REPO}}` (origin `{{TOY_PROJECT_URL}}`, base `main`). Work on branch `{{BRANCH}}`.

```bash
cd {{REPO}}
git fetch origin
git checkout -b {{BRANCH}} origin/main
```

Configure git identity:

```bash
git config user.email "e2e@pm"
git config user.name "pm-e2e"
```

## Pick the work

Work on exactly this one issue: `gh-toy-4ef` (Add --version flag to CLI). Write `requirements.md` for this issue only. Do NOT pick additional issues or run `bd ready`.

## Run the sprint

Run the pm skill commands in order:

1. `/pm plan` -- plan the work for issue `gh-toy-4ef` only. This uses your local planner and plan-reviewer subagents.
2. `/pm start` -- execute the plan. This uses your local doer and reviewer subagents.
3. `/pm cleanup` -- finalize the sprint, push the branch, and raise a PR.

Scaffolding discipline: `requirements.md`, `plan.md`, `feedback.md`, and `progress.json` MUST appear in intermediate commits (proving process was followed) but MUST NOT be in the final net diff (cleanup removes them).

## VCS

VCS provider: {{VCS}}. Push the branch and raise a PR against `main` on the toy repo.
