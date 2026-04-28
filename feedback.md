# #201 Pino JSONL Logging — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28
**Verdict:** CHANGES NEEDED

---

## 1. Done Criteria Clarity
**PASS.** Every task (T1–T6) has explicit done criteria. T2's criteria are particularly well-specified (valid JSONL fields, console.error still fires, TypeScript compiles). V1/V2/V3 checkpoints include build + test gates. No ambiguity about what "done" means.

## 2. Cohesion / Coupling
**PASS.** T2 (pino core) is self-contained. T3 (threading memberId) touches many files but is a single mechanical concern. T4 (audit) is a sweep. Tasks are cohesive internally and loosely coupled — the only dependency chain is the natural one: T2 defines the API, T3/T4 consume it.

## 3. Shared Abstractions First
**PASS.** T2 (the `logLine()` API and pino setup) is in Phase 1, before any consumers. T3 threads the new `memberId` parameter. T4 migrates remaining call sites. Correct ordering.

## 4. Riskiest Assumption Validated Early
**PASS.** The plan identifies the pino worker-thread vs. MCP stdio conflict as the key risk, places it in T2 (earliest possible), and V1 explicitly gates further work on this validation. The rollback to `fs.appendFileSync` is documented.

## 5. DRY — Later Tasks Reuse Early Abstractions
**PASS.** T3, T4, and T5 all build on the `logLine()` API defined in T2. No redundant logging mechanisms introduced.

## 6. Phase Structure (2–3 work tasks + VERIFY)
**PASS.** Phase 1: T1+T2+T3 → V1. Phase 2: T4+T5 → V2. Phase 3: T6 → V3. Each phase has 2–3 work tasks followed by a verification checkpoint.

## 7. Session-Sized Tasks
**PASS.** All tasks are single-session scoped. T4 (the audit sweep) is the largest but is mechanical — the plan enumerates every file and what to do. T2 is the most complex but well-bounded.

## 8. Dependency Order
**PASS.** The dependency graph is explicit and correct: T1/T2/T3 are parallel → V1 → T4/T5 parallel → V2 → T6 → V3. No task references work from a later task.

## 9. Vague Tasks
**PASS with one caveat.** T4 is well-specified with per-file guidelines. However, see the critical finding below (copilot.ts `memberId`).

## 10. Hidden Dependencies
**FAIL — one issue found.**

T4 says to replace `console.warn` in `copilot.ts` with `logLine('copilot', ..., memberId)`. However, the `console.warn` calls occur inside `buildPromptCommand()` and `permissionModeAutoFlag()` — methods on the `ProviderAdapter` interface that do **not** receive an `agent` or `memberId` parameter. The calling code in `execute-prompt.ts` has the agent, but these adapter methods don't.

Options:
- **(a)** Pass `memberId` through the `ProviderAdapter` interface (scope creep — touches all providers).
- **(b)** Log without `memberId`: `logLine('copilot', '...warning...')` — acceptable since these are provider-level warnings, not member-scoped operations.
- **(c)** Keep as `console.warn` since these are runtime warnings about provider capabilities, not diagnostic logging.

**Recommendation:** Option (b) — replace with `logLine` at warn level, omit `memberId`. Note this explicitly in T4 so the implementer doesn't waste time trying to thread an unavailable ID.

## 11. Risk Register
**PASS.** Six risks identified with impact/likelihood/mitigation. The top risk (pino worker vs. stdio) has a concrete fallback. The CLI-scripts-before-data-dir risk is relevant and mitigated. One addition worth considering:

- **Missing risk:** If `pino-roll` is not compatible with the SEA (single-executable application) binary build (`npm run build:binary`), the worker-thread transport may fail at runtime in the packaged binary. Should be tested during V1.

## 12. Alignment with Requirements
**PASS.** The plan covers all 8 scope items from requirements.md and all 10 acceptance criteria. The out-of-scope items are respected (no dashboard viewer, no aggregation, no structured objects).

---

## Critical Item: CLI vs. Server-Side Console Calls

**PASS.** The plan correctly distinguishes CLI output from server-side diagnostic logging in T4:

- **Keep as-is (CLI user-facing):** `install.ts` progress output (20 `console.log` for install steps), `auth.ts` interactive prompts (15 `console.error` for terminal UI), `smoke-test.ts` (18 `console.log` test output), `index.ts` `--version`/`--help` output (2 `console.log`).
- **Migrate to `logLine()`:** `copilot.ts` (3 `console.warn`), `auth-socket.ts` (2 `console.error`), `crypto.ts` (1 `console.warn`), `index.ts` `.catch` handlers (2 `console.error`).

The T4 done criteria explicitly states that CLI user-facing output is exempt and should be justified with inline comments. This matches the audit reality — the 64 call sites are predominantly CLI scripts (53 of 63), with only ~8 being server-side diagnostic calls that need migration.

**One nuance:** `install.ts` has `console.error` and `console.warn` calls (lines 389, 404, 435, 444, 453, 550) that are *also* CLI user-facing (error messages shown to the user during install). The plan says "Replace `console.error` and `console.warn` with `logLine()`" for install.ts, but these are user-facing error messages in a CLI context where the data dir may not exist yet. The plan's own risk register acknowledges this (risk #4). **Recommend:** keep all install.ts console calls as-is since the entire file is CLI-only, and note this decision in T4.

---

## Summary

**10 of 12 checks pass.** The plan is well-structured, correctly sequenced, and aligned with requirements. Two items need attention before implementation:

### Must fix
1. **T4 — copilot.ts `memberId` unavailability:** The plan instructs passing `memberId` but the `ProviderAdapter` interface doesn't expose it. Amend T4 to explicitly note that `copilot.ts` calls should use `logLine('copilot', ...)` without `memberId`.

### Should fix
2. **T4 — install.ts `console.error`/`console.warn`:** Clarify that *all* install.ts console calls are CLI user-facing and should be kept. The current wording ("Replace `console.error` and `console.warn` with `logLine()`") conflicts with the exemption rationale and with risk #4 in the register.
3. **Risk register — SEA binary compatibility:** Add a risk for pino-roll worker thread in the single-executable binary build.

### Deferred
- No items deferred.

Once the "must fix" item is addressed and the "should fix" items are considered, the plan is ready for implementation.
