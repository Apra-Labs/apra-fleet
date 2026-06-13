# Design: OpenCode Provider + PM Submodule + Agent Install Epic

## 1. Current-State Map

### apra-fleet (this repo)

| Component | Path | Purpose |
|-----------|------|---------|
| Provider interface | `src/providers/provider.ts:49-115` | `ProviderAdapter` (24 methods), `PromptOptions`, `ParsedResponse` |
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
| 7 | Core rules (13 rules including project sandboxing, status.md updates, never read code, etc.) | SKILL.md:66-82 | SKILL.md (5 design principles) | **Partial** | **Port** | pm-lite has high-level design principles but lacks the explicit operational rules. Port rules: project sandboxing (#2), status.md updates (#3), tool verification (#4), idle prevention (#6), agent dispatch grouping (#8), unattended mode (#9), security audit in DoD (#11), PR lifecycle (#12-13). |
| 8 | Secrets & credentials reference | SKILL.md:85-87 | -- | Missing | **Port** | Reference to fleet secure credentials. Important for fleet execution. Add a section to pm SKILL.md noting `{{secure.NAME}}` usage. |
| 9 | Model selection (reference to fleet skill Model Tiers) | SKILL.md:102-103 | sprint.md (model assignment by planner) | **Present** | -- | pm-lite handles model assignment differently (planner chooses per-task tier). Both valid; pm-lite approach is more sophisticated. |
| 10 | Provider awareness (reference to fleet skill Provider Awareness) | SKILL.md:107-110 | -- | Missing | **Port** | When running via fleet, the orchestrator needs to know provider-specific behaviors (e.g., agent context file naming). Port a provider-awareness section referencing context-file equivalents. |
| 11 | Agent context file mechanism (provider-specific filenames, templates, delivery rules) | context-file.md (full doc) | doer-reviewer-loop.md (dispatch templates) | **Partial** | **Port partially** | pm-lite's dispatch templates embed the prompt inline. The context-file.md concept (persistent per-provider agent context file in work_folder) is fleet-specific. Port the provider-filename table. The dispatch template approach in pm-lite is simpler and works better for local subagents. For fleet: the provider-filename mapping is still needed. |
| 12 | Doer-reviewer setup checklist (pair, icons, permissions, context file) | doer-reviewer.md:3-13 | doer-reviewer-loop.md (implicit) | **Partial** | **Port** | pm-lite assumes local subagents where pairing is automatic. For fleet dispatch: port the setup checklist (pair assignment, icon override, permission composition, pre-dispatch verification). |
| 13 | Pre-flight checks (branch verification, clean tree, SHA matching before review) | doer-reviewer.md:17-28 | doer-reviewer-loop.md (partial) | **Partial** | **Port** | pm-lite has some git checks but not the explicit SHA-matching pre-review verification. Port the full pre-flight checks section. |
| 14 | Resume rules (data-driven from planned.json phase numbers, explicit table) | doer-reviewer.md:56-78, single-pair-sprint.md:83-101 | doer-reviewer-loop.md (dispatch fresh/continue) | **Partial** | **Port** | pm-lite uses fresh dispatches per role. The resume optimization (continuing the session within a phase) is valuable for fleet. Port the resume rule table with the planned.json phase-number derivation. |
| 15 | Safeguards table (max_turns, retry limit, cycle limit, model escalation) | doer-reviewer.md:83-88, single-pair-sprint.md:120-125 | doer-reviewer-loop.md (safeguards section) | **Present** | -- | pm-lite has equivalent safeguards: dispatch retry (3/dispatch), doer-reviewer cycle (3/phase), zero progress (escalate model). Same limits. |
| 16 | Git as transport (doer commits PLAN/progress, reviewer commits feedback, annotated findings) | doer-reviewer.md:92-99 | sprint.md (git is the message bus) | **Present** | -- | pm-lite uses git as the primary state transport. Equivalent. |
| 17 | Permissions section (compose_permissions, mid-sprint denial handling, stop_prompt) | doer-reviewer.md:103-117 | -- | Missing | **Port** | Fleet-specific: compose_permissions, permission denial recovery, stop_prompt. Port as a "Fleet Execution" addendum. |
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

**Must port (7 items):**
1. Sprint selection logic (simple/single/multi) -> SKILL.md
2. Explicit `/pm` command reference -> SKILL.md
3. Core operational rules (project sandboxing, status.md, tool verification, etc.) -> SKILL.md
4. Secrets/credentials reference -> SKILL.md
5. Provider awareness + context-file filename table -> new section
6. Pre-flight checks (SHA matching before review) -> doer-reviewer-loop.md
7. Fleet-specific sections (permissions, stop_prompt, unattended modes) -> new "Fleet Execution" addendum

**Should port (3 items):**
8. Simple sprint lightweight flow -> new file or section
9. Resume rules (data-driven from phase numbers) -> doer-reviewer-loop.md
10. Documentation harvest step -> sprint.md

**Drop (2 items):**
11. Fleet skill dependency bootstrap -- by design, pm has no fleet dep
12. Fleet skill references in SKILL.md header -- replaced by self-contained docs

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
  instructionFileName: 'OPENCODE.md'  // TBD: verify OpenCode project instruction file

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
    Parse NDJSON (one JSON object per line from --format json)
    Extract assistant messages, tool results, errors
    Build result string from last assistant content
    Extract session ID if present in events
    No usage tracking initially (OpenCode doesn't emit token counts in JSON mode -- TBD)

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
    NOTE: these are defaults for local Ollama -- user overrides via register_member

  modelForTier(tier) -> modelTiers()[tier] ?? modelTiers().standard
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

OpenCode `--format json` emits NDJSON events. Expected event types (from ai-sdk patterns):

```json
{"type": "text", "content": "..."}
{"type": "tool-call", "name": "edit", "args": {...}}
{"type": "tool-result", "name": "edit", "result": "..."}
{"type": "finish", "reason": "stop", "usage": {...}}
```

Parser strategy (mirrors codex.ts):
1. Split stdout by newlines
2. Filter lines starting with `{`
3. Parse each as JSON
4. Collect text content from `type: "text"` events
5. Check for error events
6. Return last meaningful text as result
7. Extract session ID from finish event if present

Risk: the exact JSON schema of `opencode run --format json` is not fully documented. Need to
capture real output during implementation and adjust the parser.

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
