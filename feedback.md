# Code Review: Session-ID Collision Fix (9e37514)

**Reviewer:** fleet-rev
**Date:** 2026-05-16
**Commit:** 9e37514 fix(session): mint session-id up front to prevent collision
**Branch:** e2e/local-only
**Verdict:** APPROVED

---

## Fix Point 1: provider.ts buildSessionIdFlag -- PASS

`buildSessionIdFlag(sessionId)` added at provider.ts, returns `--session-id "<sanitized>"`.
Existing `buildResumeFlag` retained. Both use `sanitizeSessionId` for injection prevention.
The `PromptOptions` interface gains `resuming?: boolean`. The `resumeFlag` signature
updated to `(sessionId?: string, resuming?: boolean)`. Clean and correct.

## Fix Point 2: execute-prompt.ts mints session ID up front -- PASS

Session ID computed before command construction:
- `resuming = !!(input.resume && agent.sessionId && provider.supportsResume())`
- `mintedId = resuming ? agent.sessionId! : uuid()` (for claude/gemini)
- copilot/codex get `undefined` (correct -- they cannot accept caller-supplied IDs)

The fs.watch dir-guess block (old lines ~199-216) is deleted. The stall detector
now receives `resolveSessionLogPath(provider, mintedId, workFolder)` directly in
`onPidCaptured`. This is a significant simplification and eliminates the race-prone
mtime-based watcher.

Retry paths (stale session, server overload) both mint fresh UUIDs with
`resuming: false` -- correct, retries should not resume the failed session.

## Fix Point 3: claude.ts + gemini.ts route through shared helpers -- PASS

**claude.ts buildPromptCommand:** Uses `buildResumeFlag(sessionId)` when resuming,
`buildSessionIdFlag(sessionId)` for new sessions. No `-c` anywhere in the file.

**claude.ts resumeFlag (Windows path):** Same logic -- `resuming ? buildResumeFlag : buildSessionIdFlag`.

**gemini.ts buildPromptCommand:** Uses `buildResumeFlag` / `buildSessionIdFlag`
symmetrically. No `--resume latest` anywhere in the file.

**gemini.ts resumeFlag (Windows path):** Mirrors buildPromptCommand exactly.

Both providers' Linux and Windows paths are now structurally identical -- the same
conditional dispatches to the same shared helpers.

## Fix Point 4: parseResponse assertion -- PASS

Implemented at the call site in execute-prompt.ts (lines ~254-258) rather than
inside each provider's parseResponse method. This is a reasonable design choice:
the assertion needs access to `mintedId` which is only known at the orchestration
layer.

Logic: if `mintedId && parsed.sessionId && parsed.sessionId !== mintedId`, logs the
mismatch and calls `touchAgent(agent.id, undefined)` -- refusing to persist the
wrong ID. On match, persists `mintedId ?? parsed.sessionId`. Correct.

## Fix Point 5: Resume with no stored ID mints fresh --session-id -- PASS

When `input.resume=true` but `agent.sessionId` is falsy, `resuming` evaluates to
`false`, so `mintedId = uuid()`. The command gets `--session-id <fresh-uuid>`,
never `-c` or `--resume latest`. This is the "lost the id -> clean known session"
behavior specified in requirements.md.

## Fix Point 6: copilot.ts / codex.ts behavior UNCHANGED -- PASS

Both files received ONLY a documenting comment (3 lines each) before the class
declaration. No method bodies changed. No imports changed. The comments accurately
describe the known exception (CLI cannot take caller-supplied session ID, relies on
mtime-scan fallback in find-log-file.ts).

In execute-prompt.ts, the `mintedId` ternary yields `undefined` for providers
other than claude/gemini, so copilot/codex flow through the existing code path
unchanged.

---

## Dedicated Section: codex.ts / copilot.ts No-Behavior-Change Verification

Diffed both files line-by-line:

**codex.ts:** +3 lines (comment block before class). Zero changes to imports,
methods, or runtime logic. The class body is byte-identical to the parent commit.

**copilot.ts:** +3 lines (comment block before class). Zero changes to imports,
methods, or runtime logic. The class body is byte-identical to the parent commit.

**execute-prompt.ts interaction:** `mintedId` is `undefined` for copilot/codex
(the ternary checks `provider.name === 'claude' || provider.name === 'gemini'`).
All `mintedId`-gated branches are therefore skipped, and these providers follow
their pre-existing code paths.

**Verdict: No behavioral change. PASS.**

---

## Test Quality

**New tests in execute-prompt.test.ts (6 tests):**
- Fresh session: asserts `--session-id <uuid>`, no `-c`, no `--resume`
- Resumed session: asserts `--resume <stored-id>`, no `-c`, no `--session-id`
- Resume with no stored ID: asserts `--session-id <uuid>`, no `-c`
- Session-id mismatch: asserts wrong ID is NOT persisted
- Session-id match: asserts correct ID IS persisted
- All tests exercise the actual `executePrompt` function end-to-end with mocked exec

**New tests in providers.test.ts (14 tests):**
- Claude: `--session-id` for new, `--resume` for resume, no flags when no ID
- Gemini: `--session-id` for new, `--resume` for resume, no `--resume latest`
- `buildSessionIdFlag`: sanitization and injection rejection
- Cross-OS consistency: 4 tests verifying buildPromptCommand and resumeFlag produce
  identical flags for the same inputs (Claude new/resume, Gemini new/resume)
- Resume-with-no-stored-ID: verifies `--session-id`, not `-c`

**Old tests updated:** The `-c` asserting tests (ClaudeProvider #108) were replaced
with the new `--session-id` / `--resume` assertions. The `--resume latest` Gemini
test was replaced. No stale assertions remain.

**Full suite:** 77 test files, 1272 passed, 6 skipped (pre-existing), 0 failures.

**Build:** `npm run build` (tsc) passes cleanly.

---

## Minor Observations (non-blocking)

1. **windows.ts credential helper change (line 238):** The commit includes a
   change from `"\`r\`n"` to `[Environment]::NewLine` in the git credential helper
   script. This is functionally equivalent on Windows (both produce CRLF) but is
   unrelated to the session-id fix. Not a behavioral concern, but noted as scope
   creep. May have been done for ASCII compliance (the surrounding comments in
   windows.ts contain pre-existing non-ASCII em-dashes).

2. **Pre-existing non-ASCII in windows.ts:** Lines 3, 238, 252, 262, 266-267, 300
   contain em-dashes and a BOM. These are NOT introduced by this commit -- they
   pre-date it. Not blocking this review.

---

## Summary

All 6 fix points from requirements.md are correctly implemented. The `-c` flag is
fully eliminated from claude.ts dispatch paths. The `--resume latest` fallback is
fully eliminated from gemini.ts. Session IDs are minted up front with `uuid()`,
passed explicitly to the CLI, and asserted on return. The fs.watch dir-guess
complexity is removed in favor of direct path resolution. copilot.ts and codex.ts
have zero behavioral changes (comment-only additions verified by line-by-line diff
and runtime path analysis). The test suite is comprehensive, covering all specified
scenarios including cross-OS consistency. Build and all 1272 tests pass.

**Verdict: APPROVED**
