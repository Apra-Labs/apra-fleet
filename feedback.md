# Review: `plan/issue-216` — Auth-Socket Flaky Test Fix

**Reviewer:** fleet-rev (Claude)
**Branch:** `plan/issue-216`
**Commits reviewed:** `1f86de8` (fix), `c0cccce` (test)
**Date:** 2026-05-06

---

## Checklist

### 1. Correctness of `activeSockets` lifecycle

**PASS.** `activeSockets.add(conn)` is called in the `createServer` handler (line 78), and `conn.on('close', ...)` removes it (line 79). The `close` event fires reliably after `destroy()` — Node.js guarantees `close` fires after `end`/`destroy` on a socket, so there's no leak path. Edge case: if a connection is refused before the handler fires, it never enters `activeSockets`, so no dangling reference.

### 2. `pendingRequests.clear()` placement

**PASS.** Moved to line 226, before socket destruction (line 229) and before the `!socketServer` early return (line 234). This ensures cleanup always runs regardless of server state. Semantically correct: once cleanup starts, no request should survive — destroying sockets will sever in-flight connections anyway.

### 3. No-server early return

**PASS.** When `!socketServer` (line 234), the function returns `Promise.resolve()` after clearing pending state and destroying sockets. This correctly skips `closingPromise` bookkeeping — there's no server to close, so no async callback to wait for. The Unix socket file unlink is still attempted (line 236), which is correct for cleanup of stale files.

### 4. `closingPromise = null` in async vs sync path

**PASS.** `closingPromise = null` appears at line 250, inside the `onComplete` callback, which is inside the `server.close()` callback (line 245). This is async — it only fires after the server has fully closed. The synchronous path sets `socketServer = null` (line 242) immediately to signal "closing in progress" to `ensureAuthSocket`, while `closingPromise` remains non-null until the close callback fires. No synchronous overwrite issue.

### 5. Test `.catch(() => {})` pattern

**PASS.** At test line 321 (`passwordPromise.catch(() => {})`), this attaches a no-op rejection handler synchronously. The rejection from `waiter.reject(new Error('Auth socket closed'))` fires during `cleanupAuthSocket()` (line 322), before `expect(passwordPromise).rejects.toThrow(...)` on line 324. Without the `.catch`, the rejection would be unhandled for one microtask tick, triggering Node's unhandled-rejection warning. The `.catch` suppresses the warning without consuming the rejection — `.rejects.toThrow()` still observes it correctly because Promise rejections can have multiple handlers.

### 6. Test suite — `npm test`

**PASS.** All 1262 tests pass (76 test files), 0 failures. Auth-socket tests specifically: 38/38 pass in 803ms, no flakiness observed.

---

## Additional observations

- **`closingPromise` idempotency (line 216-218):** If `cleanupAuthSocket()` is called while already closing, it returns the existing `closingPromise`. This prevents double-close and is correct. `ensureAuthSocket` also awaits `closingPromise` (line 57-59) before proceeding, preventing a race where a new server starts while the old one is still releasing the pipe.

- **Client `destroy()` in tests:** All test clients now call `client.destroy()` after `client.end()`. This is the fix for the root cause — `end()` initiates a graceful FIN but keeps the socket in `TIME_WAIT`; `destroy()` forcefully tears it down so `server.close()` can complete immediately. Consistent across all 7 client usage sites in the test file.

- **`cleanupAuthSocket` return type change:** `void` → `Promise<void>`. All callers updated to `await`. The `afterEach` hooks are now `async` (lines 20, 338, 403). This is a breaking API change but is correct — the old synchronous API was the bug.

- **Unrelated changes present on this branch:** The branch contains many other commits (secret CLI, credential-store, network policy fixes). This review is scoped only to the two auth-socket fix commits (`1f86de8`, `c0cccce`) as specified in the task.

- **No GEMINI.md or stray context files** in the two reviewed commits. Earlier commits on the branch had cleanup commits that removed such files.

---

## Verdict

**APPROVED** — All 6 checklist items verified. The `activeSockets` tracking correctly unblocks `server.close()`, `closingPromise` serialization prevents races, `pendingRequests.clear()` placement ensures deterministic cleanup, and the test `.catch` pattern correctly suppresses unhandled-rejection warnings. 1262/1262 tests pass.
