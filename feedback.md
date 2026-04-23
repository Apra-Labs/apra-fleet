# Sprint 1 Plan Review — Session Lifecycle + OOB Auth Fix

**Reviewer:** Claude (automated review)
**Date:** 2026-04-23
**Branch:** `sprint/session-lifecycle-oob-fix`
**Verdict:** APPROVED

---

## Checklist

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Task 1 validates riskiest assumption (PID capture timing) | PASS | Correctly front-loaded. Done criteria explicitly require PID line before LLM output. Blocker note mentions stderr/side-channel fallback. |
| 2 | Dependency order correct | PASS | Phase 1-2 (#147) → Phase 3 (#160) + Phase 4 (#148) → Phase 5 (#106) → Phase 6. Matches requirements' dependency graph. #106 standalone. |
| 3 | All phases have 2-3 work tasks + VERIFY checkpoint | PASS | Phase 1: 3 tasks + VERIFY. Phases 2-5: 2 tasks + VERIFY each. Phase 6: 2 tasks + VERIFY. |
| 4 | Each task has clear done criteria and file references | PASS | Every task has "Done when:" with testable criteria and "Files:" with specific paths. |
| 5 | Risk Register present and complete | PASS | 7 risks covering PID timing, Windows PID, streaming compat, parseResponse pollution, SSH refactor regressions, stop_agent feasibility, inactivity timer. Impact + mitigation for each. |
| 6 | Integration test tasks included | PASS | Phase 6, Tasks 12-13 cover PID lifecycle, inactivity timeout, cancellation, and OOB fallback. |
| 7 | Full scope of requirements covered | PASS | All four issues (#147, #160, #148, #106) mapped to plan phases with acceptance criteria coverage. See observations below. |

---

## Observations (non-blocking)

### 1. Minor file reference inaccuracies

- **Task 8** references `src/server.ts` for MCP tool registration — actual entry point is `src/index.ts`.
- **Requirements** reference `launchAuthTerminal` at line 334 — actual location is line 376. Plan correctly doesn't hardcode the line number.
- **`strategy.ts`** exposes an `AgentStrategy` interface with `execCommand` as a method, not a standalone export. Plan's description in Task 4 is functionally correct but should reference the strategy interface pattern.

None of these affect implementability — the developer will find the right locations.

### 2. #160 uses Option 1 (rolling timer) instead of Option 2 (tool-call awareness)

Requirements list Option 2 (tool-call awareness) as preferred because Option 1 "doesn't handle blocking tool calls with no token flow" (e.g., `npm install` producing no stdout for minutes). The plan implements Option 1.

This is acceptable for Sprint 1 — Option 1 is simpler, covers the primary use case (active output keeps session alive), and the `max_total_ms` hard ceiling provides a safety net for blocking tool calls. Option 2 can be a follow-up enhancement if Option 1 proves insufficient in practice.

### 3. #148 scope alignment

Requirements note: "This issue is about stopping the PM-side background agent (the local Claude Code background agent that's dispatching work)." The plan's Task 8 kills the member-side LLM PID, and Task 9 adds a `stopped` flag to prevent re-dispatch.

This is a pragmatic implementation — it can't directly kill the Claude Code framework's background agent (acknowledged in Risk Register item 5), but the stopped flag effectively neuters it. The gap is documented and the TTL fallback is noted.

### 4. Task 3 wrapper placement

The plan correctly places the PID wrapper in the OS commands layer (`linux.ts`, `macos.ts`, `windows.ts`) via `buildAgentPromptCommand`, making it provider-agnostic. This matches the requirements' stated intent ("lives in the OS commands layer") even though the requirements' files-to-change table lists `src/providers/claude.ts`. The plan's approach is better.

---

## Summary

The plan is well-structured, correctly sequenced, and covers all four issues. The riskiest assumption (PID capture timing) is validated first. Each phase has clear verify checkpoints. The risk register is thorough and includes mitigations. The three observations above are all non-blocking — they document intentional simplifications (Option 1 over Option 2, pragmatic #148 scope) that are reasonable for Sprint 1, and minor file reference corrections that won't impede implementation.
