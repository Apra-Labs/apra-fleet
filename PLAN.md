# Multi-Provider Support — Implementation Plan

> Design doc: `docs/multi-provider-plan.md`
> Requirements: `requirements.md`
> Issues: #26, #27, #35

## Phase 1: Types + Provider Interface + Implementations

### Task 1.1: Add LlmProvider type and Agent field
- Add `LlmProvider = 'claude' | 'gemini' | 'codex' | 'copilot'` to `src/types.ts`
- Add optional `llmProvider?: LlmProvider` field to the `Agent` interface
- Ensure `getAgent()` / registry access defaults to `'claude'` when field is absent
- **Done:** Types compile, no test regressions

### Task 1.2: Create ProviderAdapter interface
- Create `src/providers/provider.ts` with the `ProviderAdapter` interface
- Include `PromptOptions` and `ParsedResponse` types
- Include `PromptErrorCategory` shared type (or import from existing)
- See `docs/multi-provider-plan.md` section 1.2 for full interface spec
- **Done:** Interface file compiles

### Task 1.3: Implement ClaudeProvider
- Create `src/providers/claude.ts`
- Extract existing CLI logic from `src/os/linux.ts`, `src/os/windows.ts`, `src/os/macos.ts`, and `src/utils/prompt-errors.ts`
- Implement all `ProviderAdapter` methods for Claude
- Must produce identical CLI commands to current hardcoded logic
- **Done:** ClaudeProvider passes unit tests matching current behavior

### Task 1.4: Implement GeminiProvider
- Create `src/providers/gemini.ts`
- Implement all `ProviderAdapter` methods per design doc research
- Key details: `gemini -p`, `--output-format json`, `--yolo`, `GEMINI_API_KEY`, `--model`, `-r` for resume
- NDJSON not needed (Gemini supports single JSON)
- **Done:** Unit tests for all methods

### Task 1.5: Implement CodexProvider
- Create `src/providers/codex.ts`
- Implement all `ProviderAdapter` methods per design doc research
- Key details: `codex exec`, `--json` (NDJSON output), `--sandbox danger-full-access --ask-for-approval never`, `OPENAI_API_KEY`
- **Must implement NDJSON response parser** — collect events, extract final result from last event
- **Done:** Unit tests including NDJSON parsing

### Task 1.6: Implement CopilotProvider
- Create `src/providers/copilot.ts`
- Implement all `ProviderAdapter` methods per design doc research
- Key details: `copilot -p`, `--format json`, `--allow-all-tools`, `COPILOT_GITHUB_TOKEN`, `--model`, `--continue` for resume
- **Done:** Unit tests for all methods

### Task 1.7: Create provider factory
- Create `src/providers/index.ts`
- `getProvider(llmProvider: LlmProvider): ProviderAdapter` — returns singleton per provider
- Default to Claude when called with undefined/null
- **Done:** Factory returns correct provider for each type

### Task 1.8: Unit tests for provider layer
- Test each provider builds correct CLI commands for all 3 OS types (linux, macos, windows)
- Test `parseResponse` per provider (single JSON, NDJSON for Codex)
- Test error classification per provider
- Test model tier mapping
- Test backwards compatibility: no `llmProvider` = Claude
- **Done:** All provider tests pass

### VERIFY 1: Provider abstraction layer complete
- `npm run build` — compiles cleanly
- `npm test` — all existing + new provider tests pass
- All 7 new files exist in `src/providers/`
- No changes to tool files yet — pure abstraction layer

---

## Phase 2: OsCommands Refactoring

### Task 2.1: Generalize OsCommands interface
- In `src/os/os-commands.ts`: add generic agent methods (`agentCommand`, `agentVersion`, `installAgent`, `updateAgent`, `buildPromptCommand` that accept `ProviderAdapter`)
- Keep old Claude-specific methods temporarily for backwards compat during transition
- **Done:** Interface updated, compiles

### Task 2.2: Implement generic methods in linux.ts
- Implement new generic agent methods in `src/os/linux.ts`
- Each method delegates CLI-specific parts to the provider, handles OS-specific shell wrapping
- **Done:** Linux implementation compiles and tests pass

### Task 2.3: Implement generic methods in macos.ts
- Same as 2.2 for `src/os/macos.ts`
- **Done:** macOS implementation compiles and tests pass

### Task 2.4: Implement generic methods in windows.ts
- Same as 2.2 for `src/os/windows.ts`
- Handle Windows-specific shell wrapping (PowerShell, PATH differences)
- **Done:** Windows implementation compiles and tests pass

### Task 2.5: Remove deprecated Claude-specific methods
- Remove old `claudeCommand`, `claudeVersion`, `claudeCheck`, `installClaude`, `updateClaude` from OsCommands interface
- Update all call sites to use new generic methods
- Run full test suite
- **Done:** No Claude-specific CLI methods remain in OsCommands, all tests pass

### VERIFY 2: OsCommands refactoring complete
- `npm run build` — compiles cleanly
- `npm test` — all tests pass
- OsCommands interface is provider-generic
- No functional behavior change for Claude members (same CLI commands produced)

---

## Phase 3: Tool Changes

### Task 3.1: Update execute-prompt.ts
- Route through `provider.buildPromptCommand()`, `provider.parseResponse()`, `provider.classifyError()`
- Session resume via `provider.resumeFlag()`
- `max_turns` only passed when `provider.supportsMaxTurns()`
- Must handle Claude's single JSON and Codex's NDJSON transparently
- **Done:** execute-prompt works with all providers (unit tests)

### Task 3.2: Update provision-auth.ts
- Flow A (OAuth copy): Claude only — gate behind `provider.supportsOAuthCopy()`
- Flow B (API key): use `provider.authEnvVar` for env var name
- Verification: use provider's version command to confirm auth works
- **Done:** Auth provisioning works per provider (unit tests)

### Task 3.3: Rename update-claude.ts to update-agent-cli.ts
- Rename file, update tool name to `update_agent_cli`
- Keep `update_claude` as alias for backwards compatibility
- Use provider's install/update commands
- Update `src/index.ts` registration
- **Done:** Tool works with all providers, alias works

### Task 3.4: Update register-member.ts
- Add optional `llm_provider` parameter (default: `'claude'`)
- Use provider adapter for CLI detection (`versionCommand()`)
- Store `llmProvider` in registry
- **Done:** Can register members with any provider

### Task 3.5: Update remaining tools
- `remove-member.ts`: cleanup uses `provider.credentialPath` and `provider.authEnvVar`
- `check-status.ts`: `fleetProcessCheck()` uses `provider.processName`
- `member-detail.ts`: show `llmProvider` in output
- `list-members.ts`: show provider in listing
- `update-member.ts`: add `llm_provider` as updatable field
- **Done:** All tools provider-aware, unit tests pass

### Task 3.6: Update prompt-errors.ts
- Thin wrapper that delegates to `provider.classifyError()`
- Keep shared `PromptErrorCategory` + `isRetryable()`
- **Done:** Error classification routes through provider

### Task 3.7: Update src/index.ts
- Register `update_agent_cli` (keep `update_claude` alias)
- Update tool descriptions: "Claude" -> "LLM agent" where appropriate
- **Done:** All tools registered correctly

### Task 3.8: Integration tests for tool changes
- Register member with each provider type
- Execute prompt with each provider (mock SSH)
- Provision auth with API key for each provider
- Update agent CLI for each provider
- Mixed fleet: dispatch to Claude member and Gemini member in same test
- Process detection: `fleetProcessCheck` with each provider's process name
- **Done:** All integration tests pass

### VERIFY 3: All tool changes complete
- `npm run build` — compiles cleanly
- `npm test` — all existing + new tests pass
- Mixed-fleet scenario works end-to-end in tests
- No Claude-specific assumptions remain in tool code (except as default)

---

## Phase 4: Documentation + Security Audit

### Task 4.1: Create docs/provider-matrix.md
- Extract comparison tables from `docs/multi-provider-plan.md` into standalone reference doc
- Strategic comparison table, model tier equivalents, unique capabilities, critical gaps
- **Done:** `docs/provider-matrix.md` committed

### Task 4.2: Update architecture and tool docs
- `docs/architecture.md`: add "Provider Abstraction" section with layer diagram
- `docs/tools-lifecycle.md`: document `llm_provider` param in register/update, rename update_claude
- `docs/tools-work.md`: provider-aware execute_prompt, note max_turns is Claude-only
- `docs/tools-infrastructure.md`: multi-provider auth + install/update
- `docs/vocabulary.md`: add "provider" / "LLM backend" terminology
- **Done:** All doc files updated

### Task 4.3: Update user guide
- `docs/user-guide.md`: multi-provider setup guide, mix-and-match examples, provider selection guidance
- **Done:** User guide updated

### Task 4.4: Security audit
- Review all new provider code for injection risks (command building, env var handling)
- Verify no secrets leak in logs or error messages
- Verify credential path handling is safe across all providers
- Check that provider.authEnvVar values cannot be manipulated
- **Done:** Audit findings documented, any issues fixed

### VERIFY 4: Documentation and security complete
- `npm run build` — compiles cleanly
- `npm test` — all tests pass
- All docs updated and consistent
- Security audit complete with no open issues
- Ready for PR
