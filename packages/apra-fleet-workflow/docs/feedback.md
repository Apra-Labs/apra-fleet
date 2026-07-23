# Design Review: apra-fleet-workflow + apra-fleet-se/auto-sprint

**Date:** 2026-07-11
**Reviewer:** Fable (background deep-review agent), high reasoning effort
**Scope:** Read-only architecture/reliability review. No code changes made during this review.

Paths below are relative to `C:\akhil\git\apra-fleet-reorg\packages\`. `WF` = `apra-fleet-workflow`, `SE` = `apra-fleet-se`, `CL` = `apra-fleet-client`.

## Context

`apra-fleet-workflow` is a new framework layered on top of `apra-fleet` (a fleet-of-AI-agents
orchestration system with its own MCP server), intended to let the author build **autonomous,
deterministic agentic workflows** -- inspired by Claude CLI's dynamic workflow tooling, but built
on apra-fleet's agent/member primitives rather than being locked into the Claude CLI. The first
concrete workflow built on this framework is `apra-fleet-se/auto-sprint`, an automated
software-development sprint pipeline (plan -> develop -> test -> harvest cycles, driven by a
beads issue-tracker DB). The long-term ambition is that this same workflow engine should
generalize to non-software domains too (retail, logistics, healthcare, etc.), so the
abstractions in `apra-fleet-workflow` matter as much as the concrete `auto-sprint` implementation.

## Executive summary

The framework has a sound instinct set -- phases/activities, schema-validated agent output, a
live dashboard, cost accounting, a vetting layer -- but nearly every one of these is currently a
facade over an unhardened core. The engine executes workflow scripts via `AsyncFunction` with
regex-based "vetting" that is trivially bypassable and even breaks one of its own three examples;
token usage is literally fabricated with `Math.random()` when the fleet doesn't report it; the
budget object is never debited or enforced; and there is no timeout, retry, idempotency, or
resume anywhere in the stack (a hung MCP response hangs the sprint forever). The concrete
`auto-sprint` runner is a happy-path skeleton, not the workflow its own diagram, CLI, and skill
contract describe: the CLI's execution block is commented out, `branch`/`goal`/`base_branch`
args are accepted but never read, no git branch or PR is ever created, a plan that fails review
3 times is executed anyway, and the final "Pass or Fail?" verdict is discarded before returning
`{status:'success'}` unconditionally. The "deterministic" claim currently rests on
`String.includes('APPROVED')` over free-form LLM text and on `bd list --ready` emptiness, which
conflates "blocked" with "done." The test suite is effectively dead: the unit tests import a
nonexistent path and a prior API, the edge-case runner crashes at import (`startViewer` doesn't
exist), and the mock sprint test's role-name casing means the deployer/integ/harvester branches
are never exercised. Framework-vs-auto-sprint layering is actually the healthiest part of the
design -- `engine.mjs`/`index.mjs` contain no beads/git assumptions -- but the domain-agnosticism
is achieved mostly by the framework doing very little. The direction is realizable; the current
implementation is a demo that must not be pointed at a real repo yet.

---

## Framework-level findings (apra-fleet-workflow)

### F1. The "sandbox" and VettingEngine are security theater -- and the loader breaks its own examples
Evidence: `WF/src/workflow/engine.mjs:50` strips only `export const meta`; `WF/examples/03-transform-sequential.js:7`
declares `export async function main()`, which survives into the `AsyncFunction` body and is a
SyntaxError -- the engine cannot run its own example. `engine.mjs:58-75` runs the script as an
`AsyncFunction` with injected globals, but the script still sees `globalThis`, `process`,
`fetch`, `import()`. `WF/src/workflow/vetting.mjs:33-47` is regex matching:
`globalThis['pro'+'cess'].env` or `await import('child_process')` written as
`'child_'+'process'` sail through, while `WF/docs/apra-fleet-workflow-architecture.md:33-39`
claims the analyzer "strictly prohibits" these. The vetting engine also bans `new Function`
(vetting.mjs:44) -- the exact mechanism the engine itself uses.

Why brittle: false sense of safety for "pull workflows from public repos" (the doc's stated
threat model), plus a loader that fails on standard ESM.

Recommendation: either drop the RCE-safety claim and treat workflow scripts as trusted code
(import them as real ES modules via `import(pathToFileURL(...))`, which also fixes the `export`
bug and error line numbers), or do real isolation (`node:vm` with a frozen context, or a worker
with a permissions-restricted Node). Do not ship regex vetting as a security boundary.

### F2. Fabricated usage/cost data
Evidence: `WF/src/workflow/index.mjs:130-134` -- if the fleet result lacks `usage`, the engine
invents random prompt/completion token counts and feeds them into `calculateCost` and the
dashboard "$ Spent" banner (`WF/src/viewer/index.mjs:341-345`).

Why brittle: the operator-facing cost number is fiction; when budget enforcement is eventually
wired to it, spend limits become fiction too. `WF/src/workflow/pricing.mjs` also carries stale
2024 model prices with a `default` fallback that silently misprices everything else.

Recommendation: report `usage: null` honestly, render "n/a" in the viewer, and treat missing
usage as a fleet-server bug to fix at the source.

### F3. `budget` is a dead stub
Evidence: `WF/src/workflow/index.mjs:44-49` defines `budget._spent = 0`; grep confirms `_spent`
is never incremented anywhere in `packages/`. `calculateCost` results (index.mjs:136) go only to
viewer events.

Recommendation: debit `budget._spent += cost` in `activity:end`, and check `budget.remaining()`
before each `agent()` dispatch, throwing a typed `BudgetExceededError`. This is the cheapest of
all the reliability fixes.

### F4. Inconsistent, string-sniffed error contract
Evidence: member-not-found is detected by `text.startsWith('Member "') && text.includes('" not
found.')` and returns `null` (index.mjs:142-146 for agent, 231-235 for command); command
`isError` throws (index.mjs:237-241); schema failure throws (158-169); transport failure throws
(179-183). So callers face three different failure signals -- `null`, throw, or a
normal-looking string -- for the same class of problem. `WF/docs/structured-errors-proposal.md`
correctly diagnoses this but is unimplemented. Downstream, `SE/auto-sprint/runner.js:81` calls
`.includes()` on an agent result -- a member-not-found `null` produces a `TypeError`, not a
handled failure.

Recommendation: implement the structured-errors proposal (Option 1) in the fleet server, and
until then make `agent()`/`command()` never return `null` -- always throw a typed error
(`MemberNotFoundError`, `AgentOutputError`, `CommandError`) so workflow authors have one contract.

### F5. Structured output is prompt-and-scrape, single-shot, no repair loop
Evidence: the schema is appended as prose to the prompt (index.mjs:101), the reply is scraped
with the greedy regex `/\{[\s\S]*\}|\[[\s\S]*\]/` (index.mjs:151) -- which grabs from the first
`{` to the last `}` and fails whenever the model emits two JSON blocks or trailing prose
containing a brace -- and any parse/validation failure is an immediate hard throw (158-169) with
no re-ask.

Why brittle: over a 5-cycle sprint with dozens of agent calls, one malformed reply kills the
entire run; there is no journal to resume from (F6).

Recommendation: add a bounded validation-repair loop (re-prompt with `ajv.errorsText` up to N
times), and prefer enforcing schema at the tool-call layer on the member (Claude CLI enforces
structured output at the harness, not by asking nicely).

### F6. No timeout, retry, idempotency, or resumability anywhere in the stack
Evidence: `CL/src/client/client.mjs:41-57` -- `request()` registers a pending promise with no
timeout; if the server accepts the request and never replies (without closing the transport), the
workflow awaits forever. No retry policy exists in `client.mjs`, `api.mjs`, or `index.mjs`. No
dispatch carries an idempotency key, so a retry after ambiguous failure can double-run a doer
(double commits, double `bd close`). The engine has no execution journal: a crash at cycle 3 of
`runner.js` loses all in-memory state (`cycle`, `devRounds`, `doerFeedback`) and a re-run starts
from scratch, re-dispatching the planner against an already-planned beads DB.

Recommendation: (1) client-side timeout defaulting to the server's `timeout_s`; (2) an
append-only run journal (JSONL of `activity:start/end` with inputs/outputs -- the viewer already
has exactly this event stream) and an engine `resume(journal)` mode that replays cached results,
Claude-CLI-style; (3) idempotency tokens on `execute_prompt`/`execute_command`.

### F7. `sequential()` API has silently diverged from docs, examples, and tests -- multi-stage pipelines are dropped on the floor
Evidence: implementation is `sequential(items, processor, opts)` (index.mjs:255). But
`WF/docs/apra-fleet-workflow-architecture.md:12` documents `sequential(items, ...stages)`;
`WF/examples/02-sprint-runner.js:26-114` passes four stage functions (Plan/Develop/Test/Harvest)
-- under the current implementation stage 2 becomes `opts` and stages 2-4 never execute, with no
error; `WF/test/apra-fleet-workflow.test.mjs:21` asserts the old multi-stage semantics;
`test-edge-sequential.js:15` passes `transform(...)` (a Promise) as `opts`, so its own
`continueOnError` expectation at line 21 cannot hold. Also note `sequential`'s error path both
pushes `null` and rethrows when `continueOnError` is false (index.mjs:262-266), discarding
partial results.

Why brittle: this is the flagship control-flow primitive and its contract is ambiguous across
every artifact in the repo; extra arguments are silently swallowed rather than rejected.

Recommendation: pick one signature (keep single-processor + a separate `pipeline(items,
...stages)` given the terminology doc), validate `arguments.length`, and fix docs/examples/tests
in the same commit. Reject unknown positional args loudly.

### F8. Doc-vs-code contradictions on failure semantics
Evidence: `WF/docs/workflow-guide.md:68` -- "Errors thrown by `transform()` will safely fail the
node, but will not crash the workflow engine itself" -- but `index.mjs:314-324` rethrows, which
(per the same guide, line 92) halts the sequence by default. `architecture.md:21` claims
`parallel()` "returns null for that specific index... rather than crashing the orchestrator" --
true only with `continueOnError: true`, which is not the default (index.mjs:275-287).

Recommendation: make the docs match the (reasonable) fail-fast defaults; don't advertise
resilience that requires an opt-in flag.

### F9. Viewer: run never completes, stop is a kill switch, and the beads extension is an XSS/injection sink
Evidence: the viewer subscribes to a workflow `'end'` event (`WF/src/viewer/index.mjs:449-453,
481-485`) that `FleetWorkflow` never emits -- the dashboard stays "LIVE" forever and the
auto-close path is dead code. `/stop` handler calls `process.exit(1)` (viewer:466-470): no state
flush, no journal, mid-dispatch agents orphaned. The core tree renderer escapes HTML carefully
(viewer:161-168), but the beads extension (`SE/auto-sprint/viewer-extensions.mjs:38-45`) injects
`node.title` and `node.description` into `innerHTML` unescaped -- bead titles are written by LLM
agents (the planner), so any agent (or poisoned upstream content) can execute script in the
operator's browser, which also holds the `/stop` capability.

Recommendation: emit `end` from the engine (`executeSource` finally block); make `/stop` a
cooperative cancellation (AbortSignal threaded through `agent()`/`command()`); escape all
extension-rendered strings.

### F10. Hidden session state undermines the declared execution model
Evidence: `CL/src/client/api.mjs:10` -- `execute_prompt` defaults `resume: true`. Every `agent()`
call in a workflow therefore resumes the member's previous conversation. `runner.js` implicitly
depends on this (its "Review the plan" prompt at line 76 contains no plan content whatsoever --
the reviewer can only know what plan it's reviewing via resumed session state or repo files), yet
neither the framework docs nor `AgentOptions` (index.mjs:9-21) mention `resume` at all.

Why brittle: cross-phase and cross-cycle context bleed (cycle-3 doer sees cycle-1 conversation),
and it makes "same prompt, same behavior" impossible by construction.

Recommendation: surface `resume` in `AgentOptions`, default it `false` for workflow dispatches,
and make every prompt self-contained.

### F11. Engine is single-tenant by accident
Evidence: `engine.mjs:46` mutates `this.wf.args` per run; `index.mjs:43` keeps a single
`currentPhase` -- two concurrent `executeSource` calls on one `FleetWorkflow` corrupt each
other's phase attribution and args. Activity IDs are
`Math.random().toString(36).substring(2,9)` (index.mjs:105, 208) rather than `randomUUID()` used
by `transform` (index.mjs:290).

Recommendation: one run = one context object; pass phase through call scope rather than instance
state (this also fixes phase mislabeling inside `parallel()`, where concurrent branches all
inherit whichever `phase()` was called last).

---

## auto-sprint-level findings (SE/auto-sprint/runner.js, bin/cli.mjs)

### A0. The product doesn't exist end-to-end: the CLI's execution path is commented out and the runner ignores the arguments the CLI collects
Evidence: `SE/bin/cli.mjs:102-137` -- the entire engine/transport/viewer block is a `/* TODO */`
comment; the CLI validates args with placeholder `async () => true` checks (65, 84) and exits.
The commented block itself references an undefined `memberList` (125) and never passes `base` or
a max-cycles knob. `runner.js` never reads `args.branch`, `args.goal`, `args.base_branch`, or
`args.max_cycles` -- `MAX_CYCLES = 5` is hardcoded (runner.js:9). There is no `git` interaction
anywhere in runner.js: no branch creation, no commits verified, no PR -- despite the CLI help
(cli.mjs:33-38), the auto-sprint skill contract (issues/branch/goal/max_cycles/base_branch/
requirementsFile), and the pm skill (`packages/apra-fleet-se/apra-pm/skills/pm/SKILL.md`) all promising
branch+PR semantics. The diagram (`SE/auto-sprint/docs/auto-sprint-diagram.md`) is broadly
faithful to runner.js's loop shape but inherits none of the goal-priority exit it advertises
externally.

Recommendation: treat the CLI-runner argument contract as the spec, write it down, and make
runner.js consume every declared arg or reject it.

### A1. Plan phase: an unapproved plan is executed silently, and approval detection is substring matching
Evidence: `runner.js:66-87` -- the planning loop exits after 3 rounds regardless; there is no
`if (!planApproved) throw/abort` after it, so a plan that was rejected three times proceeds
directly to Develop. Approval is `reviewerRes.includes('APPROVED')` (line 81): a reviewer
replying "This can NOT be APPROVED" approves the plan. The planner prompt (line 70) is one
ad-hoc sentence ("Analyze features and build a DAG by adding beads") with no requirements file,
acceptance-criteria, priority, or model-tier contract -- all of which the pm skill's planner role
requires (SKILL.md planner spec) and which the reviewer downstream depends on. Each cycle re-runs
the planner with the same open-ended prompt (the loop restarts at line 56), risking unbounded
bead creation across cycles (the mock's planner adds a new task on every invocation --
`SE/test/advanced-mock-runner-test.mjs:71-77`).

Recommendation: hard-fail (or escalate to human) on 3 rejected plans; use `schema:` on the
plan-reviewer call -- the framework already has ajv validation -- e.g. `{verdict: enum[APPROVED,
CHANGES_NEEDED], feedback: string}`; make cycle-N planning a delta prompt ("gaps only") rather
than a full re-plan.

### A2. Develop phase: the streak-assignment agent is decorative, member parallelism is broken by a case bug, and one doer failure kills the sprint
Evidence: `runner.js:118-124` -- the "Group the following ready beads into logical development
streaks" agent call's output is logged and discarded; `streaks = currentReady.map(b => [b])`
hardcodes one-bead streaks. A pure LLM spend with zero effect (also a false determinism signal:
the run *looks* like the LLM chose the grouping). Case bug: `getMembersForRole` (lines 23-31)
special-cases `role === 'Doer' || role === 'Reviewer'` but is called with `'doer'`/`'reviewer'`
(lines 106-107), so without an explicit `roleMap` the doer pool collapses to
`[physicalMembers[0]]` -- the advertised multi-member parallel development never happens. `await
parallel(streaks, ...)` (line 126) passes no `continueOnError`, so any single doer exception
(transport blip, timeout) rejects the `Promise.all` and aborts the whole workflow mid-cycle with
in-flight sibling dispatches abandoned. `doerFeedback` (lines 130, 152) is the *entire* reviewer
text broadcast to *every* doer next round, regardless of which bead the feedback concerned --
cross-contamination that grows each round. Finally, nothing verifies that the specific assigned
beads were closed; success is inferred only from the aggregate `bd list --ready` count (146-149),
so a doer that silently does nothing is indistinguishable from success if another agent closed
beads.

Recommendation: delete the streak agent call or actually consume its (schema-validated) output;
fix the role-name casing (one canonical lowercase role enum, shared with the pm skill);
`continueOnError: true` + per-streak retry for the doer barrier; after each doer, `bd show <id>`
the assigned beads and treat "still open, no new commit" as a dispatch failure.

### A3. Review phase: verdict unparsed, and the reviewer's write-access to beads contradicts the role contract
Evidence: the reviewer prompt (line 140) -- "Verify closed beads. Reopen if flawed, else
approve. Return text feedback." -- delegates the state transition to the LLM, whereas the pm
skill explicitly states the reviewer "never touches beads" and returns `reopenIds`/`newTasks`
arrays for the orchestrator to apply (SKILL.md reviewer spec). runner.js never parses the verdict
at all; loop continuation is decided purely by ready-count (146-154). The prompt also names no
bead IDs, no acceptance criteria, no diff range -- it relies entirely on resumed session state
(F10).

Recommendation: schema-validate the reviewer output (`{verdict, reopenIds[], newTasks[]}`), have
the orchestrator perform the `bd update` calls deterministically, and include the concrete task
IDs + acceptance criteria in the prompt.

### A4. Deploy/Integ phase: fragile probes, throwing commands, and results that only matter if the agent remembered to write them down
Evidence: runbook existence is probed by shelling nested-quoted `node -e
"require('fs').existsSync(...)"` strings to the member (runner.js:160-163) -- exactly the
Windows-quoting/`python3`-class portability trap the project's own CLAUDE.md warns about;
`command()` throws on `isError` (index.mjs:237-241) so a transient probe failure kills the
sprint rather than skipping the phase. The integ-test agent's output (line 174-177) is not
inspected; failures only affect the sprint if the agent chose to file bug beads. Also, the mock
test still intercepts `ls deploy.md` (advanced-mock-runner-test.mjs:55-59), a probe the runner no
longer issues -- drift inside the test itself.

Recommendation: add a first-class `fileExists`/facts primitive to the fleet API (or `command`
with `failSoft`), and require the integ runner to return a schema'd `{passed, bugsFiled[]}`.

### A5. Cycle/exit logic: `--ready` emptiness is not "done," and there is no stall detection
Evidence: three exit points (runner.js:95-98, 149, 189-193) all equate `bd list --ready`
returning `[]` with completion ("All beads closed. Exiting cycle loop.", line 190). Beads that
are `blocked` or orphaned `in_progress` (e.g. from a crashed doer) are not ready -- so a fully
wedged sprint exits with the "success" message, and Finalization then returns
`{status:'success'}`. Conversely there is no goal-priority filter (`P1/P2`) anywhere, though the
CLI and skill advertise it. There is no progress metric between cycles: five cycles of a doer
failing the same bead run to the ceiling with no "two cycles without progress -> abort" guard
(which the pm skill mandates). `JSON.parse(listRes || '[]')` (51, 93, 111, 147, 187) throws on
any non-JSON noise in bd output, killing the run. One more latent bug: `cycle` exits the loop at
6 after exhaustion, so the final phases are labeled `Final Review C6` for a 5-cycle sprint (203)
-- cosmetic but symptomatic.

Recommendation: completion = `bd list --status=open --priority<=goal` empty (plus last verdict
APPROVED); track a closed-count delta per cycle and abort on two zero-progress cycles; wrap every
`bd` JSON parse with a diagnostic error.

### A6. Finalization: the verdict is theater
Evidence: `runner.js:204` -- the final review prompt is literally `'Pass or Fail?'` with no
context; line 205 logs it; line 212 returns `{ status: 'success' }` unconditionally. A "Fail"
verdict changes nothing. The harvester prompt (line 208, "Update memories and retrospectives.")
likewise has no contract with the harvester role spec (docs/CHANGELOG/cost block per the pm
skill).

Recommendation: schema the final verdict and propagate it into the workflow return value; or drop
the call until it has an effect -- a no-op LLM call that looks like a quality gate is worse than
none.

### A7. Injection surfaces
Evidence: `args.target_issues` are interpolated raw into a shell command string (`--parent
${targetIssues.join(',')}` -- runner.js:12, executed at 38/50/92/110/146/186 via `command()`,
which is a remote shell on the member). An issue ID of `BD-1; rm -rf ~` is a remote shell
injection from a CLI flag. Reviewer/planner free text is interpolated into subsequent agent
prompts (lines 70, 130) -- agent-to-agent prompt injection with no delimiting or sanitization;
and bead titles/descriptions flow unescaped into the operator dashboard (F9).

Recommendation: validate issue IDs against `^[A-Za-z0-9._-]+$` at the CLI; wrap inter-agent
feedback in clearly delimited quoted blocks ("the following is untrusted output from another
agent"); fix the viewer escaping.

---

## Determinism audit

| Behavior | Claimed/implied | Actually |
|---|---|---|
| Plan approval gate | Deterministic loop-to-APPROVED (diagram) | `includes('APPROVED')` on free text (runner.js:81); after 3 rounds proceeds unapproved |
| Work assignment ("streaks") | Agent decides grouping (diagram: "Streak Assignment Agent") | LLM output discarded; hardcoded 1-bead streaks (runner.js:118-124) -- deterministic, but the LLM call is fake |
| Bead closure | Doer closes assigned beads | LLM voluntarily runs `bd close`; never verified per-bead (runner.js:129-135) |
| Review/reopen | State machine transition | LLM directly mutates beads; verdict text never parsed (runner.js:139-143) |
| Develop-loop exit | "All closed" | `bd list --ready` empty -- blocked/in_progress beads read as done (149, 189) |
| Sprint exit / goal | P1/P2 goal priority (CLI, skill) | Not implemented at all |
| Max cycles | `max_cycles` arg (skill) | Hardcoded 5 (runner.js:9) |
| Final verdict | Pass/Fail gate | Free-text, ignored; unconditional `{status:'success'}` (204-212) |
| Cost/budget | `budget` primitive, $ dashboard | Never enforced (F3); usage sometimes random numbers (F2) |
| Same prompt -> same context | Implied by stateless `agent()` API | `resume: true` default resumes prior member session (api.mjs:10) -- hidden cross-call state |
| Structured output | ajv-validated (real, when used) | Genuinely deterministic validation -- but runner.js never uses `schema:` on any of its 9 agent calls |

The single highest-leverage observation: **the framework already has the deterministic mechanism
(ajv schemas) and auto-sprint uses it zero times**, relying on substring matching and implicit
session state instead.

## Comparison to Claude CLI dynamic workflows

- **Resumable runs / journal caching -- absent.** No persisted activity journal, no replay. The
  `activity:start/end` event stream (index.mjs:113, 171-183) is 90% of a journal already;
  persist it as JSONL and add replay-on-resume. This is the pattern to borrow first.
- **Structured output enforced at the tool layer -- partial.** ajv post-validation exists
  (index.mjs:148-173) but enforcement is "append schema to prompt and regex-scrape," single-shot,
  no repair loop (F5). Claude CLI enforces the schema at the harness/tool-call boundary; the
  equivalent here is enforcing it inside the member's `execute_prompt` (fleet server) rather than
  in the orchestrator.
- **Adversarial / multi-vote verification -- absent.** One reviewer, substring verdict, and the
  reviewer both judges and mutates state. Borrow: N independent verifier dispatches with schema'd
  verdicts, orchestrator tallies; verifiers get read-only capability.
- **Budget-aware fan-out -- absent.** Budget stub (F3); fan-out width is hardcoded. Borrow:
  check `budget.remaining()` before dispatch and size `parallel` batches by remaining budget.
- **Barrier vs pipeline semantics -- partial/confused.** `parallel()` is a proper barrier
  (Promise.all, index.mjs:275); pipeline (multi-stage sequential) is documented and exemplified
  but not implemented (F7). Borrow: explicit distinct primitives with validated arity.
- **Loop-until-dry -- partial.** The dev loop re-polls `bd ready` until empty (a "dry" check) but
  caps at 3 rounds and detects only emptiness, not lack of progress; Claude CLI's version loops
  until an iteration produces no new findings. Borrow: progress-delta-based termination + stall
  abort.
- **Cancellation -- absent vs. Claude CLI's cooperative stop.** `/stop` is `process.exit(1)`
  (viewer:470). Borrow: AbortSignal threaded through dispatches.

## Testing gaps (prioritized)

1. **The existing suites don't run.** `WF/test/apra-fleet-workflow.test.mjs:3` imports
   `../lib/apra-fleet-workflow/index.mjs` (nonexistent path) and asserts the pre-rename
   multi-stage `sequential`/thunk-`parallel` API; `WF/test/test-runner.mjs:6` imports
   `startViewer`, which `src/viewer/index.mjs` does not export (only `createDashboardViewer`) --
   ESM link error before any test executes -- and calls nonexistent
   `viewer.markComplete/stop` (91-94); it also requires a live MCP server on hardcoded
   `127.0.0.1:7523`. `test-edge-sequential.js:15` passes `transform(fn)` (a Promise) as `opts`,
   so its own assertions are unsatisfiable. Fix the harness before writing anything new.
2. **The mock sprint test silently skips half the sprint.**
   `SE/test/advanced-mock-runner-test.mjs:117-137` matches `opts.agent === 'Integration Test
   Runner' / 'Deployer' / 'Final Reviewer' / 'Harvester'` (capitalized) while runner.js sends
   lowercase `agentType`s -- those phases fall through to the generic "Agent executed
   successfully" stub, so deploy/integ/finalization behavior is untested despite appearing
   covered. It's also `Math.random()`-driven (91-118: nondeterministic doer/reviewer behavior --
   a flaky test for a "deterministic" engine), and its teardown calls `fs.rmSync` on
   `fs/promises` (line 176), which doesn't exist.
3. **Zero coverage of the load-bearing failure paths found above:** unapproved-plan fallthrough
   (A1), blocked-beads false completion (A5), doer throw inside `parallel` (A2), agent `null`
   return -> `.includes` TypeError (F4), schema-scrape on multi-JSON output (F5), MCP
   non-response hang (F6), crash/re-entry double-dispatch (F6), budget enforcement (F3), `export
   function` scripts (F1).
4. **No golden-transcript test:** with a deterministic (non-random) mock fleet, the full sequence
   of dispatched prompts/commands per cycle should be snapshot-asserted -- that is the only way
   to catch prompt drift, which is currently invisible.

## Top 5 recommendations (risk reduction / cost)

1. **Adopt schemas + orchestrator-applied transitions for every verdict in runner.js**
   (plan-reviewer, reviewer, integ, final): the ajv machinery already exists; this converts the
   four biggest LLM-judgment gates into deterministic state-machine edges and honors the pm
   skill's "reviewer never touches beads" contract. (High risk reduction, low cost.)
2. **Fix the exit conditions:** completion = open-at-goal-priority empty + APPROVED, not
   `--ready` empty; enforce plan approval before Develop; add two-stalled-cycles abort; make the
   final verdict drive the return value. Removes both the false-success and the
   budget-burning-loop failure modes. (High, low.)
3. **Persist the activity event stream as a run journal and add resume/replay + client-side
   timeouts + typed errors** (F4/F6). This is the Claude-CLI pattern that turns "crash = restart
   from scratch, maybe double-dispatch" into "resume from last completed activity." (Very high,
   medium.)
4. **Repair the test harness and de-randomize the mock** (gaps 1-2), then add the
   golden-transcript test. Every other fix is unverifiable until the suites actually execute.
   (High, low-medium.)
5. **Re-scope the sandbox/vetting claim** (F1): load workflows as real ES modules for trusted
   use, delete or clearly demote the regex vetting, and fix the viewer XSS + shell-injectable
   issue IDs (A7/F9) -- the actual exploitable surfaces today are the dashboard and the `bd`
   command interpolation, not workflow-script imports. (Medium-high, low.)

## Structural positive worth preserving

`engine.mjs`/`index.mjs` genuinely contain no beads/git/software-dev assumptions -- all domain
coupling lives in `runner.js` and `viewer-extensions.mjs`. The generality goal is currently met
by thinness rather than design, but the layering boundary is in the right place; the reliability
primitives above (journal, budget, schemas, typed errors) are all domain-neutral and would
strengthen it rather than erode it.
