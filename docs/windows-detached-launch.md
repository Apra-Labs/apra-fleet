<!-- llm-context: How Windows background processes (the MCP server, the fleet-sprint
     supervisor) are launched detached with no visible console window, and the
     Win32_Process Create mechanics that make it work. -->
<!-- keywords: Windows, detached process, SW_HIDE, CREATE_NO_WINDOW, Win32_Process,
     Win32_ProcessStartup, WMI, hidden launch, cmd.exe quoting -->
<!-- see-also: cross-shell-command-construction.md (wrapPowerShellEncoded), transport-and-service-mode.md -->

# Windows detached, hidden-window process launch

## Problem this solves

Every ad hoc attempt to background a process on Windows via hand-rolled
`Invoke-CimMethod Win32_Process.Create` PowerShell tends to reinvent quoting and
window-visibility handling from scratch, and gets it wrong in one of two ways: a
visible `cmd.exe` console window is left on the user's desktop (alarming and
unexplained to a user who never asked for a terminal), or a raw interpolated
PowerShell one-liner gets silently mangled by `cmd.exe`'s own quote-stripping rules
before it ever reaches PowerShell's parser, causing the launch to fail with no clear
signal why.

## The standardized helper

A single helper builds and (optionally) executes the `Win32_Process.Create` launch
command, so every Windows-bound background-process launch goes through one place
instead of being improvised per call site:

- **Mechanism:** `Win32_Process.Create` with a `Win32_ProcessStartup` CIM instance
  carrying `ShowWindow`. WMI maps `ShowWindow` onto the native `STARTUPINFO`
  structure's `wShowWindow` field and implicitly sets the `STARTF_USESHOWWINDOW`
  flag -- there is no separate flag to set by hand. `ShowWindow = SW_HIDE` (0) plus
  `CreateFlags = CREATE_NO_WINDOW` is the entire hidden-window contract; no
  `DETACHED_PROCESS` flag is added on top because it conflicts and is unnecessary --
  a `Win32_Process` child is parented to the WMI provider host process, which already
  outlives the launching process (or SSH channel) that requested it.
- **Hidden is the default, not an opt-in.** A caller must explicitly opt out
  (`showWindow: true`) to get a visible window; that opt-out path also takes an
  explicit console title so a user who does see the window can identify what it is
  and that closing it kills the service.
- **Command transmission always goes through the base64 `-EncodedCommand` wrapper**
  (see `cross-shell-command-construction.md`), never a raw interpolated PowerShell
  string -- that raw-interpolation approach is exactly what `cmd.exe`'s quote-stripping
  destroyed in the ad hoc attempts this helper replaces.
- **Output redirection:** `Win32_Process.Create` cannot redirect handles itself, so
  the real child is wrapped in `cmd.exe /c "<child> > <logfile> 2>&1"`. This is a
  deliberate, surfaced trade-off, not an oversight: the PID handed back to the caller
  is the `cmd.exe` wrapper's PID, not the child's. This is safe for liveness checks
  and termination because the wrapper owns the real child directly -- it exits when
  the child exits, and killing the wrapper's process tree (`taskkill /F /T`) takes the
  child with it.
- **Every path passed to the helper is resolved by the caller in JavaScript before
  the command is built.** Nothing in the emitted script relies on shell-side
  expansion (`~`, `$HOME`, backticks, `%VAR%`) -- consistent with the general
  cross-shell command-construction invariant.
- **Failures are returned as a structured result, never thrown.** A non-zero exit,
  or output that doesn't contain the expected PID marker, comes back as
  `{ ok: false, error, stderr, returnValue }` with the raw PowerShell stderr
  preserved and (when present) the `Win32_Process.Create` `ReturnValue` code parsed
  out (`2` = access denied, `9` = path not found, `21` = invalid parameter) -- callers
  can branch on the specific cause instead of only knowing "it failed."

## Known limitation, not yet closed out

The helper itself is a self-contained, unit-tested building block. Two things a
caller building on it should be aware of:

1. Routing every Windows background-process launch site (the MCP server process,
   the fleet-sprint supervisor process) through this single helper, and documenting
   the one supported launch command in the deploy runbook so launch mechanics are no
   longer improvised per session, is a separate integration step from the helper's
   existence -- verify call sites actually use it before assuming ad hoc
   `Invoke-CimMethod`/`Start-Process` launches have been fully retired.
2. The nested-quote handling in the `cmd.exe /c "<child> > <logfile> 2>&1"` wrapper
   is exactly the class of bug this helper was built to eliminate, and by its nature
   cannot be fully validated by code review or unit tests that mock the executor --
   it needs to be exercised against a real `cmd.exe`/PowerShell pair on a live
   Windows machine before being treated as fully proven.
