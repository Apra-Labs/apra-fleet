# gbrain Integration — Phase 1 Code Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-13
**Verdict:** CHANGES NEEDED

---

## 1. Types — `src/types.ts` (T1.1)

**PASS.** `gbrain?: boolean` added to `Agent` interface at line 33. Optional field, no migration needed — existing agents without the field are `undefined` (falsy). Follows the same pattern as other optional Agent fields (`unattended`, `llmProvider`, etc.). TypeScript compiles cleanly.

---

## 2. Tool Schemas — register/update/list/detail (T1.2)

### register-member.ts — PASS

`gbrain` added to `registerMemberSchema` as `z.boolean().optional().default(false)`. Passed through to agent creation at line 176 (`gbrain: input.gbrain ?? false`). Follows existing patterns for `llm_provider` and `unattended` fields. Default false is correct — gbrain is opt-in.

### update-member.ts — PASS

`gbrain` added to `updateMemberSchema` as `z.boolean().optional()`. Toggled at line 124 with `if (input.gbrain !== undefined)` guard — same pattern used for `unattended` and `llmProvider`. Correctly allows setting to both `true` and `false`.

### list-members.ts — PASS

JSON format includes `gbrain: a.gbrain ?? false` in the member object. Compact format conditionally appends `| gbrain=enabled` only when truthy — avoids noise for non-gbrain members. Clean integration into existing display logic.

### member-detail.ts — PASS

JSON includes `gbrain: agent.gbrain ?? false`. Display string conditionally appends `| gbrain=enabled`. Follows the same conditional display pattern used in list-members.

### Backward Compatibility — PASS

All four tools default `gbrain` to `false` when the field is absent (`a.gbrain ?? false`). Existing members without the field will display correctly. No breaking changes to existing tool schemas — `gbrain` is optional in all schemas.

---

## 3. MCP Client Service — `src/services/gbrain-client.ts` (T1.3)

### Architecture — PASS

Singleton pattern via `getGbrainClient()` with `_resetGbrainClient()` for testing. Lazy connect on first `callTool` invocation. Clean separation of concerns.

### Configuration — PASS

Respects `GBRAIN_COMMAND` and `GBRAIN_ARGS` env vars with sensible defaults (`npx -y gbrain`). Constructor accepts options override. `GBRAIN_ARGS` split on space — simple but adequate for typical args.

### Connection Lifecycle — PASS

- `connect()` is idempotent (no-op if already connected)
- Validates connection by listing available tools via `client.listTools()`
- `disconnect()` handles already-disconnected state and swallows close errors (process may be dead)
- State is fully reset on disconnect (client, transport, tools, connected flag)

### Lazy Reconnect — PASS

`callTool()` checks `!this.connected || !this.client` and reconnects transparently. On unexpected errors during tool calls, marks connection as stale (resets state) so next call triggers reconnect. Good resilience pattern.

### Error Handling — PASS

Three distinct error paths:
1. Connect failure: "gbrain is not available — is the process running?"
2. Tool returns `isError: true`: extracts text content and rethrows with tool name
3. Connection drops mid-call: marks stale, throws with "connection may have dropped"

Error messages are user-actionable. The `startsWith('gbrain tool')` check in the catch block correctly differentiates tool-level errors (rethrown as-is) from transport errors (trigger stale state).

### Content Extraction — PASS

Handles both array content (filters for `type: 'text'`, joins with newline) and non-array content (`String(result.content ?? '')`). Type narrowing via inline type predicate is correct.

### Minor Note — NOTE

`getAvailableTools()` returns a defensive copy (`[...this.availableTools]`), which is good practice. The available tools list is populated on connect but never refreshed — acceptable for Phase 1 since gbrain's tool set is stable during a session.

---

## 4. Test Coverage (T1.4)

### gbrain-client.test.ts — PASS (13 tests)

Covers all critical paths:
- Initial state (disconnected, no tools)
- Connect lifecycle (connect, idempotent reconnect, disconnect, disconnect when not connected)
- `callTool` — success, lazy connect, error result, connection drop, connect failure
- Singleton behavior (same instance, reset creates new)
- Defensive copy of available tools

Mocking strategy is correct: MCP SDK `Client` and `StdioClientTransport` are mocked at module level. Mock reset in `beforeEach` ensures test isolation.

### gbrain-config.test.ts — PASS with gap (5 tests)

Tests cover:
- Register with `gbrain: true` persists
- Register without gbrain defaults to falsy
- Local agent supports gbrain
- Update to enable gbrain
- Update to disable gbrain

### Test Gap — FAIL

**Missing: `list_members` and `member_detail` gbrain display tests.** PLAN.md T1.4 explicitly lists "list_members showing gbrain status" as a done-when criterion. Neither `listMembers` nor `memberDetail` are imported or tested in `gbrain-config.test.ts`. The display logic (compact format conditional `| gbrain=enabled`, JSON format `gbrain` field) has no test coverage.

**Required fix:** Add tests to `gbrain-config.test.ts` that:
1. Call `listMembers()` with a gbrain-enabled agent and verify the output contains `gbrain=enabled` (compact) and `"gbrain": true` (JSON)
2. Call `listMembers()` with a non-gbrain agent and verify `gbrain=enabled` does NOT appear
3. Call `memberDetail()` with a gbrain-enabled agent and verify the output contains `gbrain=enabled`

---

## 5. Security

**PASS.** No secrets exposed. No unsafe operations. `gbrain` field is a simple boolean — no injection surface. Child process spawned with user-controlled command/args from env vars, which is the standard pattern for MCP server configuration.

---

## 6. Build & Existing Tests

**PASS.** `npm run build` succeeds with zero errors. `npm test` shows 2 failures in `tests/time-utils.test.ts` which are pre-existing timezone-dependent failures unrelated to this changeset. All 1242 passing tests continue to pass, including the 18 new gbrain tests.

---

## 7. PLAN.md Spec Compliance

| Spec Item | Status |
|---|---|
| T1.1: `gbrain?: boolean` on Agent | DONE |
| T1.2: register_member with gbrain | DONE |
| T1.2: update_member toggle gbrain | DONE |
| T1.2: list_members shows gbrain | DONE (code), MISSING (tests) |
| T1.2: member_detail shows gbrain | DONE (code), MISSING (tests) |
| T1.3: Singleton, lazy connect | DONE |
| T1.3: StdioClientTransport spawn | DONE |
| T1.3: Tool validation on connect | DONE |
| T1.3: callTool proxy | DONE |
| T1.3: isConnected/getAvailableTools | DONE |
| T1.3: disconnect kills process | DONE |
| T1.3: Reconnect on crash | DONE |
| T1.3: Clear error messages | DONE |
| T1.4: 18 new tests | DONE (but missing list/detail display tests) |
| VERIFY: build succeeds | DONE |
| VERIFY: tests pass | DONE (pre-existing failures only) |

---

## Summary

Phase 1 implementation is solid. Code quality is high, error handling is thorough, patterns match existing codebase conventions, and backward compatibility is maintained. The MCP client service is well-designed with proper lifecycle management and reconnection logic.

**One blocking issue:** Missing test coverage for `list_members` and `member_detail` gbrain display output, which is explicitly required by PLAN.md T1.4. Add 3-4 tests covering compact and JSON format gbrain display, then this is ready to merge.
