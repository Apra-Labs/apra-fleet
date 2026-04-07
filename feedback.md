# API Cleanup & Skill Doc Sweep — Phase 2 Re-Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 21:55:00-04:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

The initial Phase 2 review (commit 7275dd2) found one blocking issue: Task 2.2's version-stripping regex was untested — all mocks returned bare version strings, so the regex never fired. Tasks 2.1 and 2.3 were approved. The doer addressed the finding in commit f0875ea.

---

## Task 2.2 Fix Verification — PASS

Commit f0875ea adds `it('strips provider prefix from version string')` in `tests/agent-detail.test.ts:129-146`:

1. **Mock returns a prefixed string** — `'Claude Code 1.0.42'` from the `--version` command (line 136). This is a realistic provider-prefixed version that exercises the regex `/(\d+\.\d+\.\d+.*)$/`.

2. **Assertion is specific** — `expect(result.llm_cli.version).toBe('1.0.42')` (line 145). This directly proves the prefix was stripped. If the regex is removed or broken, this test will fail.

3. **Mock structure is consistent** — follows the same pattern as the existing auth-detection tests (credential file check, API key check, version, process check). No shortcuts or gaps.

The test count went from 628 → 629, confirming the new test is counted and executed.

---

## Full Test Suite — PASS

`npx vitest run` — 41 test files, 629 passed, 4 skipped. No regressions.

---

## Phase 2 Final Status

| Task | Verdict | Notes |
|------|---------|-------|
| 2.1 — Rename claude → llm_cli | PASS | Clean rename, zero stale refs (unchanged from prior review) |
| 2.2 — Strip version prefix | PASS | Regex correct, now tested with prefixed input |
| 2.3 — Update tests for rename | PASS | 3 assertion references updated (unchanged from prior review) |
| V2 — npm test | PASS | 629/629 passed, 4 skipped |

**Non-blocking (carried forward to Phase 5):** User-facing strings in `src/` still reference `provision_auth` (prompt-errors.ts, register-member.ts, provision-auth.ts, lifecycle.ts). Phase 5 Task 5.4's grep should surface these.

Phase 2 is complete. Ready for Phase 3.
