# apra-pm

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Apra-Labs/apra-pm)

A project management package for AI coding harnesses. It ships two complementary
surfaces that share the same agent definitions in `agents/`:

| Surface | Provider | Entry point | State store |
|---|---|---|---|
| **`pm` skill** | Any (Claude, AGY, OpenCode, ...) | `/pm` in your harness | beads + git |
| **`auto-sprint` workflow** | Claude Code only | `/auto-sprint` in Claude Code | beads (no PLAN.md) |

The `pm` skill is the provider-agnostic path: invoke it in any harness and it
drives the full plan -> develop -> harvest lifecycle via natural language.

The `auto-sprint` workflow is Claude-only and fully deterministic: a JavaScript
loop drives nine agents (planner, plan-reviewer, doer, reviewer, deployer,
integ-test-runner, regression-test-runner, ci-watcher, harvester) through
repeating cycles until a user-defined quality
bar (zero P1 issues, zero P1/P2 issues, etc.) is met or the cycle limit is reached.
No agent ever decides whether to continue -- all routing is in the workflow script.

## auto-sprint (Claude Code)

```
while (open issues above goal threshold > 0 AND cycles < max):
  Plan       -- planner (opus) decomposes sprint goals into a feature+task DAG in beads
               plan-reviewer validates coverage, acceptance criteria, and assigns
               a complexity bucket (S/M/L) and model to every task
  Develop    -- doer works bd-ready tasks on the model the planner assigned;
               reviewer approves or reopens (reviewer model >= sonnet)
  Deploy     -- deployer follows deploy.md (deploy + smoke test)
  Test Run   -- integ-test-runner runs integ-test-playbook.md end to end
               (real functional suite, then sandbox up -> smoke sprint ->
               teardown); closes passing features, files bugs for failures
  Exit check -- beads query: are open issues above threshold? same set as last cycle?

Finalization (once): regression-test-runner runs regression-test-playbook.md --
                     failures carry over as [regression][carry-over] beads, they
                     never gate this sprint's verdict
CI check (haiku, non-blocking): polls after PR is created; annotates PR when not green
Harvest (once): harvester writes sprint analysis, updates docs/CHANGELOG, raises PR
```

### Cost estimation and calibration

After the plan is approved, the workflow produces a cost quote for the sprint --
three scenarios (optimistic / expected / pessimistic) -- using per-task complexity
buckets and the model each task was assigned. All arithmetic is pure JavaScript;
no agent does any calculation.

At sprint end, actual token spend (from the durable sprint log) is compared against
the quote and written to CHANGELOG. The harvester then updates
`sprint-logs/calibration.json` with rolling-average actuals, so each successive
sprint produces tighter estimates. The calibration loop targets +-50% accuracy;
500%+ deviation triggers a calibration failure flag.

Models are referred to by provider-agnostic tier name (`cheap` / `standard` /
`premium`); `TIER_TO_MODEL` in `auto-sprint.js` is the only place a tier maps to a
concrete model family. Default prices used for estimation: cheap $5/M,
standard $15/M, premium $25/M output tokens.

Sprint logs are durable per-branch outputs named
`sprint-logs/<branch>-<yyyymmdd_hhmmss>.jsonl` and are never deleted. The `.jsonl`
ledgers stay local (gitignored); the committed deliverables are `calibration.json`
and the `<timestamp>.analysis.md` summary.

### Harvest: dolt push and execution summary

After the beads export/cleanup step and before PR creation, the Harvest phase
automatically runs `bd dolt push` to sync the Dolt remote. Failure is non-fatal
-- a missing remote or network error logs a warning and harvest continues.

The sprint analysis artifact (`sprint-logs/<branch>-<timestamp>.analysis.md`)
includes a **Sprint Execution Summary** section: cycles run (with develop
iteration count, reviewer CHANGES NEEDED rounds, and plan re-rounds), per-phase
dispatch/token/cost breakdown, failures/retries, and remaining risks at close.
The summary is generated even when `goalMet=false`.

### Develop-loop resilience

The develop loop includes three protections against doer context exhaustion:

- **JIT task close** -- the doer closes each task immediately after committing
  it, before claiming the next one. Completed work is always recorded even if
  the session ends mid-streak.
- **Streak token-ceiling** -- `truncateStreakToCeiling()` caps each streak to the
  longest prefix whose estimated output tokens fits under
  `calibration.doer_token_ceiling[tier]` (tunable per model tier in
  `sprint-logs/calibration.json`).
- **Null-return recovery** -- if the doer dispatch returns null, orphaned
  in_progress tasks are reset to open and the loop retries instead of aborting.
  The `MAX_DEV_ITER=20` bound still applies.

### Develop-loop progress visibility

The workflow logs structured entries at each develop iteration: task ids +
estimated USD before the doer dispatch, ready-task count at iter entry, and
reviewer verdict (APPROVED / CHANGES NEEDED) with task ids after review. Agent
session labels carry the same task-id suffix for searchability.

### Exit check scoped to open leaf work

`parseBlockers()` in leaf mode (`{ rootIds, leaf: true, includeFeatures }`) counts
open `type=task` leaves plus any open verify-set bead -- a bead of ANY issue_type
(feature, bug, or task-with-children) whose children are ALL closed while it is
still open (children-all-closed, parent-open) -- inside the sprint subtree,
excluding the root goals. Roots close at Harvest, so counting them would make
`goalMet` unreachable in-loop; leaf-scoping keeps the exit and no-progress checks
meaningful. Unrelated open issues elsewhere in the beads DB never affect
`goalMet`.

### CI pipeline task dedup guard

When no CI is configured for a project, the workflow creates a `Add CI pipeline
to project` beads task. Before creating it, the workflow searches for an open
task with that name. If one already exists it is reused; a duplicate is never
filed. A previously closed task does not suppress creation of a new one -- the
guard is scoped to open tasks only.

See `docs/sprint-workflow.md` for the full user guide and `docs/dispatch-patterns.md`
for the architectural decisions governing agent dispatch, parallelism, and
develop-loop resilience.

## pm skill (all providers)

The `pm` skill drives the same agents via natural language from any harness.
See `skills/pm/SKILL.md` and its sub-docs for the full workflow.

### Fleet member selection: tag-based dispatch

When running in fleet mode, the pm skill selects members by tags
(`tags: ['doer']` / `tags: ['reviewer']`); `list_members` has no `role`
parameter. Multi-tag queries narrow selection by capability (e.g.
`list_members(tags: ['reviewer', 'bitbucket'])`); fall back to the single-tag
query when no member matches. `compose_permissions` must be called before every
fleet dispatch, and a tag switch always requires a fresh dispatch
(`resume=false`). See `docs/pm-tag-dispatch.md` for the full design and
invariants.

## Layout

```
skills/pm/               the pm skill (SKILL.md + sub-docs)
agents/                  agent definitions (shared by both surfaces)
agents/schemas/          machine-readable input/output contracts per role
agents/_shared/          prompt fragments included by several agents
.claude/workflows/       auto-sprint.js -- deterministic Claude Code workflow
lib/                     parse-sprint-args.mjs, vet-kb-work.mjs -- standalone helpers
test/                    node --test suites (npm test)
sprint-logs/             calibration.json + per-sprint JSONL cost logs (durable)
install.mjs              installer: copies skill + agents + workflow into provider config dir
e2e/                     end-to-end suite: drive the skill headless on the toy repo
docs/                    sprint-workflow.md user guide + design intent; dispatch-patterns.md
.githooks/               pre-commit (ASCII-only guard)
```

The cost arithmetic lives in the `PURE_FUNCTIONS_BEGIN`/`PURE_FUNCTIONS_END` block
inside `.claude/workflows/auto-sprint.js`. `install.mjs` extracts that block verbatim
to `<configDir>/skills/pm/cost.js` so the pm skill can use the same functions on any
provider; `test/sprint-cost.test.mjs` evaluates the same block directly.

## Install

Installs the skill, agents, and (for Claude) the workflow into your harness config.

```
node install.mjs --llm claude     # or: agy | opencode   (default: claude)
```

This writes:
- `<configDir>/skills/pm/` -- the pm skill, plus the generated `cost.js`
- `<configDir>/agents/*.md` -- every agent definition in `agents/`
- `<configDir>/agents/schemas/` and `<configDir>/agents/_shared/` -- role contracts
  and shared prompt fragments
- `<configDir>/settings.json` (`opencode.json` for OpenCode) -- minimal permissions
  (merged, non-destructive)
- `~/.claude/workflows/auto-sprint.js` -- the auto-sprint workflow (claude only)
- `<configDir>/skills/auto-sprint-args/` -- the args-contract helper skill (claude only)

Requires `git`, `gh` (GitHub CLI), and beads (`bd`) on PATH.

## Use

**Claude Code** -- trigger the deterministic multi-cycle workflow:

```
/auto-sprint {"branch": "feat/auth-overhaul", "issues": ["BD-12", "BD-15"], "goal": "P1/P2"}
```

| Argument | Required | Default | Description |
|---|---|---|---|
| `branch` | yes | -- | Sprint branch. Created if it does not exist. |
| `issues` | yes | -- | Beads sprint goal IDs to implement this sprint. |
| `goal` | no | `P1/P2` | Exit criterion: `P1`, `P1/P2`, or `P1/P2/P3`. |
| `max_cycles` | no | `5` | Hard ceiling on sprint cycles. |
| `requirementsFile` | no | -- | Additional context file for the planner. |
| `base_branch` | no | `main` | PR target branch. |
| `skip_dolt_push` | no | `false` | Skip the Harvest `bd dolt push` (used by CI/e2e). |

See `.claude/skills/auto-sprint-args/SKILL.md` for the full argument contract.

Deploy and integration test phases require `deploy.md` and `integ-test-playbook.md`
in the project root; without them the workflow skips those phases and proceeds
directly to harvest.

**Other providers** -- invoke the pm skill:

```
/pm implement the auth overhaul sprint goals (BD-12, BD-15) on branch feat/auth-overhaul
```

## E2E

`e2e/run-e2e.mjs` clones the toy repo, renders the scenario with the repo path and
a unique branch, invokes the provider CLI headless with the skill installed, and
reads the `checkpoints.json` the orchestrator writes. The sprint runs the full
lifecycle -- it pushes the branch and raises a real PR on the toy (no merge); the
runner closes that PR and deletes the branch afterward (use `--keep-pr` to retain).

```
node install.mjs --llm claude
node e2e/run-e2e.mjs --provider claude          # all claude suites
node e2e/run-e2e.mjs --suite s1                 # one suite
```

Suites are defined in `e2e/suites.json` and are OS-independent (the runner is chosen
by the CI workflow's `runner` input):

| Suite | Provider | Scenario |
|---|---|---|
| `s1` | Claude | `e2e/scenario.md` (pm skill) |
| `s8` | AGY | `e2e/scenario.md` (pm skill) |
| `s9` | OpenCode | `e2e/scenario-opencode.md` (pm skill) |
| `s10` | Claude | `e2e/scenario-auto-sprint.md` (auto-sprint workflow) |

CLI flags vary by tool; override a provider's command with e.g.
`PMLITE_E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"`.

Pushing the branch and opening the PR needs write access to the toy: set
`GH_TOKEN` / `E2E_GH_TOKEN`, or rely on the runner's ambient git + gh credentials.

CI: the monorepo's `.github/workflows/pm-e2e.yml` (manual trigger, one suite per run;
needs a runner with the provider CLI authenticated, plus node 20+, `bd`, and
`secrets.E2E_GH_TOKEN`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Enable the ASCII pre-commit guard once after
cloning (run from the repository root -- `core.hooksPath` is repo-wide):

```
git config core.hooksPath packages/apra-fleet-se/apra-pm/.githooks
```

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
per the [Security Policy](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
