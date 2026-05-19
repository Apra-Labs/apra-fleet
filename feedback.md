# Phase 3 Cumulative Review -- Event Wiring + Client Configuration (#258)

**Reviewer:** w34k7
**Date:** 2026-05-19
**Branch:** feat/mcp-sse-transport
**Phase 3 commits reviewed:** 96d586b (T7), 57b482d (T8), b96e8b2 (T9), bc60d04 (VERIFY)
**Phase 1 commits (regression check):** 4ed4786 (T1), 8109cf1 (T2), 538d9f0 (T3)
**Phase 2 commits (regression check):** 4064eba (T4), d918615 (T5), 6b13e82 (T6), f18253d (VERIFY)
**Verdict:** APPROVED

---

## 1. Build + Test

- `npm run build`: PASS (tsc, no errors)
- `npm test`: PASS (84 test files, 1332 passed, 6 skipped, 0 failures)
- New tests added in Phase 3:
  - credential-event.test.ts (3 tests) -- all pass
  - install-multi-provider.test.ts -- 8 new transport-specific tests added (lines 772-868)
  - transport-integration.test.ts (7 tests across 6 describe blocks) -- all pass
- Phase 1 tests (event-bus, http-transport, sea-http-verify) -- still pass, no regression
- Phase 2 tests (singleton) -- still pass, no regression

---

## 2. Phase 1 + Phase 2 Regression Check

Both phases were previously APPROVED. Confirming no regression:

- `src/services/event-bus.ts`: Unchanged since Phase 1 commit 4ed4786.
- `src/services/http-transport.ts`: Unchanged since Phase 2 LOW fixes.
- `src/services/singleton.ts`: Unchanged since Phase 2 commit 6b13e82.
- `src/services/tool-registry.ts`: Unchanged since Phase 2 commit 4064eba.
- `src/index.ts`: Unchanged since Phase 2 commit d918615.
- `src/paths.ts`: Unchanged since Phase 2.
- `src/tools/shutdown-server.ts`: Unchanged since Phase 2 commit d918615.
- All Phase 1 and Phase 2 tests still pass. No behavioral regression.

Phases 1 and 2 are intact.

---

## 3. Phase 3 Task Completion vs Done Criteria

### T7: Wire credential_store_set Completion Event (96d586b) -- PASS

Done criteria from PLAN.md:
- [x] When auth-socket delivers a password, the event bus emits `credential:stored` with the credential name
- [x] Test passes
- [x] Existing auth-socket tests still pass (no regression)

Verification:
- The emit is at `src/services/auth-socket.ts:124`, inside the `if (waiter)` block, immediately after `waiter.resolve(pending.encryptedPassword)`. This is the exact correct location -- it fires ONLY after:
  1. The message is valid (type=auth, member_name, password present)
  2. A pending auth request exists for this member
  3. The password has been encrypted and the ack sent to the socket client
  4. A waiter (tool handler) exists and is resolved
- It does NOT fire when: no pending auth exists (line 104 early return), invalid message (line 127), invalid JSON (line 130), or no waiter exists (if block skipped).
- The emit payload `{ name: msg.member_name }` matches the FleetEventMap type definition.
- credential-event.test.ts has 3 tests: (1) emits on successful OOB delivery, (2) emits with correct member name, (3) does NOT emit on failed delivery. All three are real end-to-end tests using the actual auth socket (net.connect), not mocks.

### T8: Update Install Command with Provider-Specific Configs (57b482d) -- PASS

Done criteria from PLAN.md:
- [x] `apra-fleet install` registers MCP server with HTTP transport config (URL-based)
- [x] `apra-fleet install --transport stdio` registers with stdio config as before
- [x] Unit tests verify correct config shape for each provider x transport combination

Verification of each provider's HTTP config against PLAN.md spec:

**Claude HTTP:**
```
claude mcp add --scope user --transport http apra-fleet http://localhost:7523/mcp
```
Matches PLAN.md exactly. The `claude mcp remove` best-effort call precedes it.

**Gemini HTTP:** `mergeGeminiConfig(paths, { httpUrl: fleetUrl })` -> via spread `{ ...mcpConfig, trust: true }` produces:
```json
{ "httpUrl": "http://localhost:7523/mcp", "trust": true }
```
Matches PLAN.md exactly.

**Copilot HTTP:** `mergeCopilotConfig(paths, { url: fleetUrl, type: 'http' })` -> direct assignment produces:
```json
{ "url": "http://localhost:7523/mcp", "type": "http" }
```
Matches PLAN.md exactly.

**Codex HTTP:** `mergeCodexConfig(paths, { url: fleetUrl })` -> `if (mcpConfig.url)` branch produces:
```toml
[mcp_servers.apra-fleet]
url = "http://localhost:7523/mcp"
```
Matches PLAN.md exactly.

**stdio mode:** All four providers fall into the `else` branch and use the existing command+args pattern. No regression.

**Default port:** 7523 from `DEFAULT_PORT` in paths.ts. Correct.

**--transport flag parsing:** Supports both `--transport http` and `--transport=http` forms. Invalid values produce an error and exit(1). Default is `http`. Added to known flags for unknown-flag rejection.

Test coverage: 8 new transport-specific tests (lines 772-868) plus 1 regression test for TOML validity with stdio transport (line 401). The new tests verify: Claude http default, Claude stdio, Gemini http, Gemini stdio, Copilot http, Copilot stdio, Codex http, and invalid transport error.

### T9: Integration Tests + Gemini Client Verification (b96e8b2) -- PASS

Done criteria from PLAN.md:
- [x] All integration tests pass
- [x] Both transports verified end-to-end
- [x] Notification broadcast to multiple clients confirmed
- [x] Gemini-compatible client test passes

Verification of each integration test:

**(a) HTTP server tool call end-to-end:** Creates a real HTTP transport server (port 0), connects a real StreamableHTTPClientTransport, calls the `version` tool, and verifies the response contains 'apra-fleet'. This is a genuine end-to-end test exercising the full POST /mcp -> McpServer -> tool handler -> response path. Not hollow.

**(b) Event bus -> notification/message broadcast:** Starts server, connects client, sets a notification handler for LoggingMessageNotificationSchema, emits `credential:stored` on the event bus, and verifies the client receives the notification with correct payload (event name + credential name). This validates the sprint's motivating use case: auth-socket -> event bus -> HTTP transport -> notifications/message. Not hollow.

**(c) Broadcast to multiple concurrent clients:** Starts one server, connects two clients, tracks SSE GET requests to confirm both streams are open, emits one event, verifies BOTH clients receive the notification. Includes a deadline loop to wait for both SSE streams to open (up to 3s). This is the most complex and important test -- genuine concurrent multi-session verification. Not hollow.

**(d) stdio regression via InMemoryTransport:** Creates a McpServer + InMemoryTransport pair (the same pattern as stdio), registers tools, calls the version tool. Validates that tool registration and response work over the stdio-equivalent path. Adequate regression coverage.

**(e) Localhost-only binding (2 sub-tests):** Checks `httpServer.address().address === '127.0.0.1'` and URL pattern. Correct.

**(f) Gemini client compatibility:** Uses `StreamableHTTPClientTransport` (the same transport class Gemini CLI uses). Connects to the fleet server, calls the `version` tool, AND calls `listTools()` to verify the initialization handshake. References `google-gemini/gemini-cli#5268` in a code comment (lines 242-248). The comment correctly frames the diagnostic: if this test passes but Gemini CLI fails, the issue is Gemini-side. Not hollow -- this is a real client connecting, initializing, and making tool calls against our server.

---

## 4. Acceptance Criteria Check (requirements.md)

Checking each acceptance criterion against Phases 1-3 delivery:

| # | Criterion | Status | Delivered By |
|---|-----------|--------|-------------|
| 1 | Fleet runs as singleton HTTP+SSE by default; second launch reuses | DONE | T5+T6 (Phase 2) |
| 2 | Multiple MCP clients connect concurrently with own SSE stream | DONE | T2 (Phase 1), T9c (Phase 3) |
| 3 | --transport stdio still selects legacy path, no regression | DONE | T5 (Phase 2), T9d (Phase 3) |
| 4 | GET /events SSE stream; POST endpoint handles JSON-RPC | DONE | T2 (Phase 1): POST /mcp + GET /mcp for SSE |
| 5 | Generated mcp.json is "type: sse" by default; "type: stdio" when --transport stdio | DONE | T8 (Phase 3): all 4 providers x 2 modes |
| 6 | Internal event bus exists; subsystems can publish events to SSE | DONE | T1 (Phase 1) |
| 7 | credential_store_set pushes completion notification, no polling | DONE | T7 (Phase 3) |
| 8 | Both transports pass test suite; new tests cover SSE + event bus | DONE | T9 (Phase 3) |
| 9 | Docs updated for --transport flag, default, event bus | PENDING | Phase 4 (T10) |
| 10 | Full existing test suite green; pre-commit ASCII hook passes | DONE | 1332 pass, 6 skip, 0 fail |

All acceptance criteria are substantially met by Phases 1-3. Only documentation (criterion 9) remains, which is Phase 4 scope.

---

## 5. Hard Part Scrutiny

### T7: credential:stored event placement in auth-socket.ts

**PASS.** The event genuinely flows through the complete chain:

1. **auth-socket.ts:124** -- `fleetEvents.emit('credential:stored', { name: msg.member_name })` fires after `waiter.resolve()` on successful OOB password delivery.
2. **event-bus.ts** -- The typed EventEmitter singleton delivers to all subscribers.
3. **http-transport.ts** -- The `fleetEvents.on('credential:stored', ...)` listener calls `session.server.server.sendLoggingMessage(...)` for each active session.
4. **MCP client** -- Receives a `notifications/message` notification via SSE stream.

Integration test (b) verifies step 1->2->3->4 end-to-end. Integration test (c) verifies the broadcast to multiple clients.

Critical: the emit is NOT called when delivery fails. The code structure ensures this:
- Line 103: `if (!pending)` returns early with error ack -- no emit.
- Line 119: `if (waiter)` guards the emit -- if no waiter exists, no emit.
- Test 3 in credential-event.test.ts explicitly verifies: sending a password for an unknown member does NOT trigger the event.

### T8: Provider config formats match PLAN.md

**PASS.** Verified each format against PLAN.md Task 8:

- Claude: `claude mcp add --scope user --transport http apra-fleet http://localhost:7523/mcp` -- exact match.
- Gemini: `{ "httpUrl": "http://localhost:7523/mcp", "trust": true }` -- exact match.
- Copilot: `{ "url": "http://localhost:7523/mcp", "type": "http" }` -- exact match.
- Codex: `[mcp_servers.apra-fleet] url = "http://localhost:7523/mcp"` TOML -- exact match.
- stdio mode: all four providers keep existing command+args format -- no regression.
- Default port: 7523 -- correct.

The `mergeGeminiConfig` function uses spread (`{ ...mcpConfig, trust: true }`) which cleanly passes through `httpUrl` for HTTP and `command`+`args` for stdio. The `mergeCodexConfig` function has an explicit `if (mcpConfig.url)` branch for HTTP vs the existing backslash-normalization path for stdio. Both approaches are correct and clean.

### T9: Integration tests are genuine, not hollow

**PASS.** Each test creates real servers, real transports, real clients, and makes real requests:

- Tests (a), (b), (c), (f) all use `createHttpTransport()` to start a real HTTP server on port 0 and `StreamableHTTPClientTransport` to make real HTTP connections.
- Test (b) emits a real event on the event bus and waits for the notification to arrive via the SSE stream.
- Test (c) connects two real clients and verifies both receive the broadcast.
- Test (f) explicitly exercises the Gemini-compatible path and includes `listTools()` to verify the full initialization handshake.
- No mocks on the transport or server layers -- these are true integration tests.

### T9f: Gemini bug reference

**PASS.** The comment block at lines 237-249 of transport-integration.test.ts explicitly references `google-gemini/gemini-cli#5268` and correctly frames the diagnostic: if this test passes but Gemini CLI still fails in production, the failure is Gemini-side.

---

## 6. Security: Localhost-Only Binding

PASS. No changes to binding behavior. Integration test (e) explicitly verifies `address === '127.0.0.1'`. No `0.0.0.0` anywhere in the codebase's transport code.

---

## 7. File Hygiene

Changed files (20 total):

| File | Justification |
|------|--------------|
| PLAN.md | Implementation plan |
| feedback.md | Review artifact (this file) |
| progress.json | Task progress tracking |
| requirements.md | Requirements document |
| src/cli/install.ts | T8: --transport flag, provider-specific HTTP configs |
| src/index.ts | T5 (Phase 2, unchanged in Phase 3) |
| src/paths.ts | T5 (Phase 2, unchanged in Phase 3) |
| src/services/auth-socket.ts | T7: import fleetEvents + emit credential:stored |
| src/services/event-bus.ts | T1 (Phase 1, unchanged) |
| src/services/http-transport.ts | T2 (Phase 1) + Phase 2 fixes, unchanged in Phase 3 |
| src/services/singleton.ts | T6 (Phase 2, unchanged) |
| src/services/tool-registry.ts | T4 (Phase 2, unchanged) |
| src/tools/shutdown-server.ts | T5 (Phase 2, unchanged) |
| tests/credential-event.test.ts | T7: 3 tests for credential:stored event emission |
| tests/event-bus.test.ts | T1 tests (Phase 1, unchanged) |
| tests/http-transport.test.ts | T2 tests (Phase 1, unchanged) |
| tests/install-multi-provider.test.ts | T8: 8 new transport tests + 1 TOML regression test |
| tests/sea-http-verify.test.ts | T3 tests (Phase 1, unchanged) |
| tests/singleton.test.ts | T6 tests (Phase 2, unchanged) |
| tests/transport-integration.test.ts | T9: 7 integration tests (a-f) |

- CLAUDE.md: NOT committed (verified via `git diff --name-only`)
- No stray files, no unrelated changes
- All files justified by their respective tasks

---

## 8. Observations (non-blocking)

### LOW-1: Pre-existing test nesting issue in install-multi-provider.test.ts

The test "Codex MCP registration writes [mcp_servers.apra-fleet] TOML section" (line 253) appears to be nested inside the callback of the Gemini trust test (line 238) due to inconsistent indentation. This is a pre-existing structure issue (the test existed before Phase 3). The new Phase 3 transport-specific tests (lines 772-868) properly cover all provider x transport combinations at the correct nesting level, so test coverage is not impacted. If addressed in a future cleanup, the nested test should be un-indented to the describe level and its assertion updated from `command =` to `url =` to reflect the new HTTP default.

### LOW-2: Em-dashes in tool-registry.ts tool descriptions

Pre-existing from Phase 2 review (LOW-2 in that review). Three tool descriptions contain em-dashes. Not a Phase 3 issue.

---

## 9. Verdict

All three Phase 3 tasks (T7, T8, T9) meet their done criteria. Phase 1 (T1, T2, T3) and Phase 2 (T4, T5, T6) have not regressed. Build and tests pass (84 files, 1332 tests, 0 failures). The credential:stored event fires at the correct point in auth-socket.ts after OOB delivery and does not fire on failure. All four provider configs match the exact PLAN.md formats for both HTTP and stdio modes. The 7 integration tests are genuine end-to-end tests, not hollow assertions. The Gemini client compatibility test passes and references the known bug. All acceptance criteria except documentation (Phase 4) are met. File hygiene is clean. No HIGH or MEDIUM findings.

**VERDICT: APPROVED**
