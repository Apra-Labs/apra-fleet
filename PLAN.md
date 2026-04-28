# Sprint Plan — Session Lifecycle & OOB Fix

**Branch:** `sprint/session-lifecycle-oob-fix`
**Base:** `main`
**Requirements:** `requirements.md` (T1–T10)
**Tracking:** `progress.json`

---

## Phase 1 — Critical Code Bugs (T7, T8)

Front-loaded: these are runtime bugs that affect stop_prompt and cross-platform dispatch.

### T7 — BUG (CRITICAL): `stop_prompt` broken — PID stored after process exits

**Type:** work
**Description:** `extractAndStorePid()` runs after the child process exits, so `getStoredPid()` always returns `undefined` for live sessions. Fix by parsing `FLEET_PID:` from stdout data stream in real-time.

**Files to change:**
- `src/services/strategy.ts` — LocalStrategy: add PID extraction in `child.stdout.on('data')` handler
- `src/services/ssh.ts` — RemoteStrategy: add PID extraction in SSH stdout data handler
- `src/services/strategy.ts` — Verify `clearStoredPid()` is called on close/error in both strategies

**Sub-tasks:**

#### T7.1 — LocalStrategy streaming PID extraction
- In `LocalStrategy.execCommand()`, add a `pidExtracted` flag and scan each `child.stdout` data chunk for `/^FLEET_PID:(\d+)\r?$/m`
- Call `setStoredPid(this.agent.id, pid)` immediately on first match
- Log to stderr: `[fleet] stored PID ${pid} for agent ${agentId}`

#### T7.2 — RemoteStrategy streaming PID extraction
- In `ssh.ts` stdout data handler (~line 180), apply same pattern: scan incoming chunks for `FLEET_PID:` before accumulating
- Call `setStoredPid(agentId, pid)` on match with stderr log

#### T7.3 — Verify clearStoredPid on exit
- Confirm both strategies call `clearStoredPid(agentId)` in their close/error handlers
- Add calls if missing

**Done criteria:**
- `stop_prompt` can find and kill a running LLM process mid-execution
- PID is logged to stderr when captured
- PID is cleared on process exit
- `npm run build` passes
- Existing PID-related tests pass

**Risk:** Changing the streaming data path could break stdout buffering or spill-file logic. Must preserve existing accumulation behaviour — PID extraction is additive, not a replacement.

---

### T8 — BUG: `windows.ts` hardcodes Claude's `--permission-mode auto` for all providers

**Type:** work
**Description:** `buildAgentPromptCommand` in `windows.ts` hardcodes `--permission-mode auto` (Claude-only) for all providers when `unattended='auto'`. Must delegate to provider.

**Files to change:**
- `src/providers/provider.ts` — Add `permissionModeAutoFlag(): string | null` to `ProviderAdapter` interface
- `src/providers/claude.ts` — Implement: returns `'--permission-mode auto'`
- `src/providers/gemini.ts` — Implement: returns `null`
- `src/providers/codex.ts` — Implement: returns `'--ask-for-approval auto-edit'`
- `src/providers/copilot.ts` — Implement: returns `null` + logs warning
- `src/os/windows.ts` — Call `provider.permissionModeAutoFlag()` instead of hardcoding

**Done criteria:**
- All 4 providers implement `permissionModeAutoFlag()`
- `windows.ts` uses the new method for `unattended='auto'`
- `npm run build` passes
- Provider tests pass

**Risk:** Adding a method to the interface is a breaking change for any external implementors. Mitigation: this is an internal interface with exactly 4 implementations, all in-tree.

---

### V1 — VERIFY Phase 1

**Type:** verify
**Description:** Build and run full test suite. Confirm T7 and T8 work correctly together.

**Done criteria:**
- `npm run build` — 0 errors
- `npm test` — 0 failures
- Manual inspection: PID extraction code is in data handlers, not post-resolve
- Manual inspection: windows.ts delegates auto flag to provider

---

## Phase 2 — Structured Logging (T9)

Depends on T7 (PID streaming) being complete — logging hooks into the same data path.

### T9 — FEATURE: Structured logging for execute_prompt and execute_command

**Type:** work
**Description:** Add stderr-based structured logging for fleet operations: prompt/command entry, PID capture, and process exit.

**Files to change:**
- `src/services/strategy.ts` — Add log helper, entry/exit/PID logs in LocalStrategy
- `src/services/ssh.ts` — Add entry/exit logs in RemoteStrategy
- `src/tools/execute-prompt.ts` — Add entry log before dispatch
- `src/tools/execute-command.ts` — Add entry log before dispatch

**Sub-tasks:**

#### T9.1 — Log helper + credential masking
- Add `logLine(tag: string, msg: string)` helper that writes to stderr via `console.error`
- Add `maskSecrets(text: string)` that replaces `{{secure.*}}` and `sec://...` patterns with `[REDACTED]`
- Truncate logged prompt/command to 80 chars, replace newlines/tabs with spaces

#### T9.2 — execute_prompt logging
- Entry: `[fleet] execute_prompt agent=<name> prompt="<truncated>..."`
- PID capture (in T7's streaming handler): `[fleet] execute_prompt agent=<name> LLM_PID=<pid> (local|ssh:<host>)`
- Exit: `[fleet] execute_prompt agent=<name> LLM_PID=<pid> exit=<code> elapsed=<ms>ms`

#### T9.3 — execute_command logging
- Entry: `[fleet] execute_command agent=<name> cmd="<truncated>..."`
- Local PID: `[fleet] execute_command agent=<name> PID=<child.pid> (local)`
- SSH: `[fleet] execute_command agent=<name> host=<host> (ssh)`

**Done criteria:**
- All log lines appear on stderr (not stdout)
- Secrets are masked in all logged text
- Prompt/command truncated to 80 chars
- `npm run build` passes

**Risk:** Logging to stderr is safe (MCP transport is on stdout), but verbose logging could be noisy. Mitigated by keeping log lines concise and single-line.

---

### V2 — VERIFY Phase 2

**Type:** verify
**Description:** Build and test after logging additions. Verify no stdout contamination.

**Done criteria:**
- `npm run build` — 0 errors
- `npm test` — 0 failures
- Grep for `console.log` in changed files — none (all logging via `console.error`)
- Verify secret masking works for `{{secure.foo}}` and `sec://bar` patterns

---

## Phase 3 — Skill Docs (T1, T2, T3)

Documentation fixes from code review. T1 is blocking.

### T1 — FIX (BLOCKING): SKILL.md unattended='auto' provider table

**Type:** work
**Description:** Replace blanket statement at SKILL.md:192 with provider-specific table showing actual `auto` and `dangerous` flag behaviour.

**Files to change:**
- `skills/fleet/SKILL.md` — Replace line 192 area with provider table

**Done criteria:**
- Table lists all 4 providers with correct `auto` and `dangerous` flags
- Copilot rows show warning icons for unsupported modes
- Matches verified source code behaviour

**Risk:** Low — documentation only.

---

### T2 — FIX (NON-BLOCKING): Add `credential_store_update` to SKILL.md tools table

**Type:** work
**Description:** Add missing `credential_store_update` tool to the Core Fleet Tools table.

**Files to change:**
- `skills/fleet/SKILL.md` — Add row after `credential_store_delete`

**Done criteria:**
- Tool appears in table with correct description
- Consistent with existing table formatting

**Risk:** None.

---

### T3 — FIX (NON-BLOCKING): Document Copilot unattended limitation in SKILL.md

**Type:** work
**Description:** Add explicit note about Copilot's lack of unattended support. If T1's provider table is already in place, this is covered by the warning icons — verify and add callout if needed.

**Files to change:**
- `skills/fleet/SKILL.md` — Unattended modes section

**Done criteria:**
- Copilot limitation is clearly documented
- A PM reading the section knows not to dispatch unattended work to Copilot members

**Risk:** None.

---

### V3 — VERIFY Phase 3

**Type:** verify
**Description:** Build and test. Review SKILL.md changes for accuracy.

**Done criteria:**
- `npm run build` — 0 errors
- `npm test` — 0 failures
- SKILL.md provider table matches actual code behaviour (cross-check against provider source files)

---

## Phase 4 — Advisory Cleanups (T4, T5, T6)

Low-risk advisory fixes from code review.

### T4 — CLEANUP (ADVISORY): Remove Gemini mechanic from doer-reviewer.md

**Type:** work
**Description:** Replace provider implementation detail on doer-reviewer.md:10 with cross-reference to SKILL.md unattended section.

**Files to change:**
- `skills/pm/doer-reviewer.md` — Line 10

**Done criteria:**
- No provider-specific implementation details in PM orchestration doc
- Cross-reference points to correct SKILL.md section

**Risk:** None.

---

### T5 — CLEANUP (ADVISORY): Fix sub-bullet formatting in doer-reviewer.md

**Type:** work
**Description:** Indent lines 9-11 as sub-bullets under checklist item 4. Split line 11 (concatenated instructions) into two separate items.

**Files to change:**
- `skills/pm/doer-reviewer.md` — Lines 8-11

**Done criteria:**
- Sub-bullets are properly indented under item 4
- No concatenated unrelated instructions on a single line

**Risk:** None.

---

### T6 — FIX (ADVISORY): Quote `${credFile}` in linux.ts shell commands

**Type:** work
**Description:** Wrap `${credFile}` in double quotes in shell string templates for defense-in-depth.

**Files to change:**
- `src/os/linux.ts` — Lines 211 and 219

**Done criteria:**
- All `${credFile}` occurrences in shell strings are double-quoted
- Build passes
- Credential helper tests pass

**Risk:** Low. `credFile` uses `escapeDoubleQuoted()` upstream, so double-quoting is safe. Verify no tests assert on exact unquoted command strings.

---

### V4 — VERIFY Phase 4

**Type:** verify
**Description:** Build and test after advisory cleanups.

**Done criteria:**
- `npm run build` — 0 errors
- `npm test` — 0 failures
- `linux.ts` credential commands use quoted paths

---

## Phase 5 — Test Suite Audit (T10)

### T10 — REFACTOR: Test suite audit — remove dead, overlapping, and irrelevant tests

**Type:** work
**Description:** Audit all test files. Delete dead tests (testing removed code), consolidate duplicates, keep security boundary tests. Priority files: `credential-scoping-ttl.test.ts`, `unattended-mode.test.ts`, `vcs-isolation.test.ts`, `execute-prompt.test.ts`, Windows tests.

**Files to change:**
- `tests/` — Multiple test files (determined during audit)

**Sub-tasks:**

#### T10.1 — Audit priority test files
- Read and classify each test in: `credential-scoping-ttl.test.ts`, `unattended-mode.test.ts`, `vcs-isolation.test.ts`, `execute-prompt.test.ts`, Windows-specific tests
- Mark for deletion, consolidation, or keep

#### T10.2 — Audit remaining test files
- Scan all other test files for dead tests, placeholders, mock-only assertions
- Mark for deletion or consolidation

#### T10.3 — Execute deletions and consolidations
- Remove identified dead/duplicate tests
- Consolidate where appropriate (parameterised table tests)
- Do NOT delete sole security boundary tests

#### T10.4 — Validate and report
- `npm run build && npm test` — 0 failures
- Report: tests removed, tests consolidated, net reduction, coverage gaps found

**Done criteria:**
- All dead/duplicate tests removed
- No security boundary tests deleted
- Full suite passes with 0 failures
- Audit report written

**Risk:** Accidentally deleting the sole test covering a security boundary. Mitigation: classify every test before deleting; grep codebase for tested function to confirm coverage is not unique.

---

### V5 — VERIFY Phase 5

**Type:** verify
**Description:** Final build and test. Confirm test audit did not break anything.

**Done criteria:**
- `npm run build` — 0 errors
- `npm test` — 0 failures
- No regressions from any phase

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | T7 streaming PID extraction breaks stdout buffering or spill-file logic | High — corrupted output for large prompts | Medium | PID extraction is read-only scan of data chunks; existing accumulation logic is unchanged. Test with large outputs. |
| 2 | T8 interface change breaks build for providers | Medium — compile errors | Low | All 4 providers are in-tree; add method to all before building. |
| 3 | T10 accidentally removes sole security boundary test | High — silent regression | Medium | Before deleting any test: grep for tested function, confirm other tests exist. Never delete credential/auth tests without replacement. |
| 4 | T9 logging writes to stdout instead of stderr, corrupting MCP transport | Critical — fleet server breaks | Low | Use `console.error` exclusively. Grep for `console.log` in changed files at verify. |
| 5 | T7 PID race condition — process exits before PID is stored | Medium — stop_prompt still fails for very fast exits | Low | Acceptable: if process exits before first data chunk, stop_prompt is unnecessary. `clearStoredPid` on close handles cleanup. |

---

## Key Constraints

1. **T7:** PID must be extracted from stdout data events in the stream handler, NOT after promise resolution. The `FLEET_PID:` line must be parsed on the first data chunk.
2. **T8:** New `permissionModeAutoFlag(): string | null` method must be added to the `ProviderAdapter` interface and implemented by all 4 providers (claude, gemini, codex, copilot).
3. **T9:** All logging via `console.error` (stderr). Mask `{{secure.*}}` and `sec://` patterns before logging.
4. **T10:** Never delete a test that is the sole proof of a security boundary. Re-run full suite after audit — 0 failures required.
5. **No regressions:** Every phase ends with `npm run build && npm test` passing.
