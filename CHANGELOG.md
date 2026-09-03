# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] -- memory-contract/v1 skeleton complete: round-trip harness, CI drift guard, taxonomy, sign-off

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: PASS**, verified first-hand against the working
tree rather than by closed-task count: all four contract layers (prose spec,
JSON Schema 2020-12, MCP + OpenAPI bindings, conformance-suite hook) are
present or explicitly stubbed with a named downstream owner; the
provider-parameterized round-trip harness validates both request and
response for every inventoried tool against the live handler and passes
clean; the CI drift guard was proven live by a deliberate dry-run break
(a hand-introduced diff was caught and reported, then the guard passed again
once reverted); the degradation list (what JSON Schema structurally cannot
verify) was handed off with named downstream ownership; and the pre-existing
tool-surface-guard regression stayed green. Full generation is confirmed
byte-identical on repeat runs with a clean working tree, and the full local
test suite (unit plus workspace suites) passed with zero failures.

What landed on top of the schema-generation work already described below:
the error taxonomy with stable machine codes, and its projection into both
the MCP-side error shape and an RFC 9457 Problem Details OpenAPI stub; a
fixture corpus recorded from real, live tool calls (including ordered,
stateful scenarios where a later call depends on an id minted by an earlier
one); the round-trip validator that exercises every tool's real handler
against its published request and response schema; a three-way roster guard
that independently checks the real tool-registration surface, the
generator's expected roster, and the schemas on disk agree, closing the gap
where a generator's own hardcoded tool list can only notice a tool
disappearing, never a new one going unrostered; response schemas widened to
match the real multi-block response envelope (an optional onboarding
preamble and nudge alongside the payload, each with optional annotations)
while keeping the decoded payload shape itself just as strict as before; and
a self-review sign-off recording the per-layer verdict and the explicit
scope handed to each downstream owner. See
`docs/memory-contract-v1-roundtrip-and-handoff.md` for the full design of
the round-trip harness, the drift guard, the taxonomy-to-wire projection, and
the handoff boundary, and `docs/memory-contract-v1-generator-design.md` /
`docs/memory-contract-v1-inventory-notes.md` for the schema-generation and
inventory-level notes referenced below.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $33.2868.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0813 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 45 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

Carried forward as backlog (deliberately deferred, not blocking): the
directive-activation absence scan currently runs only in the generator's
strict check mode and is not wired into the plain write path; the two
copies of the beads-export shrink guard (the standalone script and its
inline copy invoked from the auto-sprint export step) have no equivalence
test proving they stay in sync; several response-body fields that are typed
as unconstrained JSON already have a known TypeScript shape available and
could be tightened; the scratch dump writers used for ad-hoc beads listing
still target the repo root instead of a temp directory; and the repo-path
quoting in the auto-sprint export shrink guard command could be hardened
further. A periodic sweep of this file's own carried-forward lists, to
correct any item that has since landed, is itself tracked as backlog work.

A full regression pass was also run this cycle as an informational,
non-gating check and surfaced pre-existing, already-tracked breakage
unrelated to this sprint's own changes: a set of integration-suite files
failing for reasons predating this sprint, a single-file test-suite time
budget exceeded by a number of files, one real-time watchdog test failing on
replay-drift after the watchdog itself fired correctly, and a smoke-test run
blocked before completion by a permission classifier declining to seed a
credential during setup. None of these are new; each was already tracked
from a prior pass and was reconfirmed rather than duplicated.

## [Unreleased] -- memory-contract/v1 schema generation, postprocess hardening, and test stabilization

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: FAIL**, judged against the epic's own acceptance
criteria rather than closed-task count: no round-trip validator exists yet
(the epic's own stated exit criterion), no CI drift guard was wired, and the
fixture corpus directory is still empty. `bindings/mcp/` now holds 23
committed tool definitions (commit `fcccf19f`, one per inventoried tool);
`bindings/openapi/` remains an unowned empty stub. See
`docs/memory-contract-v1-generator-design.md` for the full design of what did
land and `docs/learnings.md` for the review approach that reached this
verdict.

What landed: the zod-to-JSON-Schema generation path was selected, proven
against every hard construct in the surface (discriminated unions, closed
enums, optional/nullable/nullish, recursive references, tuples), and wired
into a `contract:generate` script that emits metaschema-validated draft
2020-12 request and response schemas for all 23 inventoried tools, with a
demonstrated byte-identical re-run guarantee. The deterministic postprocess
step that normalizes the generator's raw output to 2020-12 (dialect
declaration, `definitions`-to-`$defs` renaming, exclusive-bound numeric
form, tuple encoding) was hardened to be container-aware when repointing
`$ref` pointers, so a data field that happens to be named "definitions" is
no longer mistaken for a schema container and incorrectly rewritten. A claim
recorded earlier in this cycle -- that a real response carrying a display
preamble would fail its own published response schema -- does not hold for
any of the 23 inventoried kb_*/code_* tools: `wrapTool`'s onboarding preamble
and nudge suffix only ever attach when the tool result is non-JSON
(`isJsonResponse` false), all 23 kb_*/code_* handlers return
`JSON.stringify(...)`, and the nudge-suffix path is gated to `register_member`
and `execute_prompt` (`src/services/tool-registry.ts`, `src/services/onboarding.ts`). The
published single-text-block response schemas are still narrower than the real
three-block `wrapTool` envelope in general -- `register_member`,
`execute_prompt`, and any future non-JSON-returning tool can still trigger
it, and that gap is exactly what the still-missing round-trip validator is
meant to catch -- but it is not reachable through the 23 tools this contract
actually covers. Also fixed: a real
port-selection bug where an OS-assigned ephemeral port could land in a
client fetch implementation's blocked-port list, and the beads-export commit
guard's argument-passing bug in its inline copy. The `apra-pm` test suite
now also runs from the root local test command, and several subprocess-
spawning tests had their timeouts raised to real subprocess cost to stop
flaking under a loaded full-suite run.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $26.8852.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0473 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 31 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

Carried forward (still open, core to the memory-contract/v1 deliverable): the
error taxonomy with stable machine codes and its projection into MCP error
payloads and the OpenAPI stub, the round-trip fixture corpus and its
provider-parameterized validator (the sprint's stated exit criterion), the CI
drift guard, and the final self-review/sign-off checklist. Two items
previously carried forward here have since landed in later cycles of this
same continuing sprint and are no longer open: the MemoryProvider method
contract (`methods.json`, commit `c4161584`) and MCP binding definitions for
every inventoried tool (`bindings/mcp/`, commit `fcccf19f`).

**Correction (all four items above have since landed):** every item this
paragraph lists as still open has since landed in a later cycle of this same
continuing sprint -- see the newest entry at the top of this file for the
error taxonomy and its wire/OpenAPI projection, the round-trip fixture
corpus and its provider-parameterized validator, the live CI drift guard,
and the completed self-review/sign-off checklist. None of the four remain
open.

## [Unreleased] -- memory-contract/v1 inventory and test-suite stabilization

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: FAIL** (a final reviewer dispatch stalled and
could not be repaired after retry; no PASS was reached).

What landed: the contract-surface inventory (`memory-contract/v1/INVENTORY.md`)
was corrected and hardened against several inaccuracies found during
cross-checking against the real code (a tool-call-site miscount, an
incomplete list of dropped HTTP query filters, a mis-stated anchoring claim,
and an unflagged teardown-method-naming/extra-parameter asymmetry between the
two provider implementations -- see `docs/memory-contract-v1-inventory-notes.md`
for the durable findings). A baseline verification pass was recorded. A
correctness bug was fixed in the automated beads-export commit guard, which
could previously let a divergent local export silently replace the
committed issue-id set while the exported file grew in size (a size-based
check would not have caught it); the guard now compares id sets. The root
local test runner now also runs the `apra-pm` suite (previously reachable
only via CI's explicit `--prefix` invocation), and several tests that spawn
real subprocesses (git clone, PowerShell, an external CLI) had their
timeouts raised to real subprocess cost so they stop flaking under a loaded
full-suite run; a real port-selection bug was also fixed where an
OS-assigned ephemeral port could land in a client fetch implementation's
blocked-port list. The zod-to-JSON-Schema generation path and its
deterministic per-tool schema emit also landed: the `contract:generate`
script emits metaschema-validated draft 2020-12 request and response schemas
for all 23 inventoried tools (46 documents in memory-contract/v1/schemas/),
with a demonstrated byte-identical re-run guarantee.

Carried forward (still open, core to the memory-contract/v1 deliverable):
the error taxonomy with stable machine codes and its projection into MCP error
payloads and the OpenAPI stub, the round-trip fixture corpus and its
provider-parameterized validator (the sprint's stated exit criterion), the CI
drift guard, and the final self-review/sign-off checklist.

**Correction: all of the above have since landed** in a later cycle of this
same continuing sprint -- see the newest entry at the top of this file.

Deploy could not be completed during this sprint: repeated attempts were
blocked either by the runbook's own active-sprint safety gate (deploying
while this sprint's own dispatch was still the active sprint) or by an `npm
ci` failure unlinking a native `rollup` binary on Windows, which the existing
lock-clearing preflight script does not detect (it only scans for orphaned
`esbuild` holders). A regression pass afterward also could not run, blocked
on missing command-allowlist entries for its own harness.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $28.4659.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 39 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- Supervisor dashboard: live-refresh parity with the per-run viewer

Sprint goal: bring the multi-sprint supervisor's own dashboard up to the same
live-refresh standard every individual sprint's per-run viewer already had --
adopt that existing architecture rather than invent a second one.

What shipped:

- **Lean `GET /state` JSON endpoint + `GET /events` SSE stream**: the
  supervisor dashboard now serves a lightweight JSON projection of the same
  Sprint Stack view model its full HTML page renders, plus a
  Server-Sent-Events stream that signals "state may have changed, go poll"
  on a fixed cadence (the supervisor has no single internal event bus the
  way one workflow run does, since its view model changes via many disjoint
  HTTP mutation routes) plus once immediately on connect.
- **Client-side live-refresh loop**: a debounced single poll pipeline fed by
  both the SSE stream and a heartbeat-interval fallback, re-rendering Sprint
  Stack rows in place (added/updated/removed by sprint id) using the exact
  same row-rendering function the server uses for the initial page load --
  no full-page reload anywhere in the refresh path.
- **Tab-activation refresh**: switching to the Sprints or Backlog tab
  triggers a fresh fetch through that tab's own existing fetch/poll
  plumbing whenever its last fetch is stale, independent of the other tab.
- **Per-node subprocess spawn removed from every dashboard render**: sprint
  scope expansion (used for both the raw claimed-bead count and the
  goal-filtered progress bar) now walks an in-memory index built off a
  single bulk beads fetch per render, instead of issuing one subprocess call
  per discovered graph node -- eliminating the dominant cost behind a
  previously near-unusable page-load time as the number of concurrently
  running sprints (and the size of their subtrees) grows.
- **Progress-widget labeling**: the two per-sprint counters that can
  legitimately disagree (raw claimed-scope bead count vs. the goal-filtered
  "Required" progress-bar count) are now both explicitly labeled, so a
  growing raw count no longer reads as a bug.

Carried forward (filed as open, low-priority backlog items; not blocking):
narrower unit coverage for the base-drift indicator's null/error paths, and
a documentation/branch-hygiene follow-up on keeping a long-running sprint
branch's review diffs scopeable against a moving base.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $14.2427.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.5702 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 35 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-supervisor Backlog: sort by creation timestamp

Sprint goal: give the fleet-supervisor dashboard's Backlog view a way to
order issues by creation timestamp, so an operator scanning the unclaimed
task list can find the newest or oldest work without leaving the page.

What shipped:

- **Server-side `created_at` sort**: `GET /api/backlog/tasks` accepts
  optional `sort=created_at` and `dir=asc|desc` (default `desc`) query
  params, applied after the existing type/status/priority/model/q
  narrowing. The sort is a stable decorate-sort-undecorate over each row's
  original index, so ties never reorder relative to the incoming list.
  Rows with a missing or unparseable `created_at` always sort last in
  either direction and never cause an error. Omitting `sort` leaves task
  order exactly as before -- the feature is strictly additive.
- **Backlog header sort control**: the Backlog table header gained a
  Created-at sort `<select>` (Unsorted / Created (newest) / Created
  (oldest)), wired to re-fetch the task list with the chosen `sort`/`dir`
  and to reset alongside the other filters when Clear Filters is used. The
  existing header-injection mechanism still splices exactly once with the
  extra column present.

Carried forward (filed as backlog items, not blocking): a cosmetic column-
alignment mismatch between the new sort header cell and the data rows below
it, and a labeling issue where the "Filtering by ..." indicator can describe
a chosen sort as if it were a narrowing filter. Both are open, low-priority
follow-ups.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.1721.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3360 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Fable test-suite audit: hidden subprocess spawns, duplicate tests, redundant bd calls

Sprint goal: work the low-risk/high-confidence subset of a test-suite and
bd-call-volume audit -- items rated safe to fix without an open design
question -- while leaving the higher-risk call-volume items for a separate
human design decision.

What shipped:

- **Hidden live subprocess spawns eliminated**: mocked supervisor
  dashboard/backlog test fixtures now supply the `listAllBeads`/`driftCheck`
  seams those modules default to a real subprocess call when omitted, so the
  fixtures no longer silently shell out to the developer's own live beads DB
  and git repo on every run. A regression guard runs the fixed fixtures as
  real child processes under an OS-level PATH shim (fake `bd`/`git`
  executables) and additionally parses the child's own test-summary output
  to rule out a vacuous pass (an empty spawn marker file from a child that
  ran zero subtests).
- **A real dolt-push bug fixed**: the pre-gate `sync.remote` probe result is
  now cached and reused on the retry/failure path instead of being
  re-queried, while keeping the original skip branch as defense-in-depth.
- **Batched bead claiming investigated and pinned down**: `bd update
  --claim` was confirmed to support a multi-id batch call; a `bd`-call-volume
  reduction was implemented and unit-tested, but is intentionally left
  dormant (no caller sets `assignee` yet) pending a follow-up that resolves a
  same-assignee re-claim edge case before the path goes live.
- **Duplicate test files consolidated**: several near-duplicate test files
  covering the installed-supervisor self-containment check and the watchdog
  reservation-release path were merged into single, parameterized files, and
  an exact-duplicate file was deleted outright.
- See
  [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md)
  for the durable patterns behind these fixes (probe caching, the dormant
  batched-claim contract, and the no-live-spawn test technique).

Carried forward: a follow-up to verify (or rebase away) unrelated
in-flight orchestrator/member-reservation work that rode along on the same
branch as this audit but lies outside its scope, and a follow-up to confirm
`claimBeadsBatched` handles a same-assignee re-claim correctly before the
batched-claim path is activated. Both remain open as backlog. A same-sprint
regression pass could not run (see the sprint analysis artifact for the
permissions gap that blocked it) and is informational only -- it did not
gate this sprint's verdict.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $8.4210.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1315 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 18 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Windows/PowerShell shell portability and schema-repair retry correctness

Sprint goal: close out the remaining holistic-audit acceptance criteria for
member-bound command construction that silently assumed a POSIX shell, and
fix a schema-repair retry path that could resume the wrong session or lose
the original request across repair rounds.

What shipped:

- **Cross-shell command construction**: the GitHub VCS command builder now
  emits `curl.exe` explicitly on Windows members instead of relying on a
  bare `curl` invocation, which PowerShell silently resolves to its
  incompatible `Invoke-WebRequest` alias -- confirmed wired through the real
  production OS-resolution path, not just a test fixture. Golden POSIX
  command output is unchanged. A PowerShell deep-merge helper no longer
  throws on nested JSON objects (`PSCustomObject` does not support the
  `Hashtable` method the merge previously assumed) and no longer leaks
  internal accumulator metadata keys into merged JSON output. A Windows
  delete-files script builder was extracted into its own exported function
  so the regression suite exercises the real production script instead of a
  hand-duplicated copy that could silently drift.
- **Live-PowerShell regression coverage**: a reusable live-PowerShell test
  harness now backs exit-code and on-disk assertions for the credential
  file write, deep-merge, recursive file hashing, and delete-files code
  paths, closing the risk that a platform-gated suite reports green purely
  by skipping rather than by actually exercising real PowerShell.
- **Schema-repair retry contract**: a schema-invalid dispatch response is
  now retried by reattaching the original prompt and schema as explicit
  reference text on every repair round (re-derived from the one true
  original each time, so repeated rounds don't compound), and by resuming
  the exact session that produced the failed attempt via its captured
  session id rather than a generic "resume most recent session" flag. When
  no session id was captured, the retry now degrades to an explicit,
  loudly-logged fresh dispatch instead of silently guessing. A
  session-not-found response to an exact-id resume now triggers one
  additional fresh-dispatch attempt within the existing repair budget,
  rather than failing the whole repair outright.
- **Schema directory resolution**: the packaged-schema loader now picks
  whichever of its two built-in candidate directories (bundled vs
  package-local) was most recently edited, based on the newest contained
  schema file's modification time, rather than always preferring one by
  fixed convention -- preventing a stale bundled copy from silently
  shadowing an edited source schema.
- **Housekeeping**: stray root-level scratch artifacts were removed and the
  ignore rules widened so equivalent artifacts don't get re-added by
  accident; several pre-existing test-suite failures were triaged and fixed.
- See [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md)
  and [docs/dispatch-reliability-hardening.md](docs/dispatch-reliability-hardening.md)
  for the full patterns behind these fixes.

Carried forward: extending the root test run to cover the workflow package
directly (rather than only via a separate invocation), a couple of
follow-ups on schema-directory-resolution edge cases and an unused
production caller for one Windows helper, and a same-sprint regression pass
that reconfirmed several pre-existing, parent-less carry-over issues (long
single-file test durations, a setup-failure cluster in one test group, a
couple of flaky timeouts, and a sandbox smoke-test credential-provisioning
precondition) -- no new defects were found in this sprint's own work and no
new carry-over issues were filed.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $30.6565.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1440 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 52 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Cooperative workflow pause/resume: closing the resume-barrier gap

Sprint goal: finish the cooperative pause/resume feature by closing three
integration-verification gaps found in the prior round -- the resume-time
reservation re-acquire/resync still raced the first post-resume dispatch
instead of strictly preceding it, a duplicated member-argument guard
remained in the workflow engine's internal dispatch path, and a requested
regression test pinning a reservation-store failure marker had not actually
been added. All three are now closed, verified against source rather than
against child-task titles alone. Final verdict is a clean PASS.

What shipped:

- **Workflow engine**: a new `setPreResumeHook(fn)` primitive. `requestResume()`
  is now `async` and awaits this hook as a hard barrier -- strictly before it
  clears pause state, releases any gate waiter, or emits the resume event --
  so a caller's reacquire/resync work is guaranteed to finish ahead of the
  first post-resume dispatch instead of racing it. A rejecting hook
  propagates out of `requestResume()` with pause state left intact, so a
  failed resume leaves the run parked rather than resuming on a
  half-restored state. `setPreResumeHook` is generic (no domain semantics of
  its own) and defaults to a no-op barrier when unregistered, so callers with
  nothing to do before resuming see no behavior change.
- **fleet-sprint**: its reservation re-acquire and resync now run through the
  new pre-resume hook instead of a fire-and-forget event listener, closing
  the race described above. A pause requested while a git/dolt sync
  "bracket" is open now also engages the instant that bracket closes, rather
  than waiting on whatever dispatch happens to arrive next. The
  reservation-release helper used for both a full teardown and a pause
  hand-back is now a single shared implementation instead of two
  independently-maintained copies of the same loop.
- **Reservation store**: a reserve call that fails at the storage-write step
  now returns a failure marker consistent with every other rejection path,
  so a resume's re-reserve step correctly treats a failed store write as
  "member not reacquired" instead of silently trusting it as a success. A
  regression test now pins this marker directly.
- **Workflow engine cleanup**: a duplicated member-argument validation guard
  in the engine's internal dispatch path was removed; the public entry point
  the internal path is exclusively reached through already enforces it.
- See [docs/features/workflow-pause-resume.md](docs/features/workflow-pause-resume.md)
  and `packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md`
  section 4.7 for the full design, now describing the pre-resume hook as the
  hard barrier it is rather than as a known limitation.

Carried forward: a follow-up to add direct unit coverage for the
`setPreResumeHook` type-guard paths (rejecting a non-function argument,
clearing the hook with `null`) remains open, as does a follow-up to guard
`requestResume()` against two concurrent resume calls both passing the pause
gate and running the pre-resume hook in parallel. A same-day regression pass
(informational, non-gating) reconfirmed several pre-existing, parent-less
carry-over issues in an unrelated functional test suite, a slow-lane
fixture-drift test, and a sandbox smoke-test preflight gate; no new defects
were found in this sprint's own work and no new carry-over issues were filed.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $16.3035.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3214 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 25 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Cooperative workflow pause/resume (engine, viewer, supervisor, fleet-sprint)

Sprint goal: add a generic, cooperative pause/resume primitive to the workflow
engine and wire it through every layer that needs to react to it -- the
per-run viewer's UI, the multi-sprint supervisor's dashboard and watchdog, and
fleet-sprint's own git/beads sync and member-reservation handling, as the
first workflow to attach real domain state to a pause. All in-scope work
closed; final verdict is a clean PASS.

What shipped:

- **Workflow engine**: `requestPause()`/`requestResume()`/`setPauseGuard()` on
  the workflow engine, alongside the existing `requestStop()`. A pause is
  deferred rather than immediate -- it only actually engages once every
  in-flight dispatch has drained to zero and an optional caller-supplied guard
  confirms the run is at a state boundary it considers clean -- so a pause can
  never land mid-way through a sequence a workflow script considers atomic.
  `requestStop()` while paused rejects every blocked dispatch so a paused run
  tears down instead of hanging.
- **Per-run viewer**: Pause/Resume buttons and a "paused since" badge, driven
  entirely by the engine's own pause lifecycle events rather than by the
  button click itself, so the UI always reflects what the engine actually did
  (including the deferred window between request and engagement).
- **Supervisor**: row-level Pause/Resume controls that proxy to the child
  viewer's own routes (never the kill+force-release path Stop uses); the
  crash watchdog now classifies a live, engine-paused child as a distinct
  healthy "paused" state (never conflated with stalled or crashed, and never
  auto-released); a base-branch-drift indicator shows how far a paused sprint
  branch has fallen behind its base branch.
- **fleet-sprint**: registers a pause guard so a pause only ever lands at a
  clean git/dolt-sync boundary; releases its member reservations on pause
  (so other sprints can use those members while this one is parked) and
  re-acquires them on resume with an owner-checked re-reserve that fails
  loudly (naming the unavailable members) if another sprint claimed one while
  paused; every re-acquired member is unconditionally resynced (git fetch,
  branch reconciliation, beads pull) before further work is dispatched to it,
  since both git and the beads database can move independently of a paused
  sprint. See [docs/features/workflow-pause-resume.md](docs/features/workflow-pause-resume.md)
  for the full design and known limitations.
- Bundled alongside this work: a fix to the Windows stall-poller's mtime probe
  commands to avoid an intermediate PowerShell `$variable` pattern that a
  remote execution path was found to silently strip, which had been turning
  the probe into a parse error on every poll for at least one real Windows
  member.

Follow-up hardening (second cycle, same sprint): fleet-sprint's resume-time
reservation re-acquire and resync is no longer best-effort -- `requestResume()`
now awaits a caller-supplied pre-resume hook as a hard barrier before any
post-resume dispatch can proceed, closing the race where a member could be
dispatched to before its reservation/resync completed. The duplicated
member-argument guard in `_commandDispatch()` was removed (the single copy in
`command()` is now the only enforcement point). A regression test now pins the
`[-]` store-write-failure marker so a reservation-store write failure is never
misread as a successful resume re-reserve. A new follow-up
(`apra-fleet-p2to.5`) was filed to guard `requestResume()` against concurrent
double-invocation of the pre-resume hook.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $22.9383.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1429 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 34 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-supervisor self-containment fix and lifecycle documentation

Sprint goal: make the always-on fleet-sprint supervisor fully self-contained
in an installed apra-fleet (npm install or the SEA binary) -- no git clone of
the source repo required to run it -- and document its full operational
lifecycle. **Sprint verdict: PASS.**

A deployed supervisor could previously crash on boot with
`ERR_MODULE_NOT_FOUND` because two of its modules imported a shared helper via
a repo-root-relative path that reaches into a top-level directory the
install/SEA packaging step deliberately excludes. The fix vendors a verbatim,
clearly-marked copy of that helper inside the packaged supervisor tree so the
import never has to leave it. Beyond that one file, every module reachable
from the supervisor's entry point was audited end to end (41 modules) and
confirmed to resolve entirely inside the packaged tree, with a new
graph-shaped regression test that walks the same import graph an installed
tree actually has and fails on any future out-of-tree import from any
supervisor-reachable module, not just a previously-broken file.

The fleet-supervisor skill documentation was substantially expanded: it now
covers stopping the supervisor both gracefully (via its shutdown endpoint)
and via a cross-platform PID-based hard-stop when the API itself is
unresponsive, a discrete restart procedure, and registering the supervisor to
auto-start on login/boot on Windows (Task Scheduler or a Windows service),
macOS (a launchd user LaunchAgent, including a PATH caveat for a bare `node`
invocation), and Linux (a systemd user unit) -- each with both register and
de-register steps and a link back to the existing smoke test.

Deploy verification could not complete this sprint for environment/config
reasons unrelated to the code: native-module compilation failed on the local
build toolchain in one attempt, and the CLI permission allowlist used for
automated deploys was missing one required command prefix in the others. An
independent verification step booted the deployed build directly and
confirmed it serves its API correctly, so these are tracked as follow-on
environment/config fixes, not code defects.

Carried forward as low-priority backlog: a drift guard to keep the vendored
helper copy in sync with its canonical source automatically instead of by
hand; fixing the native-module build/toolchain compatibility issue in the
deploy environment; adding the missing command prefix to the deploy
permission allowlist; and updating the skill's own command examples to
reference the installed-tree path rather than a repo-checkout path. A
full-suite regression pass run informationally after the verdict surfaced a
handful of pre-existing, already-tracked flaky/slow-test issues plus one new
integration-test failure and one blocked smoke-test step, all filed for a
future sprint.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $16.8512.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2033 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 34 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- KB anchor and cache-key fixes close out remote-member correctness

Sprint goal: finish making the Knowledge Layer correct for remote members,
closing the two more severe gaps an earlier sprint on this same epic had
carried forward as open follow-on work.

A `repo_path` that does not exist on the fleet server host is now always
treated as "no anchor" rather than silently substituted with the fleet
server's own working directory. Previously, two hot-path tools resolved a
non-existent path to `null` and let it fall through to a `process.cwd()`
fallback inside the shared provider accessor -- so while the *slug* (which
database) could already reach the correct shared project KB via the remote
URL, the *anchor* (the directory the capture basis check and freshness
re-hash resolve relative source files against) silently became an unrelated
tree. Because freshness re-hashing against the wrong tree fails every basis
check, this could retire healthy entries in the real shared KB -- a
regression in severity from merely colliding with an isolated fallback
database. The fix: a provider whose anchor does not exist on this host now
suppresses freshness verdicts entirely (all-or-nothing per call) instead of
producing false staleness, while capture stays protected by its existing
fail-closed basis check. The same one-anchor-policy rule was also applied to
the two remaining call sites that still built a provider from a locally
pre-resolved path.

The fleet's own automatic post-prompt harvest dispatch, and the `code_context`
KB enrichment call site, now forward the caller's `repo_remote_url` too, so
both benefit from URL-based routing instead of only the tools a caller invokes
directly. Forwarding a member's registration-record URL from an access list
that may contain multiple, unrelated repos is deliberately conservative: a URL
is only forwarded when it unambiguously names the member's own repo, never
guessed or derived from a bare `owner/repo` entry or discovered by shelling
out to the member host.

Several missing CLI permission prefixes the `deploy` runbook requires
(installer/binary invocations) were granted to the merged effective
allowlist for this repository. The deploy phase still did not complete this
sprint, however: it failed again in both cycles on a separate, still-missing
grant for launching the built binary via its `run` subcommand, so the
shipped KB fixes above are verified by their test suites only and have not
yet been confirmed against a deployed build. The regression-test pass was
separately blocked for the same reason (a missing `bd` command grant) and
also did not complete. Both permission gaps are carried forward as open
follow-on work.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $21.4535.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 28 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Remote members can scope KB calls by git remote URL

Sprint goal: make the Knowledge Layer correct for remote members, whose work
folder is a path on another host and therefore unreachable from the fleet
server's own filesystem. Every `kb_*` tool now accepts an optional
`repo_remote_url` input (one shared schema fragment, spread into all sixteen
tool schemas, so the field cannot drift or be redeclared inconsistently).
`resolveProjectSlug` prefers an explicit remote URL over shelling out to git
against `repo_path`, so a remote member supplying its repo's origin URL
resolves to the *same* project KB and slug its local counterpart would --
instead of every remote member, across every repo, pooling into one shared
`default` database. Independently, the KB provider cache is now keyed by
`(slug, repoPath)` rather than slug alone: previously the *first* caller to
resolve a given slug fixed the anchor directory used for the capture basis
check and the freshness re-hash for every later caller resolving to that same
slug, which could silently basis-check one repo's capture against an
unrelated tree. A pre-existing, unrelated test failure (the sandbox-sync
remote-list parser throwing on `bd`'s literal `null` output for a repo with
no configured remotes) was also fixed.

This does not close the epic. Two live-verified, more severe variants of the
same class of defect remain open as follow-on work: (1) a `repo_path` that
does not exist on the fleet server host is not always translated into "no
anchor at all" -- at least one hot-path tool resolves the failure to `null`
and then lets it fall through to a `process.cwd()` fallback inside
`getKbProviders`, so the freshness anchor silently becomes the fleet server's
own working directory instead of either the real repo or no anchor; because
the slug (which database) can now correctly reach the *real* shared project
KB via the remote URL while the anchor is wrong, this can silently stale
healthy entries in that shared KB rather than merely misreading it, which is
a regression in severity from the pre-sprint behavior of colliding only with
an isolated `default` database; (2) the fleet's own automatic post-prompt
harvest dispatch path still forwards only `repo_path`, not `repo_remote_url`,
so it does not yet benefit from the new URL-based routing. Deploying and
smoke-testing this change against a real build was also blocked for the
entire sprint by missing CLI permission grants for the installer/binary
invocations the deploy runbook requires, so the shipped pieces are verified
by their test suites but have not been confirmed against a deployed build or
re-tested against the live remote-member repro that originally proved the
bug. Both gaps, and the deploy-permission blocker, are carried forward as
open, prioritized follow-on work.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $11.9020.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 19 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- kb_harvest auto-harvest is now repo-scoped, not server-cwd-scoped

`kb_harvest` -- the only fully automatic KB writer, fired after every
`execute_prompt` completion -- previously reached the database through a
second, parallel provider accessor that memoised a single global instance
keyed off the fleet server's own working directory. In practice this meant
every member's harvested learnings, from every repo, landed in whichever
repo the fleet server process happened to be started in, regardless of which
repo the member was actually working in. `execute_prompt` now passes the
dispatched member's own working folder through to the harvest call, and the
harvest tool routes through the same single accessor every other KB tool
uses, which caches providers per resolved repo slug instead of one global
slot. The parallel accessor was deleted outright rather than patched, so
there is now exactly one route from a KB tool to a provider. A related
slug-resolution bug that collapsed plain-HTTPS git remotes (those with no
userinfo prefix) to the wrong fallback slug was fixed in the same pass, so
HTTPS and SSH remotes for the same repo now resolve to the same KB.

This closes local-member cross-repo KB contamination for the automatic
harvest path. Two related items remain open as follow-on work: remote
members do not yet resolve their own repo (their harvest currently lands in
a shared `default` KB rather than colliding with another repo's KB), and the
regression guard that protects the single-accessor invariant is a textual
source check rather than a structural one, so it does not catch a future
provider constructed directly with no explicit repo path. Deploying this
change requires the CLI permission allowlist to grant the deploy-phase
command prefixes (`gh`, `npm`, the installer binary, etc.) that the
repository's checked-in permission settings do not currently include; until
that is granted, this work is verified by its test suite but has not been
smoke-verified through an actual deploy.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 17 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- KB/code-intelligence audit and pre-init lifecycle: sprint goal closed out

This entry reconciles the previous "sprint goal not met" note below: the
KB initialization lifecycle goal and the KB/code-intelligence audit goal
have both been closed at the parent level, on the strength of the work
already summarized below plus a completed audit pass. No new source
changes landed this cycle; this entry captures the final review of the
work already on the branch.

The KB initialization lifecycle delivered its pre-init sub-phase: provider
availability detection and repo index-size estimation, both pure and
unit-tested (see
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md)).
The init phase (first-time indexing with a progress-reporting opt-in
prompt) and the update phase (incremental re-indexing triggered by
staleness detection) were not built this cycle and remain open as
tracked follow-on work; an auto-reindex module delivered in an earlier
cycle already provides partial coverage of the update phase's
staleness-triggered re-indexing.

The per-member code-intelligence provider field (`codeIntelProvider` on
the `Agent` interface, wired into `register_member`/`update_member`) is
schema/persistence only -- no dispatch path resolves a provider per
member yet, so setting it has no observable effect until the routing
half of this feature is built.

The full KB/code-intelligence tool audit was run end-to-end: every KB
tool and every code-intelligence tool (with both providers) was exercised
via its audit task, and the corresponding verification task confirmed the
results. No bugs were filed as a result of the audit, consistent with a
clean pass -- the full test suite (2314 tests, 0 failures) provides
independent confirmation.

## [Unreleased] -- compose_permissions silent write no-op fix

Sprint goal: fix a bug where `compose_permissions` could report a grant as
successful while the underlying provider settings file on the target member
was never actually updated -- a silent no-op reproduced live on a Windows
member, though the underlying defect was not platform-specific. All in-scope
work closed. The sprint's own final verdict is FAIL (a reviewer dispatch
stalled and could not be repaired after a retry), and a same-day regression
pass also failed for the same stall reason; no carry-over beads were filed
from the regression pass.

What shipped:

- The config-delivery path used by `compose_permissions` now checks the exit
  code of every remote directory-creation and write command, and reads the
  written file back to structurally confirm the intended content actually
  landed (parsed-and-compared for JSON, substring-matched for TOML/string
  content) before treating a grant as delivered. Any failure -- a nonzero
  exit code or a read-back mismatch -- is surfaced as an explicit failure
  string from `compose_permissions`; the permissions ledger is left
  untouched in that case, so a failed write can no longer be recorded as if
  it had succeeded.
- A new regression test suite drives the real, unmocked local command
  execution path against a scratch filesystem and asserts on file content
  read from disk with the standard filesystem API, covering a fresh grant,
  a grant merged onto an existing settings file (preserving unrelated
  entries), and a forced write failure. This closes the coverage gap left by
  the existing test suite, which only asserted on the generated command
  string and could not have caught this class of bug.
- Verification note: this sprint's test run exercised the POSIX write path
  end-to-end on a real filesystem. The Windows write path is covered by
  code inspection and by existing mocked-command-string assertions, but was
  not executed end-to-end against a real Windows filesystem in this sprint
  -- that gap is called out explicitly rather than claimed as covered.
- Also included on this branch: a fix to the stall-poller's Windows
  liveness/staleness polling, which removed an intermediate PowerShell
  `$variable` from a remote one-liner (observed to be silently stripped by
  the SSH execution path on at least one Windows member, breaking the mtime
  signal on every poll) and replaced a directory-enumeration pattern that
  could hang against a nonexistent path with an existence guard ahead of it.

Carried forward: the write-level verification added here does not by
itself guarantee that a provider CLI reads and honors a correctly-written
settings file (a separate, already-tracked concern -- see the
workspace-trust caveat in `docs/missing-grant-recovery-and-playbook-evolution.md`),
and concurrent grant application against the same member remains an
unlocked read-modify-write. Both remain open, tracked items.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $2.7463.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1223 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- cross-shell member-bound command construction audit

Sprint goal: fix a PowerShell parse failure that broke PR lookup on a
Windows fleet member during sprint-abort finalization, then perform a
holistic, codebase-wide audit for the same underlying bug class -- any
command string built with POSIX-only shell syntax (bare `$VAR`/`$HOME`
expansion, `sed`, `xargs`, `tail`, `nohup`) and sent to a member whose
remote shell may actually be PowerShell rather than bash. All in-scope work
closed except one coverage-extension task that remains open. The sprint's
own final verdict is FAIL: the final reviewer dispatch stalled and could not
be repaired, and a same-day regression pass also failed for the same
stalled-dispatch reason. No deploy succeeded this sprint -- every deploy
attempt was blocked at the dependency-install step by a locked native
build artifact unrelated to this sprint's source changes, so nothing here
has been rebuilt/repackaged or smoke-tested as a shipped artifact; the
changes below are described as implemented and unit/integration-tested in
the source tree, not as verified-deployed.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $14.3110.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 36 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped:

- The credential-file read used during sprint-abort finalization on Windows
  members no longer relies on POSIX-style `$HOME` path expansion, which
  PowerShell either parses incorrectly or rejects outright. The value is now
  resolved to a concrete, OS-appropriate path before the command is built.
- A shared `wrapPowerShellEncoded` helper now backs every Windows-bound
  PowerShell script construction site (text/JSON file writes, credential
  file read/write, recursive file hashing, member-bound file deletion, and
  the tools below). It base64-encodes the script as a `-EncodedCommand`
  invocation (removing an entire class of shell-quoting bugs) and forces
  `$ErrorActionPreference = 'Stop'` with a try/catch so a script-opted-out
  `-ErrorAction SilentlyContinue` failure stays suppressed while every other
  failure surfaces correctly, including a native command's exit code (via
  `$LASTEXITCODE`), which the wrapper's own `exit 0` previously masked.
- Remote task monitoring, remote log tailing, and member removal's
  authorized-keys cleanup are now OS-branched: each builds either a POSIX
  command or a PowerShell command depending on the target member's OS,
  instead of a single POSIX-flavored string that silently misbehaved (or
  was silently corrupted in transit) on a PowerShell target. Member removal
  now also surfaces a warning when the authorized-keys cleanup step fails,
  instead of failing silently.
- Long-running background tasks are now supported on Windows members: the
  task is launched detached via `Invoke-CimMethod Win32_Process.Create`
  (spawned under the WMI provider host's own session, independent of the
  SSH session's job object -- a plain background launch dies with the SSH
  channel on Windows), running a PowerShell wrapper script that mirrors the
  POSIX bash wrapper's status.json/task.pid/task.log/activity-marker/retry
  behavior. `monitor_task` reads the same task-directory shape on both OSes.
- Remote pid-liveness and durable-output-file probes (the orphan-recovery
  lease-of-life gate) are now OS-branched the same way -- previously they
  always dispatched POSIX `kill -0`/`cat`, so on a Windows member the probe
  could never report a genuinely-alive process as alive.
- Member OS detection no longer caches a guessed/fallback value on
  detection failure -- only a successful, authoritative detection is
  memoized, so a member is not permanently misrouted to the wrong OS branch
  after one failed detection attempt.
- The root test command now also runs the fleet-sprint workspace's own
  `node --test` suite, which was previously invisible to the root gate
  because it used a different test runner than the rest of the monorepo; a
  green root test run previously did not actually exercise this workspace
  at all.

Carried forward: one coverage-extension task (adding live PowerShell
exit-code tests for the remaining `wrapPowerShellEncoded` call sites beyond
the ones this sprint directly touched) remains open and unclosed.

## [Unreleased] -- npm-install dependency-packaging fixes

Sprint goal: unblock npm-installed (published-tarball, non-workspace) consumers
by fixing a cluster of packaging gaps found while replaying the npm-publish
gating sequence locally -- an incompatible transitive dependency that crashed
any process resolving it on the supported Node runtime, a bundled workspace
package that was shipped as source but never registered as an installable
dependency, an install safety guard that blocked replays on any machine
already running an unrelated server, and a package-size guard whose threshold
check could never actually fire. All in-scope work closed; the sprint's own
final verdict is FAIL (a reviewer dispatch stalled and could not be repaired
before the sprint budget ran out), and a same-day regression pass could not
run because the sandbox's permission allowlist did not cover the commands the
regression playbook requires.

What shipped:

- `undici` is now pinned to `^7.29.0` (via a workspace-root override, kept in
  lockstep with the published package's own dependency manifest and a
  regenerated lockfile) to restore Node 20 compatibility -- the newer 8.x
  line throws `webidl.util.markAsUncloneable is not a function` inside
  Node 20's older Web IDL internals as soon as anything requires it, crashing
  the CLI, the supervisor subprocess, and dozens of integration test files
  outright. A root-level override alone does not propagate to a downstream
  npm-installed consumer's own dependency resolution, and a stale lockfile
  can silently keep resolving the broken version even after the override is
  added -- both gaps are now covered by a test that packs the CLI, installs
  it into a clean non-workspace target, and imports `undici` from that
  installed copy, not just from the source workspace's own `node_modules`.
- `@apralabs/apra-fleet-client` (the bundled fleet-server client used by the
  fleet-sprint engine) is now also registered as a real installable
  dependency (a `file:`-referenced entry), not just listed in the package's
  shipped-files allowlist -- being present on disk after install and being
  resolvable via standard module resolution are two different things, and
  the gap was invisible in dev-mode testing because workspace symlinking
  hides it there. npm-installed users previously hit a silent
  `could not resolve the fleet server` warning and fell back to a degraded,
  no-op dolt-mutex/id-allocator path for every real sprint.
- The `install` command's running-process safety guard is now scoped to
  whether a detected running server is actually relevant to the install being
  performed (recorded live in the install's own data directory, or running
  from the exact prefix about to be overwritten), instead of refusing
  whenever any apra-fleet process exists anywhere on the machine. An
  unrelated server no longer blocks an isolated install replay, and the
  guard falls back to non-blocking (with an informational note) rather than
  silently reinstating the old global refusal when a running process's
  executable path cannot be determined.
- The npm-publish pipeline's Clean-pack size guard now reads the real byte
  count from `npm pack --dry-run --json` instead of pattern-matching npm's
  human-readable `unpacked size: 4.1 MB`-style notice line -- the previous
  regex extraction only ever captured the leading digits before the decimal
  point, so the 10 MB threshold comparison could never actually fire
  regardless of true tarball size. The new guard also accepts both
  `--threshold N` and `--threshold=N` forms and fails loudly on a malformed
  threshold value instead of silently ignoring it.

Carried forward: the `@apralabs/apra-fleet-client` resolvability fix above
ships without an automated test that packs the CLI, installs it into a clean
non-workspace project, and asserts end-to-end that `apra-fleet workflow
fleet-sprint` resolves the fleet server with no warning -- that verification
coverage is still outstanding and the parent bug it closes remains open
pending it. Separately, one reviewer-proposed follow-up task was rejected
before reaching issue creation because its title used characters outside the
tracker's safe-character allowlist; the underlying finding (the pack-size
guard's equals-form threshold handling) was fixed directly in this sprint's
work regardless, so nothing is outstanding from that rejection. The
end-of-sprint regression pass is deferred pending
an operator adding the missing sandbox command permissions; no new
carry-over issues were filed by that (informational, non-gating) pass.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.8641.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0929 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 24 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Dolt push reliability: auth/divergence classification, recovery ladder wiring, child-id create fix

Sprint goal: fix a cluster of fleet-sprint reliability defects surfaced by
real sprint runs -- a Dolt D-push credential failure being misclassified as
data divergence and aborting the sprint instead of self-healing, an unused
Dolt conflict-recovery ladder that was never actually wired into the push
failure path, a `bd create` invocation that unconditionally combined `--id`
and `--parent` and silently lost the pre-allocated child id on failure, and
a sprint stall-detector reading closed-bead counts from a stale snapshot so
a cycle's own Integ Test closures were never credited toward progress. Also
in scope: test coverage for the VCS-auth preflight gate on read-side
dispatch brackets, and the provider-agnostic VCSModule error-taxonomy epic
this cluster builds on. **Code review found all six scoped items correctly
implemented and fully covered by the passing unit/mock suites, but the
sprint's own final verdict is FAIL**: Deploy failed at its permissions-check
step in every cycle this sprint ran (the sandbox's command allowlist did not
cover the two prefixes a prior sprint's deploy-runbook change now requires
for its supervisor-start and smoke-test steps), so the three parent bugs
routed to verify-against-a-deployed-build were never confirmed end-to-end
and remain open. The deployer correctly stopped and reported the permission
gap rather than working around it.

What shipped:

- A Dolt D-push rejection is now classified into a distinct credential
  (`auth`) failure versus a genuine non-fast-forward divergence, checked
  independently at both points a push can still fail (the first attempt, and
  the re-push that follows a reconcile-pull) -- previously both were folded
  into the same divergence error, so a lapsed credential aborted the sprint
  with a misleading "diverged" message instead of self-healing. An
  auth-classified push failure now triggers the same bounded, one-shot
  credential self-heal used elsewhere in the sync layer before retrying.
- The Dolt conflict-recovery ladder (scripted resolve-in-place, then
  discard-and-re-bootstrap, then an agent-with-runbook last resort) is now
  actually invoked from the D-push failure path at both divergence
  terminals, instead of existing only as a module exercised by its own
  tests. With no recovery hook supplied, prior degraded-by-default behavior
  is unchanged -- the ladder only ever narrows an existing failure into a
  resolved one.
- Fixed a `bd create` call that combined `--id` and `--parent` in one
  invocation, which the installed `bd` CLI rejects outright: the fix issues
  `--id` alone and links the parent with a separate `bd update --parent`
  call, verifying the reported parent matches what was requested before
  trusting the create.
- Fixed the sprint stall-detector's closed-bead count to be read fresh
  immediately before each cycle's progress evaluation, rather than reused
  from an earlier snapshot taken before that same cycle's own Integ Test
  step could close verify-routed beads -- previously those same-cycle
  closures were invisible to the stall detector's high-water-mark check,
  producing a false stalled-abort even though real progress was made every
  cycle.
- New end-to-end test coverage for the VCS-auth preflight gate on read-side
  dispatch brackets (planner, integ-test-runner, regression-test-runner),
  pinning that a preflight failure degrades silently rather than aborting
  the dispatch.

Carried forward: the three P1/P2 bugs verify-routed to a deployed build
(the Dolt credential-classification fix, the `bd create` id/parent fix, and
the stall-detector freshness fix) remain open pending a deploy run once the
sandbox's permissions allowlist is updated to cover the deploy runbook's
newer supervisor-start and smoke-test steps. A full regression pass run
after the final verdict (informational only, does not gate this sprint)
filed/reconfirmed several parent-less carry-over bugs, including a
smoke-harness port-cleanup gap in the toy-sprint deploy path.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $20.5559.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 42 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- install --force stop-confirmation fix (closes prior sprint's deploy-gate carry-over)

Sprint goal: continue the dispatch-stall/timeout reliability cluster by fixing
the two items a prior sprint in this same cluster had to carry forward after
its own deploy gate failed -- `install --force`/`update` could fail with
`ETXTBSY` (text file is busy) when it copied the new binary over a still-running
old server process, and it printed a "stopped running server" success message
unconditionally rather than only once termination was actually confirmed. All
scope work is now implemented, tested, and verified; the sprint's final verdict
is PASS.

What shipped:

- `install --force`/`update` now polls the old server process's liveness over
  a bounded grace window after sending the initial termination signal, and
  escalates to a harder kill signal (with a second, shorter poll window) if
  the process is still alive once the window elapses. The binary copy is only
  attempted once the old process is confirmed gone, closing the `ETXTBSY`
  failure that could occur when a fixed sleep wasn't long enough for a
  mid-request singleton to exit.
- The "Stopped running server." success message is now gated on that same
  confirmed-termination check instead of being printed unconditionally. If
  the old process is still detected running after both the initial signal and
  the escalation, install now reports a clear, actionable error (including
  the manual command to finish stopping it for the current platform) and
  exits non-zero, instead of asserting a stop that didn't actually happen.

No items are carried forward from this cycle. An end-of-sprint regression
pass could not run: the sandbox's permission allowlist did not cover the
commands the regression playbook requires, so the pass stopped at its own
permissions check before either its real-bd suite or its smoke test could
execute. This is informational and does not carry over any new bead; the
permissions gap needs to be resolved by an operator before a regression pass
can be attempted.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.3687.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0695 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Dispatch-layer stall/timeout reliability hardening

Sprint goal: dedupe and fix a cluster of dispatch-stall and max_turns-exhaustion
incidents traced to a stall detector that could not actually cancel a hung
dispatch, a client timeout budget that didn't account for the server's own
retry, and several related latent hazards found while investigating the same
incident cluster. **Goal work fully landed and code-quality-approved, but the
sprint's own final verdict is FAIL** -- the deploy gate failed before the smoke
test could run, and that failure was confirmed to be a genuine pre-existing
defect, not an environment fluke (see below).

What shipped:

- A confirmed stall now cancels the in-flight MCP dispatch itself (via an
  `AbortController` threaded through the same abort-signal path remote
  strategies already accept), instead of only killing the remote process and
  leaving the client to wait out its own independent hard deadline.
- The client's dispatch timeout budget now shares a single derivation with
  the server's own inactivity-timeout retry, so the client can no longer time
  out before the server's own retry-and-report-cleanly path gets a chance to
  run.
- Workspace-trust detection now also classifies an exit-0/empty-stdout
  dispatch against a never-trusted workspace as `workspace_not_trusted`
  (previously only a nonzero exit code triggered this), gated to
  self-heal-and-retry exactly once.
- The SSH connection pool's idle-reap path now re-verifies a channel is
  genuinely idle immediately before closing it, closing a latent risk that a
  provisional (not-yet-polled) stall-tracking entry's channel could be reaped
  while still live; SSH connections also now configure keepalive so a
  silently dropped connection is detected rather than left as a phantom pool
  entry.
- The supervisor watchdog's periodic tick now has a reentrancy guard, so an
  overlapping tick (possible once per-tick liveness checks take longer than
  the tick interval) is skipped rather than racing the in-flight tick on
  shared state.
- `finalizeAbort()`'s own git operations now go through the same
  self-heal-and-retry-once pattern already used elsewhere, so a stale
  credential encountered during abort cleanup no longer silently drops a
  PR-lookup step from the terminal history record.
- The sprint cost-analysis report now gives Integ Test its own line (previously
  folded into "overhead"), and dispatches that exhaust their turn ceiling or
  time out now report their real partial cost rather than an undefined/zero
  figure.
- The orchestrator no longer automatically classifies a max_turns/timeout
  streak as failed when every bead it was assigned is already closed -- it is
  now classified as a successful streak that overran its own VERIFY step, and
  no wasted resume dispatch is triggered. Paired with a strengthened doer
  contract stating that the moment its last assigned bead closes, its only
  next action is emitting the VERIFY result.
- `undici` is now pinned to the 7.x line workspace-wide via package-manager
  overrides, fixing a Node 20 incompatibility that broke child-process-spawn
  tests independent of any application code.

However, the sprint fails its own deploy gate: `install --force` failed with
`ETXTBSY` (text file is busy) while copying the new binary over a still-running
server process, and the smoke test never ran as a result. This was confirmed to
be a genuine, pre-existing latent defect in the installer's stop-then-copy
sequence (it waits a fixed short delay and unconditionally reports the old
server stopped, without verifying the process actually exited before copying
over it) rather than caused by this sprint's own changes -- but it still blocks
release and is tracked as carried-forward work (see below).

Carried forward to a future sprint:

- Make `install --force`/`update` verify the old server process has actually
  exited (polling liveness, escalating if needed) before copying the new
  binary, instead of assuming success after a fixed delay.
- Gate the installer's "stopped running server" message on confirmed
  termination instead of asserting it unconditionally.
- An end-of-sprint regression pass could not run at all: the sandbox's
  permission allowlist did not cover the commands the regression playbook
  requires, so the pass stopped at its own permissions check before either
  its real-bd suite or its smoke test could execute. This is informational
  and does not carry over any new bead.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $4.1194.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1562 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 10 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-sprint runner error-classification correctness

Sprint goal: fix a cluster of error-classification defects in the
`fleet-sprint` runner so that abort handling, terminal-record reporting,
post-dispatch teardown skipping, and reviewer contract enforcement each ask
the narrow question they are actually meant to answer, instead of a single
blanket "is this a `WorkflowError`" check sweeping routine, non-terminal
failures into a false aborted-sprint verdict. **Goal met -- sprint verdict is
PASS.**

What shipped:

- The runner's abort classification is now a curated, explicit list of
  typed error classes (stalled sprint, plan rejection, reviewer contract
  violation, budget exceeded, git/dolt divergence, pre-sprint validation
  failure) rather than every `WorkflowError` subclass -- so ordinary
  dispatch/sync failures each phase already retries or soft-fails on no
  longer masquerade as a full sprint abort with a spurious push and
  `[ABORTED]` PR.
- Terminal-record reporting (so the supervisor watchdog can classify a
  finished run as FINISHED-with-a-reason instead of CRASHED) was split out
  as its own, deliberately broader check from the narrower abort-worthy
  check, since every typed failure needs a terminal record but only a
  genuine abort needs the push-and-PR treatment.
- Post-dispatch sync teardown is no longer skipped for a dispatch failure
  where the agent provably ran (turn-limit exhaustion, or a local dispatch
  watchdog abandoning an in-flight call whose remote member kept running) --
  only genuinely no-mutation dispatch failures skip teardown now.
- A reviewer verdict's `replanIds` are now required to be a subset of its
  `reopenIds`; a `replanIds` entry that silently falls outside that set is
  both flagged as a reviewer contract violation and logged explicitly
  instead of being silently dropped.
- The Final Review LLM-auth self-heal path now short-circuits on success
  instead of falling through into a redundant second dispatch, and a
  heal-retry that itself throws degrades through the same generic failure
  ladder as every other Final Review failure.
- Plan-reviewer dispatch failures are now marked and retried distinctly from
  a genuine plan rejection, so a transport/infra failure while soliciting a
  plan-reviewer verdict is never misreported as the plan itself having been
  rejected.
- Publish's branch push is now fail-soft with a bounded retry; a push that
  still fails after retries is logged and skips PR creation and target-issue
  closure, but the sprint's already-computed PASS/FAIL verdict is still
  returned rather than being downgraded into a run failure -- so a caller
  reading the run's status can no longer assume a successful sprint verdict
  implies its branch was actually pushed or a PR was raised; `pushed:false`
  now distinguishes that case.
- A table-driven contract test enumerates every error class against both
  classification predicates (including wrapped-divergence and
  null/undefined edge cases), plus end-to-end harness assertions for each of
  the four routing outcomes (abort record, rethrow-with-no-record,
  teardown-skip, teardown-run), so future edits to this area have a single
  place to pin new rows rather than relying on scattered individual
  assertions.

Carried forward to a future sprint:

- One open task to update two pre-existing exit-classification tests for a
  concurrently-landed watchdog "launch failed" reclassification (a fast
  child exit within a configurable window of reservation now classifies
  differently than a plain crash); this runner-error-classification sprint's
  own file footprint did not need to touch those two files.
- Four regression findings surfaced by this sprint's end-of-sprint
  regression pass (informational; did not gate this sprint's verdict): a
  bd-replay recording drift in a stalled-planner-session test; a shared,
  non-exclusive smoke-test sandbox path that let two concurrent regression
  runs collide and destroy each other's in-progress state; a growing list of
  real-bd integration-suite files exceeding their single-file time budget;
  and a single real-bd suite timeout in the publish-push-failure test.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $9.4498.
Remaining budget: unknown/unbounded.
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Dispatch-layer reliability: max_turns detection, busy-lock self-heal, AGY output capture

Sprint goal: make `execute_prompt`'s terminal-signal handling truthful and
self-healing, closing three independent dispatch-layer reliability gaps.
**Goal met -- sprint verdict is PASS.**

What shipped:

- **Reliable max-turns detection.** A Claude CLI can signal "hit the turn
  limit" through more than one transcript channel depending on version and
  stream shape -- a result event's `terminal_reason` field, that event's
  `subtype`, a distinct standalone terminal event (which can arrive instead
  of any result event when a hard-timeout kill truncates the stream first),
  or a plain-text fallback with no result event at all. Detection now
  recognizes every one of these channels and normalizes them through a
  single shared classifier used by every call site, so a turn-limit
  termination always surfaces the existing `max_turns_exhausted` reason
  promptly instead of occasionally falling through to a generic exit-code
  classification and sitting dead until the hard dispatch ceiling.
- **Stall detector cross-checks OS mtime against content parsing.** The
  transcript-freshness poll now also reads the transcript file's own
  filesystem last-modified time as an independent signal alongside its
  existing content-timestamp scan, and only calls a session stalled when
  *both* signals agree the transcript is frozen -- a strict superset of the
  prior content-only check that can only convert a would-be false stall
  into recognized activity, never the reverse, while still catching a
  genuinely dead session within the configured inactivity window (a couple
  of minutes by default) instead of the much longer hard ceiling. Threshold
  is configurable and documented.
- **Busy-lock self-heal.** `execute_prompt`'s in-flight lock can outlive the
  process it was guarding (a reaped child whose cleanup handler never fires,
  or an interactive session's process dying post-registration), which used
  to wedge a member permanently -- every dispatch kept returning `busy`
  even though the member was actually idle. A busy rejection now first
  verifies the locked session's process is actually alive (local signal
  check, a fresh independent remote liveness round trip, or the session
  registry's last-known pid for interactive sessions) and self-heals
  (releases the lock, warns, proceeds) only on a definitive dead-pid
  reading -- any ambiguity is conservatively still treated as busy, so a
  dispatch that hasn't finished starting up can never be raced.
- **AGY (Antigravity) provider captures real response output.** Previously
  an AGY dispatch always returned an empty result. The provider now
  extracts both the reply text and, when the CLI's transcript exposes one,
  a session id -- pinned against a recorded-shape CLI output fixture, no
  live AGY dispatch involved in the test.
- All four fixes are covered by deterministic, fixture/mock-based regression
  tests (no real CLI or credentials). No MCP tool schema, response contract,
  or reason-enum values changed.

Carried forward: a pre-existing Node/undici incompatibility
(`webidl.util.markAsUncloneable is not a function`) that crashes a chunk of
the real (non-mocked) integration suite and the sandbox smoke test's CLI
startup was confirmed present on the base branch as well (not a regression
from this sprint) and filed as a standalone follow-up for a future sprint.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $9.5894.
Remaining budget: unknown/unbounded.
Pricing source: all 16 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-sprint stabilization: run identity, dolt coordination, Windows fixes

Sprint goal: stabilize the always-on multi-sprint supervisor by fixing the
run-identity/termination-classification gaps, wiring cross-sprint Dolt
coordination end to end for the standalone CLI launch path, closing a
Windows shell-invocation and a class of Windows entrypoint-guard defects,
and reconciling the reviewer's newTask allowlist with the planner's
verification-task convention. **Goal not fully met -- sprint verdict is
FAIL**, for release-process reasons rather than code-quality ones.

What shipped and is genuinely solid:

- Supervisor run-identity threaded into the sprint child's own engine
  run-state, so the watchdog/dashboard/history layer reports the engine's
  own terminal reason (and, where present, its verdict) truthfully instead
  of inferring an outcome from process liveness alone; a mismerge-able Dolt
  conflict is now its own distinct terminal classification carrying the
  conflict dump forward; child exit code/signal/time are recorded into the
  ledger the moment the child process exits, independent of whatever the
  engine itself manages to persist.
- Per-sprint child stdout/stderr is teed to a log file, served and linked
  from the dashboard, so a sprint's raw output stays traceable even when it
  crashes before reporting anything structured.
- The dolt-push mutex and child-id allocator (previously supervisor-only)
  are now also hosted on the fleet MCP server and wired end to end
  (`--service-url` threaded through the standalone CLI launch path), closing
  the coordination gap for sprints launched outside the supervisor. The
  thin client wrapper other packages use to call fleet MCP tools was
  updated in lockstep so it cannot silently drift from what the server
  actually accepts.
- Reviewer newTask title allowlist now accepts square brackets (reconciling
  with the `[test]` verification-task convention), and a rejected newTask is
  resurfaced into the next planning dispatch rather than silently dropped.
- Fixed a class of Windows entrypoint-guard scripts whose "is this the
  directly-run script" check compared `import.meta.url` against a
  hand-built `file://` string, which never matches on Windows (a native
  path vs. a properly-encoded URL), so the affected verification scripts
  previously exited 0 having verified nothing -- a false-pass, not a crash.
  Also fixed a Windows `bd` invocation
  path that threw ENOENT when spawned without a shell, without reintroducing
  the shell-injection surface a naive `{ shell: true }` fix would have
  opened.
- The full local unit/build suite is green, and the real (non-mocked)
  integration suite passed 142/142 files with zero failures on its final
  runs this sprint.

Why the sprint still failed:

- **The deploy step never executed in any cycle** -- a required permissions
  allowlist was missing from the local tool-permission configuration, so no
  deploy command ran and nothing was verified as actually deployable.
- **The integration playbook's smoke-test scenario completed in zero of
  four attempted cycles** -- each run stopped at the credential-provisioning
  step because no live provider credential was available to the runner,
  which is an environment/credential gap rather than a product defect, but
  it means there is no end-to-end evidence of a real planner dispatch,
  closure, or version-flag assertion against any deployed build this
  sprint. The real (non-mocked) functional suite was independently green.
- **Scope was not complete**: a number of P1 items remain open, carried
  forward to a future sprint -- a launch-failure fast path and
  diagnose-before-relaunch gate in the supervisor; wiring or decommissioning
  the existing Dolt conflict-recovery ladder; routing persona-proposed bead
  creation through the shared id allocator instead of direct creation;
  requiring machine-checkable dedup evidence before a new bead is created;
  adding the deploy-required permissions allowlist; and provisioning a
  runner credential so the smoke-test scenario can actually complete.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $37.2433.
Remaining budget: unknown/unbounded.
Pricing source: all 78 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- `auto-sprint` CLI workflow renamed to `fleet-sprint`

**BREAKING (CLI surface).** apra-fleet's own product sprint workflow is now
called `fleet-sprint` everywhere. Claude Code's separate Workflow-tool script
(`~/.claude/workflows/auto-sprint.js`, its `/auto-sprint` slash command, and
the `auto-sprint-args` skill) is a different thing and **keeps** the name
`auto-sprint` -- the two were repeatedly confused, which is what motivated the
rename.

What changed:

- `apra-fleet workflow auto-sprint ...` -> `apra-fleet workflow fleet-sprint ...`
- npm bin `auto-sprint` -> `fleet-sprint`; bundle `dist/auto-sprint.mjs` ->
  `dist/fleet-sprint.mjs` and `dist/auto-sprint-runner.mjs` ->
  `dist/fleet-sprint-runner.mjs`
- Installed workflow dir `~/.apra-fleet/workflows/auto-sprint/` ->
  `~/.apra-fleet/workflows/fleet-sprint/`
- Source dir `packages/apra-fleet-se/auto-sprint/` ->
  `packages/apra-fleet-se/fleet-sprint/`
- New `fleet-sprint-cli` skill (source:
  `packages/apra-fleet-se/fleet-sprint/skills/fleet-sprint-cli/`) documenting the
  CLI flag contract, installed to `<configDir>/skills/fleet-sprint-cli` for
  **every** LLM provider by `apra-fleet install`, and removed by `uninstall`.

Migration: re-run `apra-fleet install` to lay down the renamed workflow
directory and the new skill, and update any scripts that invoked
`apra-fleet workflow auto-sprint` or the `auto-sprint` bin.

## [Unreleased] -- Auto-sprint as a service: always-on multi-sprint supervisor

- **apra-pm architectural reorg** -- The `vendor/apra-pm` git submodule has been removed and replaced with a package-local deep copy under `packages/apra-fleet-se/apra-pm`. This eliminates silent submodule synchronization drift and significantly streamlines packaging, CI, and E2E processes that previously depended on the submodule being manually initialized.

Sprint goal: turn the single-shot, run-to-completion auto-sprint CLI into an always-on
supervisor service that runs multiple concurrent sprints with member+issue-scope
reservation, a sprint-stack dashboard, and orchestrator-bracketed git+Dolt sync, with the
service positioned as the single supported user-facing entry point. **Goal not fully
met -- sprint verdict is FAIL.** A large amount of real, well-tested functionality shipped:
an always-on supervisor process owning a combined member+issue-scope reservation ledger and
a PID-liveness watchdog with restart re-adoption; a sprint-stack dashboard (running sprints,
a process-free history view, a backlog tree that live-recomputes claimed scope) served
through one reverse-proxied port; orchestrator-bracketed git and Dolt sync with a scripted-
first conflict escalation ladder (mechanical detection/resolution before any agent is
dispatched, and only as a documented last resort); CLI convergence onto one shared fleet
transport; server-side per-member reservation enforced at dispatch time (independent of the
supervisor's own launch-time ledger, closing the gap where a manually invoked sprint could
otherwise bypass it); a shell-drivable `register-member` CLI subcommand sharing the same
validation/registration logic as the MCP tool; a darwin-x64 build-from-source deploy
fallback; and a lean dashboard-polling pattern (small recurring payload, on-demand full-text
fetch with client-side caching) for sprints with large activity/task counts. Unit and build
suites are fully green.

However, the sprint fails its own acceptance gate: the epic requires the service to complete
a full plan-develop-review-harvest cycle against a live smoke sandbox, and that end-to-end
smoke test did not pass in any of five attempted cycles. Root causes uncovered and (partially)
fixed but not yet proven to hold under a real end-to-end run: a member's live interactive
session dying mid-dispatch with no timeout ever firing on the dispatching side; a member
being incorrectly rejected as "reserved by another sprint" when the identity token used at
reservation time and at dispatch time did not match; and a sandboxed Dolt clone's remote
being re-wired and a real push attempted against it despite an explicit neutralization step,
caught only by an unrelated missing-credentials condition rather than by the neutralization
holding as designed. Additional known, tracked-but-unresolved integration blockers: a fixed
test-server port causing an EADDRINUSE cascade across dependent test processes; a smoke-test
fixture repository with no pre-tagged canary issue, requiring either a maintainer reseed or a
self-provisioned fallback; a pre-sprint scope validator that rejects a single childless issue
as a sprint target; and a bootstrap recovery step that can reactivate a real, live sync
remote unless explicitly neutralized afterward. A vendored agent-contract durability
improvement (per-commit push discipline for the vendored doer/harvester role contracts) is
incomplete: implementation work remains in progress and no test exists yet to verify it, so
the vendored contract files are unchanged from before this sprint.

Carried forward, all open, none closed this cycle: the eight integration blockers described
above; a member-reservation interoperability gap between workflow/CLI-launched sprints and
the server-side reservation check; a viewer full-state-polling performance gap on very large
sprints (distinct from, and not fully addressed by, the lean-polling pattern shipped this
sprint); a real-bd test suite performance regression where a meaningful fraction of files
exceed their per-file time budget; and the incomplete vendored agent-contract durability
work described above. Two lower-priority follow-ups from earlier in the sprint (a CLI-
convergence in-progress item, and a crash-resume-via-journal design explicitly deferred by
the original plan) also remain open and are intentionally left for a future sprint.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 80 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-reorg

Sprint goal: continue scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner") from the point the prior `feat/fleet-workflow-subsystem` sprint left off. **Goal work landed (15 beads closed this sprint, final open-at-goal-priority count 0), but the sprint's own final verdict is FAIL** -- the final reviewer dispatch timed out after repair attempts (`Command timed out after 300000ms of inactivity`) rather than returning a schema-valid verdict, so the sprint could not self-certify despite the code landing. What shipped: `apra-fleet-7pm.8` self-heal extraction in the workflow launcher (`src/cli/workflow.ts` re-extracts the on-disk payload from embedded SEA assets if it's found missing/incomplete); `apra-fleet-7pm.9` `uninstall --skill workflows` (removes the shared runtime/schema dirs and only the built-in workflow subdirectories, preserving user-authored workflows); `apra-fleet-7pm.10` the update flow reading back and re-threading the persisted `--workflows` mode into a re-invoked install; `apra-fleet-7pm.11` `docs/authoring-workflows.md` plus doc deltas; `apra-fleet-7pm.12` a fix for broken npm-mode auto-sprint runtime imports in a clean global install; `apra-fleet-7pm.13`/`.15` build-binary smoke tests for the workflow subcommand and an auto-sprint-as-built-in-workflow packaged-binary e2e test; and `apra-fleet-7pm.14` a regression guard pinning the existing CLI command surface. Also landed outside the epic: a redesigned Sprint/Backlog dependency-tree beads panel in the auto-sprint dashboard, and a positioning paper comparing `apra-fleet-workflow` to LangChain/LangGraph.

Deploy/integration still could not run this sprint, for the same reason recorded last sprint and tracked as `apra-fleet-nbp` (P3, still open): `integ-test-playbook.md` remains absent from the repo root, and `deploy.md` still lacks the required `## Deploy`/`## Smoke test` sections (it has a `## Steps` section with unresolved `<branch>`/`<run-id>`/`<tag>` placeholders and a manual, non-scriptable verify step instead). One of the three deploy attempts this sprint also flagged a stray instruction-like line in `deploy.md` ("Must be run using model tier `cheap`") as a likely prompt-injection attempt, which was correctly not followed.

Carried forward: `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3, still open, still blocking automated deploy verification). No other work from this sprint's scope was left open.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 35 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-workflow-subsystem

Sprint goal: scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner"). **Goal NOT met -- sprint verdict is FAIL.** What landed this sprint: `src/cli/workflow.ts`, the launcher subcommand that runs a workflow script (an ESM entry under `workflows/<name>/`) from inside the SEA binary against a live fleet connection; a shared, single-implementation connection-resolution helper (`@apralabs/apra-fleet-client/server-resolution`) used identically by the launcher and by `packages/apra-fleet-se/bin/cli.mjs`, resolving HTTP-singleton-attach-first with stdio self-spawn as fallback (`docs/adr-workflow-server-resolution.md`); SEA asset embedding of the workflow runtime, agent schemas, and built-in workflows via `scripts/gen-sea-config.mjs`; and `docs/authoring-workflows.md` plus deltas to `docs/install.md`, `docs/npm-packaging.md`, and `packages/apra-fleet-se/docs/cli-reference.md`. Entry-path escape prevention (rejecting `..`/absolute-path manifest entries) is implemented and tested. Full test suite passes (2275/2275, 18 skipped) and `npm run build` is clean.

What did NOT land, despite the epic being scoped for it: the `install.ts` additive workflow-install step (`apra-fleet-7pm.5`) is mid-flight as uncommitted-to-done WIP commits with its issue still open; self-heal extraction in the launcher (`apra-fleet-7pm.8`, P1) is not started; `uninstall --skill workflows` (`apra-fleet-7pm.9`), the update-flow re-install path (`apra-fleet-7pm.10`), build-binary smoke tests for the workflow subcommand (`apra-fleet-7pm.13`), a regression guard for the existing command surface (`apra-fleet-7pm.14`), and an end-to-end test of auto-sprint running as a built-in workflow (`apra-fleet-7pm.15`) are all open. The deploy/integration phase could not run at all this sprint: `integ-test-playbook.md` is absent from the repo root and `deploy.md` lacks the required `## Deploy`/`## Smoke test` sections, so no smoke test exists to execute (tracked as `apra-fleet-nbp`). A binary developer-meeting slide deck (`docs/features/apra-fleet-workflows.pptx`/`.pdf`, ~470 KB) landed without an owning task and should be re-homed or removed.

Carried forward (all remain open, none closed this cycle): `apra-fleet-7pm` (epic) and children `.5`, `.8`, `.9`, `.10`, `.13`, `.14`, `.15`; `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3).

#### Sprint cost analysis
Budget ceiling: $50.0000.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: $50.0000.
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- chore/hub-service-retire-and-docs

Sprint goals: `apra-fleet-yp3` (P2, retire `src/hub-service/` to reference-only status) and `apra-fleet-qaz` (P3, record the final tier-ownership decision in the architecture docs), both children of epic `apra-fleet-yeb`. Both goals met. This sprint follows a product-owner directive that resolved a divergence from the prior hub-spoke migration sprint: `fleet-dashboard` is the sole tier-3 persistence layer for workspace/project/member/secret configuration, and `apra-fleet.exe` is either a SaaS-connected client of fleet-dashboard's contract or a standalone client backed by local JSON files -- never a competing relational database of its own. Accordingly, `src/hub-service/` (the Postgres-backed service built during the prior hub-spoke migration sprint) is retired to reference-only: no code or tests were deleted (all 2133 tests remain green, verified as a specification of wire-protocol/security-isolation semantics), but `src/hub-service/main.ts`, `docs/hub-service-deployment.md`, `Dockerfile.hub-service`, and `docker-compose.hub-service.yml` now carry explicit reference-only/dev-only banners so nobody ships it to fleet.apralabs.com. `docs/adr-hub-persistence.md` and `docs/hub-spoke-master-plan.md` are annotated as superseded on tier-3 ownership, with a correction that SSH is NOT deprecated (it remains a permanent execution transport) and that relay/NAT-traversal work is explicitly deferred (`apra-fleet-8rs`), not abandoned. The new `docs/api-contract-reconciliation.md` records the verbatim product-owner directive and a 22-item hub<->dashboard API gap analysis; a documentation-integrity self-correction during the sprint stripped a fabricated "confirmed by direct code inspection" claim about fleet-dashboard's private (unseen) code from that document, replacing it with an explicit sourcing note. A new durable `docs/adr-tier3-ownership.md` distills the decision for future readers without the full negotiation history.

Carried forward: none from this sprint's named goals (both closed). Deferred, non-blocking cleanup identified by review: normalize 14 non-ASCII em-dash characters in `docs/api-contract-reconciliation.md` to the project's ASCII-only convention.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     45,518 | +537% |   $0.121 |   $0.452 |
| TOTAL      |      7,150 |     45,518 | +537% |   $0.121 |   $0.452 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Review outcome

**Build**: clean (tsc, zero errors).
**Tests**: 2314 passed, 5 skipped, 0 failures across 157 test files.
**Working tree**: clean.

The branch accumulates a complete KB system (capture, query, harvest,
export, import, reconcile, staleness, trust model, directives), a
code-intelligence provider abstraction with two providers and auto-reindex,
telemetry, and extensive test coverage. The codebase builds cleanly and
all tests pass. No regressions detected. No security issues found (no
secrets in code, proper use of direct file execution over a shell,
temp-dir cleanup in tests).

**Non-blocking observations**:
- No test coverage for a round-trip of the `codeIntelProvider` field in
  register/update-member tests -- the field is optional so existing
  members degrade gracefully (confirmed by passing backward-compat
  tests), but an explicit round-trip test would be a good follow-up.
- The pre-init glob matcher handles common gitignore patterns but does
  not implement negation patterns; documented as a known limitation in
  [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

**Releasability**: the branch is in a releasable state. All code is
functional and tested. The incomplete init/update phases are future
features with no impact on existing functionality. The additive
scaffolding (pre-init module, `codeIntelProvider` field) is safe to
merge -- it adds no runtime behavior until wired by a future increment.

Carried forward: the init phase (first-time indexing with progress), the
update phase (staleness-triggered incremental re-indexing beyond the
existing auto-reindex coverage), and per-member provider routing through
`getProvider()` and tool dispatch.

## [Unreleased] -- Code intelligence: per-member provider field and KB pre-init scaffolding (sprint goal not met)

Sprint goal (P1/P2): audit all KB and code-intelligence tools on this branch,
and build out the KB initialization lifecycle (pre-init/init/update phases)
plus per-member code-intelligence provider selection. Both goals remain
open; this cycle landed two small, unblocking increments toward them and
ended before the larger routing and lifecycle work was built.

The `Agent` interface now carries an optional `codeIntelProvider` field, and
`register_member` / `update_member` accept a matching input so a member's
preferred code-intelligence provider can be set or changed. This is schema
and persistence only -- no dispatch path yet resolves a provider per member,
so the field currently has no observable effect; see
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

The KB pre-init phase also gained its first two building blocks: a
provider-availability check (never throws; degrades to a structured
not-available result) and a repo index-size estimator (gitignore-aware
file walk projecting file count, byte size, and indexing time). Both are
pure, unit-tested, and not yet wired into any init-phase caller -- they
exist ahead of the init/update phases that will consume them. See
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

Carried forward to a future sprint: the full KB tool audit, per-member
provider routing through `getProvider()` and tool dispatch, the init phase
(first-time indexing with progress and an opt-in prompt), and the update
phase (staleness detection and incremental re-indexing).
| doer       |          0 |     17,909 |   n/a |   $0.000 |   $0.269 |
| reviewer   |          0 |      4,513 |   n/a |   $0.000 |   $0.068 |
| overhead   |      7,150 |     28,697 | +301% |   $0.121 |   $0.365 |
| TOTAL      |      7,150 |     51,119 | +615% |   $0.121 |   $0.702 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Final review notes

Reviewed sprint work on chore/hub-service-retire-and-docs (5 commits atop feat/hub-spoke-migration: cae75fd..4b649af). Sprint goals apra-fleet-yp3 (P2) and apra-fleet-qaz (P3), both children of epic apra-fleet-yeb, are met. Build (tsc) clean; full suite 2133 passed / 18 skipped (docker/terminal-gated) / 0 failed. Git tree clean apart from the durable sprint-logs jsonl (not flagged, per workflow). No lint script configured in package.json.

apra-fleet-yp3 (retire src/hub-service to reference-only) -- acceptance criteria fully met:
- src/hub-service/main.ts: clear top-of-file STATUS: REFERENCE IMPLEMENTATION ONLY banner with pointer to api-contract-reconciliation.md 1.5 and hub-service-deployment.md.
- docs/hub-service-deployment.md: retitled "(Reference Implementation -- Not a Deployment Target)", one-paragraph status block at top; a new contributor understands reference-only status immediately (criterion satisfied).
- Dockerfile.hub-service and docker-compose.hub-service.yml: both prepended with "REFERENCE/DEV-ONLY -- NOT a production deployment target" and the stale production-deployment guidance was removed/reframed, so nobody ships it as fleet.apralabs.com.
- docs/adr-hub-persistence.md marked Superseded; docs/hub-spoke-master-plan.md annotated with the tier-3 ownership + SSH-stays/relay-deferred correction.
- No hub-service code or tests deleted (verified: only a 13-line comment added to main.ts; 2133 tests still green, matching the doc's cited count).

apra-fleet-qaz (record final tier-ownership decision) -- acceptance criteria met:
- docs/api-contract-reconciliation.md (new, 608 lines) sections 1.5/1.6 carry the verbatim product-owner directive and corrected per-item verdicts; adr and master-plan cross-link to it. A cold reader grasps reference-only status and bootstrap/sync-first scope without needing session history.
- Documentation-integrity self-correction (commit 4b649af): the doer caught and stripped a fabricated "fleet-dashboard implementer / confirmed by direct code inspection" persona from the reconciliation doc and added an explicit sourcing note distinguishing this repo's verified source from inferences about fleet-dashboard's private (unseen) code. Verified no residual "confirmed by code inspection"-style fabricated claims remain. This is a good catch.

File hygiene: all changed files justify against the epic. docs/bootstrap-sync-design-proposal.md and docs/cross-repo-design-protocol.md are legitimate deliverables of closed sibling task apra-fleet-48p (referenced by the qaz docs so links resolve). .gitignore additions (.agents/, .codex/) correctly exclude local tool scaffolding. No temp files or stray tool config slipped in.

Minor issue (non-blocking, recommend cleaning before merge): docs/api-contract-reconciliation.md contains 14 lines with non-ASCII em-dashes (U+2014 "--", e.g. lines 38, 42, 44-46, 48, 50, 52), which violates the project's checked-in ASCII-only convention in CLAUDE.md ("never write non-ASCII characters to any file; use `-` for dashes"). Line 38 is arguably a verbatim directive quote, but lines 42/44/45/46/48/50/52 are the author's own prose. No functional impact (docs only, build/tests unaffected), so not reopening the task -- but the em-dashes should be normalized to ASCII "--" in a follow-up or before raising the PR. No security issues, no regressions in adjacent code. Work is releasable/harvestable.

## [Unreleased] -- feat/hub-spoke-migration (hub-spoke cloud migration groundwork, sprint 2)

Sprint goal (P1/P2): apra-fleet-us9 (hub-spoke cloud migration epic) and apra-fleet-20o (shared hub<->dashboard API contract). Goal not fully met -- apra-fleet-20o (P1) and several other P1/P2 tasks closed this sprint, but apra-fleet-us9 is a multi-sprint epic and remains open by design; several of its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance, spoke mode, RBAC, SSH-to-relay migration) are carried forward to next sprint.

Completed this sprint: extracted `@apralabs/fleet-api-contract`, a versioned npm workspace package holding the Zod schemas (Workspace, Project, Member, JWTClaims, UsageRecord, ActivityEvent, Installer, AdminUser) and generated OpenAPI 3.1 spec shared between the future hub service and dashboard, with `JWTClaims` as the explicit auth anchor and a runtime contract test validating a real handler response against the schema; unified identity on the member UUID with `workspace_id` promoted to the hard security-boundary claim behind a pluggable `TokenIssuer` (local dev-mode issuer today, cloud-dashboard issuer later, no token migration needed), with `session-registry`, `send-message`, and `http-transport` scoped end-to-end so cross-workspace traffic is indistinguishable from "not connected"; implemented and live-verified `registerMcpEndpoint()` for the AGY and OpenCode providers (read-modify-write of each provider's own MCP config file, non-destructive to sibling entries); closed a stale-close session-unregister race in `http-transport.ts` and required the local admin key on `/shutdown`; de-hardcoded the port and gated interactive bootstrap behind an explicit flag in `register_member`; fixed suite-wide test pollution from shared fixed-path fixtures under concurrent test runs. Full vitest suite: 1816 passed / 14 skipped / 114 files.

Carried forward: apra-fleet-us9 epic and its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance + `apra-fleet join` enrollment, spoke mode in apra-fleet.exe, workspace iron-wall security review, dashboard OAuth/RBAC), plus apra-fleet-fnz.1/.4 (registerMcpEndpoint wiring into register_member's same-machine path, and the LAN enrollment-token join flow) and apra-fleet-2xs.1 (compose_permissions deep-merge fix).

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |      8,016 |   n/a |   $0.000 |   $0.120 |
| reviewer   |          0 |     10,424 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     80,655 | +1028% |   $0.121 |   $0.575 |
| TOTAL      |      7,150 |     99,095 | +1286% |   $0.121 |   $0.851 |
| doer       |          0 |     32,374 |   n/a |   $0.000 |   $0.486 |
| reviewer   |          0 |     10,421 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     74,090 | +936% |   $0.121 |   $0.677 |
| TOTAL      |      7,150 |    116,885 | +1535% |   $0.121 |   $1.320 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Review outcome

**Build**: passes (tsc clean).
**Tests**: 2314 passed, 5 skipped, 0 failures across 157 test files.
**Working tree**: clean (only sprint log modified, expected).

**Sprint goal assessment**: Both sprint-goal issues remain open. The sprint
produced three functional commits: the `codeIntelProvider` field on the
`Agent` interface wired into register/update schemas and handlers; a new
pre-init module with provider-availability detection and index-size
estimation; and unit tests for that module.

**Observations (non-blocking)**:
- The pre-init module is not imported by any other module in `src/` --
  it is forward-looking scaffolding for the init phase, which was not
  built this sprint. This is dead code today but has test coverage and
  will be consumed once the init phase is implemented.
- `codeIntelProvider` is stored during register/update but never read by
  any downstream logic (no routing or provisioning consumes it yet).
- Neither observation is a regression or quality concern; both are
  incomplete increments from a sprint that ended early.

**Code quality**: The new code follows existing patterns (zod schemas,
never-throw error handling, vitest mocks with hoisted references). No
security issues (uses a direct file-execution call rather than a shell,
proper temp-dir cleanup in tests, no secrets). ASCII-only. Consistent with
project conventions.

**Overall branch state**: The accumulated work across all prior sprint
cycles builds cleanly and passes all tests. No regressions detected. The
branch is in a releasable state for what was completed. Both sprint-goal
issues remain open for future completion.

## [Unreleased] -- Code intelligence provider abstraction: codebase-memory-mcp shipped as default

Sprint goal (P1/P2): finish the CodeIntelligenceProvider abstraction begun in
the prior sprint pass. Following the earlier evaluation, this sprint
re-evaluated the field of candidates and selected codebase-memory-mcp (MIT,
native MCP transport, 158-language tree-sitter coverage, single static
binary) over Joern (Apache 2.0, deeper CPG-based data-flow analysis but JVM +
Scala dependency and no native MCP support). `CodebaseMemoryProvider` now
implements all seven `CodeIntelligenceProvider` methods against the
codebase-memory-mcp MCP server, following the same client-lifecycle pattern
as `GitNexusProvider` (shared singleton client, stdio transport, connection
reset on death/failure, a pre-flight index check, and structured
offline/missing-index error results). It is registered in the `PROVIDERS`
map and is now the default provider; GitNexus remains selectable by name, and
the Joern provider file is retained with a deprecation notice recording the
evaluation rationale.

#### Sprint cost analysis
Calibration: historical (5 sprints)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     14,100 |     72,947 | +417% |   $0.185 |   $0.905 |
| reviewer   |      5,859 |     23,306 | +298% |   $0.088 |   $0.350 |
| overhead   |      7,150 |    116,540 | +1530% |   $0.121 |   $1.140 |
| TOTAL      |     27,109 |    212,793 | +685% |   $0.393 |   $2.394 |
True-cost estimate (output x 4x): $1.573

Outliers (>200% variance): doer, reviewer, overhead
Calibration failures (>500%): overhead

### Review outcome

All three sprint tasks meet their acceptance criteria. Build is clean (tsc
passes), and the full test suite passes with zero failures.

**Evaluation and decision.** The comparison covers all five dimensions (ease
of integration, dependency weight, language breadth, analysis depth, and MCP
tool coverage), with the decision and rationale documented directly in the
Joern provider file's header and in
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).
The decision is verified by dedicated unit tests asserting the header covers
every comparison dimension.

**Provider implementation.** `CodebaseMemoryProvider` implements all seven
methods, follows the GitNexus MCP client lifecycle pattern exactly (shared
singleton, stdio transport, identity-guarded death handler, failure-reset),
and returns structured offline/missing-index results instead of throwing.
Unit tests cover all methods, three connection-resilience scenarios, and the
pre-flight index check.

**Registration as default.** `CodebaseMemoryProvider` is registered in the
`PROVIDERS` map and is now the default returned by `getProvider()`; GitNexus
remains selectable by explicit configuration. The Joern file carries a clear
deprecation notice. Default-fallback and explicit-selection tests were
updated accordingly.

**File hygiene note (non-blocking).** One commit in this sprint bundled a
handful of unrelated tool-config files (Beads task-tracker configuration)
alongside the sprint work. These appear to be legitimate project setup but
are unrelated to the code intelligence tasks and would have been cleaner as
a separate commit.

### Carried forward

None -- all sprint tasks met their acceptance criteria.

## [Unreleased] -- Code intelligence provider abstraction: review closeout

Sprint goal (P1/P2): add a permissively-licensed CodeIntelligenceProvider and
set it as the default, replacing GitNexus. This entry records the outcome of
a formal review pass against the original acceptance criteria for the four
planned tasks: research and select a candidate, implement the provider,
register it as the default, and add unit tests.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     35,996 | +403% |   $0.121 |   $0.354 |
| TOTAL      |      7,150 |     35,996 | +403% |   $0.121 |   $0.354 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Overall assessment

The branch builds cleanly and the full test suite passes with no failures.
The codebase is in a releasable state.

**Research and candidate selection -- fully met.** Three candidates (Joern,
SCIP, tree-sitter) were evaluated against six criteria (license, native
call-graph/relationship analysis, semantic or structured search, active
maintenance, subprocess usability, and TypeScript/Python coverage). Joern was
selected, with the rationale documented in the provider file's header comment
and in [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

**Provider implementation -- not met.** The acceptance criteria called for all
seven `CodeIntelligenceProvider` methods to be implemented following the
GitNexusProvider pattern (spawned child-process backend, structured error
results, a pre-flight index check, output sanitization). What shipped is
seven stub methods that each throw a "not implemented" error -- no subprocess
spawning, no structured errors, no pre-flight check. This is a skeleton, not
a working implementation.

**Registration as default -- not met.** The acceptance criteria required the
new provider to be imported and instantiated in the provider registry, with
the provider-selection function defaulting to it. The registry still contains
only the GitNexus provider, and the default selection is unchanged.

**Unit tests -- not met.** The acceptance criteria called for happy-path tests
of all seven methods, error/offline tests, a pre-flight test, and an updated
default-provider test. The tests that shipped only regex-match strings inside
the provider source file's comments (e.g. checking that a license string
appears in the file); the provider class itself is never instantiated or
called in the test suite. There are no behavioral tests.

### Why this was judged releasable despite the gaps

The new provider code is entirely inert: it is not imported anywhere outside
its own test file, not registered in the provider registry, and not
reachable from any tool handler. It introduces zero behavioral change and
zero regression risk to the existing GitNexus-backed code intelligence
tools. The documentation honestly records this status rather than presenting
the work as complete.

All files touched in this pass are scoped and justified: the new provider
source file and its test file, the code-intelligence-providers documentation
page, and the standard README/CHANGELOG updates. No temporary files,
secrets, unrelated configuration, or security issues were introduced.

### Carried forward

Implementing the seven provider methods against a live Code Property Graph,
registering the provider in the registry (and deciding whether it becomes
the new default or an opt-in alternative alongside GitNexus), and writing
real behavioral tests remain open work for a future sprint. The research and
method-to-query-language mapping already documented provide a concrete
implementation roadmap for that follow-up.

## [Unreleased] -- Code intelligence provider abstraction

Sprint goal (P1/P2): add a permissively-licensed code-indexing provider as an
alternative to GitNexus, implementing the full `CodeIntelligenceProvider`
interface (graph, impact, query, context, map, flow, tests) and registering
it as the default.

What shipped: a documented evaluation of Apache 2.0 / MIT candidates (Joern,
SCIP, tree-sitter) against six selection criteria (license, native
code-graph/relationship analysis, semantic or structured search, active
maintenance, subprocess usability, and TypeScript/Python coverage). Joern was
selected first for its Code Property Graph support, then superseded by
codebase-memory-mcp, which carries broader language coverage, native MCP
transport, and a far lighter deployment footprint (a single binary rather than
a JVM plus a Scala REPL). `CodebaseMemoryProvider` implements all seven
provider methods and is registered as the default; the interim Joern skeleton
was never registered in `PROVIDERS` and is not part of this release. See
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md) for
the full evaluation and current status.

Review outcome: the codebase builds cleanly and the full test suite passes.
The branch was judged releasable on the basis that the new provider code is
fully inert and every other changed file is scoped and justified -- the
incomplete provider implementation is intentionally deferred rather than
half-shipped into the active code path.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     36,179 | +406% |   $0.121 |   $0.365 |
| TOTAL      |      7,150 |     36,179 | +406% |   $0.121 |   $0.365 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none
### Final review notes

Scope reviewed: origin/main..feat/hub-spoke-migration (21 commits, 107 files). Named sprint goals: apra-fleet-20o (P1, closed) and epic apra-fleet-us9 (parent, expectedly still open).

VERIFICATION
- Build: `npm run build` and `npm run build:contract` both exit 0.
- OpenAPI: `npm run gen:openapi` regenerates packages/fleet-api-contract/openapi.json byte-identical to the committed copy (no dual-maintenance drift).
- Tests: `npm test` = 1816 passed / 14 skipped / 114 files. No lint script is configured in this repo (n/a).

ACCEPTANCE CRITERIA (apra-fleet-20o) - all met:
- Zod schemas for Workspace/Project/Member/JWTClaims/UsageRecord/ActivityEvent/Installer/AdminUser (packages/fleet-api-contract/src/schemas/*).
- JWTClaimsSchema is the explicit anchor; every auth-gated route in src/endpoints.ts carries `auth: JWTClaimsSchema`, never redefined. Member.provider enum includes 'none' per us9.14.
- OpenAPI 3.1 generated from the same schemas via src/scripts/gen-openapi.ts.
- Versioned public workspace package (@apralabs/fleet-api-contract@0.1.0, workspaces:[packages/*], README consumption path documented).
- Runtime contract test present (tests/hub-service/installers.contract.test.ts) validating getInstallersHandler() output against InstallerSchema.
Other closed P1/P2 tasks (workspace_id/UUID identity, /shutdown auth, provider MCP registration, port de-hardcode, bootstrap gating, test-pollution and stale-close race fixes) all ship with tests that pass.

MINOR (optional, not blocking):
- tests/hub-service/installers.contract.test.ts second case is named "rejects a response with an extra/unexpected field (drift guard)" but InstallerSchema is non-strict, so it does not actually reject -- it only asserts the unknown key is dropped. For a true drift guard, use `.strict()` on the schema (or `InstallerSchema.strict().parse(...)`) so an unexpected wire field fails loudly.

Committed work is buildable, fully tested, and matches the acceptance criteria for what was completed; ready to harvest as a PR once the untracked root artifacts (recovery-backup tarball, local .agents/.codex tool config dirs) are removed from the working tree -- done as part of this harvest.

## [v0.3.3] -- feat/install-default

### Breaking change -- MCP server start command changed

> **Action required for users who manually manage their MCP config.**
>
> The binary no longer starts the MCP server when invoked with no arguments.
> The new default action is **installation**. The MCP server is now started
> with the explicit `apra-fleet run` subcommand.
>
> **Who is affected:** only users who edited their MCP config by hand and
> registered the binary with no arguments (e.g. `command: apra-fleet`,
> `args: []`). Users who installed via `apra-fleet install` or
> `apra-fleet update` are updated automatically -- the installer re-registers
> the MCP server with the correct `run` argument.
>
> **How to fix (manual config only):** change `args: []` to `args: ["run"]`
> in your provider's MCP config, then reload the MCP server.
>
> `--stdio` is kept as a backward-compat alias and still starts the server,
> so `args: ["--stdio"]` also works without any code change.

### Added

- **Install as default action** -- invoking the standalone binary with no
  arguments (including double-clicking `apra-fleet-installer-win-x64.exe` on
  Windows) now runs the installer instead of silently starting an MCP stdio
  server. This is the expected behavior for users who download the binary from
  the GitHub Releases page.

- **`apra-fleet run` / `apra-fleet start`** -- new subcommands that
  explicitly start the MCP server (stdio mode). All provider MCP configs
  written by the installer are updated to use `run` as the last argument.
  `--stdio` continues to work as a backward-compat alias.

### Changed

- **MCP config updated for all providers** -- the MCP server command
  registered during `apra-fleet install` now includes `run` as an explicit
  argument for every provider (claude, gemini, agy, codex, copilot, opencode --
  gemini was a supported provider at the time of this release and has since
  been removed).
  Example SEA mode: `{ "command": "/path/apra-fleet", "args": ["run"] }`.

- **Claude `mcp add` command handles all args** -- the `claude mcp add`
  command builder now quotes and joins all args (not just `args[0]`), which
  is required for npm/dev mode where both a script path and `run` must be
  passed.

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 2-5, sprint 2)

Sprint goal (P1/P2): complete tag-aware permission composition (Phase 2), skill matrix utility (Phase 3), permissions.md update (Phase 4), and tag filter in list_members (Phase 5). Phases 2-5 were implemented and tested; the full vitest suite passes (1593 tests, 0 failures). Integration tests (apra-fleet-2tl) are carried forward. Goal partially met -- all implementation tasks done, integration tests not started.

Completed: Phase 2 tag-aware permission composition with composeFromTags() and backward-compatible behavior; Phase 3 skill-matrix utility (getRequiredSkills) encoding the skill-matrix.md rules programmatically; Phase 4 permissions.md rewritten for tag-based composition; Phase 5 list_members tags filter with AND semantics. Example tag profiles (tag-gpu.json, tag-devops.json) added.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     20,661 |   n/a |   $0.000 |   $0.252 |
| reviewer   |          0 |      8,338 |   n/a |   $0.000 |   $0.125 |
| overhead   |      7,150 |     70,662 | +888% |   $0.121 |   $0.574 |
| TOTAL      |      7,150 |     99,661 | +1294% |   $0.121 |   $0.952 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **Tag-aware permission composition** -- `compose_permissions` now accepts a `tags` parameter. Reserved tags `doer`/`reviewer` set the primary mode; custom tags (e.g. `gpu`, `devops`) each load a `tag-<name>.json` profile and merge permissions additively. Unknown tags are silently ignored. When both `role` and `tags` are given, `tags` wins. The `composeFromTags()` function is byte-identical to the role-based `compose()` for single-mode tags -- full backward compatibility.

- **Example tag profiles** -- `tag-gpu.json` and `tag-devops.json` shipped under `skills/fleet/profiles/`. These are the reference profiles for GPU and DevOps tag merges.

- **Skill matrix utility** -- `src/utils/skill-matrix.ts` exports `getRequiredSkills(tags, vcs, project?)`, the programmatic encoding of `skills/fleet/skill-matrix.md`. Returns deduplicated, sorted skill names. Currently used in tests; not yet wired into the installer onboarding path.

- **list_members tags filter** -- `list_members` now accepts a `tags` string array. AND semantics: only members carrying all supplied tags are returned. Existing behavior (no filter = all members) is unchanged.

### Changed

- **skill-matrix.md** -- Role column renamed to Tag; semantics updated to clarify that tag values are the exact strings stored in `Agent.tags` and drive both skill selection and permission profile merging.

- **permissions.md** -- Rewritten to document tag-based composition: reserved doer/reviewer tags, custom tag profiles, additive merge, primary-mode extraction, and the four-step profile composition order.

### Carried forward

- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-4xe: Parent tracker for Phase 5 (close after 2tl lands) (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)

---

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 0-1)

Sprint goal: implement member category grouping (Phase 0, apra-fleet-j23) and the member tags data model, display, and validation layer (Phase 1, apra-fleet-9iw). Both phases were completed and the test suite passes (1560 tests, 95 files). Phases 2-5 and integration tests (04a, 51i, 6ky, 4xe, 2tl) were not started in this sprint and are carried forward.

Scope: Phase 0 merges PR #238 (category field + groupByCategory). Phase 1 adds tags?: string[] to the Agent model with Zod validation (max 10 tags / 64 chars each), displays tags in check_status and list_members compact and JSON output, and covers all boundaries in tests/tags.test.ts, tests/update-member.test.ts, and tests/category.test.ts.

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     22,200 |          0 | -100% |   $0.348 |   $0.000 |
| reviewer   |      9,360 |          0 | -100% |   $0.158 |   $0.000 |
| overhead   |      7,150 |     37,428 | +423% |   $0.121 |   $0.365 |
| TOTAL      |     38,710 |     37,428 |   -3% |   $0.627 |   $0.365 |
True-cost estimate (output x 4x): $2.507

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Added

- **Member category field** -- `register_member` and `update_member` now accept an optional `category` string. Members with the same category are grouped together in `check_status` and `list_members` output. Categories are sorted alphabetically; members with no category appear under `(uncategorized)` at the end. Empty string clears the category.

- **Member tags field** -- `register_member` and `update_member` now accept an optional `tags` array (up to 10 strings, max 64 chars each). Tags are displayed in compact and JSON output for `check_status` and `list_members`. Passing an empty array in `update_member` clears all tags.

- **groupByCategory utility** -- `src/utils/agent-helpers.ts` exports `groupByCategory<T>()`, a generic helper that buckets any item list by a string key, returning a sorted-key array with `(uncategorized)` always last. Used by check_status and list_members; reusable for other item types.

### Carried forward

- apra-fleet-04a: Phase 2 -- tag-aware permission composition (P1)
- apra-fleet-9iw: Phase 1 parent tracker -- open until all sub-tasks land (P1)
- apra-fleet-51i: Phase 3 -- tag-aware skill matrix (P2)
- apra-fleet-6ky: Phase 4 (apra-fleet) -- update permissions.md for tag composition (P2)
- apra-fleet-4xe: Phase 5 -- tag-based member selection in list_members (P2)
- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased] -- feat/auto-sprint (auto-sprint pipeline)

Sprint goal: implement the full auto-sprint.js install pipeline -- submodule pin
(zbl), AssetManifest.workflows field (vqe), cost.js extraction and workflow copy
step (b8c), claude-only Skill/Workflow permissions (ano), and extended tests for
all eight agents / cost.js / workflow paths (96j). All five goals were delivered
in two cycles; build is clean and the full test suite (92 files, 1531 tests)
passes with zero failures.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     45,503 |   n/a |   $0.000 |   $0.682 |
| reviewer   |          0 |     19,192 |   n/a |   $0.000 |   $0.288 |
| overhead   |      7,150 |     53,729 | +651% |   $0.121 |   $0.473 |
| TOTAL      |      7,150 |    118,424 | +1556% |   $0.121 |   $1.444 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **auto-sprint workflow install** -- `apra-fleet install --skill pm` now writes
  `cost.js` to the PM skill directory for every provider that supports PM.
  `cost.js` is a CJS-wrapped extract of the seven pure cost-computation functions
  (`computeSprintQuote`, `computeSprintAnalysis`, `buildSprintSummary`, etc.) from
  `vendor/apra-pm/.claude/workflows/auto-sprint.js`. For Claude specifically, the
  full `auto-sprint.js` workflow is also copied to `~/.claude/workflows/`.

- **Claude permissions for auto-sprint** -- for Claude + PM installs, the
  installer now adds `Skill(auto-sprint)` and `Workflow(auto-sprint)` to the
  Claude Code allow-list via `mergePermissions`. Other providers receive no change;
  OpenCode skips `mergePermissions` entirely (its permission model is per-agent
  frontmatter, not a top-level config key).

- **AssetManifest.workflows field** -- `AssetManifest` now has a `workflows`
  field. `buildDevManifest` populates it from `vendor/apra-pm/.claude/workflows/`
  (falling back to `dist/workflows/`). `gen-sea-config.mjs` embeds
  `auto-sprint.js` as a named SEA asset. `vendor-pm.mjs` copies the workflows
  directory to `dist/workflows/` on `prepublishOnly` so npm global installs work
  without the submodule.

- **apra-pm submodule pinned to 262aef8** -- `vendor/apra-pm` is now pinned at
  commit 262aef8 (previously d141720), which carries the `auto-sprint.js`
  workflow with PURE_FUNCTIONS_BEGIN/END markers.

- **/auto-sprint completion output** -- claude+PM installs now print a
  `/auto-sprint` usage hint at the end of the install sequence.

### Carried forward

- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased]

### Added

- **OpenCode provider** -- OpenCode is now a first-class provider
  (`apra-fleet install --llm opencode`). It works with any OpenAI-compatible
  endpoint (Ollama, vLLM, etc.) for self-hosted and local models. The model
  endpoint is the user's responsibility; Fleet installs the CLI and agents but
  does not provision the inference server. See
  [docs/opencode-exploration.md](docs/opencode-exploration.md) for background.

- **Per-member model tiers** -- `register_member` now accepts an optional
  `model_tiers` map (`{ cheap, standard, premium }`) so each member can specify
  which models to use at each tier. Particularly useful for OpenCode members
  where models vary by deployment. A single-model entry fills all three tiers.
  When no map is set, the provider adapter's defaults are used.

- **PM agent installation** -- the installer now writes 4 PM agent definitions
  (planner, plan-reviewer, doer, reviewer) to each provider's agents directory
  (e.g. `~/.claude/agents/`, `~/.config/opencode/agents/`). For OpenCode,
  agent frontmatter is transformed from Claude format to OpenCode format
  (tools allowlist -> permission map, mode: subagent). Codex and Copilot skip
  agent installation (no agent system).

### Changed

- **PM skill sourced from apra-pm submodule** -- the PM skill is now vendored
  from the [apra-pm](https://github.com/Apra-Labs/apra-pm) git submodule at
  `vendor/apra-pm/` instead of being maintained inline. All gap-ported features
  from the old inline skill (sprint selection, operational rules, provider
  awareness, fleet addendum, simple sprint, resume rules, documentation harvest)
  are included. The skill is backward compatible -- all `/pm` commands, state
  file names (PLAN.md, progress.json, feedback.md, status.md), and beads
  lifecycle hooks are preserved.
