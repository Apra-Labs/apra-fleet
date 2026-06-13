# Design: OpenCode Provider + PM Submodule + Agent Install Epic

## 1. Current-State Map

### apra-fleet (this repo)

| Component | Path | Purpose |
|-----------|------|---------|
| Provider interface | `src/providers/provider.ts:49-115` | `ProviderAdapter` (26 methods + 5 readonly props = 31 members), `PromptOptions`, `ParsedResponse` |
| Provider registry | `src/providers/index.ts:9-15` | 5 providers: claude, gemini, codex, copilot, agy |
| LlmProvider type | `src/types.ts:4` | `'claude' \| 'gemini' \| 'codex' \| 'copilot' \| 'agy'` |
| Install config | `src/cli/config.ts:51-57` | `ProviderInstallConfig` (configDir, settingsFile, skillsDir, fleetSkillsDir, name) |
| Install config factory | `src/cli/config.ts:66-110` | `getProviderInstallConfig()` -- per-provider path mapping |
| Install logic | `src/cli/install.ts` | Asset manifest, skill/hook/script deployment, SEA support |
| SEA bundler | `scripts/gen-sea-config.mjs` | Manifest generation for single-executable archive |
| PM skill (old) | `skills/pm/` (21 files) | SKILL.md, context-file.md, doer-reviewer.md, single-pair-sprint.md, simple-sprint.md, multi-pair-sprint.md, cleanup.md, init.md, plan-prompt.md, beads.md, backlog-item.md, 10 templates |
| Update CLI tool | `src/tools/update-agent-cli.ts` | `updateAgentCli()` -- install/update LLM CLI on members |
| Execute prompt | `src/tools/execute-prompt.ts` | `executePrompt()` -- dispatch prompts to members |
| Register member | `src/tools/register-member.ts` | `registerMember()` -- onboard new fleet members |
| OS commands | `src/os/os-commands.ts` | `installAgent()`, `updateAgent()`, `agentVersion()` per provider |
| E2E workflow | `.github/workflows/fleet-e2e.yml` | CI e2e: s1-s8 suites, fleet-windows/linux/macos runners |
| E2E suites | `.github/e2e/suites.json` | Suite definitions with OS/provider variants |
| E2E members | `.github/e2e/members.json` | Per-OS host/user/folder configs |
| Codex provider (model) | `src/providers/codex.ts` | Reference impl for non-Claude provider |

### apra-pm-lite (Apra-Labs/apra-pm-lite, to be renamed apra-pm)

| Component | Path | Purpose |
|-----------|------|---------|
| PM skill | `skills/pm-lite/SKILL.md` | Standalone PM orchestrator (no fleet dep) |
| Beads doc | `skills/pm-lite/beads.md` | Task DB backbone, epic/task lifecycle, findings |
| Doer-reviewer loop | `skills/pm-lite/doer-reviewer-loop.md` | Per-phase execution loop with dispatch templates |
| Sprint lifecycle | `skills/pm-lite/sprint.md` | requirements -> design -> plan -> execute -> deploy -> PR |
| Worktrees | `skills/pm-lite/worktrees.md` | Git worktree topology, parallel tracks |
| Progress template | `skills/pm-lite/tpl-progress.json` | Schema for progress.json |
| Planner agent | `agents/planner.md` | Plan generation (explore, draft, front-load, refine) |
| Doer agent | `agents/doer.md` | Task execution, commit, VERIFY checkpoints |
| Reviewer agent | `agents/reviewer.md` | Code review, test validation, file hygiene |
| Plan-reviewer agent | `agents/plan-reviewer.md` | Plan review against requirements |
| Installer | `install.mjs` | Copies skill + agents to provider config dirs |
| E2E runner | `e2e/run-e2e.mjs` | Clone toy repo, dispatch orchestrator, read checkpoints |
| E2E scenario | `e2e/scenario.md` | Scenario template |
| E2E suites | `e2e/suites.json` | Claude/Gemini/AGY x Win/Linux/macOS |
| E2E validation | `e2e/validate-sprint.mjs` | Independent validation gates |
| E2E results | `e2e/extract-results.mjs` | Parse checkpoints + token telemetry |
| Design intent | `docs/pm-lite-direction.md` | Architectural decisions |

---

## 2. Submodule + Vendor Design

### Submodule Layout

```
apra-fleet/
  vendor/
    apra-pm/              <-- git submodule (Apra-Labs/apra-pm @ pinned SHA)
      agents/
        planner.md
        doer.md
        reviewer.md
        plan-reviewer.md
      skills/
        pm/               <-- renamed from pm-lite
          SKILL.md
          beads.md
          doer-reviewer-loop.md
          sprint.md
          worktrees.md
          tpl-progress.json
      install.mjs
      e2e/
        ...
  skills/
    fleet/                <-- existing fleet skill (unchanged)
    (pm/ removed)         <-- old pm skill deleted
  agents/
    (removed or empty)    <-- agents now sourced from vendor/apra-pm/agents/
```

### .gitmodules Entry

```ini
[submodule "vendor/apra-pm"]
  path = vendor/apra-pm
  url = https://github.com/Apra-Labs/apra-pm.git
  branch = main
```

### npm Package Vendoring (Build-Time Copy)

Problem: `npm install -g apra-fleet` does NOT clone submodules. Users who install via npm
would get an empty `vendor/apra-pm/` directory.

Solution: a `prepublishOnly` npm script copies submodule files into the package before publish:

```json
{
  "scripts": {
    "prepublishOnly": "node scripts/vendor-pm.mjs && npm run build",
    "postinstall": ""
  }
}
```

`scripts/vendor-pm.mjs` does:
1. Check if `vendor/apra-pm/agents/planner.md` exists (submodule initialized)
   - If yes: copy `vendor/apra-pm/skills/pm/` -> `dist/skills/pm/`
   - If yes: copy `vendor/apra-pm/agents/` -> `dist/agents/`
2. If submodule not initialized: check `dist/skills/pm/` already populated (pre-built tarball)
   - If not: error with "run git submodule update --init"

For the SEA binary (`npm run build:binary`):
- `gen-sea-config.mjs` already collects files into a manifest
- Update it to collect from `vendor/apra-pm/skills/pm/` and `vendor/apra-pm/agents/`
  instead of `skills/pm/` and `agents/`

For dev-mode (`node dist/index.js install`):
- `findProjectRoot()` in install.ts locates files relative to the project root
- Update skill/agent paths to look in `vendor/apra-pm/` first, fall back to `dist/` for npm

### Alternatives Considered

| Alternative | Pros | Cons | Decision |
|-------------|------|------|----------|
| Copy files directly (no submodule) | Simple, no git dependency | Two sources of truth, drift risk | Rejected |
| npm dependency (apra-pm as npm pkg) | Standard npm workflow | Overkill for markdown files, version coupling | Rejected |
| Monorepo (move pm into apra-fleet) | Single repo | Loses independent pm-lite development, larger PRs | Rejected |
| Submodule + build-time vendor | Single source of truth, npm works | Slightly complex build | **Chosen** |

---

## 3. Repo Rename Plan

### Steps

1. `gh repo rename apra-pm --repo Apra-Labs/apra-pm-lite` (renames on GitHub)
2. In the apra-pm repo, search-and-replace all occurrences:
   - `apra-pm-lite` -> `apra-pm` (package.json name, README, docs, CI)
   - `pm-lite` -> `pm` (skill dir name, skill name in SKILL.md frontmatter, commit prefixes like `pm-lite-doer` -> `pm-doer`, agent references)
3. Rename directory: `skills/pm-lite/` -> `skills/pm/`
4. Update `install.mjs` paths
5. Update `e2e/suites.json` references
6. Update `.github/workflows/` if any reference the old name
7. Commit as `chore: rename apra-pm-lite -> apra-pm`
8. Verify: `grep -r "pm-lite\|apra-pm-lite" --include='*.md' --include='*.mjs' --include='*.json'` returns 0 hits

### Files Affected in apra-pm-lite (to be renamed)

- `package.json` (name field)
- `skills/pm-lite/SKILL.md` (frontmatter name, any self-references)
- `skills/pm-lite/doer-reviewer-loop.md` (commit-as references: `pm-lite-doer` etc.)
- `skills/pm-lite/sprint.md` (references)
- `agents/*.md` (any `pm-lite` references in prompts)
- `install.mjs` (skill dir path)
- `e2e/suites.json` (test labels)
- `docs/pm-lite-direction.md` (filename + content)
- `README.md`, `CONTRIBUTING.md`

---

## 4. PM vs PM-Lite Gap Analysis

Systematic comparison of every concept in old `skills/pm/` vs new `skills/pm-lite/` (apra-pm-lite).

### Legend

- **Port** = must be added to the new pm before this epic ships
- **Drop** = intentionally not porting, with justification
- **Present** = already in pm-lite (no action needed)

### Gap Table

| # | Feature / Concept | Old PM File(s) | PM-Lite File(s) | Status | Decision | Notes |
|---|-------------------|----------------|------------------|--------|----------|-------|
| 1 | Fleet skill dependency (`note: This skill requires the 'fleet' skill`) | SKILL.md:4 | -- | Missing in pm-lite | **Drop** | pm-lite is designed fleet-independent. Fleet integration happens at the apra-fleet install/dispatch layer, not in the skill definition. This is the whole point of pm-lite. |
| 2 | Dependency bootstrap (`Activate fleet skill before proceeding`) | SKILL.md:13-16 | -- | Missing in pm-lite | **Drop** | Same as #1 -- no fleet dependency. |
| 3 | Sprint selection table (simple/single-pair/multi-pair) | SKILL.md:22-28 | SKILL.md (implicit via docs) | **Partial** | **Port** | pm-lite has sprint.md (full lifecycle) and worktrees.md (parallel tracks). Missing: explicit `simple-sprint` for 1-3 task lightweight flow. Port the sprint-selection logic into pm SKILL.md. |
| 4 | `/pm` command reference (init, pair, plan, start, status, resume, deploy, recover, cleanup, backlog, tasks) | SKILL.md:36-47 | SKILL.md (less formal) | **Partial** | **Port** | pm-lite uses a different command structure. Port the explicit command table as reference. |
| 5 | Beads central DB rule (one DB in PM root, not per-project) | SKILL.md:52-54, beads.md | beads.md | **Present** | -- | pm-lite's beads.md covers this. |
| 6 | Beads lifecycle hooks (init/plan/start/verify/changes-needed/cleanup) | SKILL.md:56-63, beads.md | beads.md | **Present** | -- | Equivalent coverage. |
| 7 | Core rules (14 rules, SKILL.md:66-82) | SKILL.md:66-82 | SKILL.md (5 design principles) | **Partial** | **Port (per-rule below)** | pm-lite has high-level design principles but lacks the explicit operational rules. Explicit decision for ALL 14 (no "etc."): **R1** PM never reads/writes code, only orchestrates -> **Present** (pm-lite's planner/doer/reviewer split embodies this; add a one-line statement to pm SKILL.md). **R2** project sandboxing -> **Port**. **R3** status.md recovery + per-dispatch update -> **Port**. **R4** tool verification before dispatch -> **Port** (fleet-gated). **R5** 1-3 step ad-hoc vs task harness -> **Port** (fleet-gated; local mode = inline subagent). **R6** never idle -> **Port**. **R7** keep going until stuck/done, filter questions, escalate genuine ambiguity -> **Port** (both modes). **R8** club fleet calls into one background Agent -> **Port** (fleet-gated). **R9** unattended modes + compose_permissions -> **Port** (fleet-gated). **R10** PLAN/progress/feedback committed+pushed every turn, only context file uncommitted -> **Port** (this is the git-as-transport discipline; pm-lite has it implicitly via item #16 but the explicit per-turn-commit rule must be stated). **R11** security audit + docs in DoD -> **Port**. **R12** raise PR, verify CI, never merge -> **Port** (user-facing, critical). **R13** PM runs gh directly, owns PR lifecycle -> **Port** (fleet-gated; in local mode the single conversation runs gh). **R14** always read referenced sub-docs before executing -> **Present** (agent definitions inline their own context). |
| 8 | Secrets & credentials reference | SKILL.md:85-87 | -- | Missing | **Port** | Reference to fleet secure credentials. Important for fleet execution. Add a section to pm SKILL.md noting `{{secure.NAME}}` usage. |
| 9 | Model selection (reference to fleet skill Model Tiers) | SKILL.md:102-103 | sprint.md (model assignment by planner) | **Present** | -- | pm-lite handles model assignment differently (planner chooses per-task tier). Both valid; pm-lite approach is more sophisticated. |
| 10 | Provider awareness (reference to fleet skill Provider Awareness) | SKILL.md:107-110 | -- | Missing | **Port** | When running via fleet, the orchestrator needs to know provider-specific behaviors (e.g., agent context file naming). Port a provider-awareness section referencing context-file equivalents. |
| 11 | Agent context file mechanism (provider-specific filenames, templates, delivery rules) | context-file.md (full doc) | doer-reviewer-loop.md (dispatch templates) | **Partial** | **Port partially** | pm-lite's dispatch templates embed the prompt inline. The context-file.md concept (persistent per-provider agent context file in work_folder) is fleet-specific. Port the provider-filename table. The dispatch template approach in pm-lite is simpler and works better for local subagents. For fleet: the provider-filename mapping is still needed. |
| 12 | Doer-reviewer setup checklist (pair, icons, permissions, context file) | doer-reviewer.md:3-13 | doer-reviewer-loop.md (implicit) | **Partial** | **Port** | pm-lite assumes local subagents where pairing is automatic. For fleet dispatch: port the setup checklist (pair assignment, icon override, permission composition, pre-dispatch verification). |
| 13 | Pre-flight checks (branch verification, clean tree, SHA matching before review) | doer-reviewer.md:17-28 | doer-reviewer-loop.md (partial) | **Partial** | **Port** | pm-lite has some git checks but not the explicit SHA-matching pre-review verification. Port the full pre-flight checks section. |
| 14 | Resume rules (data-driven from planned.json phase numbers, explicit table) | doer-reviewer.md:56-78, single-pair-sprint.md:83-101 | doer-reviewer-loop.md (dispatch fresh/continue) | **Partial** | **Port** | pm-lite uses fresh dispatches per role. The resume optimization (continuing the session within a phase) is valuable for fleet. Port the resume rule table with the planned.json phase-number derivation. |
| 15 | Safeguards table (max_turns, retry limit, cycle limit, model escalation) | doer-reviewer.md:83-88, single-pair-sprint.md:120-125 | doer-reviewer-loop.md (safeguards section) | **Present** | -- | pm-lite has equivalent safeguards: dispatch retry (3/dispatch), doer-reviewer cycle (3/phase), zero progress (escalate model). Same limits. |
| 16 | Git as transport (doer commits PLAN/progress, reviewer commits feedback, annotated findings) | doer-reviewer.md:92-99 | sprint.md (git is the message bus) | **Present** | -- | pm-lite uses git as the primary state transport. Equivalent. |
| 17 | Permissions section (compose_permissions, mid-sprint denial handling, stop_prompt) | doer-reviewer.md:103-117 | -- | Missing | **Port** | Fleet-specific: compose_permissions, permission denial recovery, stop_prompt. Port into the fleet-only section of the dual-mode design (see section 4a). These features are gated to fleet mode only. |
| 18 | Simple sprint (lightweight 1-3 task flow without PLAN.md/progress.json) | simple-sprint.md | -- | Missing | **Port** | pm-lite does not have a lightweight path. Port simple-sprint as an alternative flow for trivial work. The pm-lite "lightweight path" in its direction doc mentions this as near-term roadmap. |
| 19 | Multi-pair sprint (parallel doer/reviewer pairs, contracts, integration flow) | multi-pair-sprint.md | worktrees.md | **Present** (different approach) | -- | pm-lite's worktrees.md handles parallel tracks via git worktrees (single orchestrator, multiple branches). The old multi-pair-sprint used multiple fleet member pairs. Both valid; worktrees.md is more sophisticated for local execution. For fleet dispatch with multiple members, worktrees.md applies (each worktree can map to a member). |
| 20 | Sprint completion documentation harvest | single-pair-sprint.md:139-141 | sprint.md (deploy phase) | **Partial** | **Port** | pm-lite has deploy but not the explicit "documentation harvest" step. Port as optional post-completion step. |
| 21 | Recovery after PM restart (detailed per-member state recovery, auto-resume vs escalate) | single-pair-sprint.md:153-179 | sprint.md (recovery section), SKILL.md | **Present** | -- | pm-lite handles recovery via git + beads queries. Equivalent approach. |
| 22 | Cleanup command (git rm control files, restore project files, raise PR) | cleanup.md | sprint.md (completion section) | **Present** | -- | pm-lite cleans process scaffolding from the final changeset. e2e validates this (final-changeset-clean gate). |
| 23 | Init flow (project folder, templates, beads init, epic creation) | init.md | sprint.md (setup phase) | **Present** | -- | pm-lite's sprint setup covers the same init flow. |
| 24 | Plan prompt (5-phase generation: explore, draft, front-load, self-critique, refine) | plan-prompt.md | agents/planner.md | **Present** | -- | pm-lite embeds the plan generation logic in the planner agent definition. More sophisticated (the agent IS the plan prompt). |
| 25 | Backlog item template (required description fields for deferred items) | backlog-item.md | beads.md (deferred items section) | **Present** | -- | pm-lite handles backlog via beads create with appropriate priority. |
| 26 | Templates: tpl-doer.md, tpl-reviewer.md, tpl-reviewer-plan.md, tpl-pm.md, tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md, tpl-plan.md, tpl-progress.json | skills/pm/tpl-*.md | skills/pm-lite/tpl-progress.json, agents/*.md | **Partial** | **Port selectively** | pm-lite has tpl-progress.json and agent definitions replace tpl-doer/reviewer/reviewer-plan. Missing templates: tpl-pm.md (PM self-context), tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md, tpl-plan.md. These are scaffolding helpers -- port tpl-plan.md and tpl-progress.json (already present). The others are nice-to-have templates that can be generated inline. Port tpl-deploy.md if deploy phase is retained. |

### Gap Summary

**Must port (9 items):**
1. Sprint selection logic (simple/single/multi) -> SKILL.md
2. Explicit `/pm` command reference -> SKILL.md
3. Core operational rules R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12,R13 (project sandboxing, status.md, tool verification, ad-hoc-vs-harness, never-idle, keep-going/escalate, fleet-call-clubbing, unattended+compose_permissions, per-turn commit/push, security+docs DoD, PR/never-merge, PM-owns-gh) -> SKILL.md + fleet addendum (fleet-gated rules clearly marked) -- see Gap Table row 7 for the per-rule decision
4. Secrets/credentials reference -> SKILL.md
5. Provider awareness + context-file filename table -> new section
6. Pre-flight checks (SHA matching before review) -> doer-reviewer-loop.md
7. Fleet-specific sections (permissions, stop_prompt, unattended modes) -> new "Fleet Execution" addendum
8. Simple sprint lightweight flow -> new file/section (RECLASSIFIED from "should": user-facing -- `/pm` users rely on the lightweight 1-3 task path; dropping it would annoy them)
9. Resume rules (data-driven from phase numbers) -> doer-reviewer-loop.md (RECLASSIFIED from "should": fleet-critical -- without it, fleet dispatch loses the within-phase session-continue optimization)

**Should port (1 item):**
10. Documentation harvest step -> sprint.md

**Present, no action (core rules R1, R14):**
- R1 (PM never reads/writes code, only orchestrates) and R14 (read referenced sub-docs first)
  are already embodied by pm-lite's agent split; add a one-line R1 statement to SKILL.md for
  explicitness.

**Drop (2 items):**
11. Fleet skill dependency bootstrap -- by design, pm has no fleet dep
12. Fleet skill references in SKILL.md header -- replaced by self-contained docs

---

## 4a. Dual-Mode Execution (Local Subagents vs Fleet Members)

The PM skill must work FLAWLESSLY in BOTH modes. These are two fundamentally different
orchestration models -- not a "fleet addendum" bolted onto local execution.

### Mode detection and selection

The SAME pm skill detects the execution mode at sprint start:

```
Mode selection logic (in pm SKILL.md or orchestrator):
  1. Check: are fleet members available? (fleet skill loaded + members registered)
  2. Check: does the user's /pm command specify --local or --fleet?
  3. Default: if fleet members available AND the task tier has a matching member -> fleet mode
     Otherwise -> local mode (Claude Code subagents via Task/Agent tool)
```

Detection mechanism (finding B): the pm skill is a markdown skill and CANNOT import fleet
TypeScript code. Step 1 must be done by PROBING the fleet MCP tools at runtime -- e.g. attempt
`fleet_status` / `list_members`; if the tool is absent or returns no members, fall to local
mode. Do NOT assume fleet internals are importable. Likewise, local mode assumes the host
exposes a subagent dispatch primitive (Claude Code's Agent/Task tool); if neither fleet MCP
nor a subagent tool is present, the skill degrades to single-conversation inline execution and
says so rather than failing silently.

The mode is stored in `status.md` at sprint init so recovery/resume uses the same mode.

### Loop semantics: how they differ

| Aspect | Local Subagent Mode | Fleet Member Mode |
|--------|-------------------|------------------|
| Dispatch mechanism | `Agent` tool (subagent_type from agent.md) | `execute_prompt` MCP tool to remote member |
| Blocking model | INLINE BLOCKING: orchestrator keeps its turn alive until the subagent returns (SKILL.md core rule 4) | ASYNC DISPATCH: orchestrator dispatches via execute_prompt, then polls/monitors via `monitor_task` |
| Turn lifecycle | Single turn encompasses dispatch + work + result | Dispatch is one turn; monitoring is periodic turns; result collection is another turn |
| Error recovery | Subagent failure returns inline; orchestrator retries immediately | Member failure detected via monitor_task; orchestrator retries or escalates |
| Concurrency | Sequential within a turn (one subagent at a time per orchestrator) OR parallel via multiple Agent tool calls | Naturally concurrent: multiple members can work simultaneously |
| Context passing | Subagent inherits conversation context + agent.md system prompt | Member receives prompt via execute_prompt; context passed via git (committed files) + prompt text |

### How the 4 roles map in each mode

| Role | Local Mode | Fleet Mode |
|------|-----------|-----------|
| Planner | `Agent` tool with `subagent_type: "planner"`, reads planner.md agent definition | `execute_prompt` to a planner-capable member; agent.md installed on member at install time |
| Plan-reviewer | `Agent` tool with `subagent_type: "plan-reviewer"` | `execute_prompt` to a reviewer member |
| Doer | `Agent` tool with `subagent_type: "doer"` in a worktree | `execute_prompt` to doer member; member works in its own work_folder |
| Reviewer | `Agent` tool with `subagent_type: "reviewer"` | `execute_prompt` to reviewer member |

In BOTH modes, the agent.md files define the role's system prompt and capabilities. The
canonical source is `vendor/apra-pm/agents/`. In local mode, the Agent tool loads them
directly. In fleet mode, they are installed on the member at `apra-fleet install` time.

### State and transport: identical across modes

- **Git is the message bus** in both modes. Doer commits code + PLAN.md updates + progress.json.
  Reviewer commits feedback.md. Orchestrator reads git state to decide next action.
- **Beads** tracks task lifecycle (create, in_progress, close) identically.
- **Sprint state files** (status.md, progress.json, planned.json, PLAN.md, feedback.md) have
  the same schema and semantics.
- **Worktrees** apply in both modes: local mode uses git worktrees directly; fleet mode
  maps each worktree to a member's work_folder.

### Fleet-only features

These features belong ONLY to fleet mode and are skipped/no-op in local mode:

| Feature | Why fleet-only |
|---------|---------------|
| `compose_permissions` | Local subagents inherit orchestrator permissions; fleet members need explicit permission config written to their provider settings |
| Context-file filenames (provider-specific) | Local subagents use the Agent tool's built-in context; fleet members need provider-specific context files (e.g. CLAUDE.md vs AGENTS.md) written to work_folder |
| Member pairing (doer + reviewer assignment) | Local mode uses whichever Agent tool the orchestrator spawns; fleet mode pairs specific members |
| `stop_prompt` | Only needed for fleet members running unattended; local subagents are stopped by the orchestrator ending the turn |
| Unattended mode flags | Fleet members need `--dangerously-skip-permissions` etc.; local subagents inherit orchestrator's permission state |
| `monitor_task` polling | Local subagents return inline; fleet members need async monitoring |

### Acceptance criteria for dual-mode

- [ ] pm skill detects mode at sprint start and records it in status.md
- [ ] A complete sprint (plan -> execute -> review -> deploy) passes in local-only mode with no fleet skill loaded
- [ ] The same sprint passes in fleet mode with registered members
- [ ] Fleet-only features are cleanly gated (no errors/warnings in local mode)
- [ ] Reviewer explicitly checks BOTH modes in every VERIFY checkpoint
- [ ] E2E tests cover both modes (existing claude e2e = fleet mode; new local-only e2e = local mode)

---

## 5. OpenCode Provider Adapter Design

### Class: `OpenCodeProvider implements ProviderAdapter`

File: `src/providers/opencode.ts`

```
OpenCodeProvider
  name: 'opencode'
  processName: 'opencode'
  authEnvVar: ''                    // local endpoints need no API key
  credentialPath: '~/.config/opencode/'
  instructionFileName: 'OPENCODE.md'  // **UNVERIFIED** -- must confirm real filename
                                      // (likely AGENTS.md). Verify in T3.1 before relying.

  cliCommand(args) -> `opencode ${args}`
  versionCommand() -> `opencode --version 2>&1`

  installCommand(os):
    linux  -> `curl -fsSL https://opencode.ai/install | bash`
    macos  -> `npm install -g opencode-ai`
    windows -> `npm install -g opencode-ai`

  updateCommand() -> `npm update -g opencode-ai`

  buildPromptCommand(opts):
    cd "${folder}" && opencode run -m ${model} --dangerously-skip-permissions --format json
      [--agent ${agent}] [--session "${sessionId}"] "${instruction}"
    NOTE: headless is `run "<msg>"` (positional arg, NOT --prompt)

  skipPermissionsFlag() -> '--dangerously-skip-permissions'
  permissionModeAutoFlag() -> null   // no auto mode in OpenCode

  parseResponse(result):
    Parse NDJSON (one JSON object per line from --format json). REAL schema verified
    on spark -- see docs/opencode-exploration.md section 8a (the authoritative spec/fixture).
    Each line: { type, sessionID, part }. Extract:
      - result  = concat of every `text` event's part.text (assistant message lives in
                  part.text, NOT part.content)
      - usage   = last `step_finish` event's part.tokens {total,input,output,reasoning,cache}
                  (usage IS emitted -- the earlier "no token counts" assumption was WRONG)
      - session = top-level sessionID (present on EVERY event)
      - tools   = `tool_use` events: part.tool, part.state.{status,input,output}
      - isError = unparseable line, explicit error event, or step_finish.part.reason not in
                  {stop, tool-calls}

  supportsResume() -> true
  supportsMaxTurns() -> false
  resumeFlag(sessionId, resuming):
    if resuming && sessionId: `--session "${sessionId}"`
    if resuming && !sessionId: `--continue`
    else: ''

  modelTiers():
    { cheap: 'ollama/qwen3-coder:30b',
      standard: 'ollama/qwen3-coder:30b',
      premium: 'ollama/qwen3-coder:30b' }
    NOTE: static FALLBACK DEFAULTS only. Actual tier->model resolution is per-member
    at dispatch time (see section 5a below). These apply only if a member has no
    model_tiers map.

  modelForTier(tier) -> modelTiers()[tier] ?? modelTiers().standard
    NOTE: called only as default fallback. Dispatch layer overrides with member's map.
  modelFlag(model) -> `-m "${model}"`

  classifyError(output):
    /not.*found|command not found/ -> 'auth' (CLI not installed)
    /connection refused|ECONNREFUSED/ -> 'server' (endpoint down)
    /timeout|ETIMEDOUT/ -> 'server'
    /rate limit|429/ -> 'overloaded'
    default -> 'unknown'

  permissionConfigPaths() -> ['.opencode/settings.json']  // TBD: verify
  composePermissionConfig(role, allow):
    Return OpenCode agent frontmatter as permission map
    doer: { edit: 'allow', write: 'allow', bash: 'allow' }
    reviewer: { edit: 'deny', write: 'allow', bash: 'allow' }

  supportsOAuthCopy() -> false
  supportsApiKey() -> false    // no central API key concept
  oauthCredentialFiles() -> null
  oauthSettingsMerge() -> null
  oauthEnvVarsToUnset() -> []
  authEnvVarForToken(token) -> ''

  wrapWindowsPrompt(setupCmd, filePath, argList, sessionId, model):
    `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`

  jsonOutputFlag() -> '--format json'
  headlessInvocation(prompt) -> `run "${prompt}"`
```

### 5a. Per-Member Model Tier Configuration

OpenCode members point at ARBITRARY user models (their local Ollama ladder or a cloud's model
IDs). The tier->model mapping CANNOT be hardcoded in the adapter -- it must be user-configurable
per member.

#### register_member parameter

`register_member` for an opencode member accepts an optional `model_tiers` param:

```
model_tiers: {
  cheap:    "ollama/qwen3-coder:30b",
  standard: "ollama/qwen3-coder-next",
  premium:  "ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M"
}
```

Stored on the member record in `members.json` as a new `model_tiers` field.

#### Validation rules

- At least one model must be supplied at registration (no zero-model registration).
- If only one model is supplied, it fills all three tiers.
- Missing tiers inherit from the next-lower tier (premium -> standard -> cheap).
- `model_tiers` is optional on non-opencode members (existing members unaffected).

#### Dispatch-time tier resolution

Resolution happens in `src/tools/execute-prompt.ts` (or a thin helper it calls), NOT in
the ProviderAdapter:

```
function resolveModelForTier(member: MemberRecord, tier: string): string {
  // 1. Check member.model_tiers[tier]
  // 2. Fallback: member.model_tiers.standard (or the single supplied model)
  // 3. Last resort: provider.modelForTier(tier) -- adapter static defaults
  const memberTiers = member.model_tiers;
  if (memberTiers) {
    return memberTiers[tier] ?? memberTiers.standard ?? memberTiers.cheap ?? Object.values(memberTiers)[0];
  }
  return getProvider(member.llm_provider).modelForTier(tier);
}
```

The execute_prompt layer calls `resolveModelForTier(member, taskTier)` and passes the
concrete model ID to `provider.buildPromptCommand()`. The adapter never needs to know
about per-member overrides.

#### Adapter's modelTiers() / modelForTier() role

For opencode, these become placeholder defaults only -- used when:
- A member was registered without `model_tiers` (legacy or test scenarios)
- Non-fleet local execution where no member record exists

They remain the primary source for other providers (claude, gemini, etc.) where model IDs
are well-known and consistent across members.

#### Tie to issue #299 (MODEL_EP_URL)

MODEL_EP_URL addresses endpoint configuration; `model_tiers` addresses model selection.
They are complementary: MODEL_EP_URL tells opencode WHERE to connect, `model_tiers` tells
the dispatcher WHICH model to request. Both are stored on the member record.

### Registration

`src/providers/index.ts`:
```typescript
import { OpenCodeProvider } from './opencode.js';

const providers: Record<LlmProvider, ProviderAdapter> = {
  claude: new ClaudeProvider(),
  gemini: new GeminiProvider(),
  codex: new CodexProvider(),
  copilot: new CopilotProvider(),
  agy: new AgyProvider(),
  opencode: new OpenCodeProvider(),  // NEW
};
```

`src/types.ts`:
```typescript
export type LlmProvider = 'claude' | 'gemini' | 'codex' | 'copilot' | 'agy' | 'opencode';
```

### Install Config Addition

`src/cli/config.ts` -- add opencode case:
```typescript
case 'opencode':
  return {
    configDir: path.join(home, '.config', 'opencode'),
    settingsFile: path.join(home, '.config', 'opencode', 'opencode.json'),
    skillsDir: path.join(home, '.config', 'opencode', 'skills', 'pm'),
    fleetSkillsDir: path.join(home, '.config', 'opencode', 'skills', 'fleet'),
    agentsDir: path.join(home, '.config', 'opencode', 'agents'),
    name: 'OpenCode',
  };
```

### update-llm-cli Changes

`src/os/os-commands.ts` needs `installAgent()` and `updateAgent()` to work with the opencode
provider. The existing pattern calls `provider.installCommand(os)` and `provider.updateCommand()`.
These are already implemented in the adapter above.

No changes needed in `update-agent-cli.ts` itself -- it already iterates providers generically.

### parseResponse Design Detail

OpenCode `--format json` emits NDJSON. The schema below is VERIFIED from real captures on
spark (opencode v1.17.4 + ollama), NOT assumed. The authoritative spec + the captured fixture
lines live in `docs/opencode-exploration.md` section 8a; T3.4 saves them as
`tests/fixtures/opencode-output.ndjson` and drives the unit tests off them.

Every line is `{ type, sessionID, part }`. Real event types:

```json
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start"}}
{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"hello"}}
{"type":"tool_use","sessionID":"ses_...","part":{"type":"tool","tool":"write","callID":"call_...","state":{"status":"completed","input":{...},"output":"Wrote file successfully."}}}
{"type":"step_finish","sessionID":"ses_...","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":7167,"input":7165,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
```

Parser strategy (mirrors codex.ts):
1. Split stdout by newlines; parse each non-empty line as JSON (unparseable line -> isError).
2. `result` = ordered concat of every `text` event's `part.text` (assistant text is in
   `part.text`, NOT `part.content` -- the original draft was wrong).
3. `usage` = last `step_finish` event's `part.tokens` (usage IS emitted -- original "no token
   counts" assumption was wrong).
4. `session` = top-level `sessionID` (on every event; no separate extraction needed).
5. `tools` = `tool_use` events -> `part.tool` (name), `part.state.{status,input,output}`.
6. `isError` = unparseable line, explicit error event, or `step_finish.part.reason` outside
   {stop, tool-calls}.

Error-event shape (VERIFIED -- induced via a bad model id): `{"type":"error","timestamp":N,
"sessionID":"ses_...","error":{"name":"UnknownError","data":{"message":"Model not found: ..."}}}`.
Error events have top-level `type:"error"` + `sessionID` but NO `part` field; message at
`error.data.message`. Multiple error events can appear -- prefer the most specific (last). The
schema is now FULLY captured (text/tool/usage/session/error) -- no remaining unknowns for T3.4.
See docs/opencode-exploration.md section 8a for the complete fixture.

---

## 6. Agent/Skill Format Variant Strategy

### Problem

Different providers use different agent file formats:

| Provider | Agent Location | Frontmatter Format |
|----------|----------------|-------------------|
| Claude | `~/.claude/agents/<name>.md` | `name`, `description`, `tools: [Read,Edit,...]` |
| Gemini | `~/.gemini/agents/<name>.md` | (same as Claude -- Gemini CLI reads Claude format) |
| AGY | `~/.gemini/antigravity-cli/agents/<name>.md` | (same as Claude) |
| OpenCode | `~/.config/opencode/agents/<name>.md` | `description`, `mode: subagent`, `permission: {edit: allow, ...}` (name from filename) |
| Codex | N/A (no agent file support) | -- |
| Copilot | N/A (no agent file support) | -- |

### Strategy: Canonical Source + Install-Time Transform

1. **Canonical source:** Claude-format `.md` files in `vendor/apra-pm/agents/`
2. **Claude/Gemini/AGY:** copy as-is (all read Claude format)
3. **OpenCode:** transform at install time in `src/cli/install.ts`
4. **Codex/Copilot:** skip (agentsDir = undefined)

### Transform Logic

```
function transformAgentForOpenCode(claudeContent: string, filename: string): string {
  Parse YAML frontmatter from Claude format
  Extract: name, description, tools[]

  Build OpenCode frontmatter:
    description: <same>
    mode: subagent
    permission:
      edit: <'allow' if 'Edit' in tools, else 'deny'>
      write: <'allow' if 'Write' in tools, else 'allow'>
      bash: <'allow' if 'Bash' in tools, else 'deny'>
      // read, grep, glob are always available in OpenCode

  Return: ---\n<opencode frontmatter>\n---\n<body unchanged>
}
```

### Skill Files

OpenCode auto-discovers `.claude/skills/` (verified in exploration doc, section 6). This means:
- Fleet skill files installed to `~/.claude/skills/fleet/` are auto-visible to OpenCode
- PM skill files can be installed to `.claude/skills/pm/` OR `.config/opencode/skills/pm/`
- For OpenCode members, install to `~/.config/opencode/skills/pm/` (the native path)
- Skill file format (SKILL.md with frontmatter) is Claude-compatible in OpenCode -- no transform needed

### Decision

- Agent files: transform at install time (must, different frontmatter)
- Skill files: no transform needed (OpenCode reads Claude SKILL.md format natively)
- Body content: copy verbatim (system prompt works across providers)

---

## 7. E2E Test Design

### New Suite Configuration

Add to `.github/e2e/suites.json`:

```json
{
  "s9":   { "os": "linux",   "llm": "opencode", "model": "ollama/qwen3-coder:30b", "runner": "fleet-opencode" },
  "s9.1": { "os": "windows", "llm": "opencode", "model": "ollama/qwen3-coder:30b", "runner": "fleet-opencode-win" },
  "s9.2": { "os": "linux",   "llm": "opencode", "model": "ollama/qwen3-coder:30b", "runner": "fleet-opencode" },
  "s9.3": { "os": "macos",   "llm": "opencode", "model": "ollama/qwen3-coder:30b", "runner": "fleet-opencode-mac" }
}
```

### Runner Requirements

- Self-hosted runner with Ollama installed and a model pulled (e.g. `qwen3-coder:30b`)
- OpenCode CLI installed (`npm install -g opencode-ai`)
- Network access to Ollama endpoint (localhost or LAN)
- `opencode.json` configured with the Ollama provider

Initially, this can run on `spark` (DGX Spark GB10) as the Ollama backend + a connected runner.

### Test Scenario

Reuse `fleet-e2e-toy` repo. The scenario:
1. Register an OpenCode member pointing at a local Ollama endpoint
2. `apra-fleet install --llm opencode` on the member
3. Dispatch a simple sprint: create a function + tests
4. Validate: PR exists, commits >= 10, final changeset clean, process discipline, beads closed

### Validation Gates (from apra-pm-lite e2e)

| Gate | Check |
|------|-------|
| pr-exists | `gh pr list` shows a PR |
| commits>=10 | `git log --oneline \| wc -l >= 10` |
| final-changeset-clean | PR diff has no process scaffolding |
| process-discipline | Intermediate commits DO contain scaffolding |
| beads-closed | P1 issues all closed |

### Integration with Existing E2E

- Same workflow file (`.github/workflows/fleet-e2e.yml`) -- add s9 matrix entries
- Same extract/validate scripts -- extend for opencode-specific parsing if needed
- Same members.json pattern -- add opencode member config

---

## 8. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | `opencode run --format json` output format is undocumented and may change between versions | High | High | Capture real output during development; version-pin opencode-ai in tests; write a resilient NDJSON parser that handles unknown event types gracefully |
| 2 | Submodule + npm vendoring adds build complexity; CI may break if submodule not initialized | Medium | Medium | `prepublishOnly` script with clear error messages; CI step to `git submodule update --init`; fallback to pre-built dist/ |
| 3 | OpenCode headless may hang on first run (trust/onboarding gate) with weak models | Medium | Medium | Always pass `--dangerously-skip-permissions`; document model requirements; e2e tests catch hangs via timeout |
| 4 | Agent frontmatter transform may miss edge cases (new tools, changed format) | Low | Medium | Test transform against all 4 agent files; version-pin submodule SHA; transform function has explicit unknown-tool handling |
| 5 | Repo rename breaks existing forks/clones/bookmarks | Medium | Low | GitHub auto-redirects old URL; update all docs/links; announce in release notes |
| 6 | Gap analysis misses a feature used by existing users | Low | High | Exhaustive file-by-file comparison (done above); solicit user feedback during review; backward-compat e2e test |
| 7 | OpenCode + local models unreliable for agentic loops (tool call failures) | Medium | Medium | Use proven models (qwen3-coder:30b); OpenCode's built-in recovery handles tool stumbles; e2e validates real agentic completion |
| 8 | Session resume (`--session <id>`) may not work reliably in headless mode | Medium | Low | Fall back to `--continue` (resume last session); test both paths |
| 9 | Dual-mode execution drift: local subagent and fleet member code paths diverge over time, breaking one mode while fixing the other | Medium | High | Explicit dual-mode acceptance criteria in every VERIFY checkpoint; e2e tests cover BOTH modes; mode-selection logic is a single well-tested function, not scattered conditionals |
| 10 | Per-member model_tiers map adds complexity to register_member and dispatch; invalid tier names or model IDs silently fail | Low | Medium | Validate tier keys at registration; dispatch-time resolution logs the resolved model; unit tests cover all fallback paths |

---

## 9. Alternatives Considered

### PM Skill Integration

| Approach | Considered | Reason for Decision |
|----------|------------|---------------------|
| Keep both old pm and pm-lite | Rejected | Maintenance burden, user confusion, duplicate logic |
| Merge pm-lite code directly into apra-fleet (no submodule) | Rejected | Loses independent development velocity on pm repo |
| Git subtree instead of submodule | Considered | Subtree merges are harder to update than submodule pins; submodule is cleaner |

### OpenCode Provider

| Approach | Considered | Reason for Decision |
|----------|------------|---------------------|
| Use Codex with --oss flag for local models | Rejected | Verified broken (section 1 of exploration doc) |
| Use OpenCode as a wrapper around other CLIs | Rejected | OpenCode IS the CLI -- it has its own tool set |
| Generic "custom" provider for any CLI | Considered | Too abstract; OpenCode has specific flags and behaviors that need a dedicated adapter |

### Agent Format

| Approach | Considered | Reason for Decision |
|----------|------------|---------------------|
| Maintain separate agent files per provider | Rejected | N copies drift; harder to maintain |
| Use Claude format everywhere (OpenCode reads it too) | Considered | OpenCode reads `.claude/skills/` but agents need native frontmatter for permissions |
| Canonical + transform at install | Chosen | Single source of truth; transform is simple YAML rewrite; future providers add a new transform |
