# Requirements — #201 Pino JSONL Logging Framework

## Base Branch
`main`

## Goal
Replace fleet's ad-hoc `console.error` logging with a proper `pino`-based JSONL logging framework that writes to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`. Every fleet server instance gets its own file (no cross-process contention), every log line is self-identifying, and the optional `member_id` field enables per-member log filtering in the fleet dashboard (#188).

## Background

### Why `console.error` is insufficient
The MCP stdio transport uses stdin/stdout for JSON-RPC. Stderr is safe for logging (MCP spec §transport: "server MAY write UTF-8 strings to stderr for logging") and cannot corrupt the protocol. However, Claude Code CLI does not persist MCP server stderr to a file (anthropics/claude-code#29035 — Claude Desktop does, CLI does not). As a result, fleet's T9 structured logs are invisible during active tool execution — stderr is only captured at server startup. The only reliable logging channel is a fleet-owned file.

### Current state
- `src/utils/log-helpers.ts` — `logLine(tag, msg)` wraps `console.error`. Used in `execute-prompt.ts`, `execute-command.ts`, `strategy.ts`, `ssh.ts` (T9, Sprint 3).
- Dozens of direct `console.error` / `console.warn` / `console.log` calls exist across providers, auth, error paths, and VCS tools — all bypassing `logLine()`.

## Scope

1. **Add `pino` dependency** — async worker-thread transport for non-blocking file writes.
2. **Update `logLine()`** — write JSONL to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` via pino. Keep `console.error` alongside (spec-compliant; Claude Desktop captures it). Extend signature: `logLine(tag: string, msg: string, memberId?: string)`.
3. **Per-line JSONL fields:**
   - `ts` — ISO 8601 timestamp
   - `pid` — `process.pid` (matches filename; self-identifying if logs aggregated)
   - `level` — `info` / `warn` / `error`
   - `tag` — tool or subsystem (`execute_prompt`, `execute_command`, `ssh`, `vcs-auth`, etc.)
   - `member_id` — optional member GUID (pass from tool handlers that operate on a specific member)
   - `msg` — human-readable message (secrets already masked via `maskSecrets()`)
4. **Log file path:** `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`. Create `logs/` dir on first write. `APRA_FLEET_DATA_DIR` is the existing data directory constant used elsewhere in the codebase.
5. **Audit all `console.*` call sites** — `console.error`, `console.warn`, `console.log` across the entire `src/` tree. Replace every direct call with `logLine()` at the appropriate level. Pass `memberId` where the surrounding code has a member context.
6. **Basic log rotation** — pino's `pino-roll` transport or a size cap (10 MB → rename to `.1.log`, open new file). Keep last 3 rotated files.
7. **Docs** — Update `skills/fleet/SKILL.md` with a "Fleet Logs" section documenting the log file location and format. Update `skills/fleet/troubleshooting.md` to reference the log file for diagnosing tool execution issues.
8. **Cleanup** — Remove `feedback-skills.md` from the repo root (it slipped into main via PR #183).

## Out of Scope
- Dashboard log viewer (issue #188) — `member_id` field is the only integration point needed here
- Log aggregation across remote members — each member's fleet server writes its own local log
- Structured query tooling — plain `jq` / `grep` on the JSONL file is sufficient for now
- Changing `logLine()` call sites to pass structured objects — `tag + msg + memberId` is sufficient

## Constraints
- **Non-blocking:** pino's async worker-thread transport must be used — `logLine()` must never block the event loop or stall a tool handler
- **No cross-process locking:** per-`<pid>` file naming is the mechanism — do not attempt shared-file writes
- **Backward compatible:** existing `logLine(tag, msg)` call sites work unchanged — `memberId` is optional
- **TypeScript:** all changes must typecheck cleanly (`npm run build` zero errors)
- **Tests must pass:** `npm test` zero failures

## Acceptance Criteria
- [ ] `pino` added to `package.json` dependencies; builds cleanly
- [ ] `logLine()` writes JSONL lines to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` after first call
- [ ] Each JSONL line contains `ts`, `pid`, `level`, `tag`, `msg` fields; `member_id` present when passed
- [ ] `console.error` is still called alongside file write (stderr parity)
- [ ] Zero direct `console.error` / `console.warn` / `console.log` calls remain in `src/` (except inside `log-helpers.ts` itself)
- [ ] `memberId` is threaded through in tool handlers that have a member context (`execute_prompt`, `execute_command`, `stop_prompt`, `provision_vcs_auth`, etc.)
- [ ] Log rotation triggers at 10 MB; at most 3 rotated files kept
- [ ] `skills/fleet/SKILL.md` has a Fleet Logs section with file path and format
- [ ] `feedback-skills.md` removed from repo root
- [ ] `npm run build` — 0 errors; `npm test` — 0 failures
