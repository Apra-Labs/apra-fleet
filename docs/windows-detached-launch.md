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
- **Binding choice matters, not just the call shape.** `Invoke-CimMethod` against
  `Win32_Process`/`Create` throws a bare `Type mismatch` (`HRESULT 0x80041005`) when an
  embedded `Win32_ProcessStartup` CIM instance is passed via `-Arguments` -- confirmed
  live on a real Windows host. The helper uses the legacy `[wmiclass]` COM binding
  instead, which accepts the same embedded startup-info object and returns
  `ReturnValue=0` with a real PID for the identical logical call. If a future
  refactor is tempted to "modernize" this to `Invoke-CimMethod`/`New-CimInstance`,
  re-verify against a live Windows host first -- this failure mode does not surface
  in a syntax check or a mocked unit test.
- **Hidden is the default, not an opt-in.** A caller must explicitly opt out
  (`showWindow: true`) to get a visible window; that opt-out path also takes an
  explicit console title so a user who does see the window can identify what it is
  and that closing it kills the service.
- **Command transmission always goes through the base64 `-EncodedCommand` wrapper**
  (see `cross-shell-command-construction.md`), never a raw interpolated PowerShell
  string -- that raw-interpolation approach is exactly what `cmd.exe`'s quote-stripping
  destroyed in the ad hoc attempts this helper replaces.
- **Output redirection:** `Win32_Process.Create` cannot redirect handles itself, so
  the real child is wrapped in `cmd.exe /c "<child> >> <logfile> 2>&1"`. Redirection
  uses **append** (`>>`), not truncate (`>`), deliberately matching the POSIX
  fallback launchers and `deploy.md`'s own documented redirection -- a Windows
  relaunch must not destroy the previous instance's log evidence. This is a
  deliberate, surfaced trade-off, not an oversight: the PID handed back to the caller
  is the `cmd.exe` wrapper's PID, not the child's. This is safe for liveness checks
  and termination because the wrapper owns the real child directly -- it exits when
  the child exits, and killing the wrapper's process tree (`taskkill /F /T`) takes the
  child with it.
- **Fails fast on a missing launch target.** Because the real child runs via
  `cmd.exe /c`, and `cmd.exe` itself always exists, a missing target executable
  (e.g. an unresolved `serve.mjs` path) previously came back as `ReturnValue=0`
  with a live wrapper PID -- a silent-death "success" report with nothing in the
  log to explain it. Callers now `fs.existsSync()` the resolved target before
  invoking the helper and return a structured `{ ok: false }` failure when it is
  missing, instead of launching a wrapper doomed to produce an empty log.
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

## Current status

Both the MCP server launcher and the fleet-sprint supervisor launcher route through
this single helper, and `deploy.md` documents the two concrete, copy-pasteable launch
commands instead of leaving the mechanics to be improvised per session. Hand-rolled
`Invoke-CimMethod`/`cmd /c start` launches are no longer an acceptable substitute for
either process.

A live run on a real Windows host confirmed: the process stays alive (PID liveness
via `tasklist`), it has no visible window (`MainWindowHandle 0` / `tasklist /V`
showing `Window Title: N/A`), redirected output reaches the log file on disk, and
`taskkill` teardown leaves no orphaned processes.

## Known limitation, not yet closed out

1. **The hidden-vs-visible discriminator has not been proven live from every kind of
   session.** `Win32_Process.Create` attaches the new process to the *caller's own*
   window station/session. In a non-interactive session (the common case for an
   automated/CI-style shell), a window-visibility check cannot actually discriminate
   a hidden launch from a visible one -- `ShowWindow=0` and `ShowWindow=1` both land
   in a non-interactive session with no window title, so a positive-control test that
   explicitly launches with `showWindow: true` and expects it to be visible will
   self-skip (correctly) rather than produce a false pass. Treat any hidden-launch
   verification run from a non-interactive shell as having proven the negative case
   only (no window when hidden) -- proving the positive-control discriminator (a
   visible-window launch is actually detected as visible) requires a real interactive
   Windows logon (RDP or physical console), not just a live process launch.
2. The nested-quote handling in the `cmd.exe /c "<child> >> <logfile> 2>&1"` wrapper
   is exactly the class of bug this helper was built to eliminate, and by its nature
   cannot be fully validated by code review or unit tests that mock the executor --
   ongoing live verification on a real Windows host (not just the sandbox environment
   used for CI) is the only way to keep confidence in it.
