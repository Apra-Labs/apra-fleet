# #201 Pino JSONL Logging — Phase 1 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28 18:17:00+05:30
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review. Prior version was the plan re-review (APPROVED, 3187501). This is the first code review covering Phase 1 tasks T1, T2, T3 and the V1 build/test checkpoint.

---

## T1: Remove feedback-skills.md — PASS

`feedback-skills.md` no longer exists in the working tree. Commit 2b880c0 deleted it. The file was introduced by PR #183 and is confirmed absent from both the branch and main.

**Done criteria met:** File no longer exists in working tree.

---

## T2: Pino + pino-roll logger in log-helpers.ts — PASS

Reviewed `src/utils/log-helpers.ts` (new file, 70 lines). All requirements satisfied:

1. **Dependencies installed.** PASS. `pino` (^10.3.1) and `pino-roll` (^4.0.0) added to `package.json` dependencies. `npm install` succeeds.

2. **Lazy initialization.** PASS. The pino logger is created inside `getLogger()` on first call, not at import/module-load time. The `_logger` singleton is `null` until the first `logLine()` / `logWarn()` / `logError()` invocation. This satisfies the constraint that `APRA_FLEET_DATA_DIR` may not be resolved at module load time.

3. **JSONL field completeness.** PASS. Pino's `formatters` configuration produces fields:
   - `ts` — ISO 8601 via custom `timestamp` function
   - `pid` — from pino `bindings` formatter
   - `level` — string label via `level` formatter
   - `tag` — passed as a child field in `writeLog()`
   - `member_id` — conditionally included when `memberId !== undefined`
   - `msg` — pino's standard message field (the second argument to `logger[level]()`)

4. **maskSecrets() applied before pino write.** PASS. All three public functions (`logLine`, `logWarn`, `logError`) call `maskSecrets(msg)` before passing to `writeLog()`. The masked message is also used for the `console.error` call, ensuring consistency.

5. **console.error still fires.** PASS. Each public function calls `console.error(...)` with a `[fleet]` / `[fleet:warn]` / `[fleet:error]` prefix alongside the pino write.

6. **logWarn() / logError() variants.** PASS. Both are exported with identical signatures to `logLine()` and write at `warn` / `error` levels respectively.

7. **mkdirSync for logs/ dir.** PASS. `fs.mkdirSync(logsDir, { recursive: true })` is called inside `getLogger()` before creating the pino transport.

8. **pino-roll transport configuration.** PASS. `size: '10m'` and `limit: { count: 3 }` match the requirements (10 MB rotation, 3 rotated files).

9. **Log file path.** PASS. `path.join(FLEET_DIR, 'logs', \`fleet-${process.pid}.log\`)` where `FLEET_DIR` resolves to `APRA_FLEET_DATA_DIR` (or `~/.apra-fleet/data` fallback), matching the spec.

10. **Graceful fallback.** PASS. If `getLogger()` throws (e.g., data dir unavailable during CLI install), the catch block silently returns `null` and `writeLog()` becomes a no-op. Console logging continues unaffected.

11. **Backward compatibility.** PASS. The `logLine(tag, msg)` two-argument form continues to work — `memberId` is optional.

12. **Additional exports.** NOTE. `truncateForLog()` is also exported — a utility for call sites to shorten long messages before logging. Not in the plan but harmless and used by T3 callers.

**Done criteria met:** `npm install` succeeds; `logLine` writes JSONL with correct fields; `console.error` fires; TypeScript compiles cleanly.

---

## T3: Thread memberId through tool handlers — PASS

Reviewed the Phase 1 diff (3187501..4641d15) for all seven target files:

### Existing logLine() calls — memberId added as third arg:

| File | logLine calls updated | Correct? |
|---|---|---|
| `src/tools/execute-prompt.ts` | 2 calls (prompt start, finally block) | PASS — uses `agent.id` |
| `src/tools/execute-command.ts` | 1 call (command start) | PASS — uses `agent.id` |
| `src/services/ssh.ts` | 2 calls (exec start, PID extraction) | PASS — uses `agent.id` |
| `src/services/strategy.ts` | 2 calls (local spawn, local PID extraction) | PASS — uses `this.agent.id` / `this.agent.id` |

### New logLine() calls added:

| File | Tag | Correct? |
|---|---|---|
| `src/tools/stop-prompt.ts` | `stop_prompt` | PASS — includes `agent.friendlyName`, `pid`, and `agent.id` |
| `src/tools/provision-vcs-auth.ts` | `provision_vcs_auth` | PASS — includes `agent.friendlyName`, `provider`, and `agent.id` |
| `src/tools/revoke-vcs-auth.ts` | `revoke_vcs_auth` | PASS — includes `agent.friendlyName`, `provider`, and `agent.id` |

All seven files specified in PLAN.md T3 are covered. No target file was missed.

**Done criteria met:** All `logLine` calls in target files include `memberId` as third arg; new `logLine` calls added in stop-prompt, provision-vcs-auth, revoke-vcs-auth; TypeScript compiles.

---

## V1: Build + Test Checkpoint — PASS

1. **`npm run build`** — 0 errors (after `npm install`). TypeScript compiles cleanly.
2. **`npm test`** — 60 test files, 1010 tests passed, 0 failures, 6 skipped (pre-existing).
3. **`npm run build:binary`** — SEA binary builds successfully (`apra-fleet-installer-darwin-x64`, valid Mach-O x86_64). The pino worker-thread transport and pino-roll are compatible with the SEA packaging pipeline — the binary compiles and the blob injects without error.

### NOTE: CI not yet triggered

The `feat/pino-logging` branch has not been pushed to the remote, so no GitHub Actions CI run exists. Local build and test both pass. CI verification will apply on push.

### NOTE: progress.json V1 status

`progress.json` shows V1 as `"status": "pending"` despite the commit message claiming "V1 checkpoint passed." This is appropriate — V1 is a verification checkpoint for the reviewer, not the doer. The doer correctly left it for the reviewer to confirm.

---

## Scope Hygiene

The Phase 1 diff (3187501..4641d15) touches only files within scope: `feedback-skills.md` (deletion), `package.json` / `package-lock.json` (pino deps), `progress.json`, `src/utils/log-helpers.ts`, and the seven tool/service files listed in T3. No out-of-scope changes detected. The broader diff between main and the branch includes prior sprint work (PR #183) which is not under review here.

---

## Summary

**All Phase 1 tasks pass.** T1 (file removal), T2 (pino logger with lazy init, correct JSONL fields, maskSecrets, console.error parity, rotation config), T3 (memberId threading across all seven target files), and V1 (build 0 errors, test 0 failures, SEA binary compatible) are complete and correct. No blocking or non-blocking findings. Phase 2 (T4 audit + T5 tests) can proceed.
