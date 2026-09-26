# Sprint designs

A sprint design decides which steps a sprint runs and how. The engine
(fleet-sprint) used to run one fixed sequence; a design turns each step on or
off, sets how it runs, and adds steps of your own. Designs are picked in the
New sprint form and built on the Sprint designs page of `lazyfleet ui`.

## Where designs live

| Source | Folder | Editable in the UI |
|---|---|---|
| Built in | `src/lazy/sprints/designs.ts` (`BUILT_IN_DESIGNS`) | No (copy one) |
| Yours | `~/.lazyfleet/designs/<id>.json` | Yes |
| The project's | `<project>/.lazyfleet/designs/<id>.json` | No (commit them) |

A project's design wins over yours with the same id, and both win over a
built-in. The default for a new sprint is `pipeline`.

## The file

```json
{
  "id": "release-check",
  "name": "Release check",
  "description": "Fast pipeline plus a lint command and a security check.",
  "cycles": 3,
  "check": "npm ci && npm test",
  "helpers": 3,
  "plan":   { "run": "when-needed", "review": true },
  "build":  { "mode": "pipeline", "minModel": "standard", "acceptanceTasks": false },
  "review": { "run": "on", "split": "auto", "splitMinFiles": 20 },
  "test":   { "run": "auto" },
  "blocks": [
    { "kind": "command", "name": "Lint", "command": "npm run lint" },
    { "kind": "check", "name": "Security", "slot": "finish",
      "instructions": "No secrets in code or logs; every external input is validated." }
  ],
  "finish": { "finalReview": true, "harvest": false }
}
```

Every field is optional. `cycles`, `check` and `helpers` belong to the
launcher; everything else is the engine recipe, passed to fleet-sprint as
`--recipe-file` and validated by its `normalizeRecipe()`
(`packages/apra-fleet-se/fleet-sprint/recipe.mjs`). The UI and the launcher
call the same validator, so a design that saves is a design that runs.

| Field | Values | Effect |
|---|---|---|
| `plan.run` | `always`, `when-needed`, `first-cycle`, `off` | `when-needed` plans again on cycle 2+ only if open work is not yet split into tasks, or rejected findings wait to be resubmitted. `off` hands the whole ask to one builder. |
| `plan.review` | `true`, `false` | `false` skips the plan reviewer. |
| `build.mode` | `pipeline`, `classic`, `off` | `off` means no product code this sprint. |
| `build.minModel` | `cheap`, `standard`, `premium` | Floor under every builder's model tier. |
| `build.acceptanceTasks` | `true`, `false` | Pipeline planning with or without per-feature acceptance-test tasks. |
| `review.run` | `on`, `off` | `off` skips every review; a cycle ends when nothing is open at goal priority. |
| `review.split`, `splitMinFiles` | `always`, `auto`, `never`; number | When the pipeline's end-of-cycle review is split across reviewers. |
| `test.run` | `auto`, `off` | The project's deploy / integration runbooks. |
| `finish.finalReview` | `true`, `false` | `false`: PASS means nothing is open at goal priority. |
| `finish.harvest` | `true`, `false` | The docs and changelog pass. |
| `check` | command | Pipeline: gates each landing. Classic: a command step after the build. |
| `blocks[]` | see below | Your own steps. |

### Custom steps (`blocks`)

| `kind` | What runs | On failure |
|---|---|---|
| `check` | A fresh reviewer whose focus is `instructions`. | Its verdict is applied like a Re-Review (guarded reopens, validated new tasks), or only reported with `"onFail": "ignore"`. |
| `work` | A builder does `instructions` on the sprint branch and commits, at `model` (default standard). | Its notes are logged. |
| `command` | `command` on the bookkeeping helper, after a pull. | A P1 "Fix: <name> failed" task with the output tail, or nothing with `"onFail": "ignore"`. |

`slot` is `after-build` (every cycle, before tests and review) or `finish`
(once, before the final review).

## What a design cannot change

The sync brackets, one-at-a-time landing, orchestrator-only task writes, the
workspace and keep-out rules, permission blocks and the usage limit apply to
every design and every custom step. Design text is plain ASCII and length
limited because it reaches prompts and shell commands.

## Built-in designs

| Design | Plan | Build | Review | End |
|---|---|---|---|---|
| Classic | every cycle, reviewed | classic, 3 helpers | every round | final review, docs |
| Pipeline | every cycle, reviewed | pipeline | end of cycle, split | final review, docs |
| Fast pipeline | only for new work | pipeline, standard+, no acceptance tasks | split only when big | final review |
| Features only | only for new work, not reviewed | pipeline, standard+ | off | nothing |
| Solo | off | one builder, standard+ | off | final review |
| End-to-end tests only | off | off, plus a work step and a check step | off | nothing |
| Classic + docs check | as Classic | as Classic, plus a README check step | every round | final review, docs |

## Benchmarks

See "Design benchmarks" below (filled in from the benchmark runs).
