<!-- llm-context: This is the reference table comparing LLM provider capabilities in apra-fleet (Claude, Gemini, Codex, Copilot). Consult when a user asks which provider supports a feature, what the limitations are, or which provider to choose for a role (PM, doer, reviewer). -->
<!-- keywords: provider, Claude, Gemini, Codex, Copilot, capabilities, max_turns, timeout, permissions, NDJSON, truncation, comparison -->
<!-- see-also: ../README.md (provider setup instructions), FAQ.md (common provider questions) -->

# Provider Matrix

Reference tables for all LLM providers supported by Apra Fleet. Extracted from `docs/multi-provider-plan.md`.

> Tracking issues: #26 (Gemini), #27 (OpenAI Codex), #35 (GitHub Copilot)

---

## Strategic Comparison

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

---

## Model Tier Equivalents

Used by the PM for model escalation (`cheap → mid → premium`).

| Tier | Purpose | Claude | Gemini | OpenAI Codex | Copilot |
|------|---------|--------|--------|--------------|---------|
| **cheap** | Execution, status, tests, deploys | `haiku` | `gemini-2.5-flash` | `gpt-5.4-mini` | `claude-haiku-4-5` |
| **mid** | Construction, code, config | `sonnet` | `gemini-2.5-pro` | `gpt-5.4` | `claude-sonnet-4-5` |
| **premium** | Planning, review, architecture | `opus` | `gemini-2.5-pro` (no separate tier) | `gpt-5.4` (no separate tier) | `claude-sonnet-4-5` (highest available) |

**Note:** Gemini and Codex currently lack a distinct premium tier beyond their best model. Copilot exposes Anthropic's Claude models directly, so it uses the same tier names.

---

## Unique Capabilities

Features available in non-Claude providers that Claude lacks natively.

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

---

## Critical Gaps & Mitigations

Known limitations when using non-Claude providers in a fleet.

| Gap | Provider(s) | Impact on Fleet | Mitigation |
|-----|------------|----------------|------------|
| **No `--max-turns`** | Gemini, Codex, Copilot | Can't bound execution by turn count | Use `timeout_ms` as the primary execution guard. `max_turns` is Claude-only and ignored for other providers. |
| **No server-side session ID in JSON output** | Gemini, Codex, Copilot | Can't store a session ID to pass back for `--resume` | Provider-specific approach: Claude stores `session_id` from JSON. Others use generic "resume last session" flag (`-r`, `exec resume`, `--continue`). |
| **NDJSON vs single JSON** | Codex | Response format differs from other providers | CodexProvider parser collects NDJSON events and extracts the final result + metadata from the last event. Transparent to tool code via `provider.parseResponse()`. |
| **OAuth credential copy doesn't work** | Gemini, Codex, Copilot | `provision_llm_auth` Flow A (copy `~/.claude/.credentials.json`) is Claude-only | For non-Claude providers: use the `api_key` parameter with the provider's env var (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`). OAuth/login must be done interactively on the member. |
| **Different credential file locations** | All | Credential paths differ per provider | `provider.credentialPath` supplies the correct path per provider. `credentialFileCheck` is Claude-specific (OAuth credentials); non-Claude providers rely on API key env var detection. |
| **Gemini output truncation** | Gemini | Responses silently truncate at ~8K tokens (known bug) | Document limitation. For large outputs, consider splitting tasks into smaller units. |
| **Copilot 64K context limit** | Copilot | Smallest context window — may struggle with large PLAN.md + codebase | Recommend Copilot for smaller, focused tasks. Auto-compaction helps but summarization loses detail. |
| **Copilot requires paid subscription** | Copilot | Not free-tier friendly | Copilot requires GitHub Copilot Pro/Business/Enterprise. No free API key path. |
| **Codex message quotas** | Codex | Rolling 5-hour message windows instead of token budgets | Long sprints may hit quota limits. Spread work across time or use API key tier. |
| **Permission model differences** | All | Claude uses `settings.local.json`. Others use CLI flags only. | For Claude members: continue using `compose_permissions` + `settings.local.json`. For others: `dangerously_skip_permissions=true` in `execute_prompt` (maps to provider's skip-permissions flag). No fine-grained per-tool permissions outside Claude. |

---

## Auth Env Var Reference

| Provider | Env Var | Source |
|----------|---------|--------|
| Claude | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Gemini | `GEMINI_API_KEY` | aistudio.google.com |
| Codex | `OPENAI_API_KEY` | platform.openai.com |
| Copilot | `COPILOT_GITHUB_TOKEN` | github.com/settings/tokens (fine-grained PAT with "Copilot Requests" permission) |

---

## Instruction File Names

Each provider auto-loads a provider-specific instruction file from the working directory.

| Provider | Auto-loaded file |
|----------|-----------------|
| Claude | `CLAUDE.md` |
| Gemini | `GEMINI.md` |
| Codex | `AGENTS.md` |
| Copilot | `COPILOT.md` |

When the PM sends task harness files via `send_files`, it renames `tpl-agent.md` to the correct filename per provider.
