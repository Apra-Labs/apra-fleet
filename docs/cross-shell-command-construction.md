# Cross-shell command construction for member-bound commands

> **Note on granularity**: this document frames every branch point as
> `agent.os` (POSIX vs PowerShell), which was accurate when it was written.
> A member now also carries a registered `shell` (`gitbash | pwsh7 |
> powershell5` on Windows), which is finer-grained than `os` -- a Windows
> member whose registered shell is `gitbash` is a POSIX command-construction
> target, not a PowerShell one. New or updated call sites should branch on
> the registered shell (via `isPosixShell(os, shell)`) rather than on `os`
> alone. See
> [docs/windows-shell-selection.md](windows-shell-selection.md) for the
> probe design and the shell-vs-os distinction in full.

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

**This applies even to wrappers that exist to serve a `gitbash` member.** A
member registered with `shell: 'gitbash'` still has some of its host-side
work executed as a PowerShell script body -- for example, anything built on
`Invoke-CimMethod`/`Win32_Process`, which is a Windows host-management
mechanism with no POSIX equivalent, invoked in PowerShell regardless of
which shell the target member itself runs. Any helper that emits such a
script must still carry the full `$ErrorActionPreference = 'Stop'` +
try/catch + `$LASTEXITCODE`/`exit 0` envelope described above. An unguarded
`powershell -EncodedCommand <base64>` invocation runs under PowerShell's
default `Continue` mode and can exit 0 on a non-terminating error --
precisely the false-success class this pattern exists to eliminate,
regardless of which member shell the surrounding feature is nominally
"for."

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

## `curl` on Windows is a PowerShell alias, not the real binary

A command builder that emits a bare `curl ...` invocation works on a POSIX
member but silently resolves to PowerShell's `Invoke-WebRequest` alias on a
Windows member, which does not accept the same argument syntax (flags like
`-sS`, `-d @-`, header repetition, etc. are not compatible). The fix is not a
new abstraction -- it is to have the command builder emit `curl.exe`
explicitly whenever the target is Windows, which bypasses the alias and
reaches the real curl binary bundled with modern Windows. As with every
other OS-branch in this document, the OS value must be threaded through from
the *actual* production resolution path (the same place that already
resolves a member's OS for other purposes) and not just supplied by a test
fixture -- a builder that only receives `os` in its test harness but never
in its real caller is an unfixed bug wearing a passing test.

## PowerShell object-merge pitfalls: `Hashtable` vs `PSCustomObject`

A recursive JSON deep-merge implemented in PowerShell has two distinct traps
that look like the same bug but need different fixes:

- **`.Contains()` is a `Hashtable` method, not a `PSCustomObject` one.**
  `ConvertFrom-Json` produces `PSCustomObject` instances by default, so a
  merge routine written against `Hashtable` semantics throws (or silently
  misbehaves) the moment it walks into a nested object read from JSON.
  Convert the target to a `Hashtable` (recursively, before merging into it)
  rather than assuming the parsed JSON already has the shape the merge code
  expects.
- **Seeding the merge accumulator as an empty `Hashtable` before any keys
  are known leaks Hashtable-internal metadata keys into the final written
  JSON.** Start the accumulator as `$null` and only materialize it as a real
  Hashtable once actual content exists to merge into it, so the
  serialized-back-to-JSON result contains only the caller's own keys.

Both fixes are exercised by a live PowerShell process (not a string-matching
unit test), since the bug only manifests through PowerShell's real object
model and JSON cmdlets -- a test that mocks or hand-simulates PowerShell
semantics can pass while the real interpreter still throws or corrupts
output.

## A Windows script builder must be extracted, not hand-duplicated in tests

When a Windows-bound script gets non-trivial (e.g. a multi-step delete-files
routine), factor the script-string construction into its own exported
function and have the live-PowerShell test call that function directly,
rather than hand-copying an equivalent script inline in the test. A
hand-copied duplicate silently drifts from the real implementation the
moment either side changes, so a "passing" test can stop being evidence
about the production code path. Exercising the real, exported builder
closes that drift risk structurally instead of relying on someone
remembering to keep the two copies in sync.

## A platform-gated live-shell test suite needs positive proof it actually ran

A test suite that is conditionally skipped based on real platform/tool
availability (e.g. only running live PowerShell assertions when a real
`powershell` binary is present) looks identical in CI output whether it
executed and passed, or was skipped outright -- both show as "no failures."
When reviewing or citing such a suite as evidence a fix works, confirm the
run actually executed (non-trivial test count, non-zero duration, assertions
against real on-disk/process state) rather than trusting a green checkmark
alone. A suite that can silently no-op is not evidence by itself; the
positive-execution signal is what makes it evidence.

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
