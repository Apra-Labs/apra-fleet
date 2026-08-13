# Dolt manual recovery runbook (verified 2026-08-12, all steps live-tested on fleet-win-dev1)

This is the ground-truth procedure for standing up an ephemeral `dolt sql-server`
against a wedged embedded Dolt clone, querying/repairing it, and tearing it back
down -- verified end to end against a real clone on a real member, not written
from docs. It exists to (a) give a human an exact copy-pasteable recovery path
and (b) be the source of truth Path A's code (`dolt-recovery.mjs`) and the
Tier-2/3 LLM runbook (`dolt-tier2-runbook.md`) should both encode mechanically,
since every step here was independently rediscovered by trial and error at
least once already (see apra-fleet-ga61, apra-fleet-5mqg).

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

## 1. Ensure `dolt` the standalone binary is present

The embedded `bd` binary does NOT ship enough of the Dolt CLI to drive a
merge-conflict resolution over SQL -- that requires the real `dolt` binary and
a real `dolt sql-server` process, temporarily, against the SAME data directory.

**Windows:**
```powershell
winget install --id DoltHub.Dolt --silent --accept-package-agreements --accept-source-agreements
```
Note: `winget`-installed binaries do not appear on `PATH` for processes already
running (or spawned in the same shell invocation) at install time -- a fresh
process must re-read the machine `PATH`, which an SSH-dispatched non-interactive
session typically will not do automatically. Reference the binary by full path
(`C:\Program Files\Dolt\bin\dolt.exe`) rather than relying on `PATH`.

**Linux:**
```bash
sudo bash -c 'curl -L https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash'
# or: sudo apt-get install dolt   (if a repo is configured)
```

**macOS:**
```bash
brew install dolt
```

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
  CommandLine = '"C:\Program Files\Dolt\bin\dolt.exe" sql-server --host 127.0.0.1 --port 13399 --data-dir .beads/embeddeddolt'
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
SELECT * FROM dolt_conflicts;                          -- THE GATE: inspect shape before proceeding
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'issues');      -- table name is REQUIRED
CALL DOLT_COMMIT('-m', 'Tier-2/3 recovery: resolve conflict');
```
Then, outside the SQL session: `bd dolt pull` (verify), `bd dolt push`
(republish).

## 4. Verify before teardown

```
dolt --no-tls --host=127.0.0.1 --port=13399 sql -q "USE beads; SELECT * FROM dolt_status;"
```
Confirm no residual uncommitted/conflicted state before tearing the server down.

## 5. Teardown -- ALWAYS, every path, even on failure

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
  it talked to the raw `dolt` CLI directly, bypassing bd entirely, same as the
  Tier 2 LLM transcript that motivated apra-fleet-5mqg), flipping it back is
  MANDATORY and must happen in a `finally`/guaranteed-cleanup block, not as
  the last step of a list that can be abandoned mid-way (exactly what went
  wrong in the incident apra-fleet-5mqg documents).
- Remove any temp log files created for the ephemeral server's stdout/stderr.

## Why this matters for the code fix (apra-fleet-5mqg, apra-fleet-ga61)

Every numbered landmine above (`--no-tls` ordering, omitting `--user`/
`--password`, WMI vs `Start-Process`/`schtasks` for real detachment on Windows,
never hardcoding the data directory) was independently rediscovered by trial
and error here, and was ALSO independently rediscovered by trial and error by
the Tier-2 LLM dispatch whose transcript motivated apra-fleet-5mqg. That is
strong evidence this entire procedure is mechanical and fully scriptable --
there was no judgment call anywhere in this runbook, only flag/ordering
trivia a fixed script encodes once and never has to rediscover again.
