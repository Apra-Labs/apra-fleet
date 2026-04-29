# #201 Log Schema Polish — Delta Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28
**Scope:** Commits `b0c8720` and `5a3e73f` on `feat/pino-logging` (after approved `0661640`)
**Verdict:** APPROVED

---

## Commits reviewed

- `b0c8720` feat(logging): polish log schema — drop pid, add mem, cmd as msg, send/recv coverage, error logging
- `5a3e73f` feat(logging): fault-tolerance, windows no-window fixes, pm cleanup guidance

---

## 1. Log schema polish

| Item | Status | Notes |
|------|--------|-------|
| `pid` removed from JSON lines | PASS | `line.pid` deleted from `writeLog`; only `process.pid` remains in log filename (correct) |
| `member_id` renamed to `mid` | PASS | `line.mid = memberId` |
| `mem` field added | PASS | Passed as 4th param `memberName` rather than resolved inside `writeLog` — avoids circular dependency on agent registry. Sound trade-off. |
| `agent=xxx` prefix removed from all msg strings | PASS | Grep confirms zero `agent=` in `src/tools/` or `src/services/` log calls |
| `execute_command` msg is raw command (80 char truncated) | PASS | `truncateForLog(maskSecrets(input.command))` |
| `execute_prompt` msg is raw prompt (80 char truncated) | PASS | `truncateForLog(maskSecrets(input.prompt))` |
| `send_files` emits log entries | PASS | `logLine` on entry + `logError` in catch |
| `receive_files` emits log entries | PASS | `logLine` on entry + `logError` in catch |
| `logError` added in catch blocks | PASS | execute-command, execute-prompt, send-files, receive-files |
| Useless PID/host log lines removed from strategy.ts | PASS | 2 `logLine` calls + import removed |
| Useless PID/host log lines removed from ssh.ts | PASS | 2 `logLine` calls + import removed |

## 2. Fault tolerance

| Item | Status | Notes |
|------|--------|-------|
| `writeLog` body in try/catch | PASS | Entire body wrapped, `catch { /* ignore */ }` |
| `maskSecrets()` try/catch | PASS | Returns original `text` on error — correct fallback |
| `console.error()` calls each wrapped | PASS | All 3 functions (logLine, logWarn, logError) wrapped individually |

## 3. Windows flash fix

| Item | Status | Notes |
|------|--------|-------|
| `CreateNoWindow = $true` in `pidWrapWindows` | PASS | Inserted between `UseShellExecute` and `Process::Start` |
| `windowsHide: true` in `getCleanEnv` execSync | PASS | Added to options object |

## 4. Skill update (`skills/pm/context-file.md`)

| Item | Status | Notes |
|------|--------|-------|
| `rm -f` replaced with cleanup.md reference | PASS | Clear warning against plain `rm -f` / `git rm -f` |
| Mid-sprint recovery procedure added | PASS | 5-step `git rm --cached` + `git checkout origin/<base_branch>` recovery |

## 5. Tests

| Item | Status | Notes |
|------|--------|-------|
| `npm test` | PASS | 61 files, 1017 passed, 6 skipped, 0 failed |

## 6. Specific task checks

- **Remaining `agent=` prefixes in log msgs?** None found.
- **Remaining `pid` fields in log output?** None. Only `process.pid` in log filename.
- **Tool handlers with NO log coverage?** Core operational tools (execute-command, execute-prompt, send-files, receive-files, stop-prompt, provision-vcs-auth, revoke-vcs-auth) all have logging. Admin/introspection tools (cloud-control, credential-store-*, register-member, etc.) lack logging but are low-frequency — out of scope for this delta.
- **Catch blocks silently swallowing errors?** Three minor cases noted below as nits; none blocking.

## Nits (non-blocking)

1. **`execute-command.ts:215`** — long-running task launch `catch` has no `logError`, while the regular exec catch at line 245 does. Error is returned to the caller so it's observable, but a `logError` here would keep the log file complete.

2. **`provision-vcs-auth.ts:160`** and **`revoke-vcs-auth.ts:54`** — both catch blocks return error strings but don't call `logError`. These tools import `logLine` and emit success logs, so failures create a gap where errors are only visible in the MCP response, not the log file.

3. **`execute-command.ts:119`** — `ensureCloudReady` catch returns error string without `logError`. Minor since it's a pre-execution guard.

All three are non-blocking because errors are surfaced to the caller.

---

## Summary

All review criteria pass. The log schema is clean and consistent: `pid` gone, `mid`/`mem` in place, `agent=` prefixes stripped, raw command/prompt as the `msg`. Fault-tolerance wrapping is thorough. Windows flash fix covers both process start and env detection. Skill update adds important safety guidance against destructive `rm -f` on tracked project files. All 1017 tests green.
