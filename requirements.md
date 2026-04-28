# PR #183 — Remaining Work Requirements

**Branch:** `sprint/session-lifecycle-oob-fix`
**Latest commit:** `2cd8465`
**Sources:** `feedback.md` (skill file review), `docs/reviews/feedback-b238154.md` (fix commits review), direct code analysis

---

## T1 — FIX (BLOCKING): SKILL.md unattended='auto' provider table

**File:** `skills/fleet/SKILL.md:192`
**Source:** `feedback.md` — blocking finding, not yet fixed

### Problem

Line 192 currently reads:

> `unattended='auto'` does not add any CLI flag. Auto-approval is delivered via config files written by `compose_permissions` — call it before every dispatch.

This is factually wrong for two of four providers. Verified against source:

| Provider | `'auto'` actual behaviour | Source file |
|----------|--------------------------|-------------|
| Claude | Adds `--permission-mode auto` | `src/providers/claude.ts:42-43` |
| Gemini | No flag (config-file only via `compose_permissions`) | `src/providers/gemini.ts:39` |
| Codex | Adds `--ask-for-approval auto-edit` | `src/providers/codex.ts:40-41` |
| Copilot | Warns "not supported", runs interactively — no flag | `src/providers/copilot.ts:44-45` |

The blanket claim is only true for Gemini. Additionally, Copilot's complete lack of unattended support is not mentioned anywhere in the unattended section.

### Fix

Replace the blanket statement at SKILL.md:192 with a provider table:

```markdown
`unattended='auto'` behaviour is provider-specific:

| Provider | `'auto'` flag | `'dangerous'` flag |
|----------|--------------|-------------------|
| Claude | `--permission-mode auto` | `--dangerously-skip-permissions` |
| Gemini | None (config-file only via `compose_permissions`) | `--yolo` |
| Codex | `--ask-for-approval auto-edit` | `--sandbox danger-full-access --ask-for-approval never` |
| Copilot | ⚠️ Not supported — warns and runs interactively | ⚠️ Not supported |
```

After this fix, the Gemini-specific implementation detail in `doer-reviewer.md:10` can be simplified to a cross-reference (see T4).

---

## T2 — FIX (NON-BLOCKING): Add `credential_store_update` to SKILL.md tools table

**File:** `skills/fleet/SKILL.md:34-36`
**Source:** `feedback.md` — non-blocking finding

### Problem

The Core Fleet Tools table lists `credential_store_set`, `credential_store_list`, `credential_store_delete` but omits `credential_store_update`, even though:
- Tool implemented in commit `08d0273`
- Registered as MCP tool at `src/index.ts:201`
- Already referenced in prose at SKILL.md:70

A PM reading the tools table would not know this tool exists.

### Fix

Add the following row to the Core Fleet Tools table after `credential_store_delete`:

```markdown
| `credential_store_update` | Update credential metadata (members, TTL, network policy) without re-entering the secret |
```

---

## T3 — FIX (NON-BLOCKING): Document Copilot unattended limitation in SKILL.md

**File:** `skills/fleet/SKILL.md:182-202`
**Source:** `feedback.md` — non-blocking finding

### Problem

The unattended modes section makes no mention that Copilot does not support unattended operation at all. A PM dispatching to a Copilot member with `unattended='auto'` will get a console warning and an interactive session — the prompt will hang waiting for user input rather than failing with a clear error.

Verified: `src/providers/copilot.ts:43-47` — both `'auto'` and `'dangerous'` paths emit `console.warn` and add no CLI flags.

### Fix

Add a note to the unattended section — either as a callout block or a row in the provider table from T1 (the ⚠️ column already covers this if T1 is implemented together).

---

## T4 — CLEANUP (ADVISORY): Remove Gemini mechanic from doer-reviewer.md

**File:** `skills/pm/doer-reviewer.md:10`
**Source:** `feedback.md` — advisory finding

### Problem

Line 10 reads:
> "For Gemini members, auto-approval is delivered entirely by `compose_permissions` (no CLI flag is added for `auto` mode)"

This is a provider implementation detail that belongs in SKILL.md, not the PM orchestration doc. The PM doc should describe *what to do* (compose thoroughly before dispatch), not *how the flag is applied internally*.

### Fix

Once T1 is done (provider table in SKILL.md), simplify doer-reviewer.md:10 to a cross-reference:
> "For provider-specific `unattended` flag behaviour, see SKILL.md unattended modes section."

---

## T5 — CLEANUP (ADVISORY): Fix sub-bullet formatting in doer-reviewer.md

**File:** `skills/pm/doer-reviewer.md:8-11`
**Source:** `feedback.md` — advisory finding

### Problem

Lines 9-11 are intended as sub-bullets under checklist item 4 but are formatted as top-level dashes. Line 11 also concatenates two unrelated instructions: the `unattended` preference and the `context-file.md`/planning-phase note.

### Fix

Indent lines 9-11 as sub-bullets under item 4 and split line 11 into two separate items.

---

## T6 — FIX (ADVISORY): Quote `${credFile}` in linux.ts shell commands

**File:** `src/os/linux.ts:211, 219`
**Source:** `docs/reviews/feedback-b238154.md` — advisory A1

### Problem

`credFile` is interpolated bare (unquoted) into shell strings:

```typescript
// line 211
return `printf '...' > ${credFile} && chmod 600 ${credFile} && chmod +x ${credFile} && ...`;

// line 219
return `rm -f ${credFile} && git config ...`;
```

With the label regex (`/^[a-zA-Z0-9_-]{1,64}$/`) in place, no metacharacters can reach these paths — so this is **not exploitable today**. However, it is not defense-in-depth: if the regex is ever relaxed or bypassed by a future internal caller, the unquoted interpolation becomes a shell injection vector.

### Fix

Wrap all `${credFile}` occurrences in double quotes in the returned shell strings:

```typescript
// line 211
return `printf '...' > "${credFile}" && chmod 600 "${credFile}" && chmod +x "${credFile}" && ...`;

// line 219
return `rm -f "${credFile}" && git config ...`;
```

Note: `credFile` is constructed as `~/.fleet-git-credential-${escaped}` where `escaped` uses `escapeDoubleQuoted()` — double-quoting the outer path is safe and correct.

---

## T7 — BUG (CRITICAL): `stop_prompt` is broken cross-platform — PID stored after process exits

**Files:** `src/services/strategy.ts:15-23, 44, 178`, `src/utils/agent-helpers.ts:72-87`
**Source:** Direct code analysis — verified against current code

### Problem

`stop_prompt` calls `getStoredPid(agent.id)` to find the running LLM process PID. This always returns `undefined` for any active session, making `stop_prompt` a no-op that reports "no active session was running" even when Claude processes are clearly running.

**Root cause:** `extractAndStorePid()` is called at the end of `execCommand()` in both strategies, **after the Promise resolves** — i.e., after the child process has already exited:

```typescript
// strategy.ts:15-23 — extractAndStorePid
export function extractAndStorePid(agentId: string, result: SSHExecResult): SSHExecResult {
  const lines = result.stdout.split('\n');        // stdout is complete — process is DEAD
  const idx = lines.findIndex(l => /^FLEET_PID:\d+\r?$/.test(l));
  if (idx === -1) return result;
  const pid = parseInt(...);
  setStoredPid(agentId, pid);                     // stored too late — no use for killing
  ...
}

// strategy.ts:178 — LocalStrategy.execCommand
return extractAndStorePid(this.agent.id, result); // called AFTER child.on('close')
```

The `FLEET_PID:<pid>` line IS correctly emitted as the first stdout line by `pidWrapWindows`/`pidWrapUnix`, but it is accumulated in a string buffer and only parsed after the process exits. By the time `_activePids` is populated, there is nothing to kill.

This affects all platforms — local and SSH. The SSH strategy has the same design.

### Fix

Parse `FLEET_PID:` from the **stdout data stream in real-time**, not from the buffered result.

**For `LocalStrategy` (`strategy.ts`):** In the `child.stdout.on('data', ...)` handler, scan each incoming chunk for the `FLEET_PID:` line and call `setStoredPid()` immediately upon first match:

```typescript
let pidExtracted = false;
child.stdout?.on('data', (data: Buffer) => {
  resetInactivityTimer();
  const chunk = data.toString();
  if (!pidExtracted) {
    const match = chunk.match(/^FLEET_PID:(\d+)\r?$/m);
    if (match) {
      setStoredPid(this.agent.id, parseInt(match[1], 10));
      pidExtracted = true;
    }
  }
  // existing buffering logic ...
});
```

**For `RemoteStrategy` (SSH):** Equivalent streaming extraction in the SSH stdout data handler in `src/services/ssh.ts`.

**Cleanup:** Verify that `clearStoredPid(agent.id)` is called on process exit/kill in both strategies' `close`/`error` handlers so stale entries don't accumulate.

**Logging:** Add a `console.error` (stderr — visible in fleet server logs) when the PID is stored:
```typescript
console.error(`[fleet] stored PID ${pid} for agent ${agentId}`);
```
This lets operators validate PID tracking is working without instrumenting the kill path.

---

## T8 — BUG: `windows.ts` hardcodes Claude's `--permission-mode auto` for all providers

**File:** `src/os/windows.ts:124-128`
**Source:** Direct code analysis — verified against current code

### Problem

`buildAgentPromptCommand` in `windows.ts` hardcodes the Claude-specific flag for `unattended='auto'`:

```typescript
if (unattended === 'auto') {
  argList += ' --permission-mode auto';          // Claude-only flag, applied to ALL providers
} else if (unattended === 'dangerous') {
  argList += ` ${provider.skipPermissionsFlag()}`; // correctly delegates for 'dangerous'
}
```

`linux.ts` correctly delegates the entire command construction to `provider.buildPromptCommand(opts)`. On Windows, a Codex member with `unattended='auto'` receives `--permission-mode auto` (unrecognised by Codex) instead of `--ask-for-approval auto-edit`. Gemini and Copilot members on Windows are also affected.

### Fix

Introduce `provider.permissionModeAutoFlag(): string | null` returning the provider-specific flag for `auto` mode (or `null` if not applicable), and call it from `windows.ts`:

```typescript
if (unattended === 'auto') {
  const flag = provider.permissionModeAutoFlag();
  if (flag) argList += ` ${flag}`;
} else if (unattended === 'dangerous') {
  argList += ` ${provider.skipPermissionsFlag()}`;
}
```

Each provider implements:
- Claude: returns `'--permission-mode auto'`
- Codex: returns `'--ask-for-approval auto-edit'`
- Gemini: returns `null` (config-file only)
- Copilot: returns `null` + logs warning

---

## T9 — FEATURE: Structured logging for execute_prompt and execute_command

**Files:** `src/tools/execute-prompt.ts`, `src/tools/execute-command.ts`, `src/services/strategy.ts`
**Source:** New requirement

### Problem

Fleet server logs currently have no way to correlate an `execute_prompt` or `execute_command` call to the actual prompt/command content or the spawned process PID. When debugging issues like orphaned processes or unexpected behaviour, operators have no trail to follow.

Additionally, T7's fix surfaces the LLM provider PID for the first time mid-execution — that PID should be logged immediately when captured so it can be matched against OS process listings.

### Fix

**`execute_prompt` logging** — at call entry (before spawning), emit to stderr:

```
[fleet] execute_prompt agent=<friendlyName> prompt="<first 80 chars, newlines → spaces>..."
```

When the `FLEET_PID:<pid>` line is captured from the stream (as part of the T7 fix), immediately emit:

```
[fleet] execute_prompt agent=<friendlyName> LLM_PID=<pid> (local|ssh:<host>)
```

On process exit, emit:

```
[fleet] execute_prompt agent=<friendlyName> LLM_PID=<pid> exit=<code> elapsed=<ms>ms
```

**`execute_command` logging** — at call entry, emit to stderr:

```
[fleet] execute_command agent=<friendlyName> cmd="<first 80 chars, newlines → spaces>..."
```

For local execution, when the child process is spawned (`child.pid` is available immediately), emit:

```
[fleet] execute_command agent=<friendlyName> PID=<child.pid> (local)
```

For SSH execution, emit:

```
[fleet] execute_command agent=<friendlyName> host=<host> (ssh)
```

**Implementation notes:**
- Use `console.error` (stderr) — fleet runs as an MCP server so stdout is the MCP transport. Stderr is the correct observability channel.
- Truncate prompt/command to 80 characters and replace newlines/tabs with spaces for single-line log entries.
- Helper: `function logLine(tag: string, msg: string) { console.error(`[fleet] ${tag} ${msg}`); }`
- Do not log credential values — any text matching `{{secure.*}}` or `sec://` references must be masked as `[REDACTED]` before logging.

---

## T10 — REFACTOR: Test suite audit — remove dead, overlapping, and irrelevant tests

**Files:** `tests/` (all test files)
**Source:** New requirement

### Problem

The test suite has grown to 1000+ cases across many sprints. With it has come dead weight: tests for removed code, tests that duplicate each other at different abstraction levels, tests that assert on implementation details rather than behaviour, and placeholder tests that were never completed. The result is a suite that is slow to run, hard to scan for coverage gaps, and gives false confidence — bugs slip through despite 1000+ passing tests.

### Approach

Read every test file. For each test or describe block, classify it:

**Delete if:**
- It tests a function, field, or schema entry that no longer exists in the codebase (e.g. `activePid`, `dangerouslySkipPermissions` as a functional field)
- It duplicates another test at the same abstraction level with no additional coverage (copy-paste variations that add no new scenario)
- It is a placeholder with an empty body, a `// TODO`, or a `console.log` assertion
- It tests internal implementation details that are not part of any public contract (e.g. exact internal Map key names, private function signatures) — these break on refactors and add no value
- It tests the behaviour of a mock rather than the real code (mock returns X, assert X — circular)

**Consolidate if:**
- Multiple tests assert the same boundary condition with slight input variations that could be expressed as a parameterised table test
- Setup/teardown is duplicated across describe blocks within the same file

**Keep if:**
- It is the sole test proving a specific behaviour exists (even if awkwardly written — rewrite rather than delete)
- It is an integration test wiring real components end-to-end (high value, keep even if slow)
- It covers a security boundary (credential scoping, TTL rejection, label injection, member identity) — these must never be thinned

**After audit:**
- Re-run the full suite and confirm 0 failures
- Report: tests removed, tests consolidated, net reduction, and any coverage gaps found during the audit that need new tests added

### Priority areas to check first

Based on known sprint history:

1. **`credential-scoping-ttl.test.ts`** — grew to 17+ tests across two sprints; likely has overlap between scoping tests and TTL tests that share the same setup
2. **`unattended-mode.test.ts`** — 16 tests added in Sprint 2; check for tests that only verify mock call counts rather than actual flag output
3. **`vcs-isolation.test.ts`** — 7 tests; verify none are testing the old single-file credential path that was replaced
4. **`execute-prompt.test.ts`** — check for tests referencing `dangerouslySkipPermissions` as a functional field (now removed) or `activePid` (also removed)
5. **Windows-specific tests** — 4 tests added; check if any are now superseded by the `pidWrapWindows` fix or the `ProcessStartInfo` change

---

## Summary

| # | Item | Severity | File(s) |
|---|------|----------|---------|
| T1 | SKILL.md unattended='auto' provider table | **Blocking** | `skills/fleet/SKILL.md:192` |
| T2 | Add `credential_store_update` to tools table | Non-blocking | `skills/fleet/SKILL.md:34-36` |
| T3 | Document Copilot unattended limitation | Non-blocking | `skills/fleet/SKILL.md:182-202` |
| T4 | Remove Gemini mechanic from doer-reviewer.md | Advisory | `skills/pm/doer-reviewer.md:10` |
| T5 | Fix sub-bullet formatting in doer-reviewer.md | Advisory | `skills/pm/doer-reviewer.md:8-11` |
| T6 | Quote `${credFile}` in linux.ts shell strings | Advisory | `src/os/linux.ts:211,219` |
| T7 | `stop_prompt` broken — PID stored after process exits | **Critical Bug** | `src/services/strategy.ts`, `src/utils/agent-helpers.ts` |
| T8 | `windows.ts` hardcodes Claude flag for all providers in `unattended='auto'` | **Bug** | `src/os/windows.ts:124-128` |
| T9 | Structured logging for execute_prompt and execute_command | Feature | `src/tools/execute-prompt.ts`, `src/tools/execute-command.ts`, `src/services/strategy.ts` |
| T10 | Test suite audit — remove dead, overlapping, irrelevant tests | Refactor | `tests/` |

T7 and T8 are code bugs with no existing fix commits. T1–T6 are open findings from formal code reviews. T9–T10 are new requirements.
