# Cumulative Review — Sprint 1 (Phases 1 + 2 + 3 + 4 + 5)

**Reviewer:** Claude (sprint review agent)
**Date:** 2026-04-23
**Branch:** sprint/session-lifecycle-oob-fix
**Verdict:** APPROVED

## Phases 1-4 Recap (previously approved)

All previously approved. See prior review commits for full details:

- **Phase 1** (T1, T2, T3): PID wrapper, killPid interface, buildAgentPromptCommand
- **Phase 2** (T4, T5): extractAndStorePid, tryKillPid + kill-before-retry
- **Phase 3** (T6, T7): Rolling inactivity timer, max_total_ms schema + threading
- **Phase 4** (T8, T9): stop_agent MCP tool, stopped flag guard in executePrompt

## Phase 5 Review

### T10: hasGraphicalDisplay + hasInteractiveDesktop — PASS

**Implementation (`src/services/auth-socket.ts:362-372`):**
- `hasGraphicalDisplay()` checks **both** `$DISPLAY` (X11) and `$WAYLAND_DISPLAY` (Wayland) — correct. Uses `Boolean(... || ...)` so either being set is sufficient
- `hasInteractiveDesktop()` checks `process.env.SESSIONNAME === 'Console'` — correct. SSH sessions have `SESSIONNAME` set to something like `RDP-Tcp#0` or unset entirely; only physical console sessions have `Console`
- Both functions are `export`ed for direct testability — correct
- Pure environment reads, no side effects, no I/O — clean design

**Tests (`tests/auth-socket.test.ts:471-513`, 6 tests):**

`hasGraphicalDisplay` (3 tests):
1. Returns `false` when both DISPLAY and WAYLAND_DISPLAY are empty — PASS
2. Returns `true` when DISPLAY is set (`:0`) — PASS
3. Returns `true` when WAYLAND_DISPLAY is set (`wayland-0`) — PASS

`hasInteractiveDesktop` (3 tests):
1. Returns `false` when SESSIONNAME is `RDP-Tcp#0` — PASS
2. Returns `false` when SESSIONNAME is empty — PASS
3. Returns `true` when SESSIONNAME is `Console` — PASS

All tests use `vi.stubEnv` / `vi.unstubAllEnvs` for clean isolation.

### T11: launchAuthTerminal Headless Fallback — PASS

**Implementation (`src/services/auth-socket.ts:404-410`):**
- Windows path (line 404): `platform === 'win32' && !hasInteractiveDesktop()` → returns fallback string with actual `${memberName}` interpolated
- Linux path (line 408): `platform === 'linux' && !hasGraphicalDisplay()` → returns fallback string with actual `${memberName}` interpolated
- Both fallback strings include the exact instruction `! apra-fleet auth ${memberName}`
- Both include the `credential_store_set` alternative
- `onExit` is **never called** in fallback paths — no spurious "cancelled" error propagated to the caller
- Early return before any `spawn` — no wasted processes

**Existing paths preserved:**
- macOS (line 412-464): Completely unchanged — AppleScript + Terminal.app flow untouched
- Windows desktop (line 465-470): Unchanged — `start /wait` with `cmd` spawn
- Linux GUI (line 471-482): Unchanged — `findLinuxTerminal()` + `gnome-terminal`/`xterm` spawn
- Generic fallback (line 493-495): Unchanged — catch-all for spawn errors

The diff (`git diff 5b35110..9da5a57`) confirms only additions: the two helper functions and two early-return guards. Zero modifications to existing code.

**Tests (`tests/auth-socket.test.ts:516-552`, 3 tests):**
1. Linux fallback: returns `fallback:` prefix and contains `! apra-fleet auth my-member` — PASS
2. Windows fallback: returns `fallback:` prefix and contains `! apra-fleet auth my-member` — PASS
3. Placeholder check: result contains `worker-42` and does NOT contain `<name>` or `<member>` — PASS

Note: Linux/Windows tests correctly guard with `if (process.platform !== ...)` since they depend on `process.platform` for branching.

## Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | hasGraphicalDisplay checks both DISPLAY and WAYLAND_DISPLAY | PASS |
| 2 | hasInteractiveDesktop checks SESSIONNAME === 'Console' | PASS |
| 3 | Both helpers exported for testability | PASS |
| 4 | Fallback message contains actual member name (not placeholder) | PASS |
| 5 | Fallback instruction is `! apra-fleet auth <name>` | PASS |
| 6 | No "cancelled" error on SSH/headless (onExit never called) | PASS |
| 7 | GUI desktop path completely unchanged | PASS |
| 8 | macOS path completely unchanged | PASS |
| 9 | Unit tests cover both helpers under various env configs (6 tests) | PASS |
| 10 | Headless fallback tests verify name substitution (3 tests) | PASS |
| 11 | `npm run build` clean | PASS |
| 12 | `npm test` — 924 passed, 6 skipped, 0 failures | PASS |

## End-to-End Coherence (Phases 1-5)

The full chain for issues #147, #160, #148, and #106 is complete:

1. **T1** wraps the LLM command in a PID-capture shell wrapper
2. **T3** ensures `buildAgentPromptCommand` applies the wrapper for all providers
3. **T4** intercepts `execCommand` output, parses and stores the PID
4. **T2** provides the `killPid` command interface and in-memory PID store
5. **T5** uses `tryKillPid` to clean up zombie processes before new prompts
6. **T6** replaces wall-clock timeout with rolling inactivity timer + hard ceiling
7. **T7** exposes both timeout controls in `executePromptSchema`
8. **T8** adds explicit `stop_agent` tool to kill active LLM + set stopped flag
9. **T9** guards `executePrompt` entry with the stopped flag
10. **T10** detects headless/SSH environments (Linux + Windows)
11. **T11** returns actionable fallback instead of attempting (and failing) to launch a GUI terminal

Each phase builds on the previous without modifying earlier work. All cross-phase integration points are tested.

## Verdict

**APPROVED** — All 5 phases are correct, backward-compatible, and well-tested. The sprint delivers a coherent session lifecycle: PID capture → kill → inactivity timer → hard ceiling → explicit stop → headless-safe auth fallback.
