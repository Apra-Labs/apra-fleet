# Multi-Provider Support Plan

> Tracking issues: #26 (Gemini), #27 (OpenAI Codex), #35 (GitHub Copilot)

## Context

Apra Fleet is currently Claude-only: every member runs Claude Code CLI, auth provisions `ANTHROPIC_API_KEY` or Claude OAuth, session semantics assume `claude -p` / `--resume` / `--output-format json`, and the PM skill hardcodes Claude model tiers (haiku/sonnet/opus). Issues #26, #27, and #35 request support for Gemini CLI, OpenAI Codex CLI, and GitHub Copilot CLI respectively — with mix-and-match capability within a single fleet.

This plan covers: (1) research and gap analysis across all four providers, (2) a provider abstraction layer in the MCP server, (3) PM skill generalization, and (4) documentation updates.

---

## Phase 0: Research — Provider Feature Parity

Before writing code, document the CLI equivalents for every Claude concept we depend on. This section is the deliverable of Phase 0 and becomes a reference doc committed as `docs/provider-matrix.md`.

### Strategic Comparison Table

| Feature | Claude Code | Gemini CLI | OpenAI Codex CLI | GitHub Copilot CLI |
|---------|-------------|------------|------------------|-------------------|
| **Install** | Native binary / `curl \| bash` | `npm i -g @google/gemini-cli` (Node 20+) | `npm i -g @openai/codex` / Homebrew / binary (Node 18+) | `npm i -g @github/copilot` / Homebrew / WinGet |
| **Headless prompt** | `claude -p "..."` | `gemini -p "..."` | `codex exec "..."` | `copilot -p "..."` |
| **Session resume** | `--resume <session_id>` | `-r` / `--resume` (loads most recent) | `codex exec resume` (positional) | `--continue` / `--resume` |
| **JSON output** | `--output-format json` | `--output-format json` (also `stream-json`) | `--json` (NDJSON — one event per state change) | `--format json` |
| **Model selection** | `--model opus/sonnet/haiku` | `--model <name>` or `GEMINI_MODEL` env var | `--model` / `-m` | `--model <name>` or `/model` interactive |
| **Max turns** | `--max-turns N` | **Not available** | **Not available** | **Not available** (auto-compaction) |
| **Skip permissions** | `--dangerously-skip-permissions` | `--yolo` / `-y` | `--ask-for-approval never` + `--sandbox danger-full-access` | `--allow-all-tools` / `--yolo` |
| **Auth env var** | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` | `OPENAI_API_KEY` (or `CODEX_API_KEY` in exec mode) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| **OAuth / login** | `~/.claude/.credentials.json` (copyable) | Google OAuth (browser-based, not copyable) | `codex login` (ChatGPT account or API key) | `gh auth login` or `/login` (device flow) |
| **Version check** | `claude --version` | `gemini --version` | `codex --version` | `copilot --version` |
| **Install cmd (Linux)** | `curl -fsSL https://claude.ai/install.sh \| bash` | `npm i -g @google/gemini-cli` | `npm i -g @openai/codex` | `curl -fsSL https://gh.io/copilot-install \| bash` |
| **Install cmd (macOS)** | `curl -fsSL https://claude.ai/install.sh \| bash` | `npm i -g @google/gemini-cli` | `brew install --cask codex` | `brew install --cask copilot` |
| **Install cmd (Windows)** | `irm https://claude.ai/install.ps1 \| iex` | `npm i -g @google/gemini-cli` | Binary from GitHub releases (experimental) | `winget install GitHub.CopilotCLI` |
| **Update command** | `claude update` | `npm update -g @google/gemini-cli` | `npm update -g @openai/codex` | `copilot update` |
| **Process name** | `claude` | `gemini` | `codex` | `copilot` |
| **Credential path** | `~/.claude/.credentials.json` | `~/.gemini/` | `~/.codex/` | `~/.config/gh/` or `~/.copilot/` |
| **Session storage** | Server-side (session_id in JSON output) | Local: `~/.gemini/tmp/<hash>/chats/` | Local (exec resume) | Local: `~/.copilot/session-state/` (SQLite) |
| **Agentic capabilities** | File edit, shell, MCP tools | File edit, shell, web search, MCP tools | File edit, shell, MCP tools, subagents | File edit, shell, MCP tools, custom agents |
| **Context window** | 200K (Sonnet) / 1M (Opus 4.6) | 1M tokens | 192K tokens | 64K tokens (auto-compaction at 95%) |

### Model Tier Equivalents (PM escalation logic)

| Tier | Purpose | Claude | Gemini | OpenAI Codex | Copilot |
|------|---------|--------|--------|--------------|---------|
| **Cheap** | Execution, status, tests, deploys | `haiku` | `gemini-2.5-flash` | `gpt-5.4-mini` | `claude-haiku-4-5` |
| **Mid** | Construction, code, config | `sonnet` | `gemini-2.5-pro` | `gpt-5.4` | `claude-sonnet-4-5` |
| **Premium** | Planning, review, architecture | `opus` | `gemini-2.5-pro` (no separate tier) | `gpt-5.4` (no separate tier) | `claude-opus-4-5` |

**Note:** Gemini and Codex currently lack a distinct premium tier beyond their best model. Copilot exposes Anthropic's Claude models directly, so it uses the same tier names.

### Unique Capabilities We're Missing in Claude

| Feature | Available In | Not In Claude | Impact on Fleet |
|---------|-------------|--------------|-----------------|
| **1M token native context** | Gemini | Claude caps at 200K (Sonnet), 1M only on Opus 4.6 | Gemini members can ingest larger codebases in single pass |
| **Built-in Google Search** | Gemini | Claude needs external MCP tool | Gemini agents can web-search natively — useful for researching APIs, docs |
| **Output schema enforcement** | Codex (`--output-schema <file>`) | Claude | Codex can guarantee response conforms to a JSON Schema — enables structured extraction |
| **Multi-model marketplace** | Copilot (Claude + GPT models) | Claude | Copilot users choose between Claude and GPT families without switching CLI |
| **Auto-compaction** | Copilot, Codex | Claude (context just fills up) | Infinite-length sessions via automatic context summarization at 95% capacity |
| **Native subagent parallelism** | Codex | Claude (requires external orchestration like fleet) | Codex can fork subtasks internally — less need for fleet orchestration on simple parallel work |
| **Custom agent profiles** | Copilot (Markdown agent definitions) | Claude (CLAUDE.md is similar but informal) | Copilot has a formalized `agents/` directory with typed profiles |
| **Session browser** | Gemini (`/resume` interactive picker) | Claude (only has `--resume <id>`) | Gemini users can browse and search past sessions interactively |

### Critical Gaps & Mitigations

| Gap | Provider(s) | Impact on Fleet | Mitigation |
|-----|------------|----------------|------------|
| **No `--max-turns`** | Gemini, Codex, Copilot | Can't bound execution by turn count | Use `timeout_ms` as the primary execution guard. Document that `max_turns` is Claude-only. Accept that other providers run until done or timeout. |
| **No server-side session ID in JSON output** | Gemini, Codex, Copilot | Can't store a session ID to pass back for `--resume` | Provider-specific approach: Claude stores `session_id` from JSON. Others use generic "resume last session" flag (`-r`, `exec resume`, `--continue`) — store boolean `hasSession: true` in registry instead of ID. |
| **NDJSON vs single JSON** | Codex | `parseResponse()` expects single JSON object | Write a Codex-specific parser that collects NDJSON events and extracts the final result + metadata from the last event. |
| **OAuth credential copy doesn't work** | Gemini, Codex, Copilot | `provision_auth` Flow A (copy `~/.claude/.credentials.json`) is Claude-only | For non-Claude providers: support API key flow only. Document that OAuth/login must be done interactively on the member (or via `execute_command` with provider's login command). |
| **Different credential file locations** | All | `credentialFileCheck/Write/Remove` in OsCommands is hardcoded to `~/.claude/` | Move credential path to `ProviderAdapter.credentialPath`. OsCommands delegates to provider. |
| **Gemini output truncation** | Gemini | Responses silently truncate at ~8K tokens (known bug) | Document limitation. For large outputs, consider `stream-json` mode or splitting tasks into smaller units. |
| **Copilot 64K context limit** | Copilot | Smallest context window — may struggle with large PLAN.md + codebase | Document. Recommend Copilot for smaller, focused tasks. Auto-compaction helps but summarization loses detail. |
| **Copilot requires paid subscription** | Copilot | Not free-tier friendly | Document that Copilot requires GitHub Copilot Pro/Business/Enterprise. No free API key path. |
| **Codex message quotas** | Codex | Rolling 5-hour message windows instead of token budgets | Document. Long sprints may hit quota limits. Mitigation: spread work across time or use API key tier. |
| **Permission model differences** | All | Claude uses `settings.local.json`. Others use CLI flags. | For Claude members: continue using `compose_permissions` + `settings.local.json`. For others: pass skip-permissions flag in `execute_prompt` and document that fine-grained permissions require each provider's native config. |

---

## Detailed Provider Research

### Gemini CLI

**Package:** `@google/gemini-cli` on npm (requires Node.js 20+)

**Authentication (3 methods):**
1. **Google Account (default):** Run `gemini`, login via browser (OAuth 2.0). Simplest for personal machines.
2. **API Key:** Set `GEMINI_API_KEY` env var. Obtain from Google AI Studio (aistudio.google.com). Auto-loads from `~/.gemini/.env`.
3. **Google Cloud / Vertex AI:** Set `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`. Uses Application Default Credentials (ADC).

**Headless mode:** `-p` / `--prompt` flag (same as Claude). Also activates automatically in non-TTY environments.

**Session management:**
- `--resume` / `-r` loads most recent session
- Interactive: `/resume` opens Session Browser (search, filter, select)
- Storage: `~/.gemini/tmp/<project_hash>/chats/`
- Saves: full conversation history, tool executions, token usage
- Auto-cleanup: 30-day retention (configurable via `/settings`)

**JSON output:** `--output-format json` (single JSON object with `response` and `stats` fields) or `--output-format stream-json` (NDJSON).

**Models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-pro`, `gemini-3-flash`, `auto`. Select via `--model` or `GEMINI_MODEL` env var. `/model` to switch mid-session.

**Built-in tools:** Codebase Investigator, Edit, FindFiles, GoogleSearch, ReadFile, ReadFolder, SaveMemory, SearchText, Shell, WriteFile, WriteTodos, WebFetch.

**Permissions:** Default prompts for approval. `--yolo` / `-y` disables sandbox and auto-approves all. No fine-grained `settings.local.json` equivalent.

**Token limits:** 1M input. Output defaults to ~8K tokens for gemini-2.5-pro (silently truncates — known issue). No `--max-turns`.

**Update:** `npm update -g @google/gemini-cli`. Stable releases weekly (Tuesday UTC 20:00). Has auto-update detection on startup.

### OpenAI Codex CLI

**Package:** `@openai/codex` on npm (Node.js 18+). Also available via Homebrew (`brew install --cask codex`) and standalone binaries.

**Authentication:**
1. **Interactive:** `codex login` (sign in with ChatGPT account or API key)
2. **Env var:** `OPENAI_API_KEY` (standard) or `CODEX_API_KEY` (CI-specific, only in `codex exec`)
3. **Programmatic:** `printenv OPENAI_API_KEY | codex login --with-api-key`

**Headless mode:** `codex exec "prompt"` — runs single session to completion. Streams progress to stderr, results to stdout. Approval requests cause immediate failure unless auto-approved.

**Session resume:** `codex exec resume` (positional, continues previous session).

**JSON output:** `--json` flag in exec mode. Emits NDJSON (one JSON event per state change). Also supports `--output-schema <file>` for enforced structured output.

**Models:** `gpt-5.4` (default), `gpt-5.4-mini`, `gpt-5.3-Codex`, `gpt-5.3-Codex-Spark` (Pro only). Select via `--model` / `-m`. Check available: `openai models list`.

**Approval modes (3 tiers):**
1. **Suggest (default):** Requires approval for every action
2. **Auto-edit:** Auto-applies file changes, prompts for shell commands
3. **Full-auto:** Complete autonomy

**Flags:** `--ask-for-approval never` disables prompts. `--sandbox` modes: `read-only`, `auto` (default), `danger-full-access`. Switch mid-session: `/approvals auto`, `/approvals full`.

**Context:** 192K tokens. Quota: rolling 5-hour message windows (varies by plan). No hard turn limit.

**Update:** `npm update -g @openai/codex` (no built-in `codex update`). Known version-reporting bug.

### GitHub Copilot CLI

**Package:** `@github/copilot` on npm. Also via Homebrew, WinGet, or install script (`curl -fsSL https://gh.io/copilot-install | bash`). Requires active Copilot subscription (Pro/Pro+/Business/Enterprise).

**Important:** The old `gh copilot` extension (suggest/explain only) was deprecated October 2025. The current Copilot CLI is a standalone fully-agentic tool.

**Authentication:**
1. **OAuth Device Flow (default):** `/login` → one-time code → browser auth
2. **Env vars (CI):** `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` (fine-grained PAT with "Copilot Requests" permission)
3. **GitHub CLI fallback:** Uses `gh` token automatically

**Headless mode:** `-p` / `--prompt` flag for single-shot execution. Autopilot mode with `--allow-all-tools`.

**Session resume:** `--continue` / `--resume`. Interactive: `/resume`. Storage: `~/.copilot/session-state/` (SQLite).

**JSON output:** `--format json`.

**Models:** Claude Sonnet 4.5 (default), Claude Opus 4.5 (Preview), Claude Haiku 4.5, Claude Sonnet 4, GPT-5.1, GPT-5.1-Codex, GPT-5. Select via `--model` or `/model`. Availability depends on subscription tier + org policy.

**Agentic capabilities:** `read_file`, `edit_file`, `run_in_terminal` tools. Plan mode for multi-step tasks. Custom agent profiles via Markdown definitions. `/fleet` for parallel subagent execution.

**Permissions:** Interactive approval (Once/Session/Permanent/Deny). `--allow-tool <name>`, `--deny-tool <name>`, `--allow-all` / `--yolo`. Per-location permission storage.

**Context:** 64K tokens advertised. Auto-compaction at 95% capacity (summarizes history for infinite sessions). ~50-60K reserved for responses.

**Update:** `copilot --version` to check. `copilot update` to update. Current version: 1.0.12.

---

## Phase 1: Provider Abstraction Layer (MCP Server)

### 1.1 Types — `src/types.ts`

Add `llmProvider` field to the `Agent` interface:

```typescript
export type LlmProvider = 'claude' | 'gemini' | 'codex' | 'copilot';

export interface Agent {
  // ... existing fields ...
  llmProvider?: LlmProvider;  // default: 'claude' for backwards compat
}
```

**Migration:** Existing registries without `llmProvider` default to `'claude'`. No migration script — handle in `getAgent()` with `agent.llmProvider ?? 'claude'`.

### 1.2 Provider Adapter Interface — `src/providers/provider.ts` (new)

```typescript
export interface ProviderAdapter {
  readonly name: LlmProvider;
  readonly processName: string;          // 'claude' | 'gemini' | 'codex' | 'copilot'
  readonly authEnvVar: string;           // 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY' | etc.
  readonly credentialPath: string;       // '~/.claude/.credentials.json' | etc.
  readonly instructionFileName: string;  // 'CLAUDE.md' | 'GEMINI.md' | 'AGENTS.md' | 'COPILOT.md'

  // CLI command building
  cliCommand(args: string): string;
  versionCommand(): string;
  installCommand(os: 'linux' | 'macos' | 'windows'): string;
  updateCommand(): string;

  // Prompt building
  buildPromptCommand(opts: PromptOptions): string;

  // Permission bypass flag
  skipPermissionsFlag(): string;

  // Response parsing
  parseResponse(result: SSHExecResult): ParsedResponse;

  // Session management
  supportsResume(): boolean;
  supportsMaxTurns(): boolean;
  resumeFlag(sessionId?: string): string;

  // Model tier mapping
  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string;
  modelFlag(model: string): string;

  // Error classification
  classifyError(output: string): PromptErrorCategory;

  // Auth capabilities
  supportsOAuthCopy(): boolean;
  supportsApiKey(): boolean;
}
```

### 1.3 Provider Implementations — `src/providers/` (new directory)

```
src/providers/
  provider.ts         — interface + PromptOptions type + ParsedResponse type
  claude.ts           — ClaudeProvider (extract from current linux.ts + prompt-errors.ts)
  gemini.ts           — GeminiProvider
  codex.ts            — CodexProvider (handles NDJSON parsing)
  copilot.ts          — CopilotProvider
  index.ts            — getProvider(llmProvider: LlmProvider): ProviderAdapter
```

### 1.4 OsCommands Refactoring — `src/os/os-commands.ts`

Current interface mixes OS concerns with CLI concerns. Separate them:

**Remove from OsCommands:** `claudeCommand`, `claudeVersion`, `claudeCheck`, `installClaude`, `updateClaude`, `buildPromptCommand`

**Add to OsCommands (provider-generic):**
```typescript
agentCommand(provider: ProviderAdapter, args: string): string;
agentVersion(provider: ProviderAdapter): string;
installAgent(provider: ProviderAdapter): string;
updateAgent(provider: ProviderAdapter): string;
buildPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string;
```

Each OS implementation handles shell wrapping (PATH prepend, base64 decode syntax). The provider supplies CLI-specific parts (binary name, flags, JSON format).

### 1.5 Tool Changes

| Tool | Change |
|------|--------|
| `register-member.ts` | Add `llm_provider` param (optional, default `'claude'`). Use provider adapter for CLI detection. |
| `execute-prompt.ts` | Route through `provider.buildPromptCommand()`, `provider.parseResponse()`, `provider.classifyError()`. Session resume via `provider.resumeFlag()`. `max_turns` only passed when `provider.supportsMaxTurns()`. |
| `provision-auth.ts` | Flow A (OAuth copy): Claude only. Flow B (API key): use `provider.authEnvVar`. Verification via provider's CLI. |
| `update-claude.ts` | Rename to `update-agent-cli.ts`. Keep `update_claude` as alias. Use provider's install/update commands. |
| `prompt-errors.ts` | Thin wrapper delegates to `provider.classifyError()`. Keep shared `PromptErrorCategory` + `isRetryable()`. |
| `check-status.ts` | `fleetProcessCheck()` uses `provider.processName` instead of hardcoded `"claude"`. |
| `member-detail.ts` | Show `llmProvider` in detail output. |
| `remove-member.ts` | Cleanup uses `provider.credentialPath` and `provider.authEnvVar`. |
| `update-member.ts` | Add `llm_provider` as updatable field. |
| `list-members.ts` | Show provider in listing. |

### 1.6 Registry Migration

No schema version bump. `llmProvider` is optional, defaults to `'claude'`. Existing registries unchanged.

### 1.7 Index / Tool Registration — `src/index.ts`

- Register `update_agent_cli` (keep `update_claude` alias)
- Update tool descriptions: "Claude" → "LLM agent" where appropriate
- `execute_prompt`: "Run an LLM prompt on a member"
- `provision_auth`: note multi-provider support

---

## Phase 2: PM Skill Generalization

### 2.1 Model Escalation

**Current (SKILL.md):** `haiku → sonnet → opus` hardcoded

**New:** Tier-based with provider mapping:
```
cheap → mid → premium

Claude:  haiku → sonnet → opus
Gemini:  gemini-2.5-flash → gemini-2.5-pro → gemini-2.5-pro
Codex:   gpt-5.4-mini → gpt-5.4 → gpt-5.4
Copilot: claude-haiku-4-5 → claude-sonnet-4-5 → claude-opus-4-5
```

PM reads member's `llmProvider` from `member_detail` and uses the appropriate model name.

### 2.2 Template Updates

| File | Change |
|------|--------|
| `tpl-claude.md` → `tpl-agent.md` | Generic execution model. No Claude-specific references. Provider-agnostic git workflow. |
| `tpl-claude-pm.md` | Keep as-is (PM is always Claude Code) |
| `SKILL.md` | Tier-based model selection + mapping table. Provider-aware recovery section. |
| `doer-reviewer.md` | Remove session ID assumptions. Note: review dispatches use `resume=false` (already correct for all providers). |
| `troubleshooting.md` | Add provider-specific error patterns and escalation paths. |

### 2.3 Instruction File Naming

| Provider | Auto-loaded file | PM sends `tpl-agent.md` as... |
|----------|-----------------|-------------------------------|
| Claude | `CLAUDE.md` | `CLAUDE.md` |
| Gemini | `GEMINI.md` | `GEMINI.md` |
| Codex | `AGENTS.md` | `AGENTS.md` |
| Copilot | `COPILOT.md` | `COPILOT.md` |

PM's `send_files` must rename `tpl-agent.md` to the correct filename per provider.

### 2.4 Permission Handling

| Provider | Permission mechanism | PM approach |
|----------|---------------------|-------------|
| Claude | `settings.local.json` via `compose_permissions` | Continue using `compose_permissions` + `send_files` |
| Gemini | `--yolo` flag (no fine-grained file-based config) | Pass `dangerously_skip_permissions=true` in `execute_prompt` (maps to `--yolo`) |
| Codex | `--sandbox` + `--ask-for-approval` flags | Pass `dangerously_skip_permissions=true` (maps to `--sandbox danger-full-access --ask-for-approval never`) |
| Copilot | `--allow-all-tools` flag + per-location permissions | Pass `dangerously_skip_permissions=true` (maps to `--allow-all-tools`) |

**Key difference:** Claude's `compose_permissions` delivers fine-grained per-tool permissions (allow Bash but not sudo, allow Edit but not delete). Other providers are all-or-nothing. Document this limitation.

---

## Phase 3: Documentation

| Doc | Change |
|-----|--------|
| **`docs/provider-matrix.md`** (new) | Phase 0 deliverable — all comparison tables from this plan |
| **`docs/architecture.md`** | Add "Provider Abstraction" section. Updated architecture diagram showing Provider layer. Mix-and-match explanation. |
| **`docs/tools-lifecycle.md`** | `register_member`: document `llm_provider`. `update_member`: `llm_provider` updatable. `remove_member`: provider-specific cleanup. Rename `update_claude` → `update_agent_cli`. |
| **`docs/tools-work.md`** | `execute_prompt`: provider-aware behavior, note `max_turns` is Claude-only. `provision_auth`: per-provider auth flows. |
| **`docs/tools-infrastructure.md`** | Multi-provider auth + install/update. |
| **`docs/user-guide.md`** | Multi-provider setup guide. Mix-and-match fleet examples. Provider selection guidance. |
| **`docs/vocabulary.md`** | Add "provider" / "LLM backend" terminology. |

---

## Phase 4: Testing

### 4.1 Unit Tests
- Provider adapter tests: each provider builds correct CLI commands for all three OS
- `parseResponse` tests per provider (single JSON, NDJSON, etc.)
- Error classification tests per provider
- Backwards compatibility: agents without `llmProvider` default to Claude
- Model tier mapping tests

### 4.2 Integration Tests (mock SSH)
- Register member with each provider type
- Execute prompt with each provider
- Provision auth with API key for each provider
- Update agent CLI for each provider
- Mixed fleet: dispatch to Claude member and Gemini member in same test
- Process detection: `fleetProcessCheck` with each provider's process name

### 4.3 Manual Validation
- Install Gemini CLI, Codex CLI, Copilot CLI on a test machine
- Run each CLI headless with the exact commands the fleet would generate
- Verify JSON output parsing matches `parseResponse` expectations
- Verify session resume works per provider
- Verify error detection patterns match real CLI error output
- Verify process name detection in `ps` output

---

## Implementation Order

1. **Phase 0** — Validate CLI flags hands-on, commit `docs/provider-matrix.md`
2. **Phase 1.1–1.3** — Types + Provider interface + four implementations (no tool changes yet, tests pass)
3. **Phase 1.4** — OsCommands refactoring (all OS files, tests pass)
4. **Phase 1.5** — Tool changes (one at a time: execute-prompt → provision-auth → update-claude → register → remove → status → rest)
5. **Phase 2** — PM skill updates (parallel with late Phase 1.5)
6. **Phase 3** — Docs (parallel with Phase 2)
7. **Phase 4** — Comprehensive test pass

### New Files

- `src/providers/provider.ts` — interface + shared types
- `src/providers/claude.ts` — ClaudeProvider
- `src/providers/gemini.ts` — GeminiProvider
- `src/providers/codex.ts` — CodexProvider
- `src/providers/copilot.ts` — CopilotProvider
- `src/providers/index.ts` — factory
- `docs/provider-matrix.md` — reference tables

### Modified Files

- `src/types.ts` — `LlmProvider` type + `llmProvider` field
- `src/os/os-commands.ts` — generalize CLI methods
- `src/os/linux.ts` — implement generic agent methods
- `src/os/macos.ts` — implement generic agent methods
- `src/os/windows.ts` — implement generic agent methods
- `src/tools/execute-prompt.ts` — provider-aware prompt building + parsing
- `src/tools/provision-auth.ts` — multi-provider auth flows
- `src/tools/update-claude.ts` → rename to `src/tools/update-agent-cli.ts`
- `src/tools/register-member.ts` — `llm_provider` param
- `src/tools/update-member.ts` — `llm_provider` updatable
- `src/tools/remove-member.ts` — provider-aware cleanup
- `src/tools/check-status.ts` — provider-aware process detection
- `src/tools/member-detail.ts` — show provider
- `src/tools/list-members.ts` — show provider
- `src/utils/prompt-errors.ts` — delegate to provider
- `src/index.ts` — tool names + descriptions
- `skills/pm/SKILL.md` — tier-based model selection, provider awareness
- `skills/pm/tpl-claude.md` → rename to `skills/pm/tpl-agent.md`
- `skills/pm/doer-reviewer.md` — provider notes
- `skills/pm/troubleshooting.md` — provider-specific rows
- `docs/architecture.md` — provider abstraction section
- `docs/tools-lifecycle.md` — new params, renamed tools
- `docs/tools-work.md` — provider-aware behavior
- `docs/tools-infrastructure.md` — multi-provider auth/update
- `docs/user-guide.md` — multi-provider setup
- `docs/vocabulary.md` — provider terminology

---

## Verification

1. `npm test` — all existing tests pass (backwards compat, no `llmProvider` = Claude)
2. `npm run build` — compiles cleanly
3. Register member with `llm_provider: 'gemini'` — verify `gemini --version` used
4. `execute_prompt` on Gemini member — verify `gemini -p` command built correctly
5. `provision_auth` with Gemini API key — verify `GEMINI_API_KEY` set
6. `fleet_status` with mixed fleet — verify process detection per provider
7. PM model escalation — tier names map to correct models per provider
8. Manual: run each provider CLI headless, compare output to `parseResponse` expectations
