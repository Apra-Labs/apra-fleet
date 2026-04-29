# #201 Log Schema Polish — Delta Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28
**Scope:** Uncommitted changes on `feat/pino-logging` after approved commit `0661640`
**Verdict:** CHANGES REQUESTED

---

## What was reviewed

Uncommitted (unstaged) changes across 7 files:
- `src/index.ts` — agent resolver wiring
- `src/services/ssh.ts` — removed redundant log lines
- `src/services/strategy.ts` — removed redundant log lines
- `src/tools/execute-command.ts` — cleaned log msg, added `logError`
- `src/tools/execute-prompt.ts` — cleaned log msg, added `logError`
- `src/tools/send-files.ts` — added `logLine` and `logError`
- `src/utils/log-helpers.ts` — `pid` removed, `member_id` → `mid`, `mem` field via resolver

---

## Checks

### 1. Log schema polish

| Item | Status | Notes |
|------|--------|-------|
| `pid` removed from JSON lines | PASS | `line.pid = process.pid` deleted |
| `member_id` renamed to `mid` | PASS | `line.mid = memberId` |
| `mem` field added via resolver (not parameter) | PASS | `setAgentResolver` in index.ts, resolved inside `writeLog` |
| `agent=xxx` prefix removed from execute_command | PASS | msg is now `truncateForLog(maskSecrets(input.command))` |
| `agent=xxx` prefix removed from execute_prompt | PASS | msg is now `truncateForLog(maskSecrets(input.prompt))` |
| `agent=xxx` prefix removed from ALL msg strings | **FAIL** | 3 remaining: `stop-prompt.ts:31`, `revoke-vcs-auth.ts:59`, `provision-vcs-auth.ts:184` |
| `execute_command` msg is raw command (80 char truncated) | PASS | |
| `execute_prompt` msg is raw prompt (80 char truncated) | PASS | |
| `send_files` emits log entries | PASS | `logLine` + `logError` added |
| `receive_files` emits log entries | **FAIL** | No log coverage in receive-files handler |
| `logError` added in catch blocks | PASS | Added in execute-command, execute-prompt, send-files |
| Useless PID/host log lines removed from strategy.ts | PASS | 2 `logLine` calls removed |
| Useless PID/host log lines removed from ssh.ts | PASS | 2 `logLine` calls removed |

### 2. Fault tolerance

| Item | Status | Notes |
|------|--------|-------|
| `writeLog` body in try/catch | **FAIL** | No try/catch wrapping; a `JSON.stringify` or `stream.write` error will crash the host |
| `maskSecrets()` try/catch | **FAIL** | No try/catch; a regex engine error propagates |
| `console.error()` calls wrapped in try/catch | **FAIL** | No wrapping on any of the 3 `console.error` calls in logLine/logWarn/logError |

### 3. Windows flash fix

| Item | Status | Notes |
|------|--------|-------|
| `CreateNoWindow = $true` in `pidWrapWindows` | **FAIL** | No changes to `src/os/windows.ts` |
| `windowsHide: true` in `getCleanEnv` | **FAIL** | No changes to `src/os/windows.ts` |

### 4. Skill update

| Item | Status | Notes |
|------|--------|-------|
| `rm -f` replaced with cleanup.md reference | **FAIL** | No changes to `skills/pm/context-file.md` |
| Mid-sprint recovery procedure added | **FAIL** | No changes to `skills/pm/context-file.md` |

### 5. Tests

| Item | Status | Notes |
|------|--------|-------|
| `npm test` all pass | **FAIL** | 3 failures in `log-helpers.test.ts` — tests still expect old `member_id` field and `pid` field |

Failing assertions:
- `it('writes valid JSONL...')` — expects `pid: process.pid` (line 54)
- `it('field order: ts, level, tag, msg, pid...')` — expects `['ts', 'level', 'tag', 'msg', 'pid']` (line 65)
- `it('includes member_id...')` — expects `member_id` key and `['ts', 'level', 'tag', 'member_id', 'msg', 'pid']` order (lines 76-80)

---

## Summary

The core schema changes (pid removal, mid rename, mem resolver, msg cleanup) are well-implemented. The `setAgentResolver` pattern correctly avoids circular imports by injecting the registry lookup at startup. The `logError` additions in catch blocks are good.

However, this delta is incomplete against its stated scope:

1. **3 `agent=` prefixes remain** in tool handlers not touched by this diff
2. **`receive_files` has no log coverage**
3. **All fault-tolerance wrapping is missing** — `writeLog`, `maskSecrets`, and `console.error` have no try/catch
4. **Windows flash fix and skill update are entirely absent**
5. **Tests are broken** — must be updated for the new schema before merging

**Action required:** Address all FAIL items above, update tests, and re-submit.
