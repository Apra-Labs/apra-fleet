# Phase 2 Cumulative Review -- Server Refactor + Dual Transport Startup (#258)

**Reviewer:** w34k7
**Date:** 2026-05-19
**Branch:** feat/mcp-sse-transport
**Phase 2 commits reviewed:** 4064eba (T4), d918615 (T5), 6b13e82 (T6), f18253d (VERIFY)
**Phase 1 commits (regression check):** 4ed4786 (T1), 8109cf1 (T2), 538d9f0 (T3)
**Verdict:** APPROVED

---

## 1. Build + Test

- `npm run build`: PASS (tsc, no errors)
- `npm test`: PASS (82 test files, 1313 passed, 6 skipped, 0 failures)
- New tests added in Phase 2: singleton.test.ts (10 tests) -- all pass
- Phase 1 tests (event-bus.test.ts, http-transport.test.ts, sea-http-verify.test.ts) -- still pass, no regression

---

## 2. Phase 1 Regression Check

Phase 1 was previously APPROVED. Confirming no regression:

- `src/services/event-bus.ts`: Unchanged since Phase 1 commit 4ed4786.
- `src/services/http-transport.ts`: Modified in Phase 2 to address Phase 1 LOW findings (see section 7 below). The changes are additive -- LOW-1 listener cleanup, LOW-2 McpServer close, LOW-3 DRY handler extraction. No behavioral regression; the original Phase 1 risk-validation tests still pass.
- `tests/event-bus.test.ts`, `tests/http-transport.test.ts`, `tests/sea-http-verify.test.ts`: Unchanged, all pass.
- `src/paths.ts`: DEFAULT_PORT and SERVER_INFO_PATH added (additive, no change to existing FLEET_DIR export).

Phase 1 is intact.

---

## 3. Phase 2 Task Completion vs Done Criteria

### T4: Extract Tool Registration into Shared Module (4064eba) -- PASS

Done criteria from PLAN.md:
- [x] `npm run build` succeeds
- [x] `npm test` passes
- [x] Existing stdio server starts and responds to tool calls exactly as before
- [x] No functional change (pure refactor)

Verification: Diffed tool-registry.ts against the extracted block from main's index.ts. Every tool registration, helper function (wrapTool, sendOnboardingNotification, sanitizeToolResult, getOnboardingPreamble), and import is an exact move. The tool descriptions carry over the pre-existing em-dashes from main (not newly introduced). Comments were updated to ASCII dashes where they lived in index.ts (e.g., "skip banner" arrow). startStdioServer() now calls `registerAllTools(server)` -- a thin shell as specified. No behavior change.

### T5: --transport Flag + Dual Startup Paths (d918615) -- PASS

Done criteria from PLAN.md:
- [x] `apra-fleet` (no args) starts the HTTP server and writes server.json
- [x] `apra-fleet --transport stdio` starts the stdio server (no server.json)
- [x] Both paths register all tools and start subsidiary services
- [x] server.json is deleted on SIGINT/SIGTERM or shutdown_server tool call
- [x] `npm test` passes

Verification:
- `resolveTransport()` correctly maps: no args -> 'http', `--stdio` -> 'stdio', `--transport http` -> 'http', `--transport stdio` -> 'stdio', invalid -> 'invalid' (with error exit).
- `startStdioServer()` is the pre-existing startServer() body minus tool registration (which moved to tool-registry.ts). Subsidiary services (idleManager, cleanupStaleTasks, purgeExpiredCredentials, checkForUpdate, stallDetector, SIGINT/SIGTERM handlers) are all present and match main's behavior.
- `startHttpServer()` writes server.json with `{ pid, port, url, version, startedAt }`. The shutdown() handler deletes server.json, closes HTTP server, cleans up auth socket, closes SSH connections, and stops stall detector. Both SIGINT and SIGTERM are wired to shutdown().
- `setHttpHandle(handle)` makes the HTTP server available to the shutdown_server tool, which now deletes server.json and calls handle.close() before exiting.
- Help text updated to show `--transport http|stdio` and `--stdio` alias.

### T6: Singleton Lifecycle Detection with Atomic Claim (6b13e82) -- PASS

Done criteria from PLAN.md:
- [x] Starting a second fleet HTTP instance detects running instance and exits cleanly
- [x] Two simultaneous startups serialized by lock file -- exactly one wins
- [x] Stale server.json and stale lock files are cleaned up
- [x] /health endpoint responds with status JSON
- [x] Tests pass

Verification: 10 singleton tests cover all four done criteria categories (see section 5 below for deep analysis).

---

## 4. Security: Localhost-Only Binding

PASS. No changes to the binding behavior from Phase 1. Both `listenOnPort` calls in http-transport.ts still pass `'127.0.0.1'` as the host. No `0.0.0.0` anywhere.

---

## 5. Hard Part Scrutiny

### HIGH-2 (from plan review): Singleton startup race -- claimStartupLock()

**PASS.** The implementation correctly serializes concurrent startups:

1. `fs.openSync(lockPath, 'wx')` -- uses O_CREAT | O_EXCL flags. This is atomic at the filesystem level; exactly one process wins when two call it simultaneously. Correct.

2. Lock file contains PID for debugging -- good.

3. Stale-lock cleanup: If the lock file exists and `allowRetry=true`, it checks `statSync(lockPath).mtimeMs`. If older than 60 seconds, it deletes the lock and retries once with `allowRetry=false`.

4. **Stale-lock race analysis:** Two processes P1 and P2 both find a stale lock. P1 calls `unlinkSync`, then `tryAcquire(false)` which calls `openSync(lockPath, 'wx')` -- this succeeds. P2 also calls `unlinkSync` -- this either succeeds (deletes P1's new lock) or fails (if P1 hasn't written yet). If P2 deletes P1's new lock and then calls `openSync(lockPath, 'wx')`, it creates a new lock and P1's lock is lost. However: this race requires two processes to both observe a stale lock (>60s old) at nearly the same instant. In practice, fleet startups are human-initiated (not automated at sub-second intervals), so this window is negligible. For a developer-laptop singleton, this is acceptable. The retry is limited to once (allowRetry=false on recursion), so there is no infinite loop.

5. Test coverage: (c) first claim acquires, second gets acquired=false; release deletes lock; after release, next claim works. (d) stale lock (70s old) is cleaned up and acquired; fresh lock blocks acquisition. Correct.

### checkRunningInstance(): PID liveness + /health double-check

**PASS.** The implementation:

1. Reads server.json. If missing or malformed, returns `{ running: false }`. Correct.
2. `isPidAlive(pid)` -- uses `process.kill(pid, 0)`. This is cross-platform in Node.js (works on Windows, Linux, macOS). On Unix, signal 0 doesn't actually send a signal -- it just checks if the process exists. On Windows, Node.js uses OpenProcess() internally, which has the same effect. Correct.
3. Health endpoint check: HTTP GET to `${url}/health` with 2-second timeout. If response status is 200, the instance is alive. If not, stale server.json is deleted. Correct.
4. URL transformation: `url.replace(/\/mcp$/, '/health')` -- correctly derives /health from /mcp URL. Correct.
5. Both PID and health must pass. If PID is alive but health is down (zombie, different process on same PID), returns false and deletes stale server.json. This is the right double-check. Correct.

Test coverage: (a) dead PID -> running=false, server.json deleted; (b) live PID + live health -> running=true; live PID + dead health -> running=false, server.json deleted. Missing test: malformed server.json handled. Present (test for missing pid/url fields, malformed JSON).

### T4 refactor -- pure refactor confirmation

**PASS.** I verified every tool registration line and helper function in tool-registry.ts against the corresponding code in main's index.ts. All 26 tool registrations are byte-for-byte identical. Helper functions (wrapTool, sendOnboardingNotification, sanitizeToolResult, getOnboardingPreamble) are exact copies. The only difference is structural: they now receive `server` as a parameter instead of closing over it. This is the intended refactor. No behavior change.

### --transport flag: default http, stdio fallback unchanged

**PASS.** `resolveTransport()` returns 'http' for empty args (the default). `startStdioServer()` is the original `startServer()` body with tool registration delegated to `registerAllTools()`. The stdio path logs `transport=stdio` in the startup message (previously it logged no transport, which is the only visible difference -- a logging improvement, not a behavior change). Subsidiary services (idleManager, cleanupStaleTasks, stallDetector, etc.) are identical between the two paths.

### server.json lifecycle

**PASS.**
- Written in startHttpServer() after createHttpTransport() returns (server is listening and tools are registered).
- Deleted in three places: (1) SIGINT handler in startHttpServer(), (2) SIGTERM handler in startHttpServer(), (3) shutdownServer() tool when httpHandle is set.
- Contains `{ pid, port, url, version, startedAt }` -- sufficient for checkRunningInstance() to verify.
- The startup lock is released AFTER server.json is written, ensuring there is no gap where no detection mechanism is active.

### Phase 1 LOW observations: resolution check

**LOW-1 (event bus listener cleanup):** RESOLVED. http-transport.ts now maintains an `eventCleanups` array. Each `fleetEvents.on()` call stores a corresponding `() => fleetEvents.off()` cleanup. The `close()` method iterates all cleanups. Correct.

**LOW-2 (McpServer close on shutdown):** RESOLVED. Two places: (1) `onsessionclosed` callback now calls `(s.server as any).server?.close().catch(() => {})` when a session disconnects. (2) `close()` method iterates all remaining sessions and closes each McpServer before clearing the map and closing the HTTP server. Correct.

**LOW-3 (DRY GET/DELETE handler):** RESOLVED. A shared `handleSessionRequest()` function handles session lookup and delegation for both GET and DELETE. The previous ~30 lines of duplicated code is now a single function called from both branches. Correct.

---

## 6. Test Coverage and Sandbox Limitation

The task notes that live background-process spawning could not be exercised on the doer (sandbox). The singleton test suite compensates well:

- Dead-PID detection is tested with PID 2147483647 (max int32, guaranteed non-existent).
- Live-PID detection is tested by using `process.pid` (the test process itself) with a mock HTTP server.
- Health endpoint verification is tested end-to-end (real HTTP server, real HTTP GET).
- Lock file atomicity is tested by sequential claim/claim/release patterns.
- Stale lock detection is tested by backdating file mtime.

What is NOT tested (acknowledged sandbox limitation):
- Two actual fleet processes starting simultaneously (true concurrent race). The atomic `wx` flag makes this safe by construction, and the sequential test (claim, claim, release) demonstrates the serialization logic works. This is adequate.
- True SIGINT/SIGTERM signal handling during HTTP server operation. The shutdown() function is straightforward (delete file, close server, exit), and the individual operations are each tested elsewhere. Acceptable.

**Assessment:** The test suite adequately compensates for the sandbox limitation. The critical race-prevention mechanism (O_CREAT|O_EXCL) is an OS kernel guarantee, not application logic, so it does not need a concurrent test to prove correctness.

---

## 7. File Hygiene

Changed files (15 total):

| File | Justification |
|------|--------------|
| PLAN.md | Implementation plan |
| feedback.md | Review artifact (this file) |
| progress.json | Task progress tracking |
| requirements.md | Requirements document |
| src/index.ts | T5: --transport flag, resolveTransport(), startStdioServer(), startHttpServer() |
| src/paths.ts | T5: DEFAULT_PORT constant + SERVER_INFO_PATH |
| src/services/event-bus.ts | T1 (Phase 1, unchanged in Phase 2) |
| src/services/http-transport.ts | T2 (Phase 1) + Phase 2 LOW-1/2/3 fixes |
| src/services/singleton.ts | T6: checkRunningInstance() + claimStartupLock() |
| src/services/tool-registry.ts | T4: extracted tool registration module |
| src/tools/shutdown-server.ts | T5: setHttpHandle() + server.json cleanup |
| tests/event-bus.test.ts | T1 tests (Phase 1, unchanged) |
| tests/http-transport.test.ts | T2 tests (Phase 1, unchanged) |
| tests/sea-http-verify.test.ts | T3 tests (Phase 1, unchanged) |
| tests/singleton.test.ts | T6: singleton lifecycle tests |

- CLAUDE.md: NOT committed (verified)
- No stray files, no unrelated changes
- All files are justified by their respective tasks

---

## 8. Observations (non-blocking)

### LOW-1: Stale-lock cleanup has a narrow TOCTOU window

The stale-lock cleanup sequence (statSync -> unlinkSync -> openSync) is not fully atomic. Two processes observing the same stale lock can both unlink it, and the second one's unlink may delete the first one's newly-created lock. In practice, this requires two fleet startups within microseconds of each other against a >60-second-old lock file. For a developer-laptop singleton started by human action, this is not a realistic scenario. No action needed.

### LOW-2: Em-dashes in tool-registry.ts tool descriptions

Three tool descriptions in tool-registry.ts contain em-dashes (lines 92, 93, 127). These are pre-existing from main's index.ts and were correctly preserved as part of the pure refactor (changing them would violate the "no behavior change" constraint). These are in user-facing MCP tool description strings, so changing them would alter the API surface. If the project enforces ASCII-only in a future sprint, these should be updated in a separate commit that touches main directly. Not a Phase 2 issue.

---

## 9. Verdict

All three Phase 2 tasks (T4, T5, T6) meet their done criteria. Phase 1 (T1, T2, T3) has not regressed. Build and tests pass (82 files, 1313 tests). The singleton startup race is correctly handled by atomic file creation. The dual transport paths are clean, with stdio unchanged and HTTP properly lifecycle-managed. The three Phase 1 LOW observations have all been addressed. File hygiene is clean. No HIGH or MEDIUM findings.

**VERDICT: APPROVED**
