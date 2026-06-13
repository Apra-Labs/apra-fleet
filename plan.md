# Implementation Plan: OpenCode Provider + PM Submodule + Agent Install

## Overview

6 phases, dependency-ordered. Riskiest assumptions front-loaded (submodule+npm vendoring in
Phase 1, OpenCode headless reliability in Phase 3). Each phase ends with a VERIFY checkpoint.

**Tier key:** cheap = mechanical edits; standard = typical implementation; premium = design
decisions, multi-file reasoning, parser design. Tier is a PER-TASK advisory hint for model
selection -- it is NOT a monotonic phase property. Task ORDER within a phase follows
dependencies (e.g. T1.1 rename must precede T1.2 submodule; T2.1 delete-old-pm must precede
T2.2 gap-ports; T6.2 integration must precede T6.3 commit-doc), so a cheap task can correctly
follow a premium/standard one inside the same phase. The doer escalates per task as needed;
VERIFY checkpoints are kept whole (not split at tier boundaries) so review covers a coherent
unit of work.

**Doer:** fleet-dev. **Reviewer:** fleet-rev (premium for all reviews).

---

## Phase 1: Submodule Setup + Repo Rename (Foundation)

Riskiest first: validate submodule + npm vendoring works before building anything on top.

### T1.1: Rename apra-pm-lite repo + internal references
- **Tier:** standard
- **Files:**
  - `Apra-Labs/apra-pm-lite` repo (remote): `gh repo rename apra-pm`
  - In apra-pm repo: `package.json`, `skills/pm-lite/` -> `skills/pm/`, all `.md`/`.mjs`/`.json` files
  - Search-replace: `apra-pm-lite` -> `apra-pm`, `pm-lite` -> `pm`
  - Rename `docs/pm-lite-direction.md` -> `docs/pm-direction.md`
- **Done:** `grep -r "pm-lite\|apra-pm-lite" --include='*.md' --include='*.mjs' --include='*.json'` returns 0 hits; `npm test` passes in apra-pm repo
- **Blockers:** None (first task), BUT implicit prerequisite: `gh repo rename` of an org repo needs Apra-Labs org-admin / repo-admin rights on the doer's gh account. If the rename returns 403/permission-denied, STOP and escalate to the PM -- the user (org admin) runs the one rename command, then the doer resumes from the clone+internal-refs step. Do NOT work around by forking.
- **Risk:** Existing forks break (GitHub auto-redirects mitigate). Cross-repo push: the doer needs push rights to apra-pm for the internal-refs commit (same auth as the rename).

### T1.2: Add apra-pm as git submodule in apra-fleet
- **Tier:** cheap
- **Files:**
  - `.gitmodules` (new entry)
  - `vendor/apra-pm/` (submodule checkout)
- **Done:** `git submodule status` shows vendor/apra-pm at a valid SHA; `ls vendor/apra-pm/agents/planner.md` exists
- **Blockers:** T1.1 (repo must be renamed first)

### T1.3: Build-time vendoring script + npm prepublishOnly
- **Tier:** standard
- **Files:**
  - `scripts/vendor-pm.mjs` (new) -- copies submodule files to dist/
  - `package.json` -- add `prepublishOnly` script
  - `scripts/gen-sea-config.mjs` -- update to collect from `vendor/apra-pm/`
- **Done:** `npm run build` succeeds; `ls dist/skills/pm/SKILL.md` exists; `ls dist/agents/planner.md` exists; `npm pack` produces tarball containing skills/pm + agents
- **Blockers:** T1.2

### T1.4: Update install.ts to source from vendor/apra-pm paths
- **Tier:** standard
- **Files:**
  - `src/cli/install.ts` -- update `findProjectRoot()` or asset collection to look in `vendor/apra-pm/skills/pm/` and `vendor/apra-pm/agents/`
  - `src/cli/install.ts` -- update dev-mode manifest builder (`buildDevManifest`)
  - `src/cli/install.ts` -- empty-submodule guard (finding G): if `vendor/apra-pm/` exists but is empty (user cloned non-recursively), fail with a clear message directing them to `git submodule update --init --recursive` instead of installing an empty skill
- **Done:** `node dist/index.js install --llm claude` installs pm skill from submodule source; installed SKILL.md content matches `vendor/apra-pm/skills/pm/SKILL.md`; empty `vendor/apra-pm/` triggers the guard message (not a silent empty install)
- **Blockers:** T1.3

### VERIFY 1
- Submodule initialized and pinned
- `npm run build` succeeds with submodule files in output
- `npm pack` includes pm skill + agent files
- Dev-mode install works
- Empty-submodule guard (finding G): a non-recursive clone (empty `vendor/apra-pm/`) produces the `git submodule update --init` guidance, not a silent empty install
- **Reviewer checks:** submodule URL correct, .gitmodules entry clean, no old pm files referenced, empty-clone guard present

---

## Phase 2: PM Skill Replacement + Gap Ports (Core PM)

### T2.1: Delete old skills/pm/ directory
- **Tier:** cheap
- **Files:**
  - `skills/pm/` -- delete entire directory (21 files)
- **Done:** `ls skills/pm/` fails (directory gone); `npm run build` still succeeds
- **Blockers:** T1.4 (install now sources from submodule)

T2.2 was split (reviewer finding E: a single 9-item / 5-file port risks exceeding ~50 tool
calls). T2.2a = SKILL.md-centric ports; T2.2b = sub-doc ports + new files. Both commit to the
apra-pm submodule repo (requires push rights to apra-pm -- same auth as T1.1).

### T2.2a: Port SKILL.md gap items into apra-pm
- **Tier:** premium
- **Files (in vendor/apra-pm/ submodule):**
  - `skills/pm/SKILL.md` -- add: sprint selection table (simple/single/multi); `/pm` command reference table; core operational rules R2-R13 from Gap Table row 7 (fleet-only ones -- R4,R5,R8,R9,R13 -- clearly marked as fleet-mode); secrets/credentials reference (`{{secure.NAME}}`); provider awareness section + context-file filename table; one-line R1 statement (PM orchestrates, never reads/writes code)
- **Done:** SKILL.md contains all of the above; grep for each feature term confirms presence; fleet-only rules visibly gated; `npm test` passes in apra-pm
- **Blockers:** T2.1 (old pm removed, no confusion about which is canonical)
- **Risk:** modifies the submodule repo (commit in apra-pm, SHA bump in apra-fleet at T2.3)

### T2.2b: Port sub-doc gap items + new files into apra-pm
- **Tier:** premium
- **Files (in vendor/apra-pm/ submodule):**
  - `skills/pm/doer-reviewer-loop.md` -- add pre-flight checks (SHA matching before review) AND the resume-rules table (data-driven from planned.json phase numbers; MUST port -- fleet-critical session-continue optimization)
  - `skills/pm/sprint.md` -- add documentation harvest step
  - New file: `skills/pm/fleet-addendum.md` -- fleet-only sections: permissions, stop_prompt, unattended modes, compose_permissions, context-file filename table
  - New file: `skills/pm/simple-sprint.md` -- lightweight 1-3 task flow (MUST port -- user-facing; old `/pm` users rely on it)
- **Done:** All 9 "must port" items from the design Gap Summary now present across T2.2a+T2.2b (verified by grep per item); simple-sprint.md and resume-rules table exist; `npm test` passes in apra-pm
- **Blockers:** T2.2a

### T2.3: Update submodule pin after gap ports
- **Tier:** cheap
- **Files:**
  - `vendor/apra-pm` -- update to latest SHA that includes gap ports
- **Done:** `git submodule status` shows new SHA; `cat vendor/apra-pm/skills/pm/SKILL.md` contains ported content
- **Blockers:** T2.2b

### VERIFY 2
- Old skills/pm/ deleted from apra-fleet
- New pm skill (from submodule) contains all 9 gap-ported must-port items
- `apra-fleet install --llm claude` installs the new pm skill with gap ports
- No `-lite` naming anywhere in installed skill files
- Dual-mode design (section 4a) is reflected in the ported skill files: fleet-only features are gated, local mode documented
- **Backward-compat smoke test (finding F):** because old pm is deleted here in Phase 2 but the full backward-compat.test.ts lands in Phase 5, add a minimal smoke check at this checkpoint -- verify the new pm SKILL.md still exposes equivalents for each old `/pm` command and that state-file names (PLAN.md, progress.json, feedback.md, status.md) are unchanged. Catches regressions 3 phases before the full suite.
- **Reviewer checks:** gap analysis completeness (all 9 must-port present), no regression in pm capabilities, fleet-only features cleanly gated (no errors in local mode), dual-mode acceptance criteria addressed, smoke test passes

---

## Phase 3: OpenCode Provider Adapter (Core Provider)

Front-loads the second riskiest assumption: OpenCode headless + JSON parsing.

### T3.1: Add 'opencode' to LlmProvider type + provider registry
- **Tier:** cheap
- **Files:**
  - `src/types.ts:4` -- add `'opencode'` to union
  - `src/providers/opencode.ts` (new) -- skeleton class implementing ProviderAdapter
  - `src/providers/index.ts` -- import and register OpenCodeProvider
- **Pre-step:** VERIFY OpenCode's real project-instruction filename before setting `instructionFileName`. Check OpenCode source or docs -- the current guess is `'OPENCODE.md'` but it may be `'AGENTS.md'` or something else. Set the verified value in the skeleton; if unverifiable, leave it as `'OPENCODE.md'` with a TODO comment.
- **Done:** `npm run build` compiles; `getProvider('opencode')` returns OpenCodeProvider instance; `instructionFileName` is verified or explicitly marked TODO
- **Blockers:** None (independent of Phase 1-2, but ordered here for cohesion)

### T3.2: Implement core adapter methods
- **Tier:** standard
- **Files:**
  - `src/providers/opencode.ts` -- implement: cliCommand, versionCommand, installCommand, updateCommand, skipPermissionsFlag, permissionModeAutoFlag, modelTiers (static defaults only -- see T3.7 for per-member resolution), modelForTier (fallback only), modelFlag, classifyError, headlessInvocation, jsonOutputFlag
- **Done:** All simple getter/builder methods implemented; modelTiers() documented as fallback defaults; unit tests pass for each method
- **Blockers:** T3.1

### T3.3: Implement buildPromptCommand + session management
- **Tier:** standard
- **Files:**
  - `src/providers/opencode.ts` -- implement: buildPromptCommand (folder, promptFile, sessionId, unattended, model, inv), supportsResume, supportsMaxTurns, resumeFlag
- **Done:** `buildPromptCommand({folder:'/tmp/test', promptFile:'.fleet-task.md', model:'ollama/qwen3-coder:30b'})` returns correct `cd ... && opencode run ...` string; resume flag tests pass
- **Blockers:** T3.2

### T3.4: Implement parseResponse for OpenCode JSON output
- **Tier:** premium
- **Pre-step: CAPTURE REAL OUTPUT FIRST.** Before writing any parser code, capture real `opencode run --format json` output from a working opencode+ollama endpoint (e.g. spark). The PM can provide captured output if no endpoint is available. Do NOT code parseResponse against an assumed schema -- use real captured NDJSON as the test fixture and design basis.
- **Files:**
  - `tests/fixtures/opencode-output.ndjson` (new) -- captured real output from `opencode run --format json`
  - `src/providers/opencode.ts` -- implement parseResponse() parsing the captured NDJSON format
- **Done:** Unit tests use REAL captured OpenCode JSON output (not invented fixtures); handles text events, tool events, error events, empty output; returns ParsedResponse with result + isError
- **Blockers:** T3.3
- **Risk:** JSON format not fully documented -- the pre-step mitigates by using real output

### T3.5: Implement permission and auth methods
- **Tier:** standard
- **Files:**
  - `src/providers/opencode.ts` -- implement: permissionConfigPaths, composePermissionConfig (doer/reviewer permission maps), supportsOAuthCopy, supportsApiKey, oauthCredentialFiles, oauthSettingsMerge, oauthEnvVarsToUnset, authEnvVarForToken, wrapWindowsPrompt
- **Done:** `composePermissionConfig('doer')` returns correct OpenCode permission map; all auth methods return appropriate values
- **Blockers:** T3.2

### T3.6: Add opencode to install config
- **Tier:** cheap
- **Files:**
  - `src/cli/config.ts` -- add opencode case to `getProviderInstallConfig()` with paths: configDir=`~/.config/opencode`, settingsFile=`~/.config/opencode/opencode.json`, skillsDir/fleetSkillsDir/agentsDir
  - `src/cli/config.ts` -- add opencode to `PROVIDER_STANDARD_MODELS`
- **Done:** `getProviderInstallConfig('opencode')` returns correct paths; config compiles
- **Blockers:** T3.1

### T3.7: Per-member model_tiers in register_member + dispatch-time resolution
- **Tier:** standard
- **Files:**
  - `src/types.ts` -- add optional `model_tiers?: { cheap?: string; standard?: string; premium?: string }` to `MemberRecord` type
  - `src/tools/register-member.ts` -- accept `model_tiers` param; validate at least one model if provider is opencode; store on member record; single-model fills all tiers
  - `src/tools/execute-prompt.ts` -- add `resolveModelForTier(member, tier)` that reads member.model_tiers before falling back to provider.modelForTier(); pass resolved model to buildPromptCommand
- **Done:** `register_member` with `model_tiers: { cheap: "ollama/x", premium: "ollama/y" }` stores the map; `execute_prompt` with tier=premium resolves to "ollama/y" for that member; unit tests cover: full map, single-model expansion, missing map (falls back to adapter defaults)
- **Blockers:** T3.2 (adapter core methods exist)

### VERIFY 3
- `npm run build` succeeds with opencode provider
- All existing tests pass (no regression)
- Unit tests for OpenCode adapter cover: command building, response parsing, error classification, permission composition
- Per-member model_tiers: register_member stores the map; dispatch resolves tier->model from member record; fallback to adapter defaults when no map
- parseResponse tests use REAL captured OpenCode output (not invented fixtures)
- instructionFileName is verified or explicitly marked as TODO
- **Reviewer checks:** adapter method correctness, parseResponse robustness, edge cases (empty output, malformed JSON, error events), tier resolution correctness (member map -> adapter fallback chain)

---

## Phase 4: Agent Installation System (Integration)

### T4.1: Add agentsDir to ProviderInstallConfig
- **Tier:** cheap
- **Files:**
  - `src/cli/config.ts:51-57` -- add `agentsDir: string | undefined` to interface
  - `src/cli/config.ts:66-110` -- add agentsDir to each provider case: claude=`~/.claude/agents`, gemini=`~/.gemini/agents`, agy=`~/.gemini/antigravity-cli/agents`, opencode=`~/.config/opencode/agents`, codex=undefined, copilot=undefined
- **Done:** TypeScript compiles; `getProviderInstallConfig('claude').agentsDir` returns `~/.claude/agents`
- **Blockers:** T3.6 (opencode config case exists)

### T4.2: Agent install step in install.ts
- **Tier:** standard
- **Files:**
  - `src/cli/install.ts` -- add agent files to AssetManifest interface; collect from `vendor/apra-pm/agents/` in manifest builder; add install step that writes to `paths.agentsDir`
  - `scripts/gen-sea-config.mjs` -- include agents in SEA manifest
- **Done:** `apra-fleet install --llm claude` writes 4 agent files to `~/.claude/agents/`; step count is correct
- **Blockers:** T4.1, T1.4 (submodule paths wired)

### T4.3: Agent format transform for OpenCode
- **Tier:** standard
- **Files:**
  - `src/cli/install.ts` (or new `src/cli/agent-transform.ts`) -- `transformAgentForOpenCode(content, filename)` function: parse Claude YAML frontmatter, rewrite to OpenCode format (drop name, add mode: subagent, map tools -> permission)
  - `src/cli/install.ts` -- apply transform when `provider === 'opencode'` during agent install step
- **Done:** `apra-fleet install --llm opencode` writes 4 agent files to `~/.config/opencode/agents/` with correct OpenCode frontmatter; `opencode agent list` shows all 4 as (subagent)
- **Blockers:** T4.2

### T4.4: Tests for agent installation
- **Tier:** standard
- **Files:**
  - `tests/install-multi-provider.test.ts` (update or new) -- test agent install for claude/gemini/agy/opencode; test skip for codex/copilot; test transform output for OpenCode
  - `tests/agent-transform.test.ts` (new) -- unit tests for the Claude->OpenCode transform function
- **Done:** All new tests pass; existing install tests pass
- **Blockers:** T4.3

### VERIFY 4
- `apra-fleet install --llm <provider>` installs agents correctly for all 6 providers
- OpenCode agents have correct frontmatter format
- Codex/copilot skip agents silently
- All tests pass
- **Reviewer checks:** transform correctness for all 4 agents, edge cases (missing tools field, unknown tools), step count accuracy

---

## Phase 5: E2E Test Design + Backward Compatibility (Validation)

### T5.1: Add OpenCode e2e suite configuration
- **Tier:** standard
- **Files:**
  - `.github/e2e/suites.json` -- add s9/s9.1/s9.2/s9.3 entries for opencode
  - `.github/e2e/members.json` -- add opencode member config (host, user, folder, endpoint)
  - `.github/workflows/fleet-e2e.yml` -- add opencode matrix entries, opencode-specific setup steps (verify Ollama endpoint, verify opencode CLI)
- **Done:** e2e workflow YAML is valid; matrix includes s9 suites; opencode setup steps reference correct install commands
- **Blockers:** T3.6, T4.3 (opencode provider + agent install working)

### T5.2: Adopt apra-pm-lite validation harness
- **Tier:** standard
- **Files:**
  - `.github/e2e/validate-sprint.mjs` (update or new) -- add validation gates from apra-pm-lite: pr-exists, commits>=10, final-changeset-clean, process-discipline, beads-closed
  - `.github/e2e/extract-results.mjs` (update) -- handle opencode output format
- **Done:** Validation script runs against a mock sprint output directory and passes/fails correctly for each gate
- **Blockers:** T5.1

### T5.3: Backward compatibility verification
- **Tier:** standard
- **Files:**
  - `tests/backward-compat.test.ts` (new) -- verify: old `/pm` commands map to new pm skill equivalents; old status.md/progress.json/planned.json format still works; beads lifecycle hooks unchanged; provider-specific context-file filenames preserved
- **Done:** All backward-compat tests pass
- **Blockers:** T2.3 (new pm skill in place)

### VERIFY 5
- E2E suite configuration complete and valid
- Validation gates implemented
- Backward compatibility tests pass
- Dual-mode: e2e covers BOTH local-only mode (no fleet) AND fleet member dispatch mode
- **Reviewer checks:** e2e coverage completeness, no gaps in validation, backward-compat test comprehensiveness, BOTH execution modes tested

---

## Phase 6: Integration + Cleanup (Ship)

### T6.1: Update documentation
- **Tier:** cheap
- **Files:**
  - `README.md` -- add OpenCode provider to supported providers list, add opencode install example, update provider table
  - `docs/architecture.md` -- update provider list, add submodule reference
  - `CHANGELOG.md` or release notes -- document all three parts
- **Done:** README lists opencode as supported; architecture doc reflects submodule design
- **Blockers:** T5.3

### T6.2: Final integration test
- **Tier:** standard
- **Files:**
  - No new files -- run full test suite + build + install across all providers
- **Done:** `npm test` passes; `npm run build` succeeds; `npm pack` includes all files; install works for claude, gemini, agy, opencode, codex, copilot
- **Blockers:** T6.1

### T6.3: Commit docs/opencode-exploration.md
- **Tier:** cheap
- **Files:**
  - `docs/opencode-exploration.md` -- commit the untracked research log
- **Done:** File committed on the feature branch
- **Blockers:** None

### VERIFY 6 (Final)
- All tests green
- Build produces correct output
- Install works for all 6 providers
- No `-lite` naming anywhere
- PR-ready: clean diff, no debug artifacts, no temporary files
- **Reviewer checks:** overall cohesion, no dead code, security review (no secrets in committed files), docs accuracy

---

## Dependency Graph

```
T1.1 (rename) -> T1.2 (submodule) -> T1.3 (vendor script) -> T1.4 (install paths) -> VERIFY 1
                                                                        |
                                                                        v
T2.1 (delete old pm) -> T2.2a (SKILL.md ports, PREMIUM) -> T2.2b (sub-doc ports, PREMIUM) -> T2.3 (submodule pin) -> VERIFY 2
                                                                                |
T3.1 (type+skeleton) -> T3.2 (core methods) -> T3.3 (prompt+session) ----------+
        |                       |                   |                           |
        +-> T3.6 (install cfg)  +-> T3.7 (member    +-> T3.4 (parseResponse, PREMIUM)
                    |               tier-map)       |       |
                    v                               v       v
              T4.1 (agentsDir) -> T4.2 (install step) -> T4.3 (transform) -> T4.4 (tests) -> VERIFY 4
                                                                                               |
                                                           T3.5 (perms+auth) -+               |
                                                                               v               v
                                                                          VERIFY 3    T5.1 (e2e config)
                                                                                        -> T5.2 (validation)
                                                                                        -> T5.3 (compat) -> VERIFY 5
                                                                                                              |
                                                                                              T6.1 (docs) -> T6.2 (integration) -> T6.3 (exploration.md) -> VERIFY 6
```

---

## Test Strategy

| Level | What | Where |
|-------|------|-------|
| Unit | OpenCode adapter methods (command building, parsing, error classification) | `tests/opencode-provider.test.ts` |
| Unit | Agent frontmatter transform (Claude -> OpenCode) | `tests/agent-transform.test.ts` |
| Unit | Install config paths for all providers | `tests/install-multi-provider.test.ts` |
| Integration | Full install flow per provider | `tests/install-multi-provider.test.ts` |
| Integration | Backward compatibility (old pm -> new pm) | `tests/backward-compat.test.ts` |
| E2E | OpenCode member sprint (local Ollama endpoint) | `.github/e2e/` suites s9.x |
| E2E | Existing suites (claude, gemini, agy) pass with new pm | `.github/e2e/` suites s1-s8 |

---

## Rollout / Migration

1. **Before merge:** all existing e2e suites (s1-s8) must pass with the new pm skill -- validates backward compat
2. **npm publish:** `prepublishOnly` vendors submodule files; no user action needed
3. **Existing users upgrading:** `npm update -g apra-fleet && apra-fleet install` re-installs pm skill + agents from submodule; old pm files overwritten
4. **New users:** `npm install -g apra-fleet && apra-fleet install --llm opencode` -- full setup
5. **Submodule users (git clone):** `git clone --recursive` or `git submodule update --init` after clone

---

## Protecting Existing Skills/Hooks + Backward Compatibility

| Item | Protection |
|------|-----------|
| Fleet skill (`skills/fleet/`) | Untouched -- stays in apra-fleet repo, not in submodule |
| Hooks (`~/.apra-fleet/hooks/`) | Untouched -- install.ts hook logic unchanged |
| Settings merging | Install.ts `readConfig`/`writeConfig` unchanged -- settings are merged, not overwritten |
| Beads DB | Untouched -- beads is a separate binary/DB, pm skill just calls `bd` commands |
| Provider configs (settings.json, config.toml) | Only new permissions added (opencode); existing provider configs unchanged |
| Old pm sprint state files | Compatible -- pm-lite uses the same file names/formats (progress.json, PLAN.md, feedback.md, status.md) |
