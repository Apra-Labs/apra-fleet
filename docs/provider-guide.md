<!-- llm-context: User-facing guide for choosing an LLM provider in apra-fleet. Consult when a user asks which provider to use for a role (PM, doer, reviewer), what each provider is good at, or what limitations to expect. For CLI flags, credential paths, and integration internals, see provider-matrix.md. -->
<!-- keywords: provider, Claude, Gemini, Codex, Copilot, choose, role, PM, doer, reviewer, gotchas, limitations, context window, max_turns, OAuth -->
<!-- see-also: ../README.md (provider setup instructions), provider-matrix.md (full CLI and integration reference) -->

# Choosing an LLM Provider

Fleet supports Claude, Antigravity (agy), Codex, Copilot, and Gemini. Members can run different providers and mix them freely within a single fleet.

## Provider strengths

- **Claude** - Balanced coding and reasoning; fine-grained per-tool permissions via `settings.local.json`.
- **Antigravity** - High-performance Gemini-based agentic CLI; supports large context windows, background tasks, and native beads task tracking.
- **Codex** - Structured-output enforcement via `--output-schema`; native subagent parallelism for concurrent subtasks with less orchestration overhead.
- **Copilot** - Multi-model marketplace (Claude + GPT families in one CLI); auto-compaction keeps sessions running indefinitely.
- **Gemini** - 1M-token native context window; built-in Google Search for researching APIs and docs without an external tool.

## Recommended provider by role

| Role | Recommended | Why |
|------|-------------|-----|
| PM (orchestrator) | Claude Code or Antigravity (agy) | Both plan and orchestrate well - both support planning, background tasks, and premium models (e.g., Opus / premium-tier). |
| Doer | Any provider | Sonnet, Antigravity, Codex, Copilot, Gemini - mix freely. |
| Reviewer | Premium-tier models | Catches subtle issues smaller models miss. |

## Gotchas worth knowing

- **`max_turns` is Claude-only.** On Gemini, Codex, Copilot, and Antigravity, use `timeout_s` instead to bound execution time.
- **Copilot needs a paid GitHub Copilot subscription** (Pro, Business, or Enterprise) and has the smallest context window (64K). It is best suited for smaller, focused tasks.

---

To override which model each tier resolves to on a per-provider basis, see
[Customizing model tier mapping](install.md#customizing-model-tier-mapping).

---

Extending Fleet's provider support, or need the full CLI / integration detail? See [docs/provider-matrix.md](provider-matrix.md).
