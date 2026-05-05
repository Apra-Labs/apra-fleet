# Requirements — #241 Stall Detector Redesign

## Base Branch
`main` — branch to fork from and merge back to. Work continues on `feat/stall-detector`.

## Goal
Replace the broken `fs.watch()`-based stall detector with a reliable polling approach that correctly discovers session log files for both Claude and Gemini, on both local and remote members, and properly handles MCP client disconnects that currently leave dirty state.

## Background and Root Cause Analysis

The current implementation on `feat/stall-detector` is broken for 100% of sessions:
- `fs.watch()` only works on local filesystem — useless for SSH-remote members
- Path encoding is wrong (`%2F`/`%5C` instead of `-`) so even local watch fails silently
- Every entry stays `provisional: true` forever — stall fires on spawn time only
- `toLocalISOString` appends offset string to UTC time without adjusting the hours
- When MCP client disconnects mid-session, the `finally` block does not run — stall entries and `inFlightAgents` are permanently dirty. Root cause: `abortHandler` calls `tryKillPid(...).catch(() => {})` fire-and-forget; if the kill fails (silently swallowed), `execCommand` never unblocks, `finally` never runs.

The full design is in `stall-detector-design.md` (committed on the branch and available in the PM project folder). All design decisions are finalized — implementation is the work.

## Scope

### Fix 0 — Prepend inv token to `-p` argument (`execute-prompt.ts`)
- The fleet server already generates a per-invocation ID (`inv`) for every `execute_prompt` call (e.g. `"inv":"eobkp"`)
- Prepend `[<inv>] ` to the `-p` argument value (the "read .fleet-task.md" string) when constructing the CLI command
- The actual task content in `.fleet-task.md` is untouched — only the `-p` string gets the prefix
- This makes the token appear in the first line of the session log file, enabling cross-referencing and tiebreaking
- Source: `src/tools/execute-prompt.ts` where the `-p` argument is assembled

### Fix 1 — Log directory path encoding (`log-path-resolver.ts`)
- Claude: replace `/[\/\\:]/g` with `-` (not `%2F`/`%5C`)
- Gemini: add missing `/chats/` subdirectory
- Remote members: resolve home dir inline in shell command (`$(echo $HOME)` or `$env:USERPROFILE`)

### Fix 2 — Log file discovery via mtime filter
- Abstract behind `findLogFile(member, t0, inv, logDir): Promise<string|null>`
- **Local**: `fs.readdirSync(dir).filter(f => fs.statSync(f).mtimeMs > t0)`
- **Remote**: run via internal SSH/shell transport (same layer backing `execute_command` tool, NOT the MCP tool itself):
  - Linux/macOS: `find <dir> -newermt "<T0-iso>" -name "*.jsonl" 2>/dev/null | head -1`
  - Windows: PowerShell equivalent with `Get-ChildItem` and `LastWriteTime` filter
- Retry every 10s, max 3 retries (30s total); log `stall_log_not_found` if still missing
- **Case A (resume=false):** mtime scan after PID capture
- **Case B — Claude resume=true:** stored sessionId → direct path `<logDir>/<sessionId>.jsonl`
- **Case B — Gemini resume=true:** mtime scan (Gemini creates a new file per resume with same 8-char session prefix)
- `[inv]` token (inv ID prepended as `[<inv>] ` to `-p` argument): tiebreaker only when mtime scan returns >1 file

### Fix 3 — Activity polling
- Poll every `STALL_POLL_INTERVAL_MS` ms (env var, default 30000)
- Tail last 500 bytes of log file
- Claude: extract last `timestamp` field from an `assistant` entry
- Gemini: extract `lastUpdated` from `{"$set":{"lastUpdated":"..."}}` lines
- If fields missing: log `stall_poll_format_error` and skip cycle
- If timestamp advanced: reset `stallReported`, update `lastActivityAt`
- If not advanced and `now - lastActivityAt > STALL_THRESHOLD_MS`: fire `stall_detected` once (guard with `stallReported=true`)

### Fix 4 — MCP disconnect / dirty state (R8)
- Root cause confirmed by code analysis: `abortHandler` fires, calls `tryKillPid` fire-and-forget, kill failure silently swallowed, `execCommand` never unblocks, `finally` never runs
- Fix: inject AbortSignal into `execCommand` (or the strategy's underlying transport) so the MCP signal abort directly unblocks `execCommand` — independent of whether the subprocess kill succeeds
- Subprocess kill continues in parallel as best-effort cleanup

### Fix 5 — `toLocalISOString`
```typescript
function toLocalISOString(ms: number): string {
  const d = new Date(ms);
  const offsetMin = d.getTimezoneOffset();
  const sign = offsetMin <= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = new Date(ms - offsetMin * 60000);
  return local.toISOString().replace('Z', `${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`);
}
```

## Out of Scope
- New stall detection algorithms beyond the mtime+polling approach — design is finalized
- Changes to `execute_command` MCP tool public interface — internal transport only
- UI or client-side changes

## Constraints
- Branch: `feat/stall-detector` (already exists, continue work there)
- TypeScript, matches existing code style in `src/services/stall/` and `src/tools/`
- Tests must pass: `npm test` (currently 1077 tests passing on main)
- Must work for both local (Windows) and remote (macOS/Linux) members
- Internal SSH/shell transport must be used for remote polling — NOT the `execute_command` MCP tool

## Acceptance Criteria
- [ ] `-p` argument is prefixed with `[<inv>] ` in execute-prompt.ts (token appears in log line 1)
- [ ] Claude log dir path encoding produces `-` separators (not `%2F`/`%5C`)
- [ ] Gemini log dir path includes `/chats/` subdirectory
- [ ] `findLogFile` correctly resolves the log file for a fresh Claude session on a local member within 30s
- [ ] `findLogFile` correctly resolves the log file for a fresh Gemini session on a local member within 30s
- [ ] `findLogFile` uses mtime filter (not grep) as primary mechanism
- [ ] Activity polling reads the correct timestamp field for Claude and Gemini
- [ ] `stall_detected` fires exactly once per stall period (no repeated fires)
- [ ] `stall_detected` resets after activity resumes
- [ ] MCP client disconnect clears stall entry and `inFlightAgents` (finally runs)
- [ ] `toLocalISOString` produces correct local time offset (not UTC hours with appended offset string)
- [ ] All existing tests pass
- [ ] New unit tests cover: path encoding, mtime filter logic, timestamp extraction, toLocalISOString fix
