## Summary

This PR implements structured JSONL logging for the fleet server and includes several related improvements across stop_prompt, timeouts, Windows behavior, PM skills, and test hygiene.

### Structured JSONL logging (#201)
- **New logging framework** in `log-helpers.ts`: replaces bare `console.error` with structured JSONL written to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` via `fs.createWriteStream` (SEA-compatible, no pino transport)
- **Three severity levels**: `logLine` (info), `logWarn` (warn), `logError` (error) — all write JSON with `ts`, `level`, `tag`, optional `mid`/`mem` (member ID/name), and `msg`
- **`LogScope` class**: scoped logging with invocation ID (`inv`), elapsed time tracking, and `ok()`/`fail()`/`abort()` exit methods — used in `execute_prompt`, `execute_command`, `send_files`, `receive_files`
- **Secret masking**: `maskSecrets()` applied to all log output; fault-tolerant with try/catch wrappers on every `console.error` and `writeLog` call
- **Token usage tracking**: `execute_prompt` now captures and logs `input_tokens`/`output_tokens` from provider responses
- **Member context threading**: `memberId` (`mid`) and `friendlyName` (`mem`) threaded through tool handlers into log entries — replaces inline `agent=xxx` prefixes
- **PID capture callback**: `onPidCaptured` callback replaces inline `extractAndStorePid` + scattered `logLine` calls in `strategy.ts` and `ssh.ts`
- **Startup banner**: logs server version and `FLEET_DIR` on MCP connect
- **Coverage**: `execute_prompt`, `execute_command`, `send_files`, `receive_files`, `stop_prompt`, `provision_vcs_auth`, `revoke_vcs_auth`, `pid_kill`, `auth_socket`, `copilot` provider, `crypto` key migration all emit structured logs
- **New test suite**: `tests/log-helpers.test.ts` — 7 tests covering JSONL output, field order, member fields, secret masking, console.error passthrough

### stop_prompt simplification
- **Removed one-shot stopped flag**: deleted `isAgentStopped`, `setAgentStopped`, `clearAgentStopped` from `agent-helpers.ts` and the flag check from `execute_prompt`
- **Simplified behavior**: `stop_prompt` now only kills the PID — no re-dispatch prevention. Callers must use `TaskStop` on the dispatching agent after calling `stop_prompt`
- **Updated tool description**: reflects kill-only semantics with TaskStop guidance
- **Updated all docs and skills**: `stop-prompt.md`, `session-lifecycle.md`, fleet `SKILL.md`, PM `doer-reviewer.md` — removed all stopped-flag/error-gate language

### Timeout parameter rename (`timeout_ms` → `timeout_s`, `max_total_ms` → `max_total_s`)
- **`execute_prompt`**: `timeout_ms` → `timeout_s` (default 300), `max_total_ms` → `max_total_s`
- **`execute_command`**: `timeout_ms` → `timeout_s` (default 120)
- **Internal conversion**: `* 1000` at call sites to maintain ms-based internals
- **Updated all docs**: `execute-prompt.md`, `tools-work.md`, `session-lifecycle.md`, `provider-matrix.md`, fleet `SKILL.md`, `troubleshooting.md`, `README.md`

### Windows fixes
- **`CreateNoWindow = $true`** in `pidWrapWindows` — prevents console window flash when spawning LLM processes on Windows
- **`windowsHide: true`** in `WindowsCommands.getCleanEnv` `execSync` — prevents window flash during environment detection

### PM skill improvements
- **Project sandboxing** (new Core Rule 2): all project artifacts must live inside `<project>/` — never in PM root or sibling folders
- **Agent context file safety**: replaced `rm -f` cleanup guidance with `cleanup.md` reference; added 5-step recovery procedure for accidentally committed context files
- **Deploy command**: updated `/pm deploy` description with lookup-or-create flow for `deploy.md`
- **`deploy.md` init**: clarified as local copy of repo's deployment runbook with scaffold-from-template fallback
- **Rule renumbering**: existing rules 2-13 → 3-14 to accommodate new sandboxing rule

### Test cleanup
- **Renamed `agent` → `member`** in test variables across all test files for consistency with fleet terminology
- **Updated `timeout_ms` → `timeout_s`** in all test call sites with appropriate value conversion
- **Removed `tests/unit/pid-extraction.test.ts`**: tested the now-deleted `extractAndStorePid` function
- **Removed stopped-flag test assertions** from `execute-prompt.test.ts`

### Other
- **Removed `extractAndStorePid`** from `strategy.ts` — PID extraction now happens inline with `onPidCaptured` callback
- **`tryKillPid` signature change**: accepts `agent` object instead of bare `agentId` for logging context
- **`execCommand` signature change**: added optional `onPidCaptured` callback parameter to `AgentStrategy`, `RemoteStrategy`, `LocalStrategy`, and SSH `execCommand`
- **Removed `feedback-skills.md`**: stale review artifact that slipped into main via PR #183
- **Added `feedback.md`**: #201 log schema polish delta review document
- **README star CTA**: added star callout after value proposition
- **Regenerated `llms-full.txt`**

## Test plan

- [x] All 1017 tests pass (`npm test`) — 6 skipped, 0 failed
- [ ] Verify `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` is created on server start and contains valid JSONL
- [ ] Verify `execute_prompt` log entries include `inv`, `mid`, `mem`, `msg`, token usage, and elapsed time
- [ ] Verify `execute_command` log entries include scoped invocation with ok/fail/abort exits
- [ ] Verify `stop_prompt` kills PID without setting any stopped flag; next `execute_prompt` proceeds immediately
- [ ] Verify `timeout_s` / `max_total_s` parameters work correctly (values in seconds, converted internally to ms)
- [ ] Verify no console window flash on Windows when spawning LLM processes
- [ ] Verify secret masking: `{{secure.NAME}}` and `sec://` patterns appear as `[REDACTED]` in log files
- [ ] Verify `send_files` / `receive_files` emit structured log entries with success/failure counts

Closes #201

🤖 Generated with [Claude Code](https://claude.com/claude-code)
