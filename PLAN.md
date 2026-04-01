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

---

## Phase 5: PM Skill Provider Independence

### Goal
Make the PM skill (`skills/pm/`) fully provider-independent so that a Gemini (or Codex/Copilot) member can be registered, onboarded, assigned work, reviewed, and deployed through the same PM workflows that work for Claude members today. All existing Claude workflows must remain identical (backwards compatible).

### Key Design Decisions
1. **Model tiers:** Abstract tiers (`cheap`/`standard`/`premium`) replace Claude model names. Add `modelTiers()` to `ProviderAdapter`. PM uses tiers; server resolves to provider-specific models.
2. **Permission abstraction:** `compose_permissions` becomes provider-aware — accepts role + provider, produces provider-native permission config:
   - Claude → `.claude/settings.local.json` (JSON allow/deny lists)
   - Gemini → `.gemini/settings.json` + `.gemini/policies/*.toml` (TOML policy rules)
   - Codex → `.codex/config.toml` (TOML approval mode + OS-level sandbox config)
   - Copilot → `.github/copilot/settings.local.json` (JSON per-tool allow/deny)
3. **Template rename:** `tpl-claude.md` → `tpl-doer.md` (content is already mostly generic).
4. **Onboarding:** Provider-aware — detect member's `llmProvider`, adapt steps.
5. **Skill text:** No hardcoded Claude model names in skill markdown — use tier names.

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Provider CLI behavior may differ from docs | Medium | High | Validate during 5E.4 walkthrough with actual CLIs; document deviations |
| Permission config format may change across CLI versions | Medium | Medium | Pin to researched versions (Gemini CLI 0.x, Codex CLI 1.x, Copilot CLI 1.0.x); add version checks in provider adapters |
| TOML generation for Gemini/Codex may have edge cases | Medium | Medium | Test with actual CLIs in 5E.4; include TOML round-trip tests in 5C.10 |
| Non-Claude providers may not support all PM workflow features like session resume | High | Medium | Document gaps in 5E.4 gap analysis; degrade gracefully (skip resume if unsupported) |

---

### Phase 5A: Model Tier Abstraction

#### Task 5A.1: Add modelTiers() to ProviderAdapter interface (S)
- **File:** `src/providers/provider.ts`
- Add `modelTiers(): Record<'cheap' | 'standard' | 'premium', string>` to `ProviderAdapter`
- Returns a mapping from abstract tier to provider-specific model name
- **Done:** Interface updated, compiles

#### Task 5A.2: Implement modelTiers() in all providers (M)
- **Files:** `src/providers/claude.ts`, `gemini.ts`, `codex.ts`, `copilot.ts`
- Claude: `{ cheap: 'haiku', standard: 'sonnet', premium: 'opus' }`
- Gemini: `{ cheap: 'gemini-2.0-flash-lite', standard: 'gemini-2.5-flash', premium: 'gemini-2.5-pro' }`
- Codex: `{ cheap: 'gpt-5.4-mini', standard: 'gpt-5.4', premium: 'gpt-5.4' }`
- Copilot: `{ cheap: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', premium: 'claude-opus-4-5' }`
- Consult `docs/multi-provider-plan.md` for current model names
- **Done:** All 4 providers implement `modelTiers()`, unit tests verify mappings

#### Task 5A.3: Replace model names in SKILL.md (S)
- **File:** `skills/pm/SKILL.md`
- Replace `haiku→sonnet→opus` escalation with `cheap→standard→premium`
- Replace model-specific guidance ("haiku for execution... sonnet for construction... opus for planning") with tier-based language
- **Done:** No occurrences of `haiku`, `sonnet`, or `opus` as model selectors in SKILL.md

#### Task 5A.4: Replace model names in doer-reviewer.md (S)
- **File:** `skills/pm/doer-reviewer.md`
- Replace `haiku→sonnet→opus` with `cheap→standard→premium`
- Replace any `opus` references with `premium tier`
- **Done:** No occurrences of `haiku`, `sonnet`, or `opus` in doer-reviewer.md

#### Task 5A.5: Replace model names in troubleshooting.md (S)
- **File:** `skills/pm/troubleshooting.md`
- Replace `haiku→sonnet→opus` with `cheap→standard→premium`
- **Done:** No occurrences of `haiku`, `sonnet`, or `opus` in troubleshooting.md

#### VERIFY 5A: Model tier abstraction complete
- `npm run build` — compiles cleanly
- `npm test` — all tests pass
- `grep -ri "haiku\|sonnet\|opus" skills/pm/` returns zero matches
- `modelTiers()` implemented and tested for all 4 providers

---

### Phase 5B: Template Rename + Instruction File Parameterization

#### Task 5B.1: Rename tpl-claude.md → tpl-doer.md (S)
- `git mv skills/pm/tpl-claude.md skills/pm/tpl-doer.md`
- Content is already mostly generic — no content changes needed
- **Note:** For existing fleets with active sprints: tpl-claude.md removal is backwards-compatible because the file is only used by PM during dispatch, not by members at runtime.
- **Done:** `tpl-claude.md` no longer exists; `tpl-doer.md` has identical content

#### Task 5B.2: Update all references to tpl-claude.md (S)
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`, any other files referencing `tpl-claude.md`
- Replace all `tpl-claude.md` with `tpl-doer.md`
- **Done:** `grep -ri "tpl-claude" skills/pm/` returns zero matches

#### Task 5B.3: Parameterize instruction file name in skill docs (M)
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`, `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md`
- Where docs say "CLAUDE.md" for member instruction files, parameterize:
  - "Send `tpl-doer.md` as the member's instruction file (CLAUDE.md for Claude, GEMINI.md for Gemini, AGENTS.md for Codex, COPILOT.md for Copilot)"
  - "The instruction file is NEVER committed — it is role-specific"
  - Add guidance: "Use `member_detail` → `llmProvider` to determine the provider's `instructionFileName`"
- **Important:** Do NOT change references to the PM's own CLAUDE.md — PM runs on Claude
- **Done:** All member-facing instruction file references are parameterized; PM's own CLAUDE.md references unchanged

#### VERIFY 5B: Template rename and parameterization complete
- `tpl-claude.md` does not exist
- All references point to `tpl-doer.md`
- No hardcoded `CLAUDE.md` for member instruction files (PM's own are fine)
- `npm run build` + `npm test` pass

---

### Phase 5C: Provider-Native Permission Abstraction

#### Provider Permission Research

The permission config paths and formats below are confirmed from official provider documentation:

- **Gemini CLI:** `.gemini/settings.json` for tool allow/exclude lists + `.gemini/policies/*.toml` for TOML policy rules. Source: official Gemini CLI docs (google-gemini.github.io), Policy Engine reference (geminicli.com/docs/reference/policy-engine). Modes: default, auto_edit, plan, yolo. 4-tier priority system (default/workspace/user/admin).

- **Codex CLI:** `<repo>/.codex/config.toml` for approval policy + sandbox settings. Source: official Codex docs (developers.openai.com/codex/config-reference). Modes: suggest, auto-edit, full-auto. OS-level sandbox via seatbelt (macOS) / landlock+bubblewrap (Linux). Also `~/.codex/config.toml` for user-level defaults.

- **Copilot CLI:** `.github/copilot/settings.json` (repo-level, committed) + `.github/copilot/settings.local.json` (personal, gitignored). Source: official GitHub docs (docs.github.com/en/copilot). Per-tool allow/deny via --allow-tool/--deny-tool flags. Also `~/.copilot/config.json` for global config.

---

#### Task 5C.1: Add permission config methods to ProviderAdapter (M)
- **File:** `src/providers/provider.ts`
- Add to `ProviderAdapter`:
  - `permissionConfigPaths(): string[]` — returns the file path(s) for this provider's permission config (relative to repo root)
  - `composePermissionConfig(role: 'doer' | 'reviewer', grants?: string[]): Record<string, unknown> | string` — returns the permission config content for the given role. Returns object for JSON providers, string for TOML providers.
- **Done:** Interface updated, compiles

#### Task 5C.2: Implement permission config in ClaudeProvider (M)
- **File:** `src/providers/claude.ts`
- `permissionConfigPaths()`: `['.claude/settings.local.json']`
- `composePermissionConfig()`: produces JSON with allow/deny lists per role (extract logic from existing `compose_permissions` tool)
- **Done:** Claude permission composition produces identical output to current behavior

#### Task 5C.3: Implement permission config in GeminiProvider (M)
- **File:** `src/providers/gemini.ts`
- `permissionConfigPaths()`: `['.gemini/settings.json', '.gemini/policies/fleet.toml']`
- `composePermissionConfig()`: produces Gemini-native config — settings.json for mode selection (yolo for doer, default for reviewer) + TOML policy file for tool-level rules
- **Done:** Gemini permission config encodes equivalent guardrails to Claude's, in Gemini-native format

#### Task 5C.4: Implement permission config in CodexProvider (M)
- **File:** `src/providers/codex.ts`
- `permissionConfigPaths()`: `['.codex/config.toml']`
- `composePermissionConfig()`: produces TOML with `approval_mode` (full-auto for doer, suggest for reviewer) and sandbox settings
- **Done:** Codex permission config matches role intent

#### Task 5C.5: Implement permission config in CopilotProvider (S)
- **File:** `src/providers/copilot.ts`
- `permissionConfigPaths()`: `['.github/copilot/settings.local.json']`
- `composePermissionConfig()`: produces JSON with per-tool allow/deny flags
- **Done:** Copilot permission config matches role intent

#### Task 5C.6: Refactor compose_permissions to use ProviderAdapter (L)
- **File:** `src/tools/compose-permissions.ts`
- Refactor to:
  1. Look up `agent.llmProvider` from registry
  2. Get provider via `getProvider(agent.llmProvider)`
  3. Call `provider.composePermissionConfig(role, grants)` to get config content
  4. Call `provider.permissionConfigPaths()` to get target file path(s)
  5. Deliver config file(s) to member via `send_files`
- Reactive grant path: merge grants into existing config using provider method
- Backwards compat: no `llmProvider` = Claude
- **Done:** `compose_permissions` works for all 4 providers; Claude behavior unchanged

#### Task 5C.7: Update permissions.md for provider-native configs (S)
- **File:** `skills/pm/permissions.md`
- Add "Provider Permission Mechanisms" section with table:
  | Provider | Config Path(s) | Format | Mechanism |
  | Claude | `.claude/settings.local.json` | JSON | Per-tool allow/deny lists |
  | Gemini | `.gemini/settings.json` + `.gemini/policies/*.toml` | JSON+TOML | Mode selection + policy rules |
  | Codex | `.codex/config.toml` | TOML | Approval mode + OS sandbox |
  | Copilot | `.github/copilot/settings.local.json` | JSON | Per-tool allow/deny flags |
- Update "Before every sprint" and "Mid-sprint denial" sections for provider awareness
- **Done:** permissions.md documents all provider permission mechanisms

#### Task 5C.8: Update SKILL.md rule 8 for provider-native permissions (S)
- **File:** `skills/pm/SKILL.md`
- Rule 8: "Before every sprint, compose and deliver member permissions per permissions.md. `compose_permissions` produces the correct provider-native config — Claude gets `settings.local.json`, Gemini gets TOML policies, etc. Mid-sprint denial? Evaluate, grant, re-deliver via `compose_permissions`."
- **Done:** Rule 8 reflects provider-native permission model

#### Task 5C.9: Update troubleshooting.md permission entry (S)
- **File:** `skills/pm/troubleshooting.md`
- "Permission denied" row: "Run `compose_permissions` for the member — it produces provider-native permission config. For Claude: check `settings.local.json`. For Gemini: check `.gemini/policies/`. For Codex: check `config.toml` approval mode."
- **Done:** Troubleshooting reflects provider-native approach

#### Task 5C.10: Write tests for provider-aware compose_permissions (M)
- **File:** `tests/compose-permissions.test.ts` (or extend existing)
- Test: Claude member → `settings.local.json` composed (existing behavior preserved)
- Test: Gemini member → `.gemini/settings.json` + `.gemini/policies/fleet.toml` composed
- Test: Codex member → `.codex/config.toml` composed
- Test: Copilot member → `.github/copilot/settings.local.json` composed
- Test: Reactive grant for Claude → config updated
- Test: Reactive grant for Gemini → TOML policy updated
- Test: Member with no `llmProvider` → treated as Claude
- **Done:** All test cases pass

#### VERIFY 5C: Permission abstraction complete
- `npm run build` + `npm test` — all pass
- `compose_permissions` produces correct provider-native config for all 4 providers
- Skill docs consistent with implementation
- Claude behavior unchanged from Phase 4

---

### Phase 5D: Onboarding Provider Awareness

#### Task 5D.1: Update onboarding.md with provider branching (M)
- **File:** `skills/pm/onboarding.md`
- **Step 1.5 (new — Verify CLI Installation):** "Run `execute_command` with provider's `versionCommand()`. If not installed, run `installCommand()`. Use `member_detail` to determine `llmProvider` and `os`."
- **Step 2 (Disable AI Attribution):** Add provider branching:
  - Claude: existing behavior (`.claude/settings.json` attribution config)
  - Gemini/Codex/Copilot: skip with note "does not support attribution config" (or configure if supported)
- **Step 7 (Member Status File):** Add `LLM Provider: <provider>` to member profile template
- **Done:** Onboarding has clear provider branching; Gemini member can be fully onboarded

#### Task 5D.2: Update doer-reviewer.md for provider-aware config delivery (S)
- **File:** `skills/pm/doer-reviewer.md`
- Setup Checklist item 3: "Compose and deliver permissions per permissions.md — `compose_permissions` handles provider-native format automatically."
- Permissions section: "Compose and deliver permissions per permissions.md. Recompose when switching roles. Each provider gets its native permission config."
- **Done:** doer-reviewer.md has no provider-specific assumptions

#### VERIFY 5D: Onboarding provider awareness complete
- All skill docs internally consistent
- Walkthrough of onboarding for hypothetical Gemini member succeeds on paper
- `npm run build` + `npm test` pass

---

### Phase 5E: Integration, Cleanup, and Walkthrough

#### Task 5E.1: Audit all skill docs for remaining Claude assumptions (S)
- **Files:** All files in `skills/pm/`
- `grep -ri "claude" skills/pm/` — review every hit
- Categorize: (a) PM's own CLAUDE.md (keep), (b) member-facing Claude assumption (fix), (c) qualified provider example (keep)
- Fix all category (b) items
- **Done:** Every "Claude" or "CLAUDE.md" mention is either PM's own config or qualified as one provider among others

#### Task 5E.2: Add Provider Awareness section to SKILL.md (S)
- **File:** `skills/pm/SKILL.md`
- Add new "## Provider Awareness" section documenting:
  - Instruction file: lookup via `member_detail` → `llmProvider` → provider's `instructionFileName`
  - Permissions: `compose_permissions` produces provider-native config automatically
  - Model tiers: `cheap`/`standard`/`premium` — server resolves via `modelTiers()`
  - CLI differences: handled by `ProviderAdapter` — PM never constructs CLI commands
  - Attribution: Claude-only; skip for other providers
  - PM itself always runs on Claude
- **Done:** Single authoritative section documents all provider-aware PM behavior

#### Task 5E.3: Update skill-matrix.md with provider note (S)
- **File:** `skills/pm/skill-matrix.md`
- Add note: "Skills are independent of the member's LLM provider. A Gemini member needs the same project skills as a Claude member."
- **Done:** skill-matrix.md clarifies skills are provider-agnostic

#### Task 5E.4: Walkthrough test — Gemini member lifecycle (M)
- Trace complete lifecycle for a Gemini member, verify each step:
  1. `register_member` with `llmProvider: 'gemini'` → provider stored ✓
  2. Onboarding steps 1–7 → each step has Gemini branch ✓
  3. PM composes permissions → Gemini-native TOML policy delivered ✓
  4. PM sends `tpl-doer.md` as `GEMINI.md` → `execute_prompt` uses Gemini CLI ✓
  5. Doer executes → verify checkpoint → PM dispatches reviewer ✓
  6. Review cycle → merge → deploy ✓
- Document gaps as follow-up issues
- **Done:** Gap analysis document committed listing every PM workflow step with Gemini status (works/needs-work/not-supported). Zero critical gaps.

#### VERIFY 5E: Full Phase 5 complete
- `npm run build` — clean compilation
- `npm test` — all tests pass
- `grep -ri "haiku\|sonnet\|opus" skills/pm/` — zero matches
- `grep -ri "tpl-claude" skills/pm/` — zero matches
- Every `settings.local.json` reference in skill docs is qualified by provider
- Provider Awareness section in SKILL.md is comprehensive and consistent
- Gemini member lifecycle walkthrough passes

---

### Phase 5 Summary

| Sub-phase | Tasks | Focus |
|-----------|-------|-------|
| 5A | 5A.1–5A.5 + verify | Model tier abstraction (`modelTiers()` + skill doc updates) |
| 5B | 5B.1–5B.3 + verify | Template rename + instruction file parameterization |
| 5C | 5C.1–5C.10 + verify | Provider-native permission abstraction (`compose_permissions`) |
| 5D | 5D.1–5D.2 + verify | Onboarding provider awareness |
| 5E | 5E.1–5E.4 + verify | Integration, cleanup, Gemini lifecycle walkthrough |

**Total tasks:** 29 (24 implementation + 5 verify checkpoints)
**Complexity breakdown:** 14S + 9M + 1L
