# apra-fleet Sprint 3 — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-27 12:00:00+00:00
**Verdict:** APPROVED

---

## 1. Done Criteria (Check 1)

Every task (T1–T10) has explicit, measurable done criteria. T7 specifies PID logged to stderr, cleared on exit, build passes, existing tests pass. T8 specifies all 4 providers implement `permissionModeAutoFlag()`. T9 specifies stderr-only logging, secret masking, 80-char truncation. T10 specifies 0 failures after audit, no security boundary test deletions, and an audit report. **PASS.**

---

## 2. Cohesion and Coupling (Check 2)

Each task is tightly scoped: T7 is PID streaming extraction only, T8 is provider flag abstraction only, T9 is structured logging only, T1–T3 are documentation, T4–T6 are advisory cleanups, T10 is test refactoring. Cross-task coupling is minimal and explicit (T9 hooks into T7's data handler, T4 cross-references T1). **PASS.**

---

## 3. Key Abstractions First (Check 3)

Phase 1 front-loads the two critical code bugs: T7 (streaming PID — the foundation for stop_prompt and T9's PID logging) and T8 (`permissionModeAutoFlag()` — shared interface used by windows.ts). Both create abstractions reused later. **PASS.**

---

## 4. Riskiest Assumption First (Check 4)

T7 is correctly identified as the riskiest task (modifying the streaming data path could break stdout buffering or spill-file logic) and is placed first in Phase 1. Risk #1 in the register explicitly addresses this. **PASS.**

---

## 5. DRY — Later Tasks Reuse Early Abstractions (Check 5)

T9 (Phase 2) reuses T7's streaming `on('data')` handler for PID logging. T4 (Phase 4) simplifies to a cross-reference once T1 (Phase 3) adds the provider table. T3 is potentially covered by T1's warning icons. Good reuse chain. **PASS.**

---

## 6. Phase Structure — 2-3 Work Tasks + VERIFY (Check 6)

| Phase | Work Tasks | Verify |
|-------|-----------|--------|
| 1 | T7, T8 (2) | V1 |
| 2 | T9 (1) | V2 |
| 3 | T1, T2, T3 (3) | V3 |
| 4 | T4, T5, T6 (3) | V4 |
| 5 | T10 (1) | V5 |

Phases 2 and 5 have only 1 work task each. This is justified — T9 has 3 sub-tasks touching 4 files and depends on Phase 1 completion; T10 is a full test audit with 4 sub-tasks across 62 test files. Both warrant their own phase boundaries. **PASS.**

---

## 7. Session-Sized Tasks (Check 7)

All tasks are right-sized for a single session. T7 has 3 focused sub-tasks (LocalStrategy, RemoteStrategy, clearStoredPid). T9 has 3 sub-tasks (helper, execute_prompt, execute_command). T10 is the largest but has 4 ordered sub-tasks that gate each other — audit before delete. None require multi-session state. **PASS.**

---

## 8. Dependency Order (Check 8)

- T9 depends on T7's streaming data handler → Phase 2 after Phase 1. ✅
- T4 depends on T1's provider table → Phase 4 after Phase 3. ✅
- T10 runs last (Phase 5) so all code changes are stable before audit. ✅
- No circular dependencies. **PASS.**

---

## 9. Ambiguity Check (Check 9)

One **NOTE**: T10.1 lists `vcs-isolation.test.ts` as a priority file, but this file does not exist in the repository (verified via search). This is a phantom reference — the doer will waste time looking for it. Should be removed or replaced with the actual VCS test file name.

All other tasks are unambiguous. T7.1's code sample is specific enough that any developer would implement the same logic. T8 names all 4 providers and their return values. **PASS with NOTE.**

---

## 10. Hidden Dependencies (Check 10)

No hidden dependencies found. The explicit dependency T9→T7 (logging hooks into the streaming data path) is correctly documented in Phase 2's header: "Depends on T7 (PID streaming) being complete." T4→T1 is acknowledged in T4's fix description. **PASS.**

---

## 11. Risk Register (Check 11)

5 risks identified with impact, likelihood, and mitigation. Covers the key concerns: stdout buffering corruption (R1), interface breaking change (R2), security test deletion (R3), stdout/stderr contamination (R4), and PID race condition (R5). R5's mitigation is pragmatic — if the process exits before PID capture, stop_prompt is unnecessary anyway.

No additional risks identified. **PASS.**

---

## 12. Alignment with Requirements (Check 12)

All 10 requirements from `requirements.md` are addressed:

| Req | Plan Task | Aligned? |
|-----|-----------|----------|
| T1 (SKILL.md provider table) | Phase 3, T1 | ✅ |
| T2 (credential_store_update in tools table) | Phase 3, T2 | ✅ |
| T3 (Copilot unattended limitation) | Phase 3, T3 | ✅ |
| T4 (Gemini mechanic removal) | Phase 4, T4 | ✅ |
| T5 (Sub-bullet formatting) | Phase 4, T5 | ✅ |
| T6 (Quote credFile) | Phase 4, T6 | ✅ |
| T7 (PID stored after exit) | Phase 1, T7 | ✅ |
| T8 (Hardcoded Claude flag) | Phase 1, T8 | ✅ |
| T9 (Structured logging) | Phase 2, T9 | ✅ |
| T10 (Test audit) | Phase 5, T10 | ✅ |

**PASS.**

---

## Special Attention Items

### T7 — PID Extraction from Stdout Data Stream

**PASS.** The plan explicitly specifies streaming extraction in `child.stdout.on('data')` with a `pidExtracted` flag and regex match on each chunk. The code sample at T7.1 shows `setStoredPid()` called inside the data handler, not after promise resolution. The plan also covers RemoteStrategy (T7.2) and clearStoredPid on exit (T7.3).

Verified against current code: `extractAndStorePid()` is indeed called at `strategy.ts:178` after the promise resolves (post-close), and the `child.stdout.on('data')` handler at lines 130–143 currently does no PID extraction. The plan correctly identifies the bug and proposes the right fix location.

### T8 — All 4 Providers Implement `permissionModeAutoFlag()`

**PASS.** Plan specifies: Claude returns `'--permission-mode auto'`, Gemini returns `null`, Codex returns `'--ask-for-approval auto-edit'`, Copilot returns `null` + logs warning. `windows.ts` calls the method instead of hardcoding. All 4 providers are named. Verified that `permissionModeAutoFlag()` does not yet exist in `provider.ts` and that `windows.ts:124-125` currently hardcodes `--permission-mode auto`.

### T9 — Secure Ref Masking Before Logging

**PASS.** T9.1 explicitly defines `maskSecrets(text: string)` that replaces `{{secure.*}}` and `sec://...` patterns with `[REDACTED]`. Masking is specified as part of the log helper layer, applied before any text reaches `console.error`. The 80-char truncation provides a secondary defense against credential leakage in long prompts.

### T10 — Security Boundary Tests Must Not Be Deleted

**PASS.** T10.3 explicitly states: "Do NOT delete sole security boundary tests." The classification criteria in the requirements and plan both specify security boundary tests (credential scoping, TTL rejection, label injection, member identity) as unconditional keeps. Risk #3 in the register addresses this with a specific mitigation: "grep for tested function, confirm other tests exist."

---

## Summary

**Verdict: APPROVED.**

The plan is well-structured, correctly prioritises the critical bugs in Phase 1, and addresses all 10 requirements. All 12 review checks pass. The four special-attention items (T7 streaming PID, T8 provider abstraction, T9 secret masking, T10 security test preservation) are all correctly handled.

**1 NOTE (non-blocking):** T10.1 lists `vcs-isolation.test.ts` as a priority audit target, but this file does not exist in the repository. The doer should skip this reference or identify the correct VCS-related test file during the audit.

No blocking changes required. Plan is ready for execution.
