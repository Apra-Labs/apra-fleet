# Review: `fix(windows): emit Claude CLI PID not PowerShell PID in pidWrapWindows`

**Commit:** `b238154`
**Branch:** `sprint/session-lifecycle-oob-fix`
**Verdict:** APPROVED — 1 advisory finding, 0 blocking

---

## Checklist

### 1. stdout flow — Does `-NoNewWindow` without `-RedirectStandardOutput` cause Claude's stdout to be inherited?

**PASS.** `-NoNewWindow` causes `Start-Process` to attach the child to the parent's console. Since neither `-RedirectStandardOutput` nor `-RedirectStandardError` is specified, the child inherits the parent's stdout/stderr handles. Fleet's `execCommand` reads from the PowerShell process's stdout, and Claude's output flows through the shared console to that same handle. This is the documented PowerShell behavior: `-NoNewWindow` + no redirects = inherited console I/O.

### 2. Argument escaping — Is `argList.replace(/'/g, "''")` sufficient?

**PASS with advisory.** The argList is wrapped in PowerShell single quotes (`'...'`). Inside PS single-quoted strings, `''` is the only required escape (single quote → doubled). Spaces, backslashes, double quotes, equals signs, dollar signs — all pass through verbatim. This is correct.

**Advisory (A1):** The prompt literal from `headlessInvocation` wraps its content in double quotes (`-p "Your task is described in..."`). These double quotes are inside the outer single-quoted `-ArgumentList`. PowerShell's `Start-Process -ArgumentList` passes the string to `CreateProcess` as-is, so the double quotes are preserved at the Win32 level. However, if a prompt file name ever contained a single quote (e.g. `task's.md`), the `escapeWindowsArg` on `folder` does not cover `promptFile`, and `headlessInvocation` embeds it raw. The single-quote escaping in `pidWrapWindows` would catch it at the outer layer, but the inner double-quoted string in `-p "..."` would contain a literal `''` which the CLI would see as two single quotes. **Risk: negligible** — prompt files are fleet-controlled `.fleet-task.md`, never user-named with quotes. No action needed.

### 3. `provider.cliCommand('')` — Is this reliable across all providers?

**PASS.** All four providers (Claude, Gemini, Codex, Copilot) implement `cliCommand(args)` as `` `<exe> ${args}` ``. Calling with `''` returns `"<exe> "` (trailing space). The `.trim()` call strips it, yielding the bare executable name. This works for all providers. The `.trim()` is load-bearing and intentional.

### 4. WaitForExit with no timeout — acceptable?

**PASS.** Fleet's `execCommand` wraps the outer SSH/local spawn with `timeout_ms` and `max_total_ms`. If Claude hangs, the outer timer fires, kills the PowerShell process (via the stored PID's parent or SSH channel teardown), which terminates WaitForExit. Adding a timeout inside PowerShell would create a second competing timer with unclear semantics. The current design correctly delegates timeout responsibility to the fleet orchestration layer.

### 5. taskkill /T correctness — does the full subtree die?

**PASS.** `taskkill /F /T /PID <claude-pid>` performs a Win32 `TerminateProcess` on the target and all processes in its process tree. This works for standard child processes. The one edge case — children that called `CreateProcess` with `CREATE_NEW_PROCESS_GROUP` — is not relevant here: Claude's child processes (bash.exe, node workers) don't create new process groups. The fix correctly targets the Claude PID (not the PowerShell PID), so `/T` now traverses Claude's actual subtree instead of an already-exited PowerShell's empty tree.

### 6. Test coverage — 22 new tests, any gaps?

**PASS.** `tests/windows-pid-wrap.test.ts` has 22 tests covering:
- PID output format (2 tests): marker format, `$_fleet_proc.Id` vs `$PID`
- Structure (6 tests): Start-Process, -PassThru, -NoNewWindow, WaitForExit, ExitCode, variable name
- No $PID regression (4 tests): raw function + 3 `buildAgentPromptCommand` unattended variants
- Unattended modes (4 tests): false, auto, dangerous, undefined — correct flags in ArgumentList
- Working directory (2 tests): Set-Location present and ordered before Start-Process
- Env var setup (2 tests): PATH before Start-Process, `-FilePath "claude"` present
- Updated tests in `tests/unit/pid-wrapper.test.ts` (6 updated tests): new signature, `$_fleet_proc.Id`, Start-Process structure, WaitForExit, ordering, content inclusion

**Minor gap noted:** No test asserts the full argList content (e.g., that `-p "Your task is described..."`, `--output-format json`, `--max-turns 50` all appear together). Tests check permission flags and structural ordering but not the core headless invocation flags. This is a pre-existing gap (the old tests didn't check this either) and not a regression from this commit.

### 7. Full test suite

**PASS.** `npm run build` succeeds (tsc clean). `npm test` passes:
- **60 test files passed** (60 total)
- **1006 tests passed**, 6 skipped, 0 failures
- Duration: 20.59s

### 8. No regression on non-Windows

**PASS.** `git diff b238154~1..b238154` shows changes only in:
- `src/os/windows.ts`
- `tests/unit/pid-wrapper.test.ts`
- `tests/windows-pid-wrap.test.ts` (new file)

`src/os/linux.ts` and `src/os/macos.ts` are untouched. `pidWrapUnix` is unchanged. `MacOSCommands extends LinuxCommands` without overriding `buildAgentPromptCommand`. The refactoring is cleanly isolated to the Windows code path.

---

## Summary

The fix correctly solves the orphaned-process bug. The old code emitted PowerShell's `$PID`, which was useless once PowerShell exited. The new code uses `Start-Process -PassThru` to get Claude's actual PID, making `taskkill /F /T /PID` effective. stdout inheritance via `-NoNewWindow` is correct, argument escaping is sound for the actual argument values that flow through, and the `WaitForExit()` without timeout is appropriate given fleet's outer timeout layer. Test coverage is thorough with 22 new targeted tests. Build and full suite pass clean.
