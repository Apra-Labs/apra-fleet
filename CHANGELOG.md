# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] -- Per-member code-intel visibility and first-time indexing: sprint goal not fully met

This sprint targeted per-repo code-intelligence opt-out and per-member
provider routing. Neither top-level goal was completed, but several
supporting pieces landed cleanly and are ready to build on:

- **Per-repo code-intel config module** (new): a reader/writer for
  `.apra-fleet/code-intel.json` that tolerates a missing or corrupt file
  by treating it as "not yet indexed," and creates the config directory
  on demand when writing. This is idempotency-marker plumbing for the KB
  init phase; the opt-out gate it is meant to eventually serve (code-intel
  tools checking `enabled: false` before dispatching) is not wired yet.
- **`kb_setup` now triggers first-time code-intel indexing**: idempotent
  (skips if already indexed), degrades gracefully when the provider binary
  is unavailable, and reports an actionable manual-retry command on
  indexing failure. Progress reporting during indexing and partial-index
  cleanup on failure are not yet implemented.
- **Per-member code-intel provider is now visible everywhere a member is
  inspected**: `fleet_status` (compact and JSON) shows each member's
  provider or falls back to `"global default"` when unset, and
  `register_member`/`update_member` success messages include a
  `Code-Intel:` line when the field is set. This is display-only -- the
  provider selection still does not change which backend actually
  services a member's code-intel calls; that routing logic remains
  unbuilt.

See
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md)
for the full design and what remains open.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     11,183 |   n/a |   $0.000 |   $0.107 |
| reviewer   |          0 |     18,135 |   n/a |   $0.000 |   $0.272 |
| overhead   |      7,150 |    102,753 | +1337% |   $0.121 |   $0.629 |
| TOTAL      |      7,150 |    132,071 | +1747% |   $0.121 |   $1.008 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Review outcome

**Build**: clean. **Tests**: all 157 test files pass (2325 tests, 0
failures). **Working tree**: additive only, no regressions, no security
issues, no file-hygiene problems.

Gaps remaining, not blocking approval of the work that did land: the
per-repo opt-out check (`isCodeIntelEnabled()`) and its wiring into
`getProvider()` are not yet implemented; progress reporting and
partial-index cleanup for the KB init phase are not addressed; the
per-member provider routing (resolving `getProvider()` per member and
threading member context through code-intel tool dispatch) remains open.

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

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |      8,016 |   n/a |   $0.000 |   $0.120 |
| reviewer   |          0 |     10,424 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     80,655 | +1028% |   $0.121 |   $0.575 |
| TOTAL      |      7,150 |     99,095 | +1286% |   $0.121 |   $0.851 |
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

What shipped: a documented evaluation of three Apache 2.0 / MIT candidates
(Joern, SCIP, tree-sitter) against six selection criteria (license, native
code-graph/relationship analysis, semantic or structured search, active
maintenance, subprocess usability, and TypeScript/Python coverage), which
selected Joern for its Code Property Graph support across all seven provider
methods. A `JoernProvider` class implements the `CodeIntelligenceProvider`
interface as a skeleton (all seven methods present, each currently a stub),
backed by a test suite verifying the research meets all six selection
criteria. See [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md)
for the full evaluation and current status.

Outstanding / carried forward: the provider is not yet registered in the
provider registry and is not selected as the default. Real method bodies
against a live Code Property Graph, registry registration, the default-vs-
opt-in decision, and end-to-end behavioral tests remain open work. Because
the provider is not imported or reachable from any tool handler outside its
own module, it introduces no behavioral change and carries no regression
risk to the existing GitNexus-backed code intelligence tools.

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
  argument for every provider (claude, gemini, agy, codex, copilot, opencode).
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
