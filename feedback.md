# gbrain Integration — Phase 5 Code Review — APPROVED

**Reviewer:** yash-rev (Claude Opus 4.6)
**Date:** 2026-05-13 12:00:00+05:30
**Branch:** feat/gbrain-integration
**Commits reviewed:** bf3bcff, f9f3e0a, e441ae9, b271862, f837599
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `skills/pm/tpl-reviewer.md` | 82 | Brain-Aware Review section added |
| `src/services/course-correction.ts` | 48 | `captureCorrection` + `recallCorrections` service |
| `src/tools/course-correction.ts` | 34 | `course_correction_capture` + `course_correction_recall` tools |
| `skills/pm/single-pair-sprint.md` | +1 line | Call-site doc for course correction |
| `skills/pm/doer-reviewer.md` | +1 line | Call-site doc for course correction |
| `tests/course-correction.test.ts` | 116 | 6 tests covering both functions and tools |
| `src/index.ts` (line 136, 286-287) | — | Tool import and registration |

---

## Review Checklist

### 1. tpl-reviewer.md — Brain-Aware Review placement — PASS

The Brain-Aware Review section is inserted at lines 6–13, immediately after Context Recovery and before Review Model — correct placement. Instructions are clear and actionable: query brain for known context via `brain_query`, use `code_callers` and `code_refs` to assess blast radius, and check `course_correction_recall` before flagging findings. The "If gbrain enabled" reminder is also correctly placed inside the "What to check" section (line 40). Both entry points reference correct tool names.

### 2. course-correction.ts service — Silent no-op behavior — PASS

Both functions wrap gbrain calls in try/catch with silent fallbacks:
- `captureCorrection`: catches any error, returns `void` (line 28: bare `catch`)
- `recallCorrections`: catches any error, returns `''` (line 46-47)

Neither function throws when gbrain is unavailable. Tool names are correct: `brain_write` for capture (line 27), `brain_query` for recall (line 44). Collection name `course-corrections` is consistent across both functions. The `member` field is conditionally included only when present (line 24).

### 3. course-correction.ts tool — Registration — PASS

Both tools registered in `src/index.ts`:
- Import at line 136: `const { courseCorrectionCaptureSchema, courseCorrectionCapture, courseCorrectionRecallSchema, courseCorrectionRecall } = await import('./tools/course-correction.js');`
- Registration at lines 286-287 under `// --- Course correction tools ---`
- Descriptions correctly state "No member or gbrain check needed — global brain op."
- No `assertGbrainEnabled` guard — confirmed absent via grep. These are global ops that go directly through the gbrain client singleton.
- Zod schemas validate all input types with appropriate descriptions.

### 4. PM skill docs — Call-site documentation — PASS

**single-pair-sprint.md** (line 80): Call-site documented in the execution loop flow diagram — "If user interrupts or corrects the plan mid-sprint: call `course_correction_capture` with the attempted approach and the user-specified correction before resuming." Correctly scoped to user-driven interruptions.

**doer-reviewer.md** (line 53): Call-site documented under the CHANGES NEEDED branch of the doer-reviewer flow — "If the user has provided a modification or correction to the original plan alongside the CHANGES NEEDED verdict: call `course_correction_capture` with `attempted` = the original approach and `correction` = the user-specified change before re-dispatching." Correctly scoped to user corrections, not routine review findings.

Both docs specify the key parameters and explain the persistence rationale ("so future sprints and agents avoid the same mistake").

### 5. Tests — Coverage — PASS (6/6 passing)

| # | Describe block | Test | What it covers |
|---|---------------|------|----------------|
| 1 | `captureCorrection` | calls brain_write with correctly formatted message | Content string format, collection name, member field |
| 2 | `captureCorrection` | silent no-op when gbrain unavailable | Rejects → resolves to undefined, no throw |
| 3 | `recallCorrections` | calls brain_query and returns result | Query construction, collection name, return value |
| 4 | `recallCorrections` | returns empty string when gbrain unavailable | Rejects → returns '' |
| 5 | `course_correction_capture tool` | routes to captureCorrection and returns confirmation | Tool → service routing, return message |
| 6 | `course_correction_recall tool` | routes to recallCorrections and returns brain result | Tool → service routing, return value |

Coverage is solid: both service functions tested for happy path and no-op fallback, both tool functions tested for correct routing. Mock isolation via `vi.mock` of gbrain-client is clean.

### 6. Security — Injection risk — PASS

User-supplied strings (`attempted`, `correction`, `reason`) are interpolated into a plain-text content string via string concatenation (lines 17–21 of the service). This string is passed as the `content` argument to `brain_write`, which stores it in the brain's vector database. There is no shell execution, SQL, HTML rendering, or template evaluation — the values are opaque text in a vector store. Zod schemas at the tool layer enforce string types. No injection vector exists.

### 7. Build & Tests — PASS

- **Build:** `tsc` passes cleanly, no errors.
- **Tests:** 1291 passed, 2 failed, 13 skipped. The 2 failures are in `tests/time-utils.test.ts` — a pre-existing timezone-dependent issue (last modified in commit 89aad62, before Phase 5). All Phase 5 tests pass.

### 8. File Hygiene — PASS

Files changed: `progress.json` (tracker), `skills/pm/doer-reviewer.md`, `skills/pm/single-pair-sprint.md`, `skills/pm/tpl-reviewer.md` (doc updates), `src/index.ts` (registration), `src/services/course-correction.ts`, `src/tools/course-correction.ts` (new source), `tests/course-correction.test.ts` (new tests). All justified against sprint requirements. No temp files, tool configs, or agent context files.

---

## Summary

All 8 review criteria pass. The course correction service is clean — two functions with clear contracts, silent degradation when gbrain is absent, correct tool names (`brain_write`/`brain_query`), and no security concerns with brain-stored text. Tool registration follows established patterns with appropriate "global brain op" descriptions. PM skill docs integrate call-sites at the correct decision points (user corrections only, not routine findings). Test coverage is meaningful with both happy-path and failure-mode cases. Phase 5 is approved.
