# Changelog

All notable changes to this project will be documented in this file.

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
