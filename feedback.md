# Review: Issue #190 Plan — CODEX session resume and session listing

**Verdict: APPROVED**

**Reviewer:** fleet-reviewer  
**Date:** 2026-05-01  
**Branch:** `plan/issue-190`

---

## 13-Point Checklist

### 1. Does the plan address everything in requirements.md?
**PASS.** All four acceptance criteria are covered: session ID capture in `parseResponse()` (Task 3), working `execute_prompt(resume=true)` (Task 4), session ID visible in `fleet_status` (Task 3 done-when), and session listing implemented or documented as unsupported (Task 5). All four research questions are explicitly addressed in Tasks 1–2.

### 2. Are phases clearly separated with VERIFY checkpoints?
**PASS.** Four phases (Research, Implement, Session listing, Tests), each with a VERIFY block. Checkpoints are concrete — build pass, test pass, and manual verification steps.

### 3. Are tiers monotonically non-decreasing across the plan?
**PASS.** Tasks 1–2: cheap. Tasks 3–7: standard. Monotonically non-decreasing.

### 4. Does each task have a concrete "Done when" criterion?
**PASS.** Every task has a specific, verifiable "Done when." Examples: "Research doc committed with: session ID event type, field path, resume CLI flag, codex version" (Task 1); "`buildPromptCommand({..., sessionId: 'abc123'})` produces a command string containing the correct resume flag" (Task 4).

### 5. Are blockers correctly stated?
**PASS.** Task dependency chain is correct: Tasks 1–2 have no blockers. Task 3 depends on Task 1 (need event format). Task 4 depends on Tasks 1 and 3. Task 5 depends on Task 2. Tasks 6–7 depend on Tasks 3–4 respectively.

### 6. Is the base branch correct?
**PASS.** Base branch is `main`, implementation branch is `feat/codex-session-resume`. Both follow project conventions.

### 7. Are file paths accurate and do referenced files exist in the repo?
**PASS with note.**
- `src/providers/codex.ts` — exists ✓
- `src/providers/provider.ts` — exists ✓ (mentioned in Task 5)
- `docs/research-190-codex-session.md` — new file, `docs/` directory exists ✓
- `tests/providers/codex.test.ts` — **Note:** Existing provider tests live in `tests/providers.test.ts` (flat file), not a `tests/providers/` subdirectory (which does not exist). The plan says "create if absent" which is fine, but the implementer should be aware that the established pattern is a single `tests/providers.test.ts` covering all providers. Either approach works; just flagging for awareness.

### 8. Is scope complete — any files missed?
**PASS.** The plan correctly identifies the files that need changes (`codex.ts`, possibly `provider.ts`). Task 4 correctly references `sanitizeSessionId()` from `os-commands.ts`, which is already exported and available. No files are missed.

### 9. Are risks identified and mitigated?
**PASS.** Four risks in the register covering the key unknowns: no session ID in NDJSON (fallback to `supportsResume(): false`), version-dependent resume flag, sanitizer regex mismatch, and unsupported session listing. Mitigations are pragmatic — especially the fallback to disable resume if the CLI doesn't support it.

### 10. Is the regression test realistic and sufficient?
**PASS.** Unit tests cover both positive and negative paths for `parseResponse()` (with/without session event) and `buildPromptCommand()` (with/without sessionId). Manual integration verification is included in Phase 2 and Phase 4 VERIFY blocks.

### 11. Are there implementation details missing that would block a developer?
**PASS.** The plan is research-first by design — Tasks 1–2 discover the exact event types and CLI flags before any code is written. Tasks 3–4 are deliberately conditioned on research output ("using the event type and field path identified in Task 1"). The fallback path (`supportsResume(): false`) is clearly specified if the CLI doesn't support session IDs. No blocking gaps.

### 12. Are commit/branch conventions followed?
**PASS.** Branch name `feat/codex-session-resume` follows `feat/<topic>` convention. "Each task = one git commit" is stated. Base branch is `main`.

### 13. Any security concerns?
**PASS.** Task 4 explicitly calls out using `sanitizeSessionId()` before interpolating the session ID into the shell command, which prevents command injection. The sanitizer already exists in `os-commands.ts` and is used by other providers.

---

## Summary

The plan is well-structured, research-gated, and handles the primary unknown (codex CLI session behavior) correctly by making Phase 2+ conditional on Phase 1 findings. The fallback to `supportsResume(): false` is the right safety net if the CLI doesn't expose session IDs.

**Minor note for implementer:** Existing provider tests are in `tests/providers.test.ts` (single flat file), not `tests/providers/codex.test.ts`. Consider adding new codex tests to the existing file to maintain consistency, or create the new file if the test surface is large enough to warrant separation.
