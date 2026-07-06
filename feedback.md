# Phase 1 Review -- Code Intelligence Hardening (T1.1-T1.4)

Reviewer: pm-reviewer
Date: 2026-07-06
Scope: commits ec3c81e (T1.1, F3.2), 9a19e7d (T1.2, F3.1), 118164b (T1.3, F3.3);
diff 21f3a63..HEAD limited to src/ and tests/.
Verdict: **APPROVED**

## Checklist results

### 1. F3.2 -- connection resilience (src/tools/code-intelligence-gitnexus.ts)

- [OK] Failed connect clears `connectionPromise` inside the IIFE catch before
  the rejection propagates, so the next call retries a fresh connection. The
  clear cannot clobber a newer promise: no waiter can create a replacement
  before the catch runs (the variable still holds the pending promise until
  then), and waiters hold the promise object itself, so nulling the variable
  cannot null-deref a concurrent awaiter.
- [OK] Transport/client death reset: `onDeath` is registered on
  transport.onclose/onerror and client.onclose/onerror with an identity guard
  (`sharedClient === client`) so a late handler for a replaced client cannot
  clobber a newer connection. Verified against the installed MCP SDK
  (node_modules/.../shared/protocol.js, connect()): the SDK CHAINS pre-set
  transport onclose/onerror handlers rather than discarding them, and
  `_onclose`/`_onerror` invoke client.onclose/onerror -- so the wiring fires
  in production, and the double-fire (transport handler + client handler) is
  idempotent thanks to the guard.
- [OK] All four provider methods (graph/impact/query/context) route through
  the single guarded `callGitNexus` helper.
- [OK] Dead-client errors return a structured `isError` text result naming
  'npx gitnexus analyze' and /pm index, with the underlying error message
  appended as detail. Never an unhandled throw, never a silent empty.
- [OK] `resetConnection()` runs in the catch, so the call after a caught
  error reconnects (verified by test (c): second call triggers a second
  connect).
- [OK] Concurrent first calls: single-flight `connectionPromise` semantics
  preserved (cached promise returned to the second caller).

### 2. F3.1 -- pre-flight index check

- [OK] `existsSync(<repo>/.gitnexus/meta.json)` runs at the top of
  `callGitNexus`, before `getGitNexusClient()` is awaited -- a missing index
  never spawns the child (tests assert mockConnect not called).
- [OK] Error text matches requirements.md verbatim, character for character:
  `No code intelligence index found for <repo>. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`
- [OK] Calls without `repo` (or with empty-string `repo`) forward untouched.
- [OK] Nonexistent repo directory yields the missing-index error via the same
  existsSync path.

### 3. F3.3 -- fleet_status health section (src/tools/check-status.ts)

- [OK] Read-only and fast: existsSync/readFileSync plus `git rev-parse` /
  `git rev-list --count` via execFileSync with 3s timeouts (git subprocess is
  explicitly prescribed by the plan); no MCP child spawn, no network.
- [OK] Never throws: every IO/git path is individually try/caught, meta parse
  failure degrades to present:false, unknown lastCommit (rev-list failure)
  degrades to headStatus 'unavailable' with the
  `indexed <sha:8>, HEAD comparison unavailable` fragment, and fleetStatus()
  wraps the whole section in a defensive catch besides.
- [OK] Both formats: `codeIntelligence` key in the json payload; one extra
  compact line matching the planned shape, including the
  `code-intel: no index (run 'npx gitnexus analyze' or /pm index)` absent case.

### 4. Tests

- [OK] F3.2: three resilience tests per PLAN (a/b/c), each using
  vi.resetModules() + dynamic import for cold module-singleton state; they
  assert connect attempt counts and error shape, not trivial mock echoes.
- [OK] F3.1: per-method missing-index tests (temp dir via mkdtempSync)
  asserting the exact error text and that neither connect nor callTool ran,
  plus the no-repo forwarding test. Note: these reuse the statically imported
  module whose client was cached by the earlier describe block -- order-
  dependent but deterministic under vitest's in-file ordering.
- [OK] F3.3: 9 tests covering absent index, git-unavailable degradation,
  stats/indexedAt/lastCommit parsing, invalid JSON, nonexistent dir, and all
  four compact-line renderings.

### 5. Build and tests (run by reviewer)

- `npm run build`: clean, no tsc errors.
- `npm test`: 1647 passed, 14 skipped, 2 failed -- the two failures are
  exactly the known pre-existing timezone-dependent tests in
  tests/time-utils.test.ts (beads yashr-302). No other failures.

### 6. ASCII

- `git diff 21f3a63..HEAD -- src/ tests/` contains no non-ASCII bytes.

## Advisory notes (non-blocking, LOW)

1. LOW -- `callGitNexus`'s catch calls `resetConnection()` without closing the
   abandoned client. When `callTool` throws while the child is still alive
   (e.g. an MCP request timeout or a protocol-level McpError rather than a
   dead transport), the still-running `npx gitnexus mcp` child is orphaned and
   the next call spawns a new one; repeated occurrences on a long-lived server
   accumulate orphaned children. A `void client.close().catch(() => {})` in
   the reset path (or an identity-guarded reset that closes the old client)
   would tidy this. Behavior otherwise matches the F3.2 spec, which mandates
   reset-on-caught-error; not a blocker.
2. LOW -- cosmetic: the compact line renders `1 commits behind HEAD`
   (singular/plural), and an index AHEAD of HEAD (e.g. after a reset) would
   render `0 commits behind HEAD`. Harmless; fix opportunistically if the line
   format is ever revisited.

## Verdict

APPROVED. All F3.1/F3.2/F3.3 contracts are met, the required tests exist and
are meaningful, build and full suite pass (modulo the two known pre-existing
timezone failures), and the diff is ASCII-only. The two LOW notes above are
advisory and do not require rework this phase.
