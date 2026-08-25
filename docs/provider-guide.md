<!-- llm-context: User-facing guide for choosing an LLM provider in apra-fleet. Consult when a user asks which provider to use for a role (PM, doer, reviewer), what each provider is good at, or what limitations to expect. For CLI flags, credential paths, and integration internals, see provider-matrix.md. -->
<!-- keywords: provider, Claude, Antigravity, Codex, Copilot, choose, role, PM, doer, reviewer, gotchas, limitations, context window, max_turns, OAuth -->
<!-- see-also: ../README.md (provider setup instructions), provider-matrix.md (full CLI and integration reference) -->

# Choosing an LLM Provider

Fleet supports Claude, Antigravity (agy), Codex, and Copilot. Members can run different providers and mix them freely within a single fleet.

## Provider strengths

- **Claude** - Balanced coding and reasoning; fine-grained per-tool permissions via `settings.local.json`.
- **Antigravity** - High-performance Gemini-based agentic CLI; supports large context windows, background tasks, and native beads task tracking.
- **Codex** - Structured-output enforcement via `--output-schema`; native subagent parallelism for concurrent subtasks with less orchestration overhead.
- **Copilot** - Multi-model marketplace (Claude + GPT families in one CLI); auto-compaction keeps sessions running indefinitely.

## Recommended provider by role

| Role | Recommended | Why |
|------|-------------|-----|
| PM (orchestrator) | Claude Code or Antigravity (agy) | Both plan and orchestrate well - both support planning, background tasks, and premium models (e.g., Opus / premium-tier). |
| Doer | Any provider | Sonnet, Antigravity, Codex, Copilot - mix freely. |
| Reviewer | Premium-tier models | Catches subtle issues smaller models miss. |

## Gotchas worth knowing

- **`max_turns` is Claude-only.** On Codex, Copilot, and Antigravity, use `timeout_s` instead to bound execution time.
- **Copilot needs a paid GitHub Copilot subscription** (Pro, Business, or Enterprise) and has the smallest context window (64K). It is best suited for smaller, focused tasks.

## Mixing providers in one fleet

Every member runs its own LLM backend, and they collaborate across vendors. Put
a Claude doer with an Antigravity reviewer, or the reverse -- the reviewer's model
disagrees with the doer's by construction, so it catches issues a same-model
review would wave through.

A fleet that has run in production:

```
pm-1      Opus 4.7        orchestrator
doer-1    Sonnet 4.6      feature work
doer-2    Antigravity     large-context tasks
reviewer  Opus 4.7        final review
```

**OpenCode and local models.** OpenCode works with any OpenAI-compatible
endpoint (Ollama, vLLM, etc.), so it is the provider for self-hosted models.
The model endpoint is the user's responsibility -- Fleet installs the CLI and
agents but does not provision or manage the inference server. Configure the
provider and base URL in `opencode.json`; see
[opencode-exploration.md](opencode-exploration.md) for details.

Because OpenCode members can run any model, model tiers (cheap / standard /
premium) are set per member at registration via `model_tiers` in
`register_member`. A single-model entry fills all three tiers.

**Registering a member from a shell.** `apra-fleet register-member --name
<name> --path <folder> [options]` is a shell-drivable equivalent of the
`register_member` MCP tool, for contexts that can run shell commands but
cannot make MCP tool calls (scripted setup, CI, an agent role without MCP
tool access). It shares the exact same validation and registration logic as
the MCP tool -- both converge on one underlying registration function, so
the two entry points can never drift apart. Run `apra-fleet register-member
--help` for the full flag reference.

---

To override which model each tier resolves to on a per-provider basis, see
[Customizing model tier mapping](install.md#customizing-model-tier-mapping).

---

Extending Fleet's provider support, or need the full CLI / integration detail? See [docs/provider-matrix.md](provider-matrix.md).
