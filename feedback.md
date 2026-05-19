# Phase 1 Execution Review -- Core Abstractions + Risk Validation (#258)

**Reviewer:** 676yc
**Date:** 2026-05-19
**Branch:** feat/mcp-sse-transport
**Commits reviewed:** 4ed4786, 8109cf1, 538d9f0, b3f07dc
**Verdict:** APPROVED

---

## 1. Build + Test

- `npm run build`: PASS (tsc, no errors)
- `npm test`: PASS (81 test files, 1303 passed, 6 skipped, 0 failures)
- New tests: event-bus.test.ts (11 tests), http-transport.test.ts (6 tests), sea-http-verify.test.ts (4 tests) -- all pass

---

## 2. Task Completion vs Done Criteria

### T1: Typed Event Bus (4ed4786) -- PASS

Done criteria from PLAN.md:
- [x] `npm test` passes including new event-bus tests
- [x] `fleetEvents.emit('credential:stored', { name: 'x' })` delivers to all subscribers
- [x] `fleetEvents.off(...)` prevents delivery

Implementation: `src/services/event-bus.ts` -- clean TypedEventBus extending EventEmitter with typed `emit`, `on`, `off`, `once` methods. `FleetEventMap` interface covers all four event types. Singleton `fleetEvents` exported. 11 tests cover multi-subscriber delivery, unsubscribe isolation, cross-event independence, once semantics, and typed payload correctness.

### T2: HTTP Transport with Multi-Session Support (8109cf1) -- PASS

Done criteria from PLAN.md:
- [x] Two concurrent MCP clients each receive `notifications/message` when event bus emits (test c)
- [x] Server binds to 127.0.0.1 only (test a)
- [x] Port fallback works when preferred port is busy (test e)
- [x] Session cleanup works on disconnect (test d)

Implementation: `src/services/http-transport.ts` -- per-session McpServer + StreamableHTTPServerTransport architecture. Session creation on `initialize` request, session lookup by `mcp-session-id` header for subsequent requests. `onsessioninitialized`/`onsessionclosed` callbacks manage the session map. Event bus subscription broadcasts to all sessions via `sendLoggingMessage`. Port fallback from preferred port to OS-assigned port on EADDRINUSE. Health endpoint at GET /health returns JSON status.

Risk validation tests are substantive:
- (a) Verifies `address()` returns 127.0.0.1
- (b) Connects two real MCP SDK clients, verifies session map has two distinct entries
- (c) Emits event, verifies both clients receive LoggingMessageNotification with correct event type -- this is the riskiest assumption and it is proven end-to-end with real SDK clients
- (d) Sends DELETE to terminate session, verifies session map shrinks to 0
- (e) Occupies a port with a net.Server blocker, verifies transport starts on a different port

### T3: SEA Binary Compatibility Verification (538d9f0) -- PASS

Done criteria from PLAN.md:
- [x] SEA bundle builds successfully (esbuild bundles http-transport.ts)
- [x] HTTP transport code is present in the bundle (StreamableHTTPServerTransport found)
- [x] Transport can be instantiated and bind a port from the bundled code

The SEA test is NOT hollow. Test 4 is the real proof: it `require()`s the CJS bundle, calls `createHttpTransport()`, verifies the server binds a port, and hits the /health endpoint to confirm the bundled HTTP stack works end-to-end. The string-presence checks (tests 2-3) are secondary -- the functional test is what matters and it passes.

---

## 3. Security: Localhost-Only Binding

**PASS.** All three code paths that call `listenOnPort` pass `'127.0.0.1'` as the host:
- `src/services/http-transport.ts:197` -- primary bind
- `src/services/http-transport.ts:200` -- EADDRINUSE fallback

No `0.0.0.0` anywhere in the transport code. Test (a) explicitly asserts `addr.address === '127.0.0.1'`.

---

## 4. Multi-Session Model Correctness

**PASS.** The per-session McpServer model is correctly implemented:
- Each `initialize` request creates a fresh McpServer + StreamableHTTPServerTransport pair
- `onsessioninitialized` registers the session in the map; `onsessionclosed` removes it
- Event broadcast iterates the full session map and calls `sendLoggingMessage` on each -- the test proves two real SDK clients both receive the notification
- The `.catch(() => {})` on sendLoggingMessage is appropriate -- a single broken session should not block broadcast to healthy sessions

Risk R10 (per-session memory): McpServer is lightweight. At expected concurrency (2-5 clients), overhead is negligible. No concern.

---

## 5. Risk Register: Phase 1 Risks

| Risk | Status | Evidence |
|------|--------|----------|
| R1: SEA compat (@hono/node-server in bundle) | MITIGATED | T3 test 4: bundled transport starts, health responds |
| R7: Notification format (spec compliance) | MITIGATED | Uses SDK's built-in `sendLoggingMessage()`, not hand-rolled JSON-RPC |
| R9: Localhost-only bind | MITIGATED | 127.0.0.1 in both bind paths, verified by test (a) |
| R10: Per-session memory overhead | ACCEPTABLE | McpServer is a thin protocol handler; 2-5 instances is fine |

R3 (startup race) is Phase 2 -- not expected here.

---

## 6. File Hygiene

Changed files (10 total):

| File | Justification |
|------|--------------|
| PLAN.md | Implementation plan |
| feedback.md | Plan review from prior review cycle |
| progress.json | Task progress tracking |
| requirements.md | Requirements document |
| src/paths.ts | +DEFAULT_PORT constant with APRA_FLEET_PORT env var override |
| src/services/event-bus.ts | T1: typed event bus |
| src/services/http-transport.ts | T2: HTTP transport with multi-session support |
| tests/event-bus.test.ts | T1 tests |
| tests/http-transport.test.ts | T2 risk-validation tests |
| tests/sea-http-verify.test.ts | T3 SEA verification tests |

- CLAUDE.md: NOT committed (verified)
- No stray files, no unrelated changes

---

## 7. Observations (non-blocking)

### LOW-1: Event bus listeners not unsubscribed on close()

`createHttpTransport().close()` closes the HTTP server but does not call `fleetEvents.off()` for the four event listeners registered at startup. For the singleton server (which lives for the process lifetime) this is a non-issue. Tests call `fleetEvents.removeAllListeners()` in afterEach. If the transport is ever used in a non-singleton context (e.g., integration tests that create/destroy multiple transports), this could leak listeners. Consider adding cleanup in Phase 2 when the shutdown lifecycle is built.

### LOW-2: McpServer instances not explicitly closed on transport close()

When `close()` is called, individual per-session McpServer instances are not disconnected. For the singleton model this is fine -- process exit handles it. Phase 2's shutdown handler (Task 5 SIGINT/SIGTERM) should iterate sessions and close each McpServer.

### LOW-3: DELETE method handler duplicates GET pattern

Lines 151-168 (DELETE) are structurally identical to lines 134-149 (GET) -- session lookup + delegate to transport.handleRequest. This is intentional (the SDK handles DELETE semantics internally), but a minor DRY opportunity. Not worth changing now.

---

## 8. Verdict

All three Phase 1 tasks meet their done criteria. Build and tests pass. Security binding is correct. The multi-session risk-validation tests are substantive and prove the riskiest assumption end-to-end. SEA verification is functional, not hollow. File hygiene is clean. No HIGH or MEDIUM findings.

**VERDICT: APPROVED**
