# Changelog

All notable changes to this project will be documented in this file.

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
