# Uninstall Command (#245) — V4 Re-Review

**Reviewer:** claude-opus (code reviewer)
**Date:** 2026-05-05 19:05:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

V3 review (commit 4e25a3b) issued CHANGES NEEDED with 4 blocking test gaps and 2 non-blocking notes (R3, R5). The doer addressed all findings in commit 7c1714b.

---

## Blocking Findings Resolution (commit 7c1714b)

### 1. Claude CLI execSync assertion — RESOLVED

New test "calls Claude CLI to remove MCP" (uninstall.test.ts:83–94) asserts `execSync` was called with a string containing `claude mcp remove apra-fleet` and an options object. Correctly validates the F2 plan requirement. PASS.

### 2. Abort path (user declines confirmation) — RESOLVED

New test "aborts if user says no" (uninstall.test.ts:47–57) mocks readline response as 'n', verifies `console.log` includes "Aborted.", verifies `fs.rmSync` was NOT called. Clean abort with no mutations. PASS.

### 3. --skill flag targeting — RESOLVED

New test "removes only specific skills if requested" (uninstall.test.ts:96–113) covers both directions:
- `--skill pm` asserts `rmSync` called with path matching `/pm$/` and NOT called with `/fleet$/`
- `--skill fleet` asserts the inverse

Both assertions use regex matchers on the path argument. Correctly validates T4 skill-targeting logic. PASS.

### 4. defaultModel conditional removal — RESOLVED

New test "removes defaultModel only if it matches fleet standard" (uninstall.test.ts:153–183) covers two scenarios:
- Standard model value: asserts `defaultModel` is removed from written settings
- Custom model value: asserts `defaultModel` is preserved as `'custom-model'`

Uses `config.PROVIDER_STANDARD_MODELS.claude` for the match value — correctly tied to the source-of-truth constant. PASS.

---

## Bonus: Old Format Migration Test

New test "migrates old install-config format" (uninstall.test.ts:185–199) verifies that when `readFileSync` returns old `{ llm: 'gemini', skill: 'pm' }` format, the uninstall still correctly identifies and cleans up Gemini. This was gap #5 from the V3 review (non-blocking but recommended). PASS.

---

## Non-Blocking Notes Resolution

### R3 — Server Race Detection — RESOLVED

New code at uninstall.ts:155–159 calls `isApraFleetRunning()` (imported from install.ts) and aborts with `process.exit(1)` if the server is active. Error message instructs user to run `apra-fleet stop` first. New test "aborts if apra-fleet server is running" (uninstall.test.ts:221–227) validates this path. PASS.

### R5 — Post-Uninstall Warning — RESOLVED

New code at uninstall.ts:236–238 prints a `⚠ Note:` block after successful uninstall, advising users to review settings files if they suspect residual config from manual modifications. This satisfies the plan's "post-uninstall warning" requirement. PASS.

---

## Update.ts Migration (bonus fix)

The doer also updated `src/cli/update.ts` (lines 76–90) to use the new multi-provider `readInstallConfig()` instead of the old flat JSON parse. The update path now reads providers from the new schema and passes `--llm` / `--skill` to the installer correctly. Test mocks in `tests/update.test.ts` were updated to match. PASS.

---

## Build and Tests

- Build (`tsc`): PASS — no errors.
- Tests: 66 files, 1084 passed, 6 skipped, 0 failed. PASS.
- No regressions in previously passing tests. PASS.
- Test count increased from 1078 → 1084 (6 new uninstall tests). Matches expectations.
- CI: No CI config in repo. N/A.

---

## progress.json

Updated: T5 marked `"completed"`, V3 marked `"completed"`. Matches actual state. PASS.

---

## Summary

All 4 blocking test gaps from the V3 review have been addressed with well-structured, targeted tests. Both non-blocking notes (R3 race detection, R5 post-uninstall warning) have been implemented and tested. The bonus update.ts migration to the new config schema is correct. Build is green, all tests pass, no regressions detected.

Verdict: **APPROVED** — the uninstall command implementation is complete and ready for merge.
