# i125-multi-provider — Implementation Plan
> Support multiple LLM providers per member: providers[] array, execute_prompt provider routing, backward compat

---
## Tasks

### Phase 1: Schema & Registry

#### Task 1.1: Update member type — providers array
- **Change:** In the `Agent` interface, add `llmProviders?: LlmProvider[]` alongside the existing `llmProvider?: LlmProvider`. Update `loadRegistry()` in the registry service to auto-migrate on read: if an agent has `llmProvider` but no `llmProviders`, set `llmProviders = [llmProvider]`. Add a helper function `getAgentProviders(agent: Agent): LlmProvider[]` that returns `agent.llmProviders ?? (agent.llmProvider ? [agent.llmProvider] : ['claude'])` for safe access throughout the codebase.
- **Files:** `src/types.ts` (Agent interface), `src/services/registry.ts` (loadRegistry migration + helper)
- **Tier:** standard
- **Done when:** registry stores `llmProviders[]` array; old entries with `llmProvider` string auto-migrate on read; helper function returns correct array in all cases

#### Task 1.2: Update register_member tool
- **Change:** Add `llm_providers` param (array of `LlmProvider`) to `registerMemberSchema`. Keep existing `llm_provider` (single string) as a legacy alias. Validation: if both are provided, error. If `llm_provider` is given, wrap as `[llm_provider]`. If neither, default to `['claude']`. Validate each entry against the `LlmProvider` type. Store the result in `tempAgent.llmProviders`. Continue setting `tempAgent.llmProvider` to `providers[0]` for backward compat with any code that reads the old field. Update the success message to show all providers.
- **Files:** `src/tools/register-member.ts`
- **Tier:** standard
- **Done when:** `register_member` accepts `llm_providers` array + legacy `llm_provider` string alias; both stored correctly; success message shows providers list

#### Task 1.3: Update update_member tool
- **Change:** Add `llm_providers` param (array of `LlmProvider`) to `updateMemberSchema`. Keep existing `llm_provider` as legacy alias. Same conflict-resolution logic as register: if both given, error; if single given, wrap as array. Apply updates to both `llmProviders` and `llmProvider` (first element) fields.
- **Files:** `src/tools/update-member.ts`
- **Tier:** standard
- **Done when:** `update_member` accepts `llm_providers` array; updates both fields correctly

#### VERIFY: Phase 1
- `npm run build` must succeed
- `npm test` must pass
- registry read/write round-trip works with both old and new format

---
### Phase 2: Dispatch Routing

#### Task 2.1: execute_prompt — add optional provider param
- **Change:** Add optional `provider` param (type `LlmProvider`) to `executePromptSchema`. In `executePrompt()`, resolve the provider to use: if `input.provider` is given, check it exists in the member's `llmProviders` array (via `getAgentProviders()`), error if not found; if omitted, use `providers[0]` (first in the array). Replace the current `getProvider(agent.llmProvider)` call with `getProvider(resolvedProvider)`. This affects: the `provider` variable (line ~131), `buildAuthEnvPrefix` (needs env vars for the specific provider — currently reads all stored vars, which is fine), and the `claudeCmd` construction.
- **Files:** `src/tools/execute-prompt.ts`
- **Tier:** standard
- **Done when:** `execute_prompt` with `provider: "gemini"` on a multi-provider member uses Gemini strategy; without `provider` uses first provider in list; with a provider not in the member's list returns a clear error

#### Task 2.2: provision_llm_auth — add optional provider param
- **Change:** Add optional `provider` param (type `LlmProvider`) to `provisionAuthSchema`. In `provisionAuth()`, resolve the target provider: if `input.provider` is given, validate it exists in the member's `llmProviders` array, error if not; if omitted, use `providers[0]`. Replace `getProvider(agent.llmProvider)` with `getProvider(resolvedProvider)`.
- **Files:** `src/tools/provision-auth.ts`
- **Tier:** standard
- **Done when:** `provision_llm_auth` with `provider` param targets that specific provider; without param uses first provider; errors if provider not in member's list

#### VERIFY: Phase 2
- `npm run build` + `npm test` pass
- dispatch routing verified

---
### Phase 3: Display + Tests

#### Task 3.1: member_detail + fleet_status + list_members — show all providers
- **Change:** In `member-detail.ts`, change `result.llmProvider` to show all providers (comma-separated in compact, array in JSON). In compact format line (~256), change `provider=${agent.llmProvider ?? 'claude'}` to show all providers. In `check-status.ts` (fleet_status), update compact format to show providers list. In `list-members.ts`, update both JSON (`llmProvider` field) and compact format (`provider=` field) to show all providers.
- **Files:** `src/tools/member-detail.ts`, `src/tools/check-status.ts`, `src/tools/list-members.ts`
- **Tier:** cheap
- **Done when:** all three tools list all providers for multi-provider members; single-provider members display unchanged

#### Task 3.2: Tests
- **Change:** Add tests covering: (1) multi-provider registration — register with `llm_providers: ["claude", "gemini"]` stores array correctly, (2) backward compat — old registry entry with `llmProvider: "claude"` reads as `llmProviders: ["claude"]` transparently, (3) legacy alias — `llm_provider: "gemini"` maps to `llmProviders: ["gemini"]`, (4) execute_prompt provider routing — correct provider used when specified, first provider used when omitted, error on unknown provider, (5) provision_llm_auth provider param — targets specific provider when given, defaults to first
- **Files:** `tests/` directory (new test file: `tests/multi-provider.test.ts`)
- **Tier:** standard
- **Done when:** all new tests pass, all existing tests pass

#### VERIFY: Phase 3
- Full test suite passes
- Docs updated if any user-facing behaviour changed

---
## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Registry migration breaks existing members | High | Non-destructive: old `llmProvider` field still accepted on read; `loadRegistry()` auto-migrates to `llmProviders[]` |
| execute_prompt provider routing adds complexity | Med | Simple: if provider param given, look it up in llmProviders[]; else use llmProviders[0] |
| Backward compat gap | Med | Test explicitly: write old-format entry, read it, verify llmProviders[] |
| Dual-field drift (llmProvider vs llmProviders) | Low | Always keep llmProvider = llmProviders[0] on write; helper function for reads |
| list_members also shows provider — could be missed | Low | Task 3.1 explicitly includes list-members.ts |

## Notes
- Base branch: main
- Branch: feat/multi-provider-per-member
- Key architectural decision: keep both `llmProvider` (singular) and `llmProviders` (array) fields on the Agent type during migration. The singular field always equals `providers[0]` and provides backward compat for any code paths not yet updated. A `getAgentProviders()` helper centralizes read access.
- Files that read `agent.llmProvider` and need updating: `register-member.ts`, `update-member.ts`, `execute-prompt.ts`, `provision-auth.ts`, `member-detail.ts`, `check-status.ts`, `list-members.ts`, `auth-env.ts` (reads encrypted env vars, not provider-specific — no change needed)
