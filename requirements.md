# Multi-Provider Support — Requirements

> Issues: #26 (Gemini), #27 (OpenAI Codex), #35 (GitHub Copilot)
> Design doc: `docs/multi-provider-plan.md`

---

## Issue #26: Support Gemini as a fleet member LLM backend

**State:** OPEN

### Description

Add support for Google Gemini as an alternative LLM backend for fleet members, alongside Claude.

### Motivation

Not all users have access to Claude or may prefer to use Gemini for certain workloads (cost, availability, capability mix). Supporting multiple LLM backends makes the fleet more accessible and flexible. Users should be able to mix and match — e.g., some members running Claude, others running Gemini — within the same fleet.

### Scope

#### MCP Server (src/)
- Member registration should allow specifying the LLM provider/backend
- `execute_prompt` should route to the appropriate backend CLI/API
- `provision_auth` should support Gemini API key provisioning (GEMINI_API_KEY)
- `update_claude` tool needs generalization (update_agent_cli or similar)
- OS command builders (buildPromptCommand, claudeVersion, etc.) need Gemini equivalents
- Error classification (`prompt-errors.ts`) needs Gemini-specific patterns
- Agent type/interface needs an `llmProvider` field

#### PM Skill (skills/pm/)
- Model selection logic (haiku->sonnet->opus escalation) needs Gemini equivalents
- CLAUDE.md templates reference Claude-specific behavior
- Doer-reviewer loop assumes Claude CLI session semantics
- Troubleshooting guide assumes Claude error patterns

#### Documentation
- All tool docs reference Claude CLI exclusively
- User guide needs multi-provider setup instructions
- Architecture doc needs provider abstraction layer description

### Non-goals (v1)
- Gemini as the PM's own LLM (covered by separate provider-for-PM work)
- Automatic provider failover between Gemini and Claude

---

## Issue #27: Support OpenAI as a fleet member LLM backend

**State:** OPEN

### Description

Add support for OpenAI (GPT-4, o-series) as an alternative LLM backend for fleet members, alongside Claude.

### Motivation

OpenAI models are widely available and some users may prefer them for specific tasks or already have API access. Supporting OpenAI broadens the fleet's reach and allows mixed-model teams. Users should be able to mix and match — e.g., some members running Claude, others running OpenAI — within the same fleet.

### Scope

#### MCP Server (src/)
- Member registration should allow specifying the LLM provider/backend
- `execute_prompt` should route to the appropriate backend CLI/API (Codex CLI or OpenAI API)
- `provision_auth` should support OpenAI API key provisioning (OPENAI_API_KEY)
- `update_claude` tool needs generalization (update_agent_cli or similar)
- OS command builders (buildPromptCommand, claudeVersion, etc.) need OpenAI equivalents
- Error classification (`prompt-errors.ts`) needs OpenAI-specific patterns
- Agent type/interface needs an `llmProvider` field

#### PM Skill (skills/pm/)
- Model selection logic (haiku->sonnet->opus escalation) needs OpenAI equivalents (gpt-4o-mini->gpt-4o->o3 or similar)
- CLAUDE.md templates reference Claude-specific behavior
- Doer-reviewer loop assumes Claude CLI session semantics
- Troubleshooting guide assumes Claude error patterns

#### Documentation
- All tool docs reference Claude CLI exclusively
- User guide needs multi-provider setup instructions
- Architecture doc needs provider abstraction layer description

### Non-goals (v1)
- OpenAI as the PM's own LLM (covered by separate provider-for-PM work)
- Automatic provider failover between OpenAI and Claude

---

## Issue #35: Support GitHub Copilot CLI as a fleet member LLM backend

**State:** OPEN

### Description

Add support for GitHub Copilot CLI (`gh copilot`) as an alternative LLM backend for fleet members.

### Motivation

GitHub Copilot is widely adopted in enterprise environments where developers already have Copilot licenses through their GitHub org. Supporting it as a fleet backend avoids requiring a separate LLM subscription and leverages existing access. Microsoft is investing heavily in Copilot's agentic capabilities.

### Scope

#### MCP Server (src/)
- Member registration should allow specifying Copilot as the LLM provider
- `execute_prompt` should route to `gh copilot` CLI
- `provision_auth` should handle Copilot auth (tied to `gh auth login`)
- OS command builders need Copilot CLI equivalents
- Error classification needs Copilot-specific patterns

#### PM Skill (skills/pm/)
- Model selection logic needs Copilot equivalents (if model tiers exist)
- Templates reference Claude-specific behavior — need Copilot variants

### Research needed
- Copilot CLI's headless/non-interactive mode capabilities
- Session/context persistence (equivalent to Claude's `--resume`)
- Structured output support (equivalent to `--output-format json`)
- Available model tiers and selection flags
- Rate limits and token caps
- Tool use / agentic capabilities in CLI mode

### Dependencies
- Depends on provider abstraction layer from #26 / #27

---

## Cross-cutting Requirements

1. **Backwards compatibility:** Existing Claude-only fleets must work without any changes. The `llmProvider` field defaults to `'claude'` when absent.
2. **Mix-and-match:** A single fleet can have members using different providers simultaneously.
3. **Provider abstraction:** All provider-specific logic must be encapsulated behind a `ProviderAdapter` interface — no provider-specific conditionals scattered across tool code.
4. **Security:** No credential leaks in logs or error messages. Command building must be injection-safe. Auth env var names must not be manipulable.
5. **Testing:** Unit tests for each provider adapter. Integration tests for mixed-fleet scenarios. All existing tests must continue to pass.
6. **Documentation:** All tool docs, user guide, and architecture docs updated to reflect multi-provider support.
