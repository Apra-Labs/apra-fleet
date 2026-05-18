<!-- llm-context: User-facing guide for choosing an LLM provider in apra-fleet. Consult when a user asks which provider to use for a role (PM, doer, reviewer), what each provider is good at, or what limitations to expect. For CLI flags, credential paths, and integration internals, see provider-matrix.md. -->
<!-- keywords: provider, Claude, Gemini, Codex, Copilot, choose, role, PM, doer, reviewer, gotchas, limitations, context window, max_turns, OAuth -->
<!-- see-also: ../README.md (provider setup instructions), provider-matrix.md (full CLI and integration reference) -->

# Choosing an LLM Provider

Fleet supports Claude, Gemini, Codex, and Copilot. Members can run different providers and mix them freely within a single fleet.

## Provider strengths

- **Claude** -- Balanced coding and reasoning; fine-grained per-tool permissions via `settings.local.json`; OAuth credentials are copyable across members.
- **Gemini** -- 1M-token native context window; built-in Google Search for researching APIs and docs without an external tool.
- **Codex** -- Structured-output enforcement via `--output-schema`; native subagent parallelism for concurrent subtasks with less orchestration overhead.
- **Copilot** -- Multi-model marketplace (Claude + GPT families in one CLI); auto-compaction keeps sessions running indefinitely.

## Recommended provider by role

| Role | Recommended | Why |
|------|-------------|-----|
| PM (orchestrator) | Claude Opus/Sonnet, or Gemini `gemini-3.1-pro-preview` | Both plan and orchestrate well -- Gemini's orchestration support improved substantially in recent releases. |
| Doer | Any provider | Sonnet, Gemini, Codex, Copilot -- mix freely. |
| Reviewer | Premium-tier models | Catches subtle issues smaller models miss. |

## Gotchas worth knowing

- **`max_turns` is Claude-only.** On Gemini, Codex, and Copilot, use `timeout_s` instead to bound execution time.
- **Gemini can silently truncate large outputs.** If a task produces very large responses, split it into smaller units.
- **Copilot needs a paid GitHub Copilot subscription** (Pro, Business, or Enterprise) and has the smallest context window (64K). It is best suited for smaller, focused tasks.
- **OAuth credential copy is Claude-to-Claude only.** For other providers, supply an API key via the provider's env var (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`) or complete an interactive login on the member.

---

Extending Fleet's provider support, or need the full CLI / integration detail? See [docs/provider-matrix.md](provider-matrix.md).
