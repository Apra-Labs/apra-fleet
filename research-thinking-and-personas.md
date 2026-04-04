# Research: Auto Thinking Mode & CLI Agent Personas

_Researched: 2026-04-04_

---

## Issue #55 — Auto Thinking / Model Mode

### How each provider exposes "auto" thinking

#### Claude (Anthropic)

**API-level**: Claude has moved from fixed `budget_tokens` to **adaptive thinking**:

- **Deprecated**: `thinking: { type: 'enabled', budget_tokens: <number> }` — fixed token budget
- **Current**: `thinking: { type: 'adaptive' }` — model decides when/how much to think
- The `effort` parameter guides depth: `low`, `medium`, `high`, `max`

Key characteristics:
- `effort` is a behavioral signal, not a hard limit
- Even at `low` effort, complex problems may still trigger thinking
- `max` effort (Opus 4.6 only) provides deepest reasoning
- Adaptive thinking often outperforms fixed budgets for bimodal tasks and long-horizon agentic workflows

**CLI-level**: The `--effort <level>` flag is available:
```
--effort <level>   Effort level for the current session (low, medium, high, max)
```

This maps directly to the API's adaptive thinking effort parameter.

#### Gemini (Google)

**API-level**: Gemini 2.5 series uses `thinkingBudget`:

- `thinkingBudget: <128-32768>` — fixed token budget
- `thinkingBudget: -1` — **dynamic thinking** (auto mode), caps at 8,192 tokens
- Gemini 2.5 Pro cannot disable thinking; minimum budget is 128 tokens

Note: Gemini 3 uses `thinkingLevel` instead of `thinkingBudget`.

**CLI-level**: The Gemini CLI (`gemini --help`) does **not expose** a thinking budget flag. No `--thinking-budget`, `--effort`, or similar parameter exists in the current CLI options. Thinking configuration would need to be set via:
- GEMINI.md system prompts
- Policy files in `.gemini/policies/`
- Future CLI updates

#### Codex (OpenAI)

**API/CLI-level**: Codex supports reasoning effort levels:
- `medium` — recommended daily driver, balances intelligence and speed
- `high` — for harder tasks
- `xhigh` (Extra High) — maximum thinking for the hardest tasks

The CLI exposes this via configuration, though not as a direct flag in `codex --help`. Reasoning effort can be set per-thread or via `/personality` commands.

#### Copilot (GitHub)

No explicit thinking/reasoning budget parameter documented. Copilot's model selection (Claude Haiku/Sonnet/Opus backends) determines capability level rather than explicit thinking configuration.

---

### CLI support (flags available non-interactively)

| Provider | Thinking/Effort Flag | Non-Interactive Support |
|----------|---------------------|------------------------|
| Claude   | `--effort <low\|medium\|high\|max>` | Yes, works with `-p` |
| Gemini   | None available | N/A |
| Codex    | Via config only | Partial |
| Copilot  | None | N/A |

**Claude is the only provider with direct CLI flag support for thinking/effort control in non-interactive mode.**

---

### Cost and latency implications

#### Claude Pricing (2026)

| Model | Input | Output (incl. thinking) |
|-------|-------|------------------------|
| Haiku 4.5 | $1/MTok | $5/MTok |
| Sonnet 4.6 | $3/MTok | $15/MTok |
| Opus 4.6 | $5/MTok | $25/MTok |

**Key insight**: Thinking tokens are billed as standard output tokens at the model's normal rate. There is no separate "thinking" pricing tier. Setting `max_tokens` provides a hard limit on total output (thinking + response).

Effort level impacts:
- `low`: Minimal thinking, fast responses, lower cost
- `medium`: Balanced (recommended for most Sonnet 4.6 use cases)
- `high`: Deep thinking on most prompts
- `max`: Extensive thinking on everything (Opus only)

#### Gemini Pricing (2026)

| Model | Input | Output |
|-------|-------|--------|
| Gemini 2.5 Pro | $1.25/MTok (<200K ctx) | $10/MTok |
| Gemini 2.5 Pro | $2.50/MTok (>200K ctx) | $10/MTok |
| Gemini 2.5 Flash | $0.15/MTok | $0.60/MTok |
| Gemini 2.5 Flash (thinking mode) | - | $3.50/MTok |

Dynamic thinking (`thinkingBudget: -1`) caps at 8,192 thinking tokens, providing cost predictability.

#### Latency Considerations

- Higher effort/thinking budgets increase latency significantly
- Adaptive/dynamic modes allow simple queries to skip thinking entirely, reducing average latency
- For fleet workloads with mixed complexity, adaptive modes may outperform fixed budgets

---

### Recommended fleet abstraction

#### Option A: `thinking` as a flag on existing tiers (Recommended)

```typescript
interface PromptOptions {
  // existing
  model?: string;           // explicit model or tier name
  
  // new
  effort?: 'low' | 'medium' | 'high' | 'max' | 'auto';
}
```

**Rationale**:
- Thinking/effort is orthogonal to model capability (you might want Haiku + high effort, or Opus + low effort)
- Maps cleanly to Claude's `--effort` flag
- `auto` can mean "let the model decide" (adaptive thinking)
- For providers without effort support (Gemini CLI), ignore the parameter or log a warning

**Provider mapping**:

| Fleet `effort` | Claude CLI | Gemini API | Codex |
|----------------|------------|------------|-------|
| `low` | `--effort low` | `thinkingBudget: 128` | reasoning: medium |
| `medium` | `--effort medium` | `thinkingBudget: 4096` | reasoning: medium |
| `high` | `--effort high` | `thinkingBudget: 16384` | reasoning: high |
| `max` | `--effort max` | `thinkingBudget: 32768` | reasoning: xhigh |
| `auto` | (default, no flag) | `thinkingBudget: -1` | (default) |

#### Option B: `think` as a 4th tier (Not Recommended)

Adding a `think` tier conflates two dimensions:
- Model capability (cheap/standard/premium)
- Reasoning depth (effort level)

This would require tier names like `premium-think` or `think-premium`, leading to combinatorial explosion.

---

### Open questions

1. **Gemini CLI gap**: Should we contribute a `--thinking-budget` flag upstream to Gemini CLI, or accept that Gemini thinking is API-only for now?

2. **Default effort**: What should the fleet default be?
   - `auto` (let model decide) — most flexible, but unpredictable costs
   - `medium` — safe default for production workloads

3. **Effort per role**: Should doers default to higher effort than reviewers? Or should effort be task-specific?

4. **Backward compatibility**: The `model` parameter currently accepts tier names (`cheap`, `standard`, `premium`). Should `effort` be embedded in model strings (e.g., `premium:high`) or kept strictly separate?

5. **Cost tracking**: Extended thinking tokens aren't currently broken out in `ParsedResponse.usage`. Should we add `thinking_tokens` for observability?

---

## Issue #56 — CLI Agent Personas

### Claude Code: non-interactive persona support

**Yes, Claude Code CLI supports invoking named agents non-interactively:**

```bash
claude --agent <agent-name> -p "your prompt here"
```

The `--agent <agent>` flag specifies which agent to use for the session. This overrides the `agent` setting in `.claude/settings.json`.

For plugin-provided agents, use the scoped format:
```bash
claude --agent <plugin-name>:<agent-name> -p "prompt"
```

The `--agents <json>` flag allows defining custom agents inline:
```bash
claude --agents '{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}' --agent reviewer -p "Review this code"
```

---

### Available personas and capabilities

#### Built-in Agents (from `claude agents` output)

| Agent | Model | Description |
|-------|-------|-------------|
| **Explore** | haiku | Fast, read-only agent for codebase search and analysis |
| **general-purpose** | inherit | Complex multi-step tasks requiring exploration and action |
| **Plan** | inherit | Research agent for plan mode, gathers context before presenting plans |
| **statusline-setup** | sonnet | Specialized for user status line configuration |

#### Agent Capabilities

**Explore**:
- Optimized for fast codebase exploration
- Uses cheaper Haiku model for cost efficiency
- Read-only tools (no Edit, Write)
- Supports thoroughness levels: `quick`, `medium`, `very thorough`
- Ideal for: codebase recon, file discovery, code search

**Plan**:
- Purpose-built for architecture and implementation planning
- Inherits parent model (typically Sonnet/Opus)
- Read-only tools
- Returns step-by-step plans, identifies critical files, considers trade-offs
- Ideal for: task decomposition, planning phases

**general-purpose**:
- Full tool access
- Inherits parent model
- For complex tasks requiring both exploration and modification
- Ideal for: multi-step execution tasks

#### Cost/Context Profiles

Subagents run in isolated conversation contexts:
- Intermediate tool calls stay inside the subagent
- Only final message returns to parent
- This preserves parent context window
- Explore uses Haiku = much cheaper for reconnaissance

---

### Other providers (Gemini, Codex, Copilot)

#### Gemini CLI

**No equivalent agent/persona flag.** The Gemini CLI supports:
- Skills (`gemini skills list/enable/disable`) — but these are tool capabilities, not personas
- `--approval-mode` (`default`, `auto_edit`, `yolo`, `plan`) — operational mode, not persona

Gemini has "agent mode" at the API level, but the CLI doesn't expose persona selection. Plan mode (`--approval-mode plan`) is the closest equivalent, providing read-only exploration.

#### Codex CLI

**No direct persona flag.** Codex supports:
- Personality/communication style via `/personality` or config
- Reasoning effort levels (medium/high/xhigh)
- No built-in specialized agents like Explore/Plan

#### Copilot CLI

**Supports custom agents** but differently:
```bash
copilot --agent <agent-name> -p "prompt"
```

Built-in specialized agents (from changelog):
- **Explore** — fast codebase analysis
- **Task** — running builds and tests
- **Code Review** — change review
- **Plan** — implementation planning

Copilot auto-delegates to these agents when appropriate. Custom agents can be defined with personas, tool selections, and MCP servers.

---

### Proposed `agent` parameter design for `execute_prompt`

#### Schema Extension

```typescript
// In executePromptSchema (execute-prompt.ts)
agent: z.enum(['default', 'explore', 'plan']).optional()
  .describe('Agent persona to use. "explore" for fast codebase recon (Haiku), "plan" for architecture planning, "default" for full execution capability.')
```

#### PromptOptions Extension

```typescript
// In PromptOptions (provider.ts)
interface PromptOptions {
  folder: string;
  b64Prompt: string;
  sessionId?: string;
  dangerouslySkipPermissions?: boolean;
  model?: string;
  maxTurns?: number;
  agent?: 'default' | 'explore' | 'plan';  // NEW
}
```

#### Provider Mapping

| Fleet `agent` | Claude CLI | Gemini CLI | Copilot CLI | Codex |
|---------------|------------|------------|-------------|-------|
| `default` | (no flag) | (default) | (no flag) | (default) |
| `explore` | `--agent Explore` | `--approval-mode plan` | `--agent Explore` | (no equivalent) |
| `plan` | `--agent Plan` | `--approval-mode plan` | `--agent Plan` | (no equivalent) |

#### Implementation in ClaudeProvider.buildPromptCommand()

```typescript
buildPromptCommand(opts: PromptOptions): string {
  // ... existing code ...
  
  if (opts.agent && opts.agent !== 'default') {
    const agentName = opts.agent === 'explore' ? 'Explore' : 'Plan';
    cmd += ` --agent ${agentName}`;
  }
  
  return cmd;
}
```

#### Use Case: Doer with Explore Phase

```typescript
// First: cheap exploration
await executePrompt({
  member_id: doerId,
  prompt: "Find all authentication-related files and summarize the auth flow",
  agent: 'explore',  // Uses Haiku, read-only
});

// Then: full execution
await executePrompt({
  member_id: doerId,
  prompt: "Implement the OAuth refresh token flow based on the codebase patterns",
  agent: 'default',  // Full capability
});
```

---

### Open questions

1. **Explore model override**: The Explore agent uses Haiku by default. Should the fleet's `model` parameter override this, or should Explore always use Haiku for cost efficiency?

2. **Plan mode vs Plan agent**: Claude has both `--permission-mode plan` (read-only mode) and `--agent Plan` (planning persona). Should the fleet expose these separately?

3. **Custom agents**: Should `execute_prompt` accept arbitrary agent names, or restrict to known built-ins? Arbitrary names would allow members to define project-specific agents in `.claude/agents/`.

4. **Provider fallback**: For providers without agent support (Gemini, Codex), should `agent: 'explore'` silently fall back to default, or fail with an error?

5. **Agent + effort interaction**: Can we combine `--agent Explore --effort high`? Or does the agent's model selection override effort?

6. **Session continuity**: Do subagent conversations create separate session IDs? How does `resume: true` interact with agent switches?

---

## Summary: Recommended Next Steps

### Issue #55 (Thinking/Effort)
1. Add `effort?: 'low' | 'medium' | 'high' | 'max' | 'auto'` to `PromptOptions`
2. Implement `--effort` flag in `ClaudeProvider.buildPromptCommand()`
3. Log warnings for providers that don't support effort
4. Default to `auto` (no flag) for backward compatibility

### Issue #56 (Agent Personas)
1. Add `agent?: 'default' | 'explore' | 'plan'` to `PromptOptions`
2. Implement `--agent` flag in `ClaudeProvider.buildPromptCommand()`
3. Map to `--approval-mode plan` for Gemini as a read-only fallback
4. Document that Explore uses Haiku and is cheaper for reconnaissance

Both features are additive and can be implemented independently. Claude has the best CLI support for both; other providers require workarounds or partial implementations.

---

## Sources

### Issue #55 Research
- [Building with extended thinking - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Adaptive thinking - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Effort - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- [What's new in Claude 4.6 - Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- [Gemini thinking - Google AI Developers](https://ai.google.dev/gemini-api/docs/thinking)
- [Thinking - Vertex AI Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Features - Codex CLI | OpenAI](https://developers.openai.com/codex/cli/features)
- [Claude API Pricing 2026 | MetaCTO](https://www.metacto.com/blogs/anthropic-api-pricing-a-full-breakdown-of-costs-and-integration)
- [Gemini 2.5 Pro API Pricing 2026](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-pro)

### Issue #56 Research
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Subagents in the SDK - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [GitHub Copilot CLI: Enhanced agents - GitHub Changelog](https://github.blog/changelog/2026-01-14-github-copilot-cli-enhanced-agents-context-management-and-new-ways-to-install/)
- [Creating custom agents for Copilot CLI - GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [Headless Mode - Gemini CLI](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- [Using agents in VS Code - Copilot](https://code.visualstudio.com/docs/copilot/agents/overview)
- [Claude Code Agent Teams Guide 2026](https://claudefa.st/blog/guide/agents/agent-teams)
