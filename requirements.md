# Requirements — #125 Multi-provider per member

## Base Branch
`main`

## Goal
Allow a single fleet member to be registered with multiple LLM providers so the PM can select which provider to use at each dispatch, enabling mixed-model workflows (e.g. Gemini for reasoning, Claude for code generation) on the same member without re-registration.

## Scope

### 1. Schema change (`src/types.ts`)
- Change `provider?: string` → `providers?: string[]` in the member registry type
- Backward compat: when reading old registry entries with `provider`, wrap in single-element array

### 2. `register_member` + `update_member`
- Accept `providers` (array) as the primary parameter
- Keep `provider` (single string) as a legacy alias that maps to `[provider]`
- Validate each entry against the supported set: `claude`, `gemini`, `codex`, `copilot`

### 3. `execute_prompt` dispatch
- Add optional `provider` parameter — use that provider's strategy if specified
- If omitted, use the first provider in the member's list (preserves current behaviour)
- Error if the requested provider is not in the member's registered providers list

### 4. `provision_llm_auth`
- Extend to accept optional `provider` parameter to target a specific provider's auth on a multi-provider member
- If omitted, defaults to first provider (preserves current behaviour)

### 5. `member_detail` + `fleet_status`
- Display all providers (comma-separated or list) instead of single provider

## Out of Scope
- Simultaneous multi-provider dispatch in one `execute_prompt` call
- Auto-routing / model selection logic in the PM — PM specifies provider explicitly
- Changing how LLM auth tokens are stored per-provider (existing credential store layout unchanged)

## Constraints
- Existing single-provider members must continue to work with no changes required
- Registry migration must be non-destructive — old entries remain valid
- All existing tests must continue to pass

## Acceptance Criteria
- [ ] `register_member` accepts `providers: ["claude", "gemini"]` and stores array in registry
- [ ] Old registry entries with `provider: "claude"` are read as `providers: ["claude"]` transparently
- [ ] `execute_prompt` with `provider: "gemini"` on a multi-provider member uses Gemini strategy
- [ ] `execute_prompt` without `provider` uses first provider in list (unchanged behaviour)
- [ ] `execute_prompt` with a provider not in the member's list returns a clear error
- [ ] `member_detail` and `fleet_status` show all registered providers
- [ ] `provision_llm_auth` accepts optional `provider` param
- [ ] All existing tests pass; new tests cover multi-provider registration, dispatch routing, and backward compat
