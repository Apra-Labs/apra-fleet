# Cross-shell command construction for member-bound commands

## The invariant

Any command string sent to a fleet member over the exec transport
(`strategy.execCommand`, `execute_command`, or a tool that builds one of these
strings directly) must not rely on shell-level variable expansion, path
syntax, or control flow that is specific to one shell family. A member's
remote shell is not guaranteed to be POSIX (bash/sh) -- it can be PowerShell
on Windows, and the two interpret the same-looking tokens differently:

- A bare `$HOME/...` or `$VAR` path is POSIX variable expansion. PowerShell
  either parses `$HOME` as an automatic variable with different semantics, or
  fails outright when the following `/` is not a valid operator position
  (`ParserError: You must provide a value expression following the '/'
  operator`).
- On at least one real Windows member, the SSH exec transport has been
  observed to silently *strip* bare `$name` tokens out of the command string
  before a nested `powershell -c` invocation ever parses it -- so the failure
  mode is not always a loud parse error; it can be silent corruption of the
  command.
- POSIX-only utilities used inline (`sed`, `xargs`, `tail`, `cat ... ||
  echo`) have no equivalent on a PowerShell target and must be branched,
  not translated in place.

**The fix pattern, in order of preference:**

1. Resolve any host/path value to a concrete, OS-appropriate string in JS
   *before* building the command (mirrors how path resolution is already
   done host-side elsewhere rather than shell-side). Prefer this whenever
   the value is known ahead of dispatch.
2. When step 1 isn't possible (the value only exists on the remote side, or
   the operation itself is OS-specific), branch the command construction
   explicitly on `agent.os` and build two independent command strings -- one
   POSIX, one PowerShell -- rather than trying to write one "portable"
   one-liner. Every call site touched by this pattern (credential file
   reads, remote log/status/pid inspection, remote tail, authorized_keys
   cleanup) took this branching approach.

A POSIX-only feature that has no Windows equivalent (e.g. the long-running
task wrapper, which is a bash script using `nohup`/`chmod +x`/backgrounding)
must hard-fail with a surfaced error on Windows members rather than silently
warn-and-attempt. An advisory warning that the caller can ignore is a false
success: the caller has no reliable signal that the operation didn't happen.
Hard-failing before any registration/bookkeeping side effect occurs (e.g.
before minting a task id) avoids leaving orphaned state behind.

## `wrapPowerShellEncoded`: the standard way to send a PowerShell script

All Windows member-bound PowerShell scripts should be sent through a single
helper that base64-encodes the script as a `-EncodedCommand` invocation
(`powershell -EncodedCommand <base64>`), rather than composed ad hoc, for two
reasons:

1. **Encoding avoids quoting/escaping bugs entirely.** A raw PowerShell
   one-liner passed as a shell argument is fragile across quoting layers
   (the exec transport's own shell, then PowerShell's own parser). Base64
   `-EncodedCommand` sidesteps that: the script is transmitted as opaque
   data and decoded by PowerShell itself, so there is no intermediate
   shell-quoting step to get wrong.
2. **Exit-code semantics need to be forced, not assumed.** `powershell.exe`
   only reports a non-zero process exit code on a *terminating* error. A
   non-terminating error (e.g. `Set-Content` hitting access-denied, or a
   cmdlet erroring under the default `$ErrorActionPreference = 'Continue'`)
   writes to the error stream but the process still exits 0 -- callers that
   check only the exit code get a false "succeeded" result. The wrapper
   forces `$ErrorActionPreference = 'Stop'` for the duration of the script
   and re-throws any caught error via `exit 1`, converting non-terminating
   errors into terminating (and therefore visible) ones.
   - A trailing `exit 0` is required inside the `try` block. Without it,
     `powershell.exe`'s own exit code falls back to `$?` of the last
     statement, which PowerShell sets to `$false` whenever *any* error
     record was written to the error stream during the session -- even one
     that was intentionally suppressed via `-ErrorAction SilentlyContinue`
     on an individual cmdlet. Without the explicit `exit 0`, every
     intentionally-tolerated failure (e.g. deleting a file that's already
     gone) would surface as a false non-zero exit.
   - Call sites that intentionally tolerate a failure on a specific cmdlet
     (e.g. delete-if-exists) pass `-ErrorAction SilentlyContinue` on that
     individual cmdlet, which overrides the wrapper's global `Stop`
     preference for that one call while leaving everything else covered.

Every Windows-bound PowerShell script construction site should route through
this helper rather than hand-rolling its own base64/`-EncodedCommand`
wrapping, so the exit-code and quoting guarantees stay centralized in one
place instead of drifting per call site.

A concrete instance of the hazard this section warns about: the member-home
directory probe used to build its Windows `USERPROFILE` lookup as a raw
inline string (`powershell -NoProfile -c "...$env:USERPROFILE..."`), relying
on the *outer* exec shell to leave `$env:USERPROFILE` untouched inside the
double quotes so the inner `powershell -c` could expand it itself. On a
member whose own default exec shell is also PowerShell, the outer shell
expands the variable during its own tokenization before the inner
`powershell -c` invocation ever sees it, producing a bare, unquoted path
token -- a PowerShell syntax error. This reproduces the same defect class
described above (relying on shell-level expansion in a member-bound command
string) and was fixed by routing that probe through `wrapPowerShellEncoded`
like every other Windows-targeting invocation, rather than inventing a
probe-specific workaround.

## OS-detection caching pitfall

Member OS detection results should only be cached on a successful,
authoritative detection. Caching a fallback/guessed value (e.g. "assume
linux when detection failed") and reusing it on subsequent calls silently
locks a member into the wrong OS branch for the rest of its session, even
after a later call could have detected the real OS correctly. Detection
failures should be retried on the next call rather than memoized.

## Two other one-off pitfalls worth generalizing

- **Avoid intermediate `$variable` assignment inside a single-line remote
  PowerShell command**, even when passed through `-c` rather than
  `-EncodedCommand`, on transports that have shown they may strip bare
  `$name` tokens. Restructure the pipeline to avoid naming an intermediate
  variable at all (e.g. select-and-format directly in the pipeline instead
  of assigning to `$i` and branching on it).
- **A polling pipeline that runs `Get-ChildItem` (or an equivalent
  recursive listing) against a path that does not exist yet** can hang
  rather than fail fast, especially when errors are suppressed. Guard with
  an existence check (`Test-Path`) before the recursive listing so the
  common "not created yet" case returns immediately instead of depending on
  a suppressed-error code path that has been observed to hang.
- **Timestamp formats differ by OS when read back from a remote command.**
  A Windows-side script that emits an ISO-8601 timestamp string needs
  `Date.parse`-style parsing on the caller side, not the whole-seconds
  numeric parsing used for POSIX `stat`/`date` output. Don't assume a single
  numeric-epoch parser covers both branches.

## Where this pattern must be checked when adding a new member-bound command

Any code that builds a command string for `strategy.execCommand` (directly,
or via a tool handler) is a potential instance of this bug class if it:

- embeds `$HOME`, `$VAR`, `~`, or other POSIX-shell expansion syntax in the
  string, or
- invokes a POSIX-only utility (`sed`, `xargs`, `cat ... ||`, `tail`, `nohup`,
  etc.) without a Windows branch, or
- assumes the remote shell behaves like bash regardless of `agent.os`.

New command-construction call sites should resolve the OS-appropriate
command explicitly (via the OS-command abstraction or an explicit `agent.os`
branch) rather than writing one string and hoping it works on every shell.
