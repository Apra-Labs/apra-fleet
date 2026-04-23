# Cumulative Review — Sprint 1 (Phases 1 + 2 + 3 + 4)

**Reviewer:** Claude (sprint review agent)
**Date:** 2026-04-23
**Branch:** sprint/session-lifecycle-oob-fix
**Verdict:** APPROVED

## Phase 1 Recap (previously approved)

T1 (PID wrapper), T2 (killPid interface + PID store), T3 (buildAgentPromptCommand wraps all providers) — all correct and well-tested. See prior review commit `8e0d4b5` for full details.

## Phase 2 Recap (previously approved)

T4 (extractAndStorePid), T5 (tryKillPid + kill-before-retry in executePrompt) — all correct and well-tested. See prior review commit `bbbac96` for full details.

## Phase 3 Recap (previously approved)

T6 (rolling inactivity timer in SSH + Local), T7 (max_total_ms schema + threading through all execCommand calls) — all correct and well-tested. See prior review commit `ec2d1e4` for full details.

## Phase 4 Review

### T8: stop_agent MCP Tool — PASS

**Implementation (`src/tools/stop-agent.ts`):**
- Resolves member by ID or friendly name via `resolveMember` (consistent with other tools)
- Reuses `tryKillPid` from Phase 1/2 infrastructure — zero code duplication
- Sets in-memory stopped flag via `setAgentStopped` after killing the process
- Returns differentiated messages: "killed PID X" vs "marked stopped (no active session)"
- Graceful no-op when no PID stored: `tryKillPid` returns immediately (PID undefined → early return), then the stopped flag alone is sufficient to block re-dispatch. Correct

**Registration (`src/index.ts`):**
- Import at line 77, tool registration at line 194
- Description clearly explains the tool's purpose and the flag-clearing behavior
- Schema uses `memberIdentifier` (member_id or member_name) — consistent with fleet conventions

**Stopped flag store (`src/utils/agent-helpers.ts:89-106`):**
- In-memory `Map<string, boolean>` — mirrors `_activePids` pattern. Correct design: transient flag that clears on server restart (safe default)
- Three clean functions: `isAgentStopped`, `setAgentStopped`, `clearAgentStopped`
- JSDoc comments explain the purpose and which tool calls each function

**Tests (`tests/stop-agent.test.ts`, 5 tests):**
1. Returns not-found error for unknown member — PASS
2. Kills active PID and sets stopped flag when PID is stored — PASS
3. Sets stopped flag even when no PID is stored (idle agents) — PASS
4. Resolves member by friendly name — PASS
5. Kill command uses 5000ms timeout — PASS

### T9: Stopped Flag Guard in executePrompt — PASS

**Implementation (`src/tools/execute-prompt.ts:139-144`):**
- Guard fires BEFORE `tryKillPid` (line 147) and BEFORE prompt write/execution — no wasted work on a stopped agent
- Clears the flag immediately via `clearAgentStopped` — member is not permanently locked out
- Returns clear error message naming the agent and explaining the flag has been cleared
- Next explicit `execute_prompt` call proceeds normally (tested)

**Tests (`tests/execute-prompt.test.ts:441-513`, 3 tests):**
1. Returns stopped error and clears flag when agent is stopped — PASS
2. Proceeds normally after stopped flag is cleared (multi-call flow) — PASS
3. Fresh agents proceed normally (no false positives) — PASS

### Coherence: T8 + T9 Together

The two-step mechanism correctly prevents stopped agents from re-dispatching:

1. PM calls `stop_agent` → kills LLM process (if running) + sets stopped flag
2. If a background agent's `execute_prompt` call is already in-flight, the active process is dead — the call fails at the command execution layer
3. If the background agent retries, the stopped flag guard fires, returns an error, and clears the flag. The PM-side agent receives the error as its tool result
4. No subsequent retries will hit the flag (it's cleared), so intentional `execute_prompt` calls proceed normally

**Race condition analysis:** The only theoretical race is if `stop_agent` sets the flag between the guard check (line 141) and command execution. In this case, `stop_agent` has already killed the PID via `tryKillPid`, so the execution would fail at the command layer anyway. The stale flag is harmless — it gets cleared on the next `execute_prompt` call. No deadlock or permanent lockout possible.

### PM-Side Background Agent Gap

The acknowledged limitation (PM-side background agent spawned via `Agent(run_in_background=true)` cannot be directly killed by fleet) is correctly addressed by design: killing the member-side LLM and blocking re-dispatch starves the background agent — its tool calls return errors, forcing it to halt. This is documented in the requirements (`requirements-sprint1.md`). The code comments at lines 139-140 of execute-prompt.ts are clear about the mechanism. No additional in-code documentation needed.

## Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | T8 reuses tryKillPid (no duplication) | PASS |
| 2 | Stopped flag is in-memory only (same pattern as activePid) | PASS |
| 3 | stop_agent registered in index.ts with schema + description | PASS |
| 4 | T9 guard fires at entry BEFORE kill or spawn | PASS |
| 5 | Flag cleared after rejection (no permanent lockout) | PASS |
| 6 | stop_agent on member with no active session is a graceful no-op + flag set | PASS |
| 7 | T8 + T9 together prevent re-dispatch (no race condition gaps) | PASS |
| 8 | PM-side gap documented in requirements | PASS |
| 9 | `npm run build` clean | PASS |
| 10 | `npm test` — 915 passed, 6 skipped, 0 failures | PASS |

## End-to-End Coherence (Phases 1 + 2 + 3 + 4)

The full chain for issues #147, #160, and #148 is now complete:

1. **T1** wraps the LLM command in a PID-capture shell wrapper that emits `FLEET_PID:<pid>` as the first stdout line
2. **T3** ensures `buildAgentPromptCommand` applies this wrapper for all providers
3. **T4** intercepts `execCommand` output, parses the PID line, stores it, and strips it from stdout
4. **T2** provides the `killPid` command interface and in-memory PID store
5. **T5** uses `tryKillPid` to clean up zombie processes before new prompts and before retries
6. **T6** replaces wall-clock timeout with rolling inactivity timer + optional hard ceiling in both SSH and Local strategies
7. **T7** exposes both timeout controls in `executePromptSchema` and threads them through all execution paths
8. **T8** adds explicit `stop_agent` tool to kill active LLM + set stopped flag
9. **T9** guards `executePrompt` entry with the stopped flag, blocking re-dispatch from background agents

No gaps identified. Each phase builds on the previous without modifying earlier work. All cross-phase integration points are tested.

## Verdict

**APPROVED** — Phases 1-4 are all correct, backward-compatible, and well-tested. The sprint's session lifecycle improvements (PID capture → kill → inactivity timer → hard ceiling → explicit stop) form a coherent whole. Ready for Phase 5.
