# Requirements: OpenCode Provider + PM Submodule + Agent Install Epic

## Problem Statement

apra-fleet currently supports five LLM providers (claude, gemini, codex, copilot, agy) but lacks
support for OpenCode -- the only viable CLI agentic coder for self-hosted / OpenAI-compatible
endpoints (Ollama, vLLM, custom cloud). Codex CLI is broken for local models (Responses API
incompatibility, agentic loop failures). OpenCode fills this gap.

Separately, the PM skill in apra-fleet (`skills/pm/`) is tightly coupled to the `fleet` skill
(it cannot run standalone) and duplicates orchestration logic that has been independently refined
in the apra-pm-lite repo (`Apra-Labs/apra-pm-lite`). pm-lite works WITHOUT fleet, runs as local
Claude Code subagents, and has a mature e2e test harness. The two skill sets need to be unified.

Finally, PR #289 introduced an agent-install mechanism (writing `agents/*.md` to provider-specific
dirs during `apra-fleet install`) but is not yet merged. The canonical agent definitions now live
in apra-pm-lite and must be the single source of truth, installed from the submodule.

## Goals

1. **OpenCode as a first-class provider** -- register, execute prompts, parse responses, install
   CLI, compose permissions, classify errors, support resume -- fully on par with codex.ts.
2. **Unified PM skill** -- replace apra-fleet's old `skills/pm/` with apra-pm-lite's pm-lite
   skill via a git submodule, preserving any old-pm features missing in pm-lite.
3. **Agent installation at install time** -- `apra-fleet install` writes the 4 agent files
   (planner, doer, reviewer, plan-reviewer) from the submodule to each provider's agents dir.
4. **Format-flawless runtime** -- the pm skill + agents run correctly both standalone (Claude
   Code local subagents) AND dispatched to fleet members across all providers.
5. **No user disruption** -- existing users upgrading see no breakage, no new manual steps.
6. **Comprehensive e2e coverage** -- new test scenarios for OpenCode + local-endpoint sprints.

## Non-Goals

- Provisioning model endpoints (Ollama URLs, API keys) -- left to the user.
- Supporting OpenCode's TUI mode -- fleet uses headless `opencode run` only.
- Multi-project orchestration in pm-lite (single project per orchestrator, per pm-lite design).
- Merging PR #289 as-is -- we take its APPROACH (agentsDir) but source agents from the submodule.

---

## Part 1: Installer Installs the 4 Agents

### Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| P1.1 | Add `agentsDir` (string or undefined) to `ProviderInstallConfig` | Must |
| P1.2 | Map agentsDir per provider: claude -> `~/.claude/agents`, gemini -> `~/.gemini/agents`, agy -> `~/.gemini/antigravity-cli/agents`, opencode -> `~/.config/opencode/agents`, codex/copilot -> undefined (skip) | Must |
| P1.3 | During `apra-fleet install`, write 4 agent `.md` files from the apra-pm submodule's `agents/` dir to `agentsDir` | Must |
| P1.4 | Agent files are embedded in the SEA binary (gen-sea-config.mjs manifest) so npm-global installs work | Must |
| P1.5 | Skip agent step silently for providers with `agentsDir === undefined` | Must |
| P1.6 | Step count in install output adjusts correctly for agents step | Should |
| P1.7 | For OpenCode, convert Claude-format agent frontmatter to OpenCode format at install time (name -> filename, tools -> permission map, add mode: subagent) | Must |

### Acceptance Criteria

- `apra-fleet install --llm claude` writes 4 files to `~/.claude/agents/`
- `apra-fleet install --llm opencode` writes 4 files to `~/.config/opencode/agents/` with OpenCode-format frontmatter
- `apra-fleet install --llm codex` does NOT create an agents dir or write agent files
- Agent files match the canonical source in the apra-pm submodule (modulo format transform)
- Existing install tests pass; new tests cover agent installation per provider

---

## Part 2: Replace PM Skill with apra-pm Submodule

### Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| P2.1 | Rename `Apra-Labs/apra-pm-lite` repo to `Apra-Labs/apra-pm` via `gh repo rename` | Must |
| P2.2 | Rewrite ALL internal references in apra-pm repo: `apra-pm-lite` -> `apra-pm`, `pm-lite` -> `pm` (skill dir, skill name, commit prefixes, docs) | Must |
| P2.3 | Add apra-pm as a git submodule at `vendor/apra-pm` (or similar) in apra-fleet | Must |
| P2.4 | At build/publish time, copy submodule's `skills/pm/` and `agents/` into the npm package so `npm i -g` users get pm files without `--recursive` | Must |
| P2.5 | Update `apra-fleet install` to source skill files from the vendored submodule path | Must |
| P2.6 | Remove old `skills/pm/` directory from apra-fleet | Must |
| P2.7 | Remove the fleet-skill dependency from the pm SKILL.md (pm-lite already has no fleet dep) | Must |
| P2.8 | **Gap analysis:** every concept/feature in old pm that is MISSING in pm-lite must be enumerated. Each gap gets a decision: port (into the new pm) or drop (with justification) | Must |
| P2.9 | Ported features integrated into the pm skill files in the apra-pm repo | Must |
| P2.10 | `.gitmodules` entry for the submodule | Must |

### User Decisions (Fixed)

- Submodule path: `vendor/apra-pm` (or `deps/apra-pm`)
- Skill dir after rename: `skills/pm/` (inside apra-pm repo)
- Internal name: `pm` (not `pm-lite`)
- Old pm files: delete entirely
- Fleet-dep: removed (pm works standalone)

### Gap Analysis Requirements

The gap analysis (design.md) must systematically compare:
- Old pm `SKILL.md` vs new pm-lite `SKILL.md`
- Old `context-file.md` vs new (if equivalent exists)
- Old `doer-reviewer.md` vs new `doer-reviewer-loop.md`
- Old `single-pair-sprint.md` vs new `sprint.md`
- Old `simple-sprint.md`, `multi-pair-sprint.md` vs new equivalents
- Old `cleanup.md`, `init.md`, `plan-prompt.md`, `beads.md` vs new equivalents
- All old templates (`tpl-*.md`, `tpl-progress.json`) vs new equivalents
- Old `backlog-item.md` vs new equivalent

For each gap: feature name, which repo has it, decision (port/drop), justification.

### No-Disruption Requirements

| ID | Requirement |
|----|-------------|
| ND.1 | `apra-fleet install` produces the same functional outcome (skills + agents deployed) |
| ND.2 | Existing `/pm` commands continue to work (init, pair, plan, start, status, resume, deploy, recover, cleanup, backlog, tasks) |
| ND.3 | Existing sprint state files (status.md, progress.json, planned.json, PLAN.md, feedback.md) remain compatible |
| ND.4 | Beads lifecycle hooks remain the same |
| ND.5 | Agent context file mechanism preserved (provider-specific filenames) |
| ND.6 | No new manual setup steps for existing users -- `apra-fleet install` handles everything |

---

## Part 3: OpenCode Provider Adapter

### Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| P3.1 | Create `src/providers/opencode.ts` implementing full `ProviderAdapter` interface | Must |
| P3.2 | Register in `src/providers/index.ts` providers map | Must |
| P3.3 | Add `'opencode'` to `LlmProvider` type union in `src/types.ts` | Must |
| P3.4 | Add opencode case to `getProviderInstallConfig()` in `src/cli/config.ts` | Must |
| P3.5 | `update-llm-cli` tool supports installing OpenCode CLI (`npm install -g opencode-ai` or curl) | Must |
| P3.6 | Headless invocation: `opencode run -m <provider/model> --dangerously-skip-permissions --format json [--agent <name>] "<prompt>"` | Must |
| P3.7 | Parse `--format json` NDJSON output in `parseResponse()` | Must |
| P3.8 | Session resume via `--continue` / `--session <id>` flags | Must |
| P3.9 | Permission composition: agent frontmatter `permission:` map (edit/write/bash = allow/deny/ask) | Must |
| P3.10 | Model tiers are USER-CONFIGURABLE PER MEMBER via a tier->model map supplied at `register_member` time (e.g. `model_tiers: { cheap: "ollama/qwen3-coder:30b", standard: "ollama/qwen3-coder-next", premium: "ollama/GLM-4.5-Air:Q4_K_M" }`). Adapter defaults are placeholders only. | Must |
| P3.10a | `register_member` for an opencode member accepts an optional `model_tiers` param: a map of `{cheap, standard, premium}` to concrete model IDs. Stored on the member record. At least one model must be supplied (no zero-model registration). | Must |
| P3.10b | Tier resolution happens AT DISPATCH TIME in the execute_prompt / dispatch layer: when the planner assigns a task tier, the dispatcher reads the member's `model_tiers` map and passes the concrete model ID to the ProviderAdapter. The adapter's static `modelTiers()`/`modelForTier()` serve only as fallback defaults. | Must |
| P3.10c | Fallback: if a member supplies only one model, it is used for all three tiers. If `model_tiers` is absent on the member record, the adapter's static defaults apply. Ties to issue #299 (MODEL_EP_URL). | Should |
| P3.11 | Error classification for common OpenCode errors | Must |
| P3.12 | `instructionFileName` for OpenCode (project-level config file) | Must |
| P3.13 | Windows `wrapWindowsPrompt()` support | Must |
| P3.14 | No endpoint provisioning -- assume user has configured opencode.json with provider/baseURL | Must |
| P3.15 | PM skill works FLAWLESSLY in BOTH modes: (a) local subagents in a single conversation (no fleet), and (b) dispatched to fleet members via execute_prompt. Dual-mode correctness is an explicit acceptance criterion. | Must |

### Provider Adapter Mapping (from opencode-exploration.md)

| Adapter Member | OpenCode Value |
|----------------|----------------|
| name | `'opencode'` |
| processName | `'opencode'` |
| authEnvVar | `''` (local endpoints need no key; user configures per-endpoint) |
| credentialPath | `'~/.config/opencode/'` |
| instructionFileName | `'OPENCODE.md'` -- **UNVERIFIED**: must confirm OpenCode's real project-instruction filename (likely AGENTS.md) before relying on this. See plan.md T3.1 verify-step. |
| cliCommand(args) | `opencode ${args}` |
| versionCommand() | `opencode --version 2>&1` |
| installCommand(os) | `npm install -g opencode-ai` (all OS) or curl for linux |
| updateCommand() | `npm update -g opencode-ai` |
| headlessInvocation(prompt) | `run "${prompt}"` |
| jsonOutputFlag() | `--format json` |
| skipPermissionsFlag() | `--dangerously-skip-permissions` |
| permissionModeAutoFlag() | null (no auto mode -- only full bypass or ask) |
| modelFlag(model) | `-m "${model}"` |
| supportsResume() | true |
| resumeFlag(sessionId) | `--session "${sessionId}"` or `--continue` |
| supportsMaxTurns() | false |
| modelTiers() | Static defaults only (fallback when member has no `model_tiers`): `{ cheap: 'ollama/qwen3-coder:30b', standard: 'ollama/qwen3-coder:30b', premium: 'ollama/qwen3-coder:30b' }`. Actual tier resolution is per-member at dispatch time -- see P3.10-P3.10c. |

### Constraints

- Model ID format: `<provider>/<model>` (e.g. `ollama/qwen3-coder:30b`) -- adapter must compose this
- No HF token needed for Ollama-registry models
- Fleet does NOT provision endpoints -- user configures opencode.json
- OpenCode's `--format json` emits raw JSON events -- parseResponse must handle this format

---

## Cross-Cutting: Agent/Skill Format Variants

### Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| CC.1 | Canonical agent source is Claude-format `.md` in `agents/` of apra-pm repo | Must |
| CC.2 | At install time, transform to provider-native format for opencode (and any future providers) | Must |
| CC.3 | Claude frontmatter: `name`, `description`, `tools: [Read,Edit,Write,Bash,Grep,Glob,Agent]` | -- |
| CC.4 | OpenCode frontmatter: `description`, `mode: subagent`, `permission: {edit: allow/deny, write: allow, bash: allow}` + name from filename | -- |
| CC.5 | Skill files (.claude/skills vs .config/opencode/skills): OpenCode auto-discovers `.claude/skills/` so no transform needed for skills | Should |
| CC.6 | Flawless fleet execution is priority over DRY -- per-provider variants are acceptable if needed | Must |
| CC.7 | Transform logic lives in `src/cli/install.ts` (or a helper) -- not in the submodule | Should |

---

## Cross-Cutting: E2E Tests

### Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| E2E.1 | New suite in `.github/e2e/suites.json` for OpenCode provider (s9 series: s9.1 win, s9.2 linux, s9.3 mac) | Must |
| E2E.2 | Suite runs against a local endpoint (Ollama on a self-hosted runner, or mock) | Must |
| E2E.3 | Validation gates from apra-pm-lite's harness: pr-exists, commits>=10, final-changeset-clean, process-discipline, beads-closed | Should |
| E2E.4 | Independent validation (not self-reported checkpoints) | Must |
| E2E.5 | Toy repo: reuse `fleet-e2e-toy` | Should |
| E2E.6 | Runner label: `fleet-opencode` or reuse existing self-hosted runner with opencode installed | Should |

---

## Acceptance Criteria Summary

1. `apra-fleet install --llm opencode` succeeds: installs pm skill, fleet skill, 4 agents (OpenCode format)
2. `register_member` with `llm_provider: 'opencode'` creates a valid member with user-supplied `model_tiers` map
3. `execute_prompt` on an OpenCode member completes a simple task, resolving tier->model from the member's map at dispatch time
4. pm skill dispatches doer/reviewer via OpenCode members in a sprint
5. pm skill works FLAWLESSLY standalone (Claude Code local subagents, no fleet) -- unchanged from pm-lite
6. pm skill works FLAWLESSLY dispatched to fleet members -- dual-mode is an explicit reviewer check
7. All existing tests pass (no regression)
8. Gap analysis complete with every old-pm feature accounted for
9. E2E suite for OpenCode defined and runnable (may initially be manual until self-hosted runner available)
10. No `-lite` naming anywhere in either repo after rename
