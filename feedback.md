# #201 Log Schema Polish — Delta Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28
**Scope:** Commits `b0c8720` and `5a3e73f` on `feat/pino-logging` (after approved `0661640`)
**Verdict:** APPROVED (with one nit)

---

## Commits reviewed

- `b0c8720` feat(logging): polish log schema — drop pid, add mem, cmd as msg, send/recv coverage, error logging
- `5a3e73f` feat(logging): fault-tolerance, windows no-window fixes, pm cleanup guidance

---

## 1. Log schema polish

| Item | Status | Notes |
|------|--------|-------|
| `pid` removed from JSON lines | PASS | `line.pid` deleted from `writeLog` |
| `member_id` renamed to `mid` | PASS | `line.mid = memberId` |
| `mem` field added | PASS | Passed as 4th param `memberName` — differs from task spec ("resolved inside writeLog") but avoids circular dependency on registry. Pragmatic choice. |
| `agent=xxx` prefix removed from all msg strings | PASS | Cleaned in execute-command, execute-prompt, stop-prompt, provision-vcs-auth, revoke-vcs-auth |
| `execute_command` msg is raw command (80 char truncated) | PASS | `truncateForLog(maskSecrets(input.command))` |
| `execute_prompt` msg is raw prompt (80 char truncated) | PASS | `truncateForLog(maskSecrets(input.prompt))` |
| `send_files` emits log entries | PASS | `logLine` + `logError` |
| `receive_files` emits log entries | PASS | `logLine` + `logError` |
| `logError` added in catch blocks | PASS | execute-command, execute-prompt, send-files, receive-files |
| Useless PID/host log lines removed from strategy.ts | PASS | 2 `logLine` calls removed, `logLine` import removed |
| Useless PID/host log lines removed from ssh.ts | PASS | 2 `logLine` calls removed, `logLine` import removed |

Remaining `agent=` prefixes: **none** — `grep -r 'agent=' src/tools/` confirms all cleaned.

## 2. Fault tolerance

| Item | Status | Notes |
|------|--------|-------|
| `writeLog` body in try/catch | PASS | Entire body wrapped, `catch { /* ignore */ }` |
| `maskSecrets()` try/catch | PASS | Returns original `text` on error — correct fallback |
| `console.error()` calls each wrapped in try/catch | PASS | All 3 functions (logLine, logWarn, logError) wrapped individually |

## 3. Windows flash fix

| Item | Status | Notes |
|------|--------|-------|
| `$_fleet_psi.CreateNoWindow = $true` in `pidWrapWindows` | PASS | Added between `UseShellExecute` and `Process::Start` |
| `windowsHide: true` in `getCleanEnv` execSync | PASS | Added to options object |

## 4. Skill update (`skills/pm/context-file.md`)

| Item | Status | Notes |
|------|--------|-------|
| `rm -f` replaced with cleanup.md reference | PASS | Clear warning: "Never use plain `rm -f` or `git rm -f`" |
| Mid-sprint recovery procedure added | PASS | 5-step `git rm --cached` / `git checkout origin/<base_branch>` recovery block |

## 5. Tests

| Item | Status | Notes |
|------|--------|-------|
| `npm test` all pass | PASS | 61 files, 1017 passed, 6 skipped, 0 failed |
| `npm run build` | PASS | tsc clean |
| Tests updated for new schema | PASS | `member_id` → `mid`, `pid` assertions removed, new `mem` field test added |

## 6. Specific task checks

- **Remaining `agent=` prefixes in log msgs?** None. All cleaned.
- **Remaining `pid` fields in log output?** None. Only `process.pid` in log filename (correct).
- **Tool handlers with NO log coverage?** Many secondary tools (cloud-control, credential-store-*, register-member, etc.) still lack logging, but these are low-frequency admin operations — out of scope for this delta.
- **Catch blocks that silently swallow errors without logging?** One nit — see below.

## Nit (non-blocking)

`execute-command.ts:215–217` — the long-running task launch `catch` block has no `logError`, while the regular exec catch at line 245 does. Consider adding `logError('execute_command', ...)` there for consistency. Not blocking since the error message is returned to the caller.

---

## Summary

All review criteria pass. Schema changes are clean and consistent. Fault tolerance wrapping is thorough — `writeLog`, `maskSecrets`, and all `console.error` calls are properly guarded. Windows flash fix addresses both the process start and env-detection paths. Skill update adds necessary safety guidance. Tests updated and green. The `mem` field implementation via parameter (rather than internal resolver) is a reasonable deviation that avoids a circular import — no objection.
