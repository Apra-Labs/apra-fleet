# Beads Conflict Resolution -- Dolt SQL Playbook

`bd dolt pull` / `bd dolt push` can fail with a genuine, non-fast-forward divergence:

```
Error: merge origin/main: merge conflicts in issues require operator resolution;
merge aborted and working set restored
```

This is not corruption and the working set is untouched -- `bd` already aborted the
merge safely. Resolve it by driving the real `dolt` binary against the same data
directory over SQL, ephemerally, then pull/push again through `bd` as normal.

**Do not `bd init`, `bd init --from-jsonl`, or delete `.beads/` to "fix" this** --
that discards local issue state. See `beads.md`.

For the fully automated version of this same procedure (used by fleet-sprint
itself at every sync point), see `settleDoltConflicts()` in
`packages/apra-fleet-se/fleet-sprint/dolt-settle.mjs`, which applies a
deterministic per-field last-writer-wins rulebook instead of a human picking a
side. This playbook is the manual fallback -- use it when you need to see the
actual conflicting content before deciding, or when settle isn't wired for the
context you're in (e.g. resolving conflicts in the orchestrator's own local
checkout rather than against a registered fleet member).

## 0. Find the real data directory -- never hardcode it

```bash
bd dolt status
```

Read the `Data:` line. **On a machine with multiple worktrees, `bd` resolves to
one shared `.beads` directory for the whole repo (typically the main checkout's),
not a per-worktree copy** -- always use the absolute path this command reports,
never a path you assume from cwd.

If it reports `embedded (in-process, no server)`, there's no live server to
route through -- start an ephemeral one (step 2). If it already reports a live
server (`host:port`), target that instead of starting a second one.

## 1. Ensure the pinned `dolt` binary is present

```powershell
& "$env:USERPROFILE\.apra-fleet\bin\dolt.exe" version   # Windows
```
```bash
"$HOME/.apra-fleet/bin/dolt" version                    # POSIX
```

Never install via a package manager (`winget`/`apt`/`brew`) -- it delivers an
unpinned version that drifts from the repo's pin and can be invisible to
already-running sessions' PATH. If missing, fetch the pinned release asset
(`DOLT_VERSION` in `src/cli/dolt-install.ts`) to that exact path.

## 2. Start an ephemeral sql-server against that data dir

**Windows -- `Start-Process` does NOT actually detach** (dies with the SSH/job
session). Use WMI:

```powershell
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd /c ""C:\Users\<you>\.apra-fleet\bin\dolt.exe" sql-server --host 127.0.0.1 --port 13401 --data-dir "<ABSOLUTE data dir from step 0>" > "%TEMP%\dolt-settle-local.log" 2>&1"'
  CurrentDirectory = 'C:\akhil\git\apra-fleet'
}
$result.ProcessId   # record for teardown -- this is cmd.exe's PID, not dolt's (see step 5)
```

Wrapping in `cmd /c ... > log 2>&1` is required to capture startup errors (a bad
`--data-dir` fails silently otherwise). Verify before proceeding:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 13401   # expect TcpTestSucceeded: True
Get-Content "$env:TEMP\dolt-settle-local.log"             # expect "Server ready. Accepting connections."
```

**POSIX:** `nohup dolt sql-server --host 127.0.0.1 --port 13401 --data-dir <dir> > /tmp/dolt-recovery.log 2>&1 & disown`

## 3. Inspect the conflict before resolving -- do not guess a side

```bash
dolt --no-tls --host=127.0.0.1 --port=13401 sql -q "
USE beads;
SET @@dolt_allow_commit_conflicts = 1;
CALL DOLT_MERGE('origin/main');
SELECT \`table\` FROM dolt_conflicts;"
```

Two non-obvious flag landmines: `--no-tls` must come *before* `--host`/`--port`
(order-sensitive), and never pass `--user=root` or `--password` explicitly --
that switches the client into an interactive credential prompt that then fails
non-interactively. Omit both and it authenticates as root/empty-password
silently.

For each conflicted table, see which rows and which side is newer:

```sql
SELECT base_id, our_id, their_id, our_updated_at, their_updated_at
FROM dolt_conflicts_issues;   -- table name is `dolt_conflicts_<table>`
```

## 4. Resolve -- per-field last-writer-wins, not a blanket side

```sql
CALL DOLT_CONFLICTS_RESOLVE('--ours', 'issues');    -- our_updated_at newer
-- or '--theirs' if their_updated_at is newer
CALL DOLT_COMMIT('-m', 'manual recovery: resolve <issue-id> conflict, <ours|theirs> newer');
SELECT COUNT(*) FROM dolt_conflicts;   -- MUST be 0 before continuing
```

A bare `--ours`/`--theirs` picks the whole row. Only safe when one side is
strictly newer (verify via `updated_at` from step 3) or you've confirmed the
older side's content is already fully contained in the newer side -- never
pick a side just to make the error go away.

## 5. Teardown BEFORE republishing -- order matters

Embedded-mode `bd` needs Dolt's per-directory exclusive lock; republishing
while the ephemeral server still holds it fails or silently falls back
read-only.

```powershell
Get-Process | Where-Object { $_.ProcessName -eq 'dolt' } | Stop-Process -Force
# the WMI-created PID from step 2 is cmd.exe, not dolt.exe -- find dolt.exe by name, not by that PID
Test-NetConnection -ComputerName 127.0.0.1 -Port 13401   # expect False
```

Then, only after the port is confirmed closed:

```bash
bd dolt pull   # verify
bd dolt push   # republish
```

## Full reference

`packages/apra-fleet-se/fleet-sprint/docs/dolt-manual-recovery-verified.md` --
the original live-verified spec this playbook condenses, including the
`settleDoltConflicts()` rulebook for tables other than `issues` (union for
`labels`, plain theirs for machine-local/append-only tables) and the
`dolt_mode` cleanup guarantee if a recovery ever routes `bd` itself through a
server.
