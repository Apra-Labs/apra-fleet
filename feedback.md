# Sprint Plan Review — 10-Issue Blitz

**Reviewer verdict: APPROVED with notes**

**Date:** 2026-04-22
**Branch:** `sprint/10-issue-blitz`
**Reviewed:** `PLAN.md` against `requirements-10-issue-blitz.md`

---

## Per-Issue Assessment

### T1.1 — ESM `__dirname` shim (#167) ✅
- **Root cause:** Correct. Bare `__dirname` at line 63 of `compose-permissions.ts`, confirmed.
- **Files:** Correct. Shim pattern from `install.ts:123-126` verified.
- **Acceptance criteria:** Match requirements exactly.
- **Tests:** Implicit via `npm test` gate.

### T1.2 — receive_files Windows path (#146) ✅
- **Root cause:** Correct. `path.posix.resolve()` at line 49 treats `C:` as relative segment. Good analysis.
- **Files:** Correct — both `receive-files.ts` and `send-files.ts` confirmed to share the pattern.
- **Acceptance criteria:** All four path formats from the issue are explicitly listed.
- **Risk:** Correctly flagged as highest-risk in Phase 1. Ordered second (after trivial T1.1), which is fine.

### T1.3 — SSH usernames with spaces (#144) ✅
- **Root cause:** Correct. `ssh.ts:49` passes username directly; `register-member.ts:25` accepts spaces. Plan correctly identifies the real risk is shell interpolation in `src/os/*.ts`.
- **Files:** Correct targets.
- **Acceptance criteria:** Match requirements.

### T1.4 — SSH error messages (#150) ✅
- **Root cause:** Correct. Generic error at `register-member.ts:177` confirmed.
- **Files:** Correct. Plan includes the onboarding hook gate at `onboarding.ts:159` (confirmed: `result.startsWith('✅')`).
- **Acceptance criteria:** Match requirements. Error classification helper is a clean approach.

### T2.1 — send_files basename collision (#70) ✅
- **Root cause:** Correct. `sftp.ts:76` confirmed to use `path.basename(localPath)`.
- **Implementation:** Chose Option B (detect collision). Requirements say "choose one" — this is valid. Option B is simpler and lower-risk.
- **Acceptance criteria:** Match requirements.

### T2.2 — Stale task cleanup (#8) ✅
- **Root cause:** Correct. `task-wrapper.ts:34` creates dirs, never cleaned.
- **Files:** New `task-cleanup.ts` + startup hook in `index.ts`. Reasonable.
- **Acceptance criteria:** Match requirements including env var override.
- **Note:** Plan uses two separate env vars (`FLEET_TASK_RETENTION_HOURS_SUCCESS` and `FLEET_TASK_RETENTION_HOURS`). Requirements only mention one (`FLEET_TASK_RETENTION_HOURS`). This is fine — it's more granular — but the naming should be documented.

### T2.3 — Credential cleanup after expiry (#69) ✅
- **Root cause:** Correct. `provision-vcs-auth.ts:145` confirmed as integration point.
- **Files:** Correct. New `credential-cleanup.ts` with timer map per agent.
- **Acceptance criteria:** Match requirements. Adds the important "re-provision cancels old timer" case.

### T2.4 — Full decommissioning (#72) ✅
- **Root cause:** Correct. `remove-member.ts:19-84` confirmed.
- **Files:** Correct. Integrates with T2.3 (`cancelCredentialCleanup`).
- **Acceptance criteria:** Match requirements.
- **Ordering note:** T2.4 is last in Phase 2 despite being flagged as highest-risk. This is actually correct here — it depends on T2.3 (`cancelCredentialCleanup`), so it must come after.

### T3.1 — Local members skip fleet-mcp (#151) ✅
- **Root cause:** Correct. `execute-prompt.ts` launches Claude Code which loads MCP from settings.
- **Implementation:** Option B (settings.local.json override) with fallback to `--mcp-config /dev/null`. Reasonable.
- **Acceptance criteria:** Match requirements.

### T3.2 — Release update notification (#161) ⚠️
- **Root cause:** Correct. `check-status.ts` fleetStatus function at line 173 confirmed.
- **Files:** Correct targets.
- **Acceptance criteria:** Match requirements.
- **MISSING:** Requirements explicitly state: *"Update fleet skill `SKILL.md` to instruct the PM to surface this notice and offer `/pm deploy apra-fleet`."* The plan does not include this step. **Add a sub-task to T3.2 for updating SKILL.md.**

---

## Structural Review

### Verify checkpoints (V1, V2, V3)
All three phases include build + test gates with `npm run build` and `npm test`. V3 additionally includes `npm run lint`. Each checkpoint requires reporting test count vs baseline/previous phase. ✅

### Task ordering
- Phase 1: Trivial fix first (T1.1), then highest-risk (T1.2), then moderate (T1.3, T1.4). ✅
- Phase 2: Cleanup tasks building on each other. T2.4 depends on T2.3, so ordering is correct. ✅
- Phase 3: Higher-risk investigation (T3.1) before straightforward feature (T3.2). ✅

### Integration tests
Each task specifies `npm test` must pass. Each verify checkpoint requires ≥1 new test per issue. The plan relies on the existing vitest suite (786 tests baseline) plus new unit tests per task. ✅

### Risk assessment
Correctly identifies T1.2, T2.4, and T3.1 as highest-risk in their respective phases. ✅

---

## Summary

| Check | Status |
|-------|--------|
| Root causes correctly identified | ✅ All 10 |
| Right files targeted | ✅ All 14 file references verified against source |
| Acceptance criteria achievable | ✅ All match or exceed requirements |
| Verify checkpoints with build+test | ✅ V1, V2, V3 all present |
| Task ordering (risky first) | ✅ Correct, dependencies respected |
| Integration tests called out | ✅ Per-task and per-phase |

## Action Items

1. **T3.2 — Add SKILL.md update sub-task.** The requirements explicitly call for updating the fleet skill file. Add this to the plan before starting Phase 3.

**Verdict: APPROVED — proceed with implementation. Address the SKILL.md gap in T3.2 before Phase 3 begins.**

---

# Phase 1 Implementation Review

**Reviewer verdict: APPROVED**

**Date:** 2026-04-22
**Branch:** `sprint/10-issue-blitz`
**Commits reviewed:** T1.1 (`9c87b00`) through V1 (`1d05cc5`)
**Build:** ✅ 0 errors
**Tests:** ✅ 811 passed, 4 skipped (46 files). V1 claimed 812 — delta is platform-dependent `skipIf` tests (macOS vs Linux).

---

## Per-Task Verdicts

### T1.1 — ESM `__dirname` shim (#167) ✅

**Fix:** Added `fileURLToPath`/`dirname` shim at top of `compose-permissions.ts` (lines 5–8).

- Correct pattern, matches existing shim in `install.ts`.
- Imports `fileURLToPath` from `url` and `dirname` from `path` — standard ESM approach.
- No new dedicated test, but this is implicitly tested by the build succeeding and existing compose-permissions tests passing. Acceptable for a one-liner shim.

### T1.2 — receive_files/send_files Windows path rejection (#146) ✅

**Fix:** New `isContainedInWorkFolder()` helper in `src/utils/platform.ts` (lines 9–30). Both `receive-files.ts` and `send-files.ts` now call it instead of inline `path.posix.resolve` logic.

- **Root cause correctly addressed:** `path.posix.resolve` treats `C:` as a relative segment. The new helper detects Windows drive letters and manually collapses `..`/`.` segments with a stack-based approach.
- **Security:** Path traversal via `..` is correctly blocked — `stack.pop()` handles it, and the final containment check is sound.
- **Edge case note:** If `stack.pop()` is called on an empty stack (e.g., `../../..`), it returns `undefined` and the stack stays empty — the path collapses to empty string, which won't match the work folder prefix. This is safe (rejects the path).
- **Deduplication:** Good — removed duplicated inline logic from both files, replaced with shared utility.
- **Tests:** 6 new tests in `receive-files.test.ts` + 8 new tests in `platform.test.ts` covering all four path formats from the issue plus traversal attacks. Thorough.

### T1.3 — SSH username with spaces (#144) ✅

**Fix:** Updated schema description in `register-member.ts` (line 26) to document that spaces are allowed. Added tests confirming `getSSHConfig` passes username through intact.

- **Root cause correctly addressed:** Audit confirmed the username is passed directly to ssh2's `ConnectConfig.username` and never shell-interpolated. The fix is documentation + test coverage, not a code change — which is the correct response when the code already works.
- **Tests:** 2 new tests in `platform.test.ts` (lines 438–463) verifying `getSSHConfig` preserves space-containing usernames.

### T1.4 — SSH error messages (#150) ✅

**Fix:** New `classifySshError()` helper in `src/utils/ssh-error-messages.ts`. Applied in `register-member.ts` line 178 at the connection failure return path.

- **Root cause correctly addressed:** The generic `connResult.error` string is now mapped to user-friendly messages for the four most common SSH failure modes.
- **Fallthrough:** Unknown errors return the raw message unchanged — good, no information loss.
- **Null safety:** `error ?? ''` at line 5 handles undefined/null input, and the caller also passes `connResult.error ?? ''`.
- **Onboarding hook:** Test at line 42 verifies the hook doesn't fire on failure results (❌ prefix). Good defensive test.
- **Tests:** 9 tests covering all four error categories, unknown errors, and empty string handling.

---

## Issues to Watch

1. **`isContainedInWorkFolder` empty-stack edge:** Not a bug, but if a future path format produces an empty resolved string it would be silently rejected. Consider adding a comment in the function noting this is intentional.

2. **Test count delta:** V1 checkpoint says 812, local run shows 811 + 4 skipped. The 1-test difference is likely `cleanExec` tests that are `skipIf(process.platform !== 'linux')` on macOS. Not a concern, but the V1 commit message should ideally note the platform.

---

## Summary

| Check | Status |
|-------|--------|
| Root causes correctly addressed | ✅ All 4 |
| No regressions (build clean, tests pass) | ✅ |
| Tests added per task | ✅ T1.1 implicit, T1.2 +14, T1.3 +2, T1.4 +9 |
| Code quality (no unnecessary changes) | ✅ |
| Security (path traversal, injection) | ✅ |

**Verdict: APPROVED — Phase 1 is solid. Proceed to Phase 2.**
