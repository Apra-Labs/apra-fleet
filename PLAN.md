# Stall Detector Redesign (#241) — Implementation Plan

> Replace the broken `fs.watch()`-based stall detector with a reliable polling approach. Implements 5 targeted fixes across path encoding, log file discovery, activity polling, MCP disconnect cleanup, and timestamp formatting.

---

## Tasks

### Phase 1: Path Encoding & Log Directory Resolution

#### Task 1: Fix path encoding and Gemini log directory
- **Change:** In `sessionLogDir`, replace `/[\/\\:]/g` with `-` (not `%2F`/`%5C`); add `/chats/` subdirectory for Gemini; resolve home dir inline in remote shell commands using `$(echo $HOME)` / `$env:USERPROFILE`
- **Files:** `src/services/stall/log-path-resolver.ts`
- **Tier:** cheap
- **Done when:** Claude path encoding produces `-` separators; Gemini path includes `/chats/`; remote command embeds inline home dir variable

#### Task 2: Unit tests for path encoding and log directory resolution
- **Change:** Add test cases covering Claude Windows encoding, Claude macOS encoding, Gemini path with `/chats/`, and remote home dir resolution
- **Files:** `src/services/stall/log-path-resolver.test.ts`
- **Tier:** cheap
- **Done when:** All new test cases pass; `npm test` green

#### VERIFY: Path Encoding & Log Directory Resolution
- Run `npm test` — all tests must pass
- Push: `git push origin feat/stall-detector`
- STOP and report

---

### Phase 2: Log File Discovery via mtime Filter

#### Task 3: Implement `findLogFile` with mtime filter
- **Change:** Create `findLogFile(member, t0, inv, logDir): Promise<string|null>` — local variant uses `fs.readdirSync` + `fs.statSync().mtimeMs > t0`; remote variant runs `find -newermt "<T0-iso>"` (Linux/macOS) or `Get-ChildItem | Where-Object LastWriteTime` (Windows) via internal SSH/shell transport; retry every 10s, max 3 retries (30s total); log `stall_log_not_found` if unresolved; apply `[inv]` token check as tiebreaker when >1 candidate; handle Case A (fresh session, mtime scan), Case B Claude (direct `<logDir>/<sessionId>.jsonl`), and Case B Gemini (mtime scan)
- **Files:** `src/services/stall/find-log-file.ts`
- **Tier:** standard
- **Done when:** Resolves correct file for a fresh local Claude session within 30s; resolves for a fresh local Gemini session within 30s; mtime filter is primary mechanism; `stall_log_not_found` logged after 30s with no match

#### Task 4: Unit tests for `findLogFile`
- **Change:** Add tests for local mtime filter (matching and non-matching files), Case B Claude direct path lookup, Case B Gemini mtime scan, retry exhaustion logging, and `[inv]` tiebreaker logic
- **Files:** `src/services/stall/find-log-file.test.ts`
- **Tier:** standard
- **Done when:** All new test cases pass; `npm test` green

#### VERIFY: Log File Discovery
- Run `npm test` — all tests must pass
- Push: `git push origin feat/stall-detector`
- STOP and report

---

### Phase 3: Activity Polling

#### Task 5: Implement polling loop
- **Change:** Poll every `STALL_POLL_INTERVAL_MS` ms (default 30000); tail last 500 bytes of log file; extract last `timestamp` field from `assistant` entries (Claude) or `lastUpdated` from `{"$set":{"lastUpdated":"..."}}` lines (Gemini); log `stall_poll_format_error` and skip cycle if expected fields missing; reset `stallReported` and update `lastActivityAt` if timestamp advanced; fire `stall_detected` once (set `stallReported=true`) when `now - lastActivityAt > STALL_THRESHOLD_MS`; reset only when activity advances
- **Files:** `src/services/stall/stall-poller.ts`, `src/services/stall/stall-detector.ts`
- **Tier:** standard
- **Done when:** `stall_detected` fires exactly once per stall period; resets after activity resumes; Claude and Gemini timestamp fields correctly extracted; `stall_poll_format_error` logged on missing fields

#### Task 6: Unit tests for polling and timestamp extraction
- **Change:** Add tests for Claude `timestamp` extraction from `assistant` entries, Gemini `lastUpdated` extraction from `$set` lines, once-per-stall guard (`stallReported`), reset after activity advance, and missing-field log path
- **Files:** `src/services/stall/stall-poller.test.ts`
- **Tier:** standard
- **Done when:** All new test cases pass; `npm test` green

#### VERIFY: Activity Polling
- Run `npm test` — all tests must pass
- Push: `git push origin feat/stall-detector`
- STOP and report

---

### Phase 4: MCP Disconnect / Dirty State (R8)

#### Task 7: Inject AbortSignal into `execCommand`
- **Change:** Pass the MCP request's `AbortSignal` into `execCommand` (or the strategy's underlying transport) so MCP client disconnect directly unblocks the `await` — independent of whether subprocess kill succeeds; subprocess kill continues in parallel as best-effort cleanup; `finally` block now reliably runs to clear stall entry and `inFlightAgents`
- **Files:** `src/tools/execute-prompt.ts`, `src/services/exec/exec-command.ts` (or transport layer equivalent)
- **Tier:** premium
- **Done when:** MCP client disconnect clears stall entry and `inFlightAgents`; `finally` block runs even when subprocess kill is rejected or never resolves

#### Task 8: Unit tests for disconnect cleanup
- **Change:** Add tests that simulate MCP abort signal firing while `execCommand` is awaiting; verify `finally` runs, stall entry is cleared, and `inFlightAgents` is cleaned up even when subprocess kill rejects
- **Files:** `src/tools/execute-prompt.test.ts`
- **Tier:** premium
- **Done when:** All new test cases pass; `npm test` green

#### VERIFY: MCP Disconnect Fix
- Run `npm test` — all tests must pass
- Push: `git push origin feat/stall-detector`
- STOP and report

---

### Phase 5: `toLocalISOString` Fix

#### Task 9: Fix `toLocalISOString`
- **Change:** Replace broken implementation with the corrected version: subtract `offsetMin * 60000` from `ms` to produce a local-time Date, then replace `Z` with the correct `±HH:MM` offset string; sign logic: `offsetMin <= 0` → `+`, else `-`
- **Files:** `src/services/stall/time-utils.ts` (or wherever `toLocalISOString` is currently defined)
- **Tier:** cheap
- **Done when:** `toLocalISOString` produces correct local time with correct offset (e.g., EDT input returns hours adjusted for UTC−4, not UTC hours with `−04:00` appended)

#### Task 10: Unit tests for `toLocalISOString`
- **Change:** Add tests for UTC+0, a positive-offset timezone (east of UTC), and a negative-offset timezone (west of UTC); assert hour component matches local time, not UTC
- **Files:** `src/services/stall/time-utils.test.ts`
- **Tier:** cheap
- **Done when:** All new test cases pass; `npm test` green

#### VERIFY: toLocalISOString Fix
- Run `npm test` — all tests must pass
- Push: `git push origin feat/stall-detector`
- STOP and report

---

## Risk Register
| Risk | Impact | Mitigation |
|------|--------|------------|
| Internal SSH/shell transport not directly callable from stall service | High | Audit transport layer before Task 3; expose a thin internal method if needed, without touching the public MCP interface |
| AbortSignal threading through `execCommand` requires changes in multiple layers | High | Trace the full call chain before Task 7; inject at the deepest layer that owns the blocking `await` |
| `find -newermt` format varies between BSD (macOS) and GNU (Linux) | Medium | Test both; fall back to `-newer <tempfile>` if `-newermt` unavailable on target OS |
| Two sessions started within the same second (tiebreaker triggered) | Low | `[inv]` token tiebreaker in Task 3 handles this; log when tiebreaker fires |

## Notes
- Base branch: main
- Implementation branch: feat/stall-detector
