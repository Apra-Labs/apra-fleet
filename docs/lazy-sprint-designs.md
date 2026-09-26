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
built-in. The default for a new sprint is `fast-pipeline`, chosen by the
benchmarks below.

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

Ten sprints, one per design and task, each on a fresh copy of the same starting
repo, all through the lazyfleet launcher with the same engine commit. Limits:
2 cycles, a $6 usage limit, `npm test` as the landing check for pipeline
designs. One run each, so treat small differences as noise.

Quality was measured four ways:

- **Hidden spec tests**: acceptance tests written from the spec only (27 for
  task A, 24 for B), never seen by a sprint.
- **Test strength**: mutation testing of the sprint's own tests. Each module is
  wrapped so it returns a subtly wrong result (digits dropped, an ellipsis that
  overflows, numbers sorted as text...), and the score is the share of those
  the sprint's own tests catch. The wrapper calls the original first, so input
  checks and errors stay intact.
- **Blind review**: one reviewer per task grading the codebases side by side,
  with design names hidden, on correctness, robustness, tests, readability,
  consistency, docs and scope, then an overall score out of 10.
- Spec and hygiene checks (files, exports, README, CLI).

### Task A: a 4-function string library

| Design | Time | Est. cost | Agent runs | Hidden tests | Test strength | Review /10 |
|---|---|---|---|---|---|---|
| Solo | 1.7 min | $0.20 | 3 | **25/27** | 77% | 4 |
| Features only | 3.1 min | $0.65 | 7 | 27/27 | 85% | 7 |
| Classic | 7.6 min | $1.16 | 6 | 27/27 | 100% | 8 |
| Fast pipeline | 9.2 min | $1.67 | 12 | 27/27 | 92% | 8 |
| Classic + docs check | 9.7 min | $1.34 | 8 | 27/27 | 92% | 7 |
| Pipeline | 14.4 min | $3.29 | 22 | 27/27 | 92% | 7 |

### Task B: an 8-function CSV toolkit with a CLI

| Design | Time | Est. cost | Agent runs | Hidden tests | Test strength | Review /10 |
|---|---|---|---|---|---|---|
| Solo | 4.1 min | $0.49 | 3 | 24/24 | 100% | 5 |
| Fast pipeline | 8.1 min | $2.59 | 19 | 24/24 | 100% | 8 |
| Classic | 15.2 min | $2.09 | 9 | 24/24 | 100% | 6 |

### Task C: end-to-end tests only, on a library with one planted bug

The End-to-end tests only design ran in 2.5 minutes ($0.29), changed no product
code (one new file, `test/e2e.test.js`), found the planted bug (slugify
dropping digits) and filed it as a P1 task for a later sprint.

### What the numbers say

- **Solo is the cheapest and fastest, and the least careful.** On task A it
  shipped a real spec bug (`truncate('hello', 3)` returned `'hel'`) and tests
  that lock the bug in; on task B the blind review found robustness gaps (a
  bare CR merges rows, the CLI ignores bad arguments).
- **Features only** was correct and three times faster than Classic on a small
  task, with thinner tests. The landing check did its job as the safety net.
- **Pipeline's fixed costs dominate a small task.** Fast pipeline removes most
  of them: on task A it was 36% faster and half the cost of Pipeline, with the
  same test strength and a better review.
- **On the larger task the parallel build pays off.** Fast pipeline finished in
  8.1 minutes against Classic's 15.2, and was the only codebase the blind
  review found no real spec bug in. It cost about a quarter more, mostly in
  reviews.
- **The model floor mattered.** Every design with a floor built on standard;
  the cheap-tier bug that cost Pipeline a whole cycle in the first benchmark
  did not come back.

That is why the default is `fast-pipeline`. Solo or Features only are good
choices for a quick change you will check yourself; Classic when you want the
strongest tests on small work.

### Caveats

One run per design; model output varies run to run. The tasks are small. Costs
are the engine's token-price estimate (plan usage on a subscription). The
hidden tests and mutants are this benchmark's own, and the blind reviewer is a
single model with its own taste. The first draft of the hidden tests missed
Solo's truncate bug and was too strict about CRLF output; both were fixed and
every run was re-scored.
