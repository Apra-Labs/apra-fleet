# Plan — #201 Pino JSONL Logging Framework

**Base branch:** `main`
**Target branch:** `feat/pino-logging`
**Requirements:** `requirements.md`

---

## Console.* Audit Summary

**Total call sites in `src/`:** 64 (63 excluding `log-helpers.ts`)

| File | Count | Types | Notes |
|---|---|---|---|
| `src/cli/install.ts` | 20 | log, error, warn | CLI installer output |
| `src/smoke-test.ts` | 18 | log | Test harness — likely exempt |
| `src/cli/auth.ts` | 15 | error | CLI auth prompts |
| `src/index.ts` | 4 | log, error | CLI dispatch (--version, --help, error catches) |
| `src/providers/copilot.ts` | 3 | warn | Unattended mode warnings |
| `src/services/auth-socket.ts` | 2 | error | Terminal launch errors |
| `src/utils/crypto.ts` | 1 | warn | Deprecation warning |

**Existing `logLine()` call sites (already migrated in Sprint 3):**
- `src/tools/execute-prompt.ts` — 2 calls
- `src/tools/execute-command.ts` — 1 call
- `src/services/ssh.ts` — 2 calls
- `src/services/strategy.ts` — 2 calls

**Tool handlers with member context but NO `logLine()` calls yet:**
- `src/tools/stop-prompt.ts`
- `src/tools/provision-vcs-auth.ts`
- `src/tools/revoke-vcs-auth.ts`

---

## Phase 1 — Foundation

### T1: Remove `feedback-skills.md`

| | |
|---|---|
| **Description** | Delete `feedback-skills.md` from repo root. It slipped into main via PR #183 and is not part of the project. |
| **Files** | `feedback-skills.md` (delete) |
| **Done criteria** | File no longer exists in working tree. |

### T2: Add pino + pino-roll; create JSONL logger in `log-helpers.ts`

| | |
|---|---|
| **Description** | Install `pino` and `pino-roll` as production dependencies. In `src/utils/log-helpers.ts`: (1) create a lazily-initialized pino instance that writes JSONL to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` using `pino-roll` as an async worker-thread transport with 10 MB size cap and 3 rotated files; (2) extend `logLine` signature to `logLine(tag: string, msg: string, memberId?: string)`; (3) each JSONL line includes fields `ts` (ISO 8601), `pid`, `level`, `tag`, `member_id` (when provided), `msg`; (4) keep the existing `console.error` call alongside the pino write; (5) add a `logWarn()` and `logError()` variant or a `level` parameter so callers can log at different levels. Ensure `maskSecrets()` is applied to `msg` before writing. Create the `logs/` directory on first write (pino-roll handles this, but verify). |
| **Files** | `package.json`, `src/utils/log-helpers.ts` |
| **Done criteria** | `npm install` succeeds; `logLine('test', 'hello')` writes a valid JSONL line to the expected file path; `logLine('test', 'hello', 'member-uuid')` includes `member_id` field; `console.error` still fires; TypeScript compiles cleanly. |

### T3: Thread `memberId` through tool handlers

| | |
|---|---|
| **Description** | In tool handlers that resolve a member via `resolveMember()`, pass the resolved `agent.id` (the member UUID) as the third argument to every `logLine()` call. Add `logLine()` calls to handlers that currently have none. Target files and what to add: |
| | - `execute-prompt.ts` — pass `agent.id` to existing `logLine` calls |
| | - `execute-command.ts` — pass `agent.id` to existing `logLine` call |
| | - `stop-prompt.ts` — add `logLine('stop_prompt', ...)` with `agent.id` |
| | - `provision-vcs-auth.ts` — add `logLine('provision_vcs_auth', ...)` with `agent.id` |
| | - `revoke-vcs-auth.ts` — add `logLine('revoke_vcs_auth', ...)` with `agent.id` |
| | - `ssh.ts` — pass member id through (the `agent` object is available; use `agent.id`) |
| | - `strategy.ts` — same as ssh.ts |
| **Files** | `src/tools/execute-prompt.ts`, `src/tools/execute-command.ts`, `src/tools/stop-prompt.ts`, `src/tools/provision-vcs-auth.ts`, `src/tools/revoke-vcs-auth.ts`, `src/services/ssh.ts`, `src/services/strategy.ts` |
| **Done criteria** | All `logLine` calls in these files include `memberId` as third arg; new `logLine` calls added in stop-prompt, provision-vcs-auth, revoke-vcs-auth; TypeScript compiles. |

### V1: Build + Test Checkpoint

| | |
|---|---|
| **Verify** | `npm run build` — 0 errors; `npm test` — 0 failures. |
| **Rollback** | If pino worker thread conflicts with stdio transport, fall back to synchronous `fs.appendFileSync` writes behind a `writeJsonlLine()` helper (no pino). This is the key risk — test it before proceeding. |

---

## Phase 2 — Audit + Tests

### T4: Full `console.*` audit — replace all direct calls with `logLine()`

| | |
|---|---|
| **Description** | Replace every `console.error`, `console.warn`, and `console.log` call in `src/` (except `log-helpers.ts` itself) with the appropriate `logLine()` call. Guidelines by file: |
| | **`src/index.ts`** — CLI dispatch lines (`--version`, `--help`) use stdout intentionally; keep `console.log` for those. Replace the `.catch` `console.error` calls with `logLine('cli', ...)`. |
| | **`src/cli/auth.ts`** — CLI auth UI writes to stderr for user interaction. Keep `console.error` for user-facing prompts. Replace any purely diagnostic/error logging with `logLine()`. |
| | **`src/smoke-test.ts`** — Test harness; keep `console.log` (it's a standalone script, not server code). |
| | **`src/providers/copilot.ts`** — Replace `console.warn` with `logLine('copilot', ...)` at warn level. **Note:** `buildPromptCommand()` and `permissionModeAutoFlag()` are `ProviderAdapter` interface methods — they receive no agent parameter, so `memberId` is unavailable; omit the third argument entirely for these call sites. |
| | **Doer:** fixed — copilot.ts logLine calls omit memberId because ProviderAdapter methods have no agent parameter |
| | **`src/services/auth-socket.ts`** — Replace `console.error` with `logLine('auth_socket', ...)`. |
| | **`src/utils/crypto.ts`** — Replace `console.warn` with `logLine('crypto', ...)` at warn level. |
| | **Decision:** CLI-facing `console.log`/`console.error` in `index.ts`, `install.ts`, `auth.ts`, and `smoke-test.ts` that are user-visible output (not diagnostic logging) should be **kept**. The acceptance criteria "zero direct console.* calls except log-helpers.ts" applies to server-side code; CLI scripts that run outside the MCP server context are exempt when the output is intentional user communication. Document any kept calls with a brief inline comment. **`install.ts` is fully exempt** — all 20 console.* calls are CLI installer output and `APRA_FLEET_DATA_DIR` may not yet exist when it runs; treat it identically to `auth.ts`, `smoke-test.ts`, and `index.ts` (no changes). |
| **Files** | `src/providers/copilot.ts`, `src/services/auth-socket.ts`, `src/utils/crypto.ts`, `src/index.ts` (partial), `src/cli/auth.ts` (partial) |
| **Done criteria** | `grep -rn "console\.\(error\|warn\|log\)" src/ --include="*.ts"` returns only: (1) `log-helpers.ts` internal call, (2) CLI user-facing output in `index.ts`/`install.ts`/`auth.ts`/`smoke-test.ts` — each justified. All replaced calls use appropriate log level. |
| **Doer:** fixed — install.ts removed from T4 migration; all its console.* calls are CLI user-facing output and it is fully exempt (same as auth.ts, smoke-test.ts, index.ts) | |

### T5: Tests

| | |
|---|---|
| **Description** | Write unit tests for the new `logLine()` behaviour. Test cases: |
| | 1. First `logLine` call creates `APRA_FLEET_DATA_DIR/logs/` directory and `fleet-<pid>.log` file |
| | 2. Written line is valid JSON with fields `ts`, `pid`, `level`, `tag`, `msg` |
| | 3. `memberId` arg populates `member_id` field; omitting it excludes the field |
| | 4. `maskSecrets()` is applied — a message containing `{{secure.MY_KEY}}` is written as `[REDACTED]` |
| | 5. Log rotation triggers when file exceeds 10 MB (or mock/verify pino-roll config) |
| | 6. `console.error` is still called (spy/mock assertion) |
| | Update any existing tests that assert on `console.error` output from `logLine` if the format changed. |
| **Files** | `tests/log-helpers.test.ts` (new or extend existing), possibly `tests/*.test.ts` (update existing) |
| **Done criteria** | All new tests pass; no existing tests broken; `npm test` — 0 failures. |

### V2: Build + Test Checkpoint

| | |
|---|---|
| **Verify** | `npm run build` — 0 errors; `npm test` — 0 failures. Manually verify: start server, invoke a tool, confirm JSONL line appears in `logs/fleet-<pid>.log` with expected fields. |

---

## Phase 3 — Docs

### T6: Documentation updates

| | |
|---|---|
| **Description** | Add logging documentation to fleet skill docs: |
| | 1. **`skills/fleet/SKILL.md`** — Add a "Fleet Logs" section documenting: log file location (`APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`), JSONL format and fields, how to read logs (`cat` / `jq` examples), rotation behaviour. Update the `execute_prompt` section to mention that `pid` is logged for correlation. |
| | 2. **`skills/fleet/troubleshooting.md`** — Add a reference to the log file for diagnosing tool execution issues (e.g., "Check `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` for detailed execution traces"). |
| **Files** | `skills/fleet/SKILL.md`, `skills/fleet/troubleshooting.md` |
| **Done criteria** | Both files updated with accurate log file documentation; no broken markdown. |

### V3: Final Checkpoint

| | |
|---|---|
| **Verify** | `npm run build` — 0 errors; `npm test` — 0 failures. All acceptance criteria from `requirements.md` met. |

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Pino worker thread conflicts with MCP stdio transport** | High — could corrupt JSON-RPC or deadlock | Medium | Test immediately after T2. Pino's worker thread writes to a *file*, not stdout/stderr, so it should not interfere with stdio. If it does, fall back to synchronous `fs.appendFileSync` behind the same `logLine()` API. |
| **`APRA_FLEET_DATA_DIR` not resolved at module load time** | Medium — log file created in wrong location or crashes | Low | Use lazy initialization: create the pino instance on first `logLine()` call, not at import time. The data dir constant is already available at runtime from the existing config module. |
| **pino-roll `mkdir` fails on Windows** | Medium — no logs written | Low | Explicitly `mkdirSync(logsDir, { recursive: true })` before creating the pino instance, rather than relying on pino-roll to create the directory. |
| **CLI scripts (`install.ts`, `auth.ts`) break if `logLine()` tries to write before data dir exists** | Medium — install fails | Low | CLI scripts run outside the MCP server context. If `logLine()` is called from CLI code, guard the file write (try/catch, skip file write if data dir unavailable). Or keep CLI-specific `console.*` calls as-is. |
| **Existing tests mock `console.error` and break when `logLine()` format changes** | Low — test failures | Medium | Audit existing test mocks in T5; update assertions to match new format. |
| **Log rotation under pino-roll leaves stale handles on Windows** | Low — file locking issues | Low | Test rotation on Windows during V2. pino-roll uses rename-based rotation which should work, but verify. |
| **pino-roll worker thread compatibility with SEA binary build** | High — binary may fail to start or silently drop logs | Medium | pino uses `worker_threads` for its async transport; Node.js Single Executable Application (SEA) packaging may not bundle or resolve the worker thread correctly. **Mitigation:** run `npm run build:binary` as part of the T2 verification step and confirm the binary starts and writes a JSONL log line before proceeding. If incompatible, fall back to the synchronous `fs.appendFileSync` fallback already described in V1. |
| **Doer:** fixed — SEA binary / pino-roll worker thread risk added | | | |

---

## Task Dependency Graph

```
T1 (cleanup) ──┐
T2 (pino)   ───┤──► V1 (build+test) ──► T4 (audit) ───┐
T3 (thread) ───┘                         T5 (tests) ───┤──► V2 (build+test) ──► T6 (docs) ──► V3 (final)
```

T1, T2, T3 can be developed in parallel but should be verified together at V1. T4 and T5 can be developed in parallel after V1.
