<!-- llm-context: This is the reference table comparing LLM provider capabilities in apra-fleet (Claude, Codex, Copilot, AGY). Consult when a user asks which provider supports a feature, what the limitations are, or which provider to choose for a role (PM, doer, reviewer). -->
<!-- keywords: provider, Claude, Codex, Copilot, AGY, capabilities, max_turns, timeout, permissions, NDJSON, truncation, comparison -->
<!-- see-also: ../README.md (provider setup instructions), FAQ.md (common provider questions) -->

# Provider Matrix

Reference tables for all LLM providers supported by Apra Fleet. Extracted from `docs/multi-provider-plan.md`.

> Tracking issues: #27 (OpenAI Codex), #35 (GitHub Copilot)

---

## Strategic Comparison

| Feature | Claude Code | Google Antigravity CLI (agy) | OpenAI Codex CLI | GitHub Copilot CLI |
|---------|-------------|------------------------------|------------------|-------------------|
| **Install** | Native binary / `curl \| bash` | `npm install -g @google/antigravity-cli` | `npm i -g @openai/codex` / Homebrew / binary (Node 18+) | `npm i -g @github/copilot` / Homebrew / WinGet |
| **Headless prompt** | `claude -p "..."` | `agy -p "..."` | `codex exec "..."` | `copilot -p "..."` |
| **Session resume** | `--resume <session_id>` | `--conversation "<session_id>"` | `codex exec resume` (positional) | `--continue` / `--resume` |
| **JSON output** | `--output-format json` | **Not available** | `--json` (NDJSON -- one event per state change) | `--format json` |
| **Model selection** | `--model opus/sonnet/haiku` | **Not available** (custom models configured in apra-fleet registry) | `--model` / `-m` | `--model <name>` or `/model` interactive |
| **Max turns** | `--max-turns N` | **Not available** | **Not available** | **Not available** (auto-compaction) |
| **Skip permissions** | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` | `--ask-for-approval never` + `--sandbox danger-full-access` | `--allow-all-tools` / `--yolo` |
| **Auth env var** | `ANTHROPIC_API_KEY` | `ANTIGRAVITY_API_KEY` | `OPENAI_API_KEY` (or `CODEX_API_KEY` in exec mode) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| **OAuth / login** | `~/.claude/.credentials.json` (copyable) | Browser OAuth / settings.json | `codex login` (ChatGPT account or API key) | `gh auth login` or `/login` (device flow) |
| **Version check** | `claude --version` | `agy --version 2>&1` | `codex --version` | `copilot --version` |
| **Install cmd (Linux)** | `curl -fsSL https://claude.ai/install.sh \| bash` | `npm install -g @google/antigravity-cli` | `npm i -g @openai/codex` | `curl -fsSL https://gh.io/copilot-install \| bash` |
| **Install cmd (macOS)** | `curl -fsSL https://claude.ai/install.sh \| bash` | `npm install -g @google/antigravity-cli` | `brew install --cask codex` | `brew install --cask copilot` |
| **Install cmd (Windows)** | `irm https://claude.ai/install.ps1 \| iex` | `npm install -g @google/antigravity-cli` | Binary from GitHub releases (experimental) | `winget install GitHub.CopilotCLI` |
| **Update command** | `claude update` | `agy update` | `npm update -g @openai/codex` | `copilot update` |
| **Process name** | `claude` | `agy` | `codex` | `copilot` |
| **Credential path** | `~/.claude/.credentials.json` | `~/.gemini/antigravity-cli/settings.json` | `~/.codex/` | `~/.config/gh/` or `~/.copilot/` |
| **Session storage** | Fleet-minted UUID; passed as `--session-id <id>`; resumed with `--resume <id>` | Local cache; resumed with `--conversation "<session_id>"` | Local (exec resume) | Local: `~/.copilot/session-state/` (SQLite) |
| **Agentic capabilities** | File edit, shell, MCP tools | File edit, shell, MCP tools, web search, beads | File edit, shell, MCP tools, subagents | File edit, shell, MCP tools, custom agents |
| **Context window** | 200K (Sonnet) / 1M (Opus 4.7) | 1M tokens | 192K tokens | 64K tokens (auto-compaction at 95%) |

---

## Model Tier Equivalents

Used by the PM for model escalation (`cheap -> mid -> premium`).

| Tier | Purpose | Claude | Antigravity | OpenAI Codex | Copilot |
|------|---------|--------|-------------|--------------|---------|
| **cheap** | Execution, status, tests, deploys | `haiku` | `gemini-3.5-flash-lite` | `gpt-5.4-mini` | `claude-haiku-4-5` |
| **mid** | Construction, code, config | `sonnet` | `gemini-3.5-flash` | `gpt-5.4` | `claude-sonnet-4-5` |
| **premium** | Planning, review, architecture | `opus` | `claude-sonnet-4.6` | `gpt-5.4` (no separate tier) | `claude-sonnet-4-5` (highest available) |

**Note:** Codex currently lacks a distinct premium tier beyond its best model. Copilot exposes Anthropic's Claude models directly, so it uses the same tier names.

---

## Unique Capabilities

Features available in non-Claude providers that Claude lacks natively.

| Feature | Available In | Not In Claude | Impact on Fleet |
|---------|-------------|--------------|-----------------|
| **Output schema enforcement** | Codex (`--output-schema <file>`) | Claude | Codex can guarantee response conforms to a JSON Schema -- enables structured extraction |
| **Multi-model marketplace** | Copilot (Claude + GPT models) | Claude | Copilot users choose between Claude and GPT families without switching CLI |
| **Auto-compaction** | Copilot, Codex | Claude (context just fills up) | Infinite-length sessions via automatic context summarization at 95% capacity |
| **Native subagent parallelism** | Codex | Claude (requires external orchestration like fleet) | Codex can fork subtasks internally -- less need for fleet orchestration on simple parallel work |
| **Custom agent profiles** | Copilot (Markdown agent definitions) | Claude (CLAUDE.md is similar but informal) | Copilot has a formalized `agents/` directory with typed profiles |

---

## Critical Gaps & Mitigations

Known limitations when using non-Claude providers in a fleet.

| Gap | Provider(s) | Impact on Fleet | Mitigation |
|-----|------------|----------------|------------|
| **No `--max-turns`** | Codex, Copilot | Can't bound execution by turn count | Use `timeout_s` as the primary execution guard. `max_turns` is Claude-only and ignored for other providers. |
| **No caller-minted session ID** | Codex, Copilot | Fleet cannot pass a specific session ID for targeted resume | Fleet mints a UUID and passes `--session-id <id>` (new session) or `--resume <id>` (resumed session) for Claude. Codex and Copilot resume the most-recent local session via a generic flag (`codex exec resume`, `--continue`). |
| **NDJSON vs single JSON** | Codex | Response format differs from other providers | CodexProvider parser collects NDJSON events and extracts the final result + metadata from the last event. Transparent to tool code via `provider.parseResponse()`. |
| **OAuth credential copy doesn't work** | Codex, Copilot | `provision_llm_auth` Flow A (copy `~/.claude/.credentials.json`) is Claude-only | For Codex and Copilot: use the `api_key` parameter with the provider's env var (`OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`). OAuth/login must be done interactively on the member. |
| **Different credential file locations** | All | Credential paths differ per provider | `provider.credentialPath` supplies the correct path per provider. `credentialFileCheck` is Claude-specific (OAuth credentials); non-Claude providers rely on API key env var detection. |
| **Copilot 64K context limit** | Copilot | Smallest context window -- may struggle with large PLAN.md + codebase | Recommend Copilot for smaller, focused tasks. Auto-compaction helps but summarization loses detail. |
| **Copilot requires paid subscription** | Copilot | Not free-tier friendly | Copilot requires GitHub Copilot Pro/Business/Enterprise. No free API key path. |
| **Codex message quotas** | Codex | Rolling 5-hour message windows instead of token budgets | Long sprints may hit quota limits. Spread work across time or use API key tier. |
| **Permission model differences** | All | Claude uses `settings.local.json`. Others use CLI flags only. | For Claude members: continue using `compose_permissions` + `settings.local.json`. For others: use `update_member(unattended='dangerous')` to pass the provider's skip-permissions flag. No fine-grained per-tool permissions outside Claude. |

---

## Auth Env Var Reference

| Provider | Env Var | Source |
|----------|---------|--------|
| Claude | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Antigravity (agy) | `ANTIGRAVITY_API_KEY` | aistudio.google.com |
| Codex | `OPENAI_API_KEY` | platform.openai.com |
| Copilot | `COPILOT_GITHUB_TOKEN` | github.com/settings/tokens (fine-grained PAT with "Copilot Requests" permission) |

---

## Instruction File Names

Each provider auto-loads a provider-specific instruction file from the working directory.

| Provider | Auto-loaded file |
|----------|-----------------|
| Claude | `CLAUDE.md` |
| Antigravity (agy) | `GEMINI.md` |
| Codex | `AGENTS.md` |
| Copilot | `COPILOT.md` |

When the PM sends task harness files via `send_files`, it renames `tpl-agent.md` to the correct filename per provider.
