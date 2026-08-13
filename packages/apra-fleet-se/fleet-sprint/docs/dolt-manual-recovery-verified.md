# Dolt manual recovery runbook (verified 2026-08-12, all steps live-tested on fleet-win-dev1)

This is the ground-truth procedure for standing up an ephemeral `dolt sql-server`
against a wedged embedded Dolt clone, querying/repairing it, and tearing it back
down -- verified end to end against a real clone on a real member, not written
from docs.

STATUS: this procedure is now AUTOMATED end to end by `settleDoltConflicts()`
(`packages/apra-fleet-se/fleet-sprint/dolt-settle.mjs`), which is the
executable form of this document and runs at both sync divergence terminals --
fleet members self-heal without a human or an LLM. The old Path A / Path B /
Tier 2 ladder and its LLM runbook (`dolt-tier2-runbook.md`) were retired and
deleted; see `dolt-sync-redesign.md`.

This document remains the SPECIFICATION that code encodes, and the human
copy-paste fallback for driving a clone by hand. Every step here was
independently rediscovered by trial and error at least once already (see
apra-fleet-ga61, apra-fleet-5mqg) -- which is exactly why it is written down
and encoded once.

## 0. Precondition: find the REAL data directory. Never hardcode it.

```
bd dolt status
```

Read the `Data:` line from the output (also mirrored in `.beads/metadata.json`'s
`dolt_mode` field). This is bd's own live, authoritative answer for THIS clone,
right now. Do not assume `.beads/embeddeddolt` -- that happens to be bd's
convention today, but a script that hardcodes it and finds a second/different
directory should treat that as orphaned residue from a prior failed recovery
(see apra-fleet-5mqg) and refuse to proceed blind, not silently pick one.

If `bd dolt status` reports `embedded (in-process, no server)`, there is no
live server to route through -- an ephemeral one must be started (step 2). If
it already reports a live server (host:port), skip straight to step 3 and
target that existing server/port instead of starting a second one.

## 1. Ensure the PINNED `dolt` binary is present (never a package manager)

The embedded `bd` binary does NOT ship enough of the Dolt CLI to drive a
merge-conflict resolution over SQL -- that requires the real `dolt` binary and
a real `dolt sql-server` process, temporarily, against the SAME data directory.

CORRECTED 2026-08-13 (`dolt-sync-redesign.md` Part 5, Precondition V2). This
step previously said `winget install --id DoltHub.Dolt` on Windows, plus
`apt`/`brew` on POSIX. That was a genuine mistake and must not be repeated:
winget delivered a STALE 1.86.3 build while this repo carries its own version
pin, so an OS package manager is a second, unpinned version channel -- banned
from every code path and runbook this design owns. It also created a PATH
problem of its own: a winget-installed binary is invisible to processes that
started before the install, which is every SSH-dispatched session.

The fleet's ONE pinned channel is the same GitHub release asset
`src/cli/dolt-install.ts` uses (`DOLT_VERSION`, currently `v2.2.0`), landed at
the fleet-managed path -- always referenced as an absolute path, never system
PATH, and needing no admin rights:

- Windows: `%USERPROFILE%\.apra-fleet\bin\dolt.exe`
- POSIX:   `$HOME/.apra-fleet/bin/dolt`

Probe it first -- existence is not enough, it must actually RUN and report the
pinned version:

```bash
"$HOME/.apra-fleet/bin/dolt" version                        # POSIX
```
```powershell
& "$env:USERPROFILE\.apra-fleet\bin\dolt.exe" version        # Windows
```

If it is missing, broken, or the wrong version, install it from the pinned
asset. `settleDoltConflicts()` does exactly this itself (`ensurePinnedDolt()`
in `dolt-settle.mjs`, design doc Part 5.3) -- members never run
`apra-fleet install`, so nothing else on a member ever puts a pinned dolt
there. By hand, the same sequence is:

**Windows:**
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.apra-fleet\bin" | Out-Null
Invoke-WebRequest -Uri https://github.com/dolthub/dolt/releases/download/v2.2.0/dolt-windows-amd64.zip -OutFile "$env:TEMP\dolt-settle.zip" -TimeoutSec 300
Expand-Archive -Force "$env:TEMP\dolt-settle.zip" "$env:TEMP\dolt-settle"
Get-ChildItem -Recurse -Filter dolt.exe "$env:TEMP\dolt-settle" | Select-Object -First 1 |
  Copy-Item -Force -Destination "$env:USERPROFILE\.apra-fleet\bin\dolt.exe"
```

**Linux / macOS** (swap the asset for `dolt-linux-amd64.tar.gz`,
`dolt-darwin-amd64.tar.gz` or `dolt-darwin-arm64.tar.gz` to match the member):
```bash
mkdir -p "$HOME/.apra-fleet/bin"
curl -fL --max-time 300 https://github.com/dolthub/dolt/releases/download/v2.2.0/dolt-linux-amd64.tar.gz -o /tmp/dolt-settle.tgz
mkdir -p /tmp/dolt-settle && tar -xzf /tmp/dolt-settle.tgz -C /tmp/dolt-settle
install -m 0755 "$(find /tmp/dolt-settle -type f -name dolt | head -1)" "$HOME/.apra-fleet/bin/dolt"
```

Then re-probe: the freshly installed binary must report the pinned version
before you continue. On Windows a replace can fail because a stray `dolt`
process holds the file -- kill any process whose executable path IS this
fleet-managed path (nothing else ever launches a binary there) and retry once.

Every `dolt ...` invocation below means that absolute pinned path, not a bare
`dolt` from PATH.

## 2. Start the ephemeral sql-server -- GENUINELY DETACHED

This is the step with real cross-platform divergence, and where most of the
danger lives (an interrupted/never-torn-down server is exactly what
apra-fleet-5mqg is about).

**Windows -- do NOT use `Start-Process` or `schtasks`:**

- `Start-Process -WindowStyle Hidden` looked detached but is NOT: it is still a
  child of the invoking SSH/job-object session. Verified live: the sql-server
  process (and its listening port) died the instant the launching
  `execute_command` call's session ended, even with `-RedirectStandardOutput`/
  `-RedirectStandardError` set and `-PassThru`.
- `schtasks`/`Register-ScheduledTask` + `Start-ScheduledTask` also failed:
  verified live, `Get-ScheduledTaskInfo` reported `LastTaskResult 267011`
  (`SCHED_S_TASK_QUEUED`) -- the task was queued but never actually ran,
  because this is a non-interactive SSH session with no interactive logon
  (the exact apra-fleet-i8qj failure mode, reproduced here independently).
- **What actually works, verified live:** spawn via WMI, which creates the
  process under the WMI provider host's own session (session 0), fully
  independent of the SSH session's job object:

```powershell
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"C:\Users\<you>\.apra-fleet\bin\dolt.exe" sql-server --host 127.0.0.1 --port 13399 --data-dir .beads/embeddeddolt'
  CurrentDirectory = 'C:\akhil\git\apra-fleet'
}
$result.ProcessId   # <-- record this PID for teardown (step 5)
```
Verify it is actually up before proceeding: `Get-Process -Id <pid>` should
show it running under `SI` (session ID) `0`, and
`Test-NetConnection -ComputerName 127.0.0.1 -Port 13399` should report
`TcpTestSucceeded: True`.

**Linux / macOS (POSIX):** the SSH-session-job-object problem does not exist on
POSIX in the same way; the existing `nohup ... & disown` pattern (as used by
`task-wrapper.ts`'s bash wrapper for `long_running` commands elsewhere in this
codebase) is sufficient:

```bash
nohup dolt sql-server --host 127.0.0.1 --port 13399 --data-dir .beads/embeddeddolt \
  > /tmp/dolt-recovery.log 2>&1 &
echo "PID:$!"
disown
```

## 3. Connect and query -- the exact working flag set (verified live)

```
dolt --no-tls --host=127.0.0.1 --port=13399 sql -q "USE beads; SELECT ...;"
```

Two specific, non-obvious landmines, both reproduced live on this run:

1. **`--no-tls` must come BEFORE `--host`/`--port`.** With `--host`/`--port`
   given first and `--no-tls` after, the client still requested TLS and failed
   with `TLS requested but server does not support TLS` -- Dolt's global-flag
   parser is order-sensitive here. Always lead with `--no-tls`.
2. **Do NOT pass `--user=root` or `--password` at all**, even though root with
   an empty password is the documented default. Explicitly passing `--user=root`
   switches the client into a credential-resolution path that issues an
   interactive `Enter password:` prompt and then fails non-interactively with
   `Failed to parse credentials: The handle is invalid` -- this is the EXACT
   apra-fleet-ga61 symptom, reproduced live and now root-caused precisely: it
   is triggered by explicitly specifying `--user`/`--password`, not by network
   mode itself. Omitting both flags entirely lets the client silently
   authenticate as root with the empty-password default with zero prompt.
   (Separately, on Windows/PowerShell specifically: an empty-string argument
   like `--password ''` can be silently dropped by PowerShell's native-argument
   passing, shifting the NEXT flag into becoming its value -- another reason to
   just omit the flag rather than try to pass an explicit empty value.)

Use `USE beads;` as the first statement of every query -- the target database
name is not implied by `--data-dir` alone once connected over SQL.

The actual recovery SQL (identical across all three OSes -- this part has no
platform variance):

```sql
SET @@dolt_allow_commit_conflicts = 1;
CALL DOLT_MERGE('origin/main');
SELECT `table` FROM dolt_conflicts;                     -- enumerate EVERY conflicted table
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'issues');      -- table name is REQUIRED
CALL DOLT_COMMIT('-m', 'manual recovery: resolve conflict');
SELECT COUNT(*) FROM dolt_conflicts;                    -- MUST be 0 before you republish
```
A bare `--theirs` is only correct when discarding our side's version of those
rows is genuinely acceptable. `settleDoltConflicts()` applies the full rulebook
instead -- per-field last-writer-wins by `updated_at` for `issues` and
`dependencies`, a real set-union INSERT for `labels`, generic
LWW-or-theirs for anything else (design doc Part 3.2 step 4). Resolving by hand
with real content on both sides, follow the same rules rather than clobbering
one side.

Then, outside the SQL session -- and ONLY AFTER the teardown in step 5 --
`bd dolt pull` (verify), `bd dolt push` (republish). The order matters; see
step 5.

## 4. Verify before teardown

```
dolt --no-tls --host=127.0.0.1 --port=13399 sql -q "USE beads; SELECT * FROM dolt_status;"
```
Confirm no residual uncommitted/conflicted state before tearing the server down.

## 5. Teardown -- ALWAYS, every path, even on failure, and BEFORE republishing

Ordering, corrected (design doc Part 7.2): tear the ephemeral server down
FIRST, then run `bd dolt pull` / `bd dolt push`. Embedded-mode `bd` must open
the same data dir the server still holds under Dolt's per-directory exclusive
lock, so republishing while the server is still up fails or falls back
read-only.

**Windows:**
```powershell
Stop-Process -Id <pid> -Force -ErrorAction SilentlyContinue
```
**POSIX:**
```bash
kill <pid>
```

Then, on every OS:
- Verify the port is actually closed (`Test-NetConnection` / `nc -z` /
  `lsof -i:<port>`).
- Verify `bd dolt status` reports `embedded (in-process, no server)` again and
  `.beads/metadata.json`'s `dolt_mode` is `"embedded"` -- if this recovery
  procedure ever explicitly flips `dolt_mode` to `"server"` as part of routing
  bd itself through the ephemeral server (this manual run did NOT do that --
  it talked to the raw `dolt` CLI directly, bypassing bd entirely -- and
  `settleDoltConflicts()` deliberately does the same, which is what makes its
  teardown unconditionally safe), flipping it back is
  MANDATORY and must happen in a `finally`/guaranteed-cleanup block, not as
  the last step of a list that can be abandoned mid-way (exactly what went
  wrong in the incident apra-fleet-5mqg documents).
- Remove any temp log files created for the ephemeral server's stdout/stderr.

## Why this matters for the code fix (apra-fleet-5mqg, apra-fleet-ga61)

Every numbered landmine above (`--no-tls` ordering, omitting `--user`/
`--password`, WMI vs `Start-Process`/`schtasks` for real detachment on Windows,
never hardcoding the data directory) was independently rediscovered by trial
and error here, and was ALSO independently rediscovered by trial and error by
the Tier-2 LLM dispatch whose transcript motivated apra-fleet-5mqg. That was
strong evidence this entire procedure is mechanical and fully scriptable --
there was no judgment call anywhere in this runbook, only flag/ordering
trivia a fixed script encodes once and never has to rediscover again. That
script now exists: `fleet-sprint/dolt-settle.mjs`.

CAVEAT on the evidence: every landmine above was verified live against a
winget-installed dolt **1.86.3**, not against the pinned **v2.2.0** the fleet
now installs. Re-verifying them on the pinned binary, per OS, is Precondition
V0 of the design doc's Part 4 verification pass.
