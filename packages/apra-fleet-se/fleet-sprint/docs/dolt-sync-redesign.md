# Dolt sync redesign: from a 3-tier recovery ladder to one deterministic settle step

Status: BEING IMPLEMENTED on branch `fix/dolt-settle-recovery` (written
2026-08-13). Per-part implementation status is tracked in "Implementation
status" immediately below; Part 4's verification table is the live-run record.
See `dolt-manual-recovery-verified.md` for the live-verified mechanical spec
(exact flags, exact commands, exact OS-specific detachment technique) this
design's `settle()` step is built from.

### Implementation status

| Part | Item | Status |
|------|------|--------|
| 3.1-3.2, 5 | `fleet-sprint/dolt-settle.mjs` + `test/dolt-settle.test.mjs` | DONE |
| 3.2 step 4 | `labels` set-union (real INSERT, live-read uniqueness key) | DONE |
| 2.4, 3.2 | settle wired at the push AND pull/readiness divergence terminals | DONE |
| 2.4 | old ladder (`dolt-recovery*.mjs`, tier-2 runbook) retired | DONE (deleted) |
| 3.4 | mutex lease renewal while held | DONE |
| 3.3 | supervisor orphaned-sql-server sweep | DONE |
| 5.5 V2 | `dolt-manual-recovery-verified.md` step 1 corrected to the pinned installer | PENDING |
| 6 | `scripts/dolt-settle-integration.mjs` | PENDING |
| 4 | live 3-OS verification | PENDING |
| 8 | beads audit executed | PENDING |

Produced by a deep architecture review (apra-fleet-ga61, apra-fleet-5mqg
evidence chains, full reads of dolt-sync.mjs / dolt-recovery*.mjs / runner.js /
dolt-mutex.mjs, plus upstream beads sync semantics) after the user explicitly
rejected the existing multi-tier ladder as an acceptable end state: "I am not
interested in a multi-tier ladder, I just need a reliable system which works
100% of time."

---

## Part 1 -- how the current system actually works (verified against code)

### 1.1 G-push and D-push

Two orthogonal sync planes per fleet member:

- **G-pull/G-push** -- the member's git code checkout against the shared
  sprint branch (`syncMemberBefore`/`syncMemberAfter`, `runner.js` ~868-1012).
- **D-pull/D-push** -- the member's beads Dolt clone against the shared Dolt
  remote (`refs/dolt/data`), exclusively in `dolt-sync.mjs` (the declared
  "SINGLE permitted dolt command surface").

`syncMemberAfterOrdered()` (`runner.js:1094-1145`) runs **G-push strictly
before D-push**. If G-push throws, D-push is skipped and the error rethrown --
pushing a bead close to the shared DB while the code justifying it never left
the member's checkout would advertise an **unreachable close**. D-push here is
`fatal: true` for the mirrored reason.

D-push conflict policy (`dolt-sync.mjs:108-114, 670-721`): first-successful-
pusher-wins. A rejected push gets exactly one reconcile `bd dolt pull` and one
re-push; a divergence outliving that becomes `DoltDivergedError` -> terminal
`BEADS_SYNC_CONFLICT` (after the recovery ladder).

### 1.2 What `dolt_push_mutex` does and does not prevent

`src/supervisor/dolt-mutex.mjs`: a supervisor-process, in-memory, FIFO mutex,
60s lease, pid-liveness reclaim, HTTP long-poll. Prevents two sprints pushing
in overlapping windows -- serializes remote-ref updates.

**Does NOT prevent row-level conflicts**, because conflicts are created at
local **commit** time, during agent dispatches, entirely outside the mutex:

1. Members A and B both D-pull; both clones sit at remote commit X.
2. A's dispatched agent commits a change to `bead-1` locally.
3. Concurrently, B's dispatched agent commits a *different* change to the same
   `bead-1` locally (even a disjoint field -- Dolt conflicts are row-level,
   not cell-level, in bd's current embedded mode).
4. A acquires the mutex, pushes, releases. Remote now has A's version.
5. B acquires the mutex (FIFO), push rejected, runs its one reconcile pull --
   Dolt hits a **row-level conflict**. `bd` auto-aborts the merge, B's clone
   is now wedged (one unresolved conflict blocks all pull/push for that
   clone), `DoltDivergedError` surfaces.

Additional real gaps in the mutex itself:
- **Lease expiry with a live holder:** `reclaimExpired()` force-evicts at 60s
  even if the pid is alive, and `doltPushAfter` never calls `renew()`. A
  push+reconcile (or, today, a Tier-2 dispatch with `timeout_s: 1800` run
  *while the mutex is nominally held*) loses mutual exclusion 60s in.
- **In-memory only** -- a supervisor restart forgets holder and queue.
- **Non-participants** -- an operator's own clone, manual `bd dolt push`, or a
  sprint run without a supervisor bypass the mutex entirely.

### 1.3 Conflict shapes actually possible

Single-row `issues` conflicts dominate, but are not the only shape:
`issues` multi-row, `dependencies` (audit-only vs semantic), `labels`
(set-union), `comments`/`events` (append-only union), machine-local
metadata/config rows (trivially `theirs`), and **schema-level forks** from
mixed `bd` binary versions across members -- upstream documents this last one
as a genuine anti-pattern that can make a clone *permanently* unmergeable; no
row-data algorithm fixes it, it must be prevented operationally (fleet-wide
version pinning).

Upstream `bd` itself (newer than this fleet's pin) now ships
`TryAutoResolveMergeConflicts` with a per-table deterministic rulebook,
including per-field last-writer-wins by `updated_at` for `issues` -- direct
corroboration that a total mechanical rule for this data model exists and is
what the vendor converged on independently.

### 1.4 The recovery ladder as it ACTUALLY behaves in production

- **Path A never runs.** `runner.js:1142` builds the ladder without injecting
  `sql`/`spawnSqlServer`/`readMetadata`/`writeMetadata`. `recoverDoltConflictPathA`
  throws its precondition guard immediately every time (confirmed live across
  4 incidents in 2 sprint logs). Path A's careful reversible-teardown code is
  production-dead.
- **Path B never runs.** Hard-disabled (`enablePathB: false`) for a correct
  reason: this bracket wraps an arbitrary multi-command dispatch with no
  single `pendingMutation` to replay -- firing Path B here would silently
  discard the dispatch's bead writes and report success.
- **Tier 2 is the only tier that ever executes** -- dispatches a real LLM
  agent with `dolt-tier2-runbook.md`, with **no code-guaranteed rollback**:
  step 6 (teardown/revert) is the last item of an instruction list, not a
  `finally`. Proven live (apra-fleet-5mqg): an agent hit its 50-turn budget
  immediately after *announcing* it was about to do step 6, having already
  used a raw ephemeral server to resolve a conflict, leaving the member with
  an orphaned server-mode data dir -- which in turn made the apra-fleet-ga61
  network-client credential-prompt bug reachable in the first place.
- **Structural zero-success:** `recoverDoltConflict` returns
  `{ ok: false, tier: 'tier-2', escalated: true }` by construction -- Tier 2
  only dispatches, it never verifies. Every divergence reaching the terminal
  ends in `BEADS_SYNC_CONFLICT` for that streak, 100% of the time, even when
  the dispatched agent successfully fixes the clone (the fix only helps some
  *later* bracket).
- **The pull side has no recovery at all.** A clone wedged by a previous
  failed reconcile hard-aborts the *next* sprint at the readiness gate, with
  no recovery seam.

### 1.5 Which runbook is used by which actor

- `dolt-tier2-runbook.md` -- read by the dispatched Tier-2 LLM agent (wired
  via `DEFAULT_TIER2_RUNBOOK_PATH`). The only runbook any code reads.
- `docs/dolt-operator-conflict-runbook.md` -- human operator debugging their
  own clone by hand. Zero code references.
- `dolt-manual-recovery-verified.md` -- live-verified mechanical spec, not yet
  referenced by code (this design makes it so, in spirit: `dolt-settle.mjs` is
  its executable form).

---

## Part 2 -- the redesign: one deterministic settle step, no ladder

### 2.1 Why NOT full centralization (single always-on Dolt server, no per-member clones)

Rejected, decisively:

1. It would move 100% of beads traffic onto bd's **least-proven** code path.
   apra-fleet-ga61 is a real, still-partially-open bug specifically in bd's
   *network-client* mode on Windows (credential-prompt landmines triggered by
   explicit `--user`/`--password`). That path is dormant today because the
   fleet runs embedded. Centralizing makes the buggy path the *only* path, for
   every command, on every member, forever.
2. It converts a publish-time dependency into a total-availability dependency.
   Today a supervisor outage only delays pushes (local clones stay safe by
   design). Under centralization, a network blip fails every `bd` read/write
   on every member mid-dispatch -- worse than a rare, mechanically-resolvable
   conflict, for a fleet of long-running agents on separate machines over SSH.
3. Migration cost is fleet-wide and cross-cutting (auth/TLS provisioning,
   backup story for the sole canonical clone, decommissioning the entire
   clone/sync surface with both systems live during migration).

(If the fleet ever gets an HA supervisor and all members on one reliable LAN,
this is a legitimate long-term end state -- just not the reliable-today
answer.)

### 2.2 THE RECOMMENDATION: a single, total, deterministic `settle()` step

Replace the entire ladder with **one conflict-settlement function that is
total over row-level conflicts** -- no gates, no allowlist, no escalation
path, no LLM, no runbook dispatch. Its correctness rule is beads' own
published merge semantics (the same rules upstream `TryAutoResolveMergeConflicts`
encodes), executed via the exact live-verified mechanics in
`dolt-manual-recovery-verified.md`.

**The settle algorithm**, per conflicted table, read from
`dolt_conflicts_<table>`'s `base_*`/`our_*`/`their_*` columns:

- **`issues`** (modify/modify): per-field merge -- a field changed by only one
  side keeps that side; a field changed by both sides resolves by
  **last-writer-wins on `updated_at`** (bd stamps this on every mutation);
  `updated_at` itself merges to `max(ours, theirs)`. Tiebreak on equal/
  unparseable `updated_at`: **theirs** (consistent with the existing
  first-successful-pusher-wins policy -- the remote side already published).
  A fixed tiebreak is what makes this total.
- **`issues` add/add** on the same id: identical rows keep; otherwise the same
  per-field rule.
- **`issues` delete/modify**: modify wins (beads closes rather than deletes;
  genuine deletes are near-nonexistent, so this is not a live risk).
- **`labels`**: set-union. **`comments`/`events`**: append-only union (keep
  both, never drop). **`dependencies`**: audit-only diffs -> theirs; semantic
  diffs -> per-field LWW, same tiebreak. Machine-local metadata/config rows:
  theirs.
- **Any other table**: generic per-field LWW-by-`updated_at` where the column
  exists, else theirs. **The function never returns "cannot resolve."** Its
  only other possible outcome is an *operational* error (server wouldn't
  start, a SQL statement failed) -- handled like any other infra command
  failure via the existing degraded/fatal policy, not as an escalation tier.

**The mechanism**, straight from the verified doc, with two deliberate
hardening choices:

1. Read the real data dir from `bd dolt status` live -- never hardcode
   `.beads/embeddeddolt` (closes the per-project-mode/orphaned-directory risk
   apra-fleet-5mqg's live validation surfaced).
2. Spawn the ephemeral `dolt sql-server` genuinely detached: WMI
   `Win32_Process.Create` on Windows (verified live -- `Start-Process` and
   `schtasks` both fail to survive the SSH session), `nohup ... & disown` on
   POSIX. Record the pid.
3. **Do not flip `.beads/metadata.json` or route `bd` through the server at
   all.** Drive the raw `dolt` client directly at the socket: `--no-tls`
   *before* `--host`/`--port` (order-sensitive), never pass `--user`/
   `--password` (passing `--user=root` explicitly is what triggers the
   interactive-credential-prompt failure; omitting both flags authenticates
   silently as root with the documented empty-password default), `USE beads;`
   first. This is what the Tier-2 transcript actually did successfully, and it
   **eliminates the entire apra-fleet-5mqg rollback class outright** -- bd's
   own routing state is never touched, so there is nothing to revert.
4. `SET @@dolt_allow_commit_conflicts=1; CALL DOLT_MERGE('origin/main');` ->
   read `dolt_conflicts` and each `dolt_conflicts_<table>` -> apply the
   rulebook via `UPDATE`s + `CALL DOLT_CONFLICTS_RESOLVE(...)` per table ->
   `CALL DOLT_COMMIT(...)` -> verify `dolt_conflicts` is empty.
5. `bd dolt pull` then `bd dolt push` to republish.
6. **Teardown in a real code `try/finally`:** kill the recorded pid, verify
   the port closed, verify `bd dolt status` reports embedded -- on every path,
   including throw. Belt-and-suspenders: a supervisor sweep that kills any
   orphaned loopback `dolt sql-server` older than N minutes on a member
   (closes apra-fleet-5mqg even against an orchestrator-process kill).

### 2.3 What stays, fixed in detail

- Keep the D-pull/D-push brackets, first-pusher-wins reconcile, and the mutex
  (it still guarantees at most one loser per race and orderly remote-ref
  updates) -- but fix the lease hole: `doltPushAfter` should `renew()` on an
  interval while held, or release before settle and re-acquire for the
  republish push.
- Wire settle at **both** divergence terminals: the push terminal (where the
  ladder sits today) *and* the pull/readiness-gate terminal (currently
  recovery-free -- a wedged clone at sprint start must self-heal, not abort).
- Optional accelerator, not a tier: if a newer pinned `bd` ships
  `TryAutoResolveMergeConflicts`, use it as the reconcile-pull so most
  conflicts never even reach settle. Settle remains the single total terminal
  either way.
- The one shape settle cannot fix -- a schema fork from mixed `bd` versions --
  is *prevented*, not resolved: enforce the fleet-wide `bd` version pin at
  member provisioning/readiness-gate time. (Full centralization would have the
  same constraint, so this is not a point against settle.)

### 2.4 Migration plan (concrete files/functions)

1. **New** `packages/apra-fleet-se/fleet-sprint/dolt-settle.mjs`:
   `settleDoltConflicts(member, { command, log })` implementing the above
   end-to-end through the injected `command()` -- binary check/winget
   install, WMI/nohup spawn, `dolt --no-tls ... sql -q ...`, kill.
   Unit-testable exactly like Path A was (scripted mock `command()`). Port
   Path A's `finally` discipline; delete its gates/allowlist.
2. **`runner.js`**: at `syncMemberAfterOrdered` (line 1142) replace
   `buildDoltRecoveryLadder(...)` with the settle callback; drop `agent`/
   `resolveConflictModel` threading for dolt recovery. Wire the same settle
   into the pre-dispatch D-pull and readiness-gate paths.
3. **`dolt-sync.mjs`**: `surfaceDivergence` invokes settle (rename
   `opts.recover` -> `opts.settle`; a settle success IS a verified recovery
   because settle itself re-pushes and verifies -- unlike Tier 2, it can
   return `ok: true`). Add the equivalent terminal inside `doltPullBefore`.
   Add mutex `renew` handling around long holds.
4. **`src/supervisor/dolt-mutex.mjs` + `createHttpDoltPushMutexClient`
   (`runner.js`)**: expose/consume `renew`; add the orphaned-sql-server sweep
   to the supervisor.
5. **Delete/retire**: `dolt-recovery-path-b.mjs`, `dolt-recovery-tier2.mjs`
   (the dispatch machinery, `buildDoltRecoveryLadder`, wedged-state prompt),
   Path A's gate machinery in `dolt-recovery.mjs` (file superseded by
   `dolt-settle.mjs`). `errors.mjs` unchanged -- `DoltDivergedError` survives
   only as "settle itself had an operational failure," already handled by the
   existing degraded/fatal taxonomy.
6. **Close the loop on the P0s**: ga61's client landmines are permanently
   encoded in settle's fixed flag set (and bd stays embedded, keeping ga61's
   trigger dormant); apra-fleet-5mqg is closed structurally (no metadata flip
   + try/finally kill + supervisor sweep).

### 2.5 The runbook question, answered explicitly

**The Tier-2 runbook/LLM-dispatch concept is obsolete under this redesign.**
Do not revise `dolt-tier2-runbook.md` -- retire it (delete, or mark
historical). Its content should not be "improved" with the verified material,
because its premise -- an LLM executing a teardown-critical procedure from
prose -- is the exact defect apra-fleet-5mqg proved. Instead:

- `dolt-manual-recovery-verified.md` becomes the specification `dolt-settle.mjs`
  encodes, and remains the human copy-paste fallback.
- `docs/dolt-operator-conflict-runbook.md` stays for humans on their own
  clones, updated to point at the verified doc and to note that fleet members
  now self-heal via settle rather than escalating to a human/LLM.

### Critical files for implementation

- `packages/apra-fleet-se/fleet-sprint/dolt-sync.mjs`
- `packages/apra-fleet-se/fleet-sprint/runner.js`
- `packages/apra-fleet-se/fleet-sprint/dolt-recovery.mjs` (superseded by the
  new `dolt-settle.mjs`)
- `packages/apra-fleet-se/fleet-sprint/dolt-recovery-tier2.mjs` (retired,
  along with `dolt-recovery-path-b.mjs`)
- `packages/apra-fleet-se/fleet-sprint/docs/dolt-manual-recovery-verified.md`
  (the spec the settle code encodes)

---

## Part 3 -- implementation-level detail

This section exists so implementation does not require re-deriving anything
from Parts 1/2. Every function signature, SQL template, and OS-specific
command below is meant to be copied close to verbatim into
`dolt-settle.mjs`.

### 3.1 Module shape

```js
// packages/apra-fleet-se/fleet-sprint/dolt-settle.mjs

/**
 * @typedef {Object} SettleOpts
 * @property {(cmd: string, opts?: object) => Promise<{stdout: string, stderr: string, exitCode: number}>} command
 *   Injected shell-command runner, member-scoped (same shape as every other
 *   dolt-sync.mjs/runner.js call site already uses -- NOT a raw child_process
 *   call; must route through whatever member-dispatch mechanism the caller
 *   already has, exactly like Path A's `command` opt did).
 * @property {(msg: string) => void} [log]
 * @property {string} [remote='origin']
 * @property {string} [branch='main']
 * @property {number} [portRangeStart=13300] Ephemeral port search start.
 * @property {number} [portRangeEnd=13400]
 * @property {string} [doltWindowsPath='C:\\Program Files\\Dolt\\bin\\dolt.exe']
 * @property {string} [doltPosixPath='dolt']
 */

/**
 * Total, deterministic settle: resolves EVERY row-level Dolt conflict shape
 * this data model can produce, no gates, no escalation. Only throws on a
 * genuine operational failure (server wouldn't start, an individual SQL
 * statement errored for a reason unrelated to conflict content) -- callers
 * treat that exactly like any other infra command failure (existing
 * degraded/fatal taxonomy in dolt-sync.mjs), NOT as a ladder tier.
 *
 * @param {string} member
 * @param {SettleOpts} opts
 * @returns {Promise<{ ok: true, resolvedTables: string[], resolvedRowCounts: Record<string, number> }>}
 */
export async function settleDoltConflicts(member, opts) { /* see 3.4 */ }
```

`settleDoltConflicts` REPLACES `recoverDoltConflict`/`buildDoltRecoveryLadder`
as the one function `dolt-sync.mjs` and `runner.js` call at every divergence
terminal. There is no `tier` return field because there is no tier -- callers
branch only on the promise resolving vs throwing.

### 3.2 Step-by-step with exact commands (cross-referencing
`dolt-manual-recovery-verified.md`, which remains the authoritative source for
any flag/ordering detail not repeated here)

**Step 0 -- resolve the real data dir (never hardcode).**
```js
const { stdout } = await command('bd dolt status');
// stdout line 2 is "  Data: <path>" when embedded, or a host:port line when
// server. Parse both; if server mode is already active, target THAT
// host:port instead of starting a second ephemeral server (see 3.5).
```

**Step 1 -- ensure `dolt` binary present. CORRECTED (see Part 5): do NOT use
`winget`/`apt`/`brew`.** This repo already has a portable, version-pinned
installer wired into `apra-fleet install` -- `src/cli/dolt-install.ts`,
`downloadAndExtractDolt(BIN_DIR)` -- which lands the binary at
`path.join(BIN_DIR, platform === 'win32' ? 'dolt.exe' : 'dolt')`
(`BIN_DIR` from `src/cli/config.ts`, a fleet-managed dir, never system PATH).
Every fleet member that has run `apra-fleet install` already has this binary
at that exact path, at the exact pinned version. `dolt-settle.mjs` step 1
should simply be:
```js
const doltPath = path.join(BIN_DIR, process.platform === 'win32' ? 'dolt.exe' : 'dolt');
if (!(await command(`Test-Path '${doltPath}'` /* or `test -x` on POSIX */)).stdout.includes('True' /* or exit 0 */)) {
  // reuse the SAME installer the fleet already ships, not an OS package manager:
  await downloadAndExtractDolt(BIN_DIR);
}
```
This also sidesteps the PATH problem entirely: today's manual verification
(3.6) hit a real snag where a `winget`-installed binary was invisible to a
freshly spawned process because PATH is only re-read on next shell start --
`BIN_DIR` is an absolute path passed explicitly, no PATH involved at all.

**Step 2 -- pick an ephemeral loopback port and spawn, genuinely detached.**
Port selection: try ports sequentially in `[portRangeStart, portRangeEnd)`,
probing with a plain TCP connect-refused check before use (do not trust
"probably free" -- a stale ephemeral server from an earlier interrupted run,
exactly the apra-fleet-5mqg failure class, may still be listening; if the
probe succeeds, treat that as a live server. Do NOT assume it is safe to
reuse -- see 3.5 for the disposition).

```powershell
# Windows -- WMI Win32_Process.Create, the ONLY verified-working detachment.
# Start-Process and schtasks BOTH fail (die with the SSH session / never run
# without an interactive logon session, respectively) -- do not use either.
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"<doltWindowsPath>" sql-server --host 127.0.0.1 --port <port> --data-dir <dataDir>'
  CurrentDirectory = '<memberRepoRoot>'
}
# $result.ReturnValue must be 0; $result.ProcessId is the pid to record.
```
```bash
# POSIX
nohup dolt sql-server --host 127.0.0.1 --port <port> --data-dir <dataDir> \
  > /tmp/dolt-settle-<member>-<port>.log 2>&1 &
echo "PID:$!"
disown
```
Verify up before proceeding (poll, do not sleep-and-hope): retry a TCP connect
to `127.0.0.1:<port>` up to ~10x over 5s; separately tail the redirected log
for `"Server ready. Accepting connections."` as a secondary confirmation.

**Step 3 -- connect and merge. Exact working invocation (landmines from live
verification baked in -- CAVEAT: verified against `dolt 1.86.3` via a manual
`winget` install, NOT this repo's pinned `v2.2.0`. Flag parsing/behavior can
differ across a version gap that large. Re-verify every landmine below
against the actual pinned `BIN_DIR` binary as the FIRST step of the manual
OS testing pass (3.6/Part 4) before trusting any of it in real code.):**
```
dolt --no-tls --host=127.0.0.1 --port=<port> sql -q "<SQL>"
```
- `--no-tls` MUST precede `--host`/`--port` (order-sensitive parser).
- Do NOT pass `--user` or `--password` at all, in any form. Passing
  `--user=root` explicitly switches the client into an interactive
  credential-resolution path that fails non-interactively
  (`Failed to parse credentials: The handle is invalid` -- the apra-fleet-ga61
  symptom, reproduced and root-caused live). Omitting both authenticates
  silently as root with the documented empty-password default.
- On Windows/PowerShell specifically, an empty-string arg like
  `--password ''` can be silently DROPPED by PowerShell's native-argument
  passing, shifting the next flag into becoming its value -- moot here since
  the flag is omitted entirely, but do not "fix" this by adding
  `--password=''` back; that reintroduces the credential-prompt bug.
- Run from `<dataDir>/beads` OR pass `--data-dir` again on the client
  invocation; either works, but be consistent (the verified doc used cwd).
- Always lead every query with `USE beads;` -- the database name is not
  implied by `--data-dir` once connected over SQL.

```sql
USE beads;
SET @@dolt_allow_commit_conflicts = 1;
CALL DOLT_MERGE('<remote>/<branch>');
SELECT `table` FROM dolt_conflicts;   -- enumerate every conflicted table, no gate/allowlist
```

**Step 4 -- resolve each conflicted table with the settle rulebook.** For each
table name returned by `dolt_conflicts`, query its `dolt_conflicts_<table>`
view (columns: `base_*`, `our_*`, `their_*`, plus PK columns) and apply:

```sql
-- issues: per-field LWW by updated_at, `theirs` tiebreak on equal/null.
-- Computed as one UPDATE using CASE per contested field, then resolve.
UPDATE issues i
JOIN dolt_conflicts_issues c ON i.id = c.our_id
SET
  i.title    = CASE WHEN c.their_updated_at >= c.our_updated_at THEN c.their_title    ELSE c.our_title    END,
  i.status   = CASE WHEN c.their_updated_at >= c.our_updated_at THEN c.their_status   ELSE c.our_status   END,
  i.priority = CASE WHEN c.their_updated_at >= c.our_updated_at THEN c.their_priority ELSE c.our_priority END,
  -- ... one CASE per mutable column; enumerate ALL of them, do not special-case
  -- "which fields changed" -- CASE on updated_at recency is total and simpler
  -- than diffing base vs our vs their per field, and produces the same result
  -- for a single-field change (the unchanged side's CASE branches are no-ops).
  i.updated_at = GREATEST(c.our_updated_at, c.their_updated_at)
WHERE i.id IN (SELECT our_id FROM dolt_conflicts_issues);

CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'issues');
-- NOTE: --theirs here is safe DESPITE the LWW UPDATE above having already
-- run, because DOLT_CONFLICTS_RESOLVE operates on the conflict markers, not
-- content -- the UPDATE already rewrote the working-set row to the correct
-- merged content; --theirs/--ours only decides which side's row shape
-- (columns/existence) wins the conflict-resolution bookkeeping itself. If a
-- prototype shows this interacts differently in practice, this is the one
-- step to validate most carefully in the manual OS testing pass (3.6) --
-- flag it explicitly if `--theirs` clobbers the LWW-merged row.

-- labels: set-union (add/add is the only realistic labels conflict shape).
INSERT INTO labels (issue_id, label)
SELECT our_issue_id, our_label FROM dolt_conflicts_labels
WHERE NOT EXISTS (
  SELECT 1 FROM labels l WHERE l.issue_id = dolt_conflicts_labels.our_issue_id
    AND l.label = dolt_conflicts_labels.our_label
)
UNION
SELECT their_issue_id, their_label FROM dolt_conflicts_labels
WHERE NOT EXISTS (
  SELECT 1 FROM labels l WHERE l.issue_id = dolt_conflicts_labels.their_issue_id
    AND l.label = dolt_conflicts_labels.their_label
);
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'labels');

-- comments / events: append-only union -- both rows always kept, never
-- dropped. If comment/event ids collide (shouldn't, they're generated with
-- enough entropy per bd's schema, but do not assume): keep theirs, re-insert
-- ours under a synthesized new id rather than discarding it.
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'comments');
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'events');
-- (append-only tables essentially never generate a REAL conflict needing
-- content merge -- the theirs/ours split only ever concerns row survival,
-- and both survive by construction upstream; verify this empirically in 3.6.)

-- dependencies: audit-columns-only diff -> theirs; semantic (dep_type) diff
-- -> per-field LWW, same tiebreak as issues.
UPDATE dependencies d
JOIN dolt_conflicts_dependencies c ON d.id = c.our_id
SET d.dep_type = CASE WHEN c.their_updated_at >= c.our_updated_at THEN c.their_dep_type ELSE c.our_dep_type END
WHERE c.our_dep_type != c.their_dep_type;
CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'dependencies');

-- machine-local metadata/config rows (e.g. kv.memory.*, dolt_auto_push_*):
-- always theirs, no merge logic needed.
CALL DOLT_CONFLICTS_RESOLVE('--theirs', '<config-table>');

-- ANY table not explicitly enumerated above (the generic fallback --
-- guarantees totality): generic per-field LWW-by-updated_at where the
-- column exists on that table, else theirs outright. Implement this as a
-- catch-all after the named-table branches, driven off `information_schema`
-- to discover whether `updated_at` exists on the conflicted table, rather
-- than hardcoding a fixed table list -- this is what makes the function
-- genuinely total rather than "total over the tables we thought of."
```

```sql
CALL DOLT_COMMIT('-m', 'settle: automated deterministic conflict resolution');
SELECT COUNT(*) FROM dolt_conflicts;  -- MUST be 0 before proceeding; if not, throw (operational failure, not "unresolvable")
SELECT commit_hash, committer, message FROM dolt_log LIMIT 5;  -- sanity: both sides' history present
```

**Step 5 -- CORRECTED ORDER (see Part 7.2): tear the ephemeral server down
BEFORE republishing, not after.** Embedded-mode `bd` (used by `bd dolt pull`/
`bd dolt push` below) must open the SAME data dir the ephemeral server still
holds under Dolt's per-directory exclusive-access lock; running the republish
while the server is still up hits that lock and fails or falls back
read-only. So: once step 4's SQL-side verification confirms
`dolt_conflicts` is empty and the commit is in, kill the recorded pid and
verify the port is closed FIRST (the non-`finally` portion of step 6, run
inline here on the happy path), and only then republish:
```
# kill <pid>; verify port closed -- see step 6 for the exact per-OS commands
bd dolt pull
bd dolt push
```
Confirm push actually succeeds mechanically (exit code + no divergence
message) -- never trust "the SQL said 0 conflicts" alone as proof of success,
exactly the posture the old Tier 2 runbook already correctly called for.

**Step 6 -- teardown, unconditionally, in a real `finally`.** The kill +
port-close verification above is the happy-path early execution of this same
teardown; the `finally` block below is what GUARANTEES it also runs on every
throw path (settle failure before reaching step 4/5), so teardown logic
lives in one place and is simply invoked early on success:
```js
try {
  // steps 2-5
} finally {
  await killByPid(pid);              // Stop-Process -Force / kill, per OS
  await verifyPortClosed(port);      // TCP connect must now fail
  const status = await command('bd dolt status');
  if (!status.stdout.includes('embedded')) {
    log(`[settle] WARNING: dolt_mode not embedded after teardown for ${member} -- this should be impossible since settle never flips it; investigate immediately, do not silently continue.`);
  }
  await command(`rm -f /tmp/dolt-settle-${member}-${port}.log`); // or Remove-Item on Windows
}
```

### 3.3 Supervisor-side orphan sweep (belt-and-suspenders for 3.2's teardown)

New, small addition to `src/supervisor/dolt-mutex.mjs` or a sibling module:
on a timer (e.g. every 5 minutes), for each known member, check for any
process matching `dolt sql-server.*--port 13[3-9]\d\d` (the settle port
range) older than e.g. 10 minutes, and kill it. This is a pure safety net --
if 3.2's `finally` is correct, this sweep should NEVER find anything. Its
value is covering the one case even a `finally` cannot: the orchestrator
process itself being killed mid-settle (SIGKILL, machine crash) before the
`finally` block runs.

### 3.4 Mutex lease fix

```js
// runner.js, wherever doltPushAfter currently holds the mutex across a
// push+reconcile:
const grant = await mutexClient.acquire();
const renewInterval = setInterval(() => mutexClient.renew(grant.token).catch(() => {}), 20_000); // well under the 60s lease
try {
  // push, reconcile, settle-if-needed, republish
} finally {
  clearInterval(renewInterval);
  await mutexClient.release(grant.token);
}
```
Requires `createHttpDoltPushMutexClient` (runner.js) to expose a `renew`
method against the existing (or a new) `/api/dolt-push-mutex/:sprintId/renew`
route, and `dolt-mutex.mjs`'s `reclaimExpired()` logic already supports the
concept (it is literally what a lease renewal resets) -- this is additive,
not a behavior change to the reclaim logic itself.

### 3.5 Handling a pre-existing live server on the target port/data dir

If step 0/2's probe finds an already-listening server (from an interrupted
prior settle attempt, or -- per the earlier live investigation -- a stray
`.beads/dolt` per-project-mode-looking directory that turned out to be
orphaned residue from an old interrupted recovery): do NOT assume it is safe
to route through. Kill it first (same teardown path as 3.2 step 6, applied
proactively), THEN start a fresh one against the canonical data dir from
step 0. This keeps `settleDoltConflicts` idempotent and self-healing against
its own prior failures, not just against ordinary merge conflicts.

### 3.6 Manual verification plan across all 3 OSes

This must be done by hand (not via fleet-sprint) before this is considered
done, per the explicit instruction that started this branch. For EACH of
Windows (`fleet-win-dev1`), Linux (`fleet-lin-dev1`), and macOS (`fleet-mac`):

1. **Prereq check**: confirm `bd dolt status` on the member starts in
   `embedded` mode (matches the fleet's real baseline).
2. **Manufacture a real row-level conflict deliberately** (do not simulate --
   use two actual clones): from the orchestrator's own local clone AND the
   target member's clone, both starting at the same remote commit, make a
   conflicting edit to the SAME bead's SAME field from each side (e.g. change
   `status` on one, `priority` on the other -- proves cell-vs-row-level
   conflict semantics; then a second run changing the SAME field on both
   sides -- proves the LWW tiebreak actually fires). Push from the
   orchestrator side first (uncontested), so the member's next `bd dolt pull`
   is guaranteed to hit a real merge conflict.
3. **Run `settleDoltConflicts` against the member** (initially by hand,
   running each step of 3.2 as discrete commands via `execute_command` per
   OS, before it's wired into automated `runner.js` code) and capture:
   - the exact spawn technique's success/failure per OS (WMI on Windows;
     `nohup`+`disown` on POSIX -- confirm POSIX detachment ALSO survives the
     SSH session the way Windows notably did NOT with `Start-Process`; do not
     assume POSIX is fine just because the existing `task-wrapper.ts` bash
     pattern assumes it).
   - the connect/query flag set working identically on all 3 (the ordering/
     `--user` landmines were only verified on Windows so far -- confirm the
     SAME landmines, or their absence, on Linux/macOS `dolt` builds).
   - the settle SQL actually producing the LWW-correct row (query the
     resolved row afterward and confirm it matches which side had the later
     `updated_at`, not just that `dolt_conflicts` is empty).
   - `bd dolt push` succeeding and the orchestrator's own subsequent
     `bd dolt pull` seeing the settled, correct row.
   - teardown leaving zero residual processes/ports/mode-flips.
4. **Record pass/fail per OS per step** in this doc's Part 4 (append a table
   once the runs happen) before calling any OS done.

---

## Part 4 -- manual verification log (fill in as runs happen)

| OS | Date | Spawn technique verified? | Flag set verified? | LWW correctness verified? | Teardown clean? | Notes |
|----|------|---------------------------|---------------------|----------------------------|------------------|-------|
| Windows (fleet-win-dev1) | | | | | | |
| Linux (fleet-lin-dev1) | | | | | | |
| macOS (fleet-mac) | | | | | | |

---

## Part 5 -- pinning a working Dolt version end-to-end

The manual verification pass (2026-08-12/13, fleet-win-dev1) contained one
genuine mistake, caught and corrected the same day: it installed dolt via
`winget install --id DoltHub.Dolt`, which silently delivered a STALE build
(1.86.3) while the vendor's current release is 2.2.3 -- and while this repo
already carries a version pin. This Part makes the pin airtight end-to-end
and supersedes both `dolt-manual-recovery-verified.md` step 1 (the
winget/apt/brew instructions -- to be corrected in that doc) and the Part 3.2
step-1 code sketch. A first revision of this Part contained its own error --
it assumed members run `apra-fleet install` -- corrected in 5.2 below.

### 5.1 The pin, and its single source of truth

`src/cli/dolt-install.ts` holds the repo's only Dolt version pin and asset
knowledge:

- `export const DOLT_VERSION = 'v2.2.0'` (line 22). Assets download directly
  from `https://github.com/dolthub/dolt/releases/download/v2.2.0/` per
  platform/arch (`resolveDoltAsset`, lines 48-78: win32/x64 ->
  `dolt-windows-amd64.zip`, linux/x64 -> `dolt-linux-amd64.tar.gz`,
  darwin/x64 and darwin/arm64 -> the darwin tarballs; any other combo throws
  `UnsupportedDoltPlatformError`, never a silent no-op).
- `downloadAndExtractDolt(destDir)` extracts the single static binary into a
  caller-supplied dir -- on the orchestrator, `BIN_DIR` = `~/.apra-fleet/bin`
  (`src/cli/config.ts:9`). Never system PATH, no admin rights.
- `verifyDolt(doltPath)` is a *functional* check, not an existence check: it
  runs `dolt version` (throws on failure -- catching present-but-broken
  binaries) then smoke-tests a real `dolt sql-server` (warn-not-fail).

Anything else -- winget, apt, brew, `install.sh | bash` -- is a second,
unpinned version channel and is banned from every code path and runbook this
design owns. The winget incident is the proof: the winget package is not even
vendor-current (1.86.3 vs 2.2.3), so "install via package manager" does not
merely risk drift, it guarantees it.

### 5.2 Orchestrator and member are NOT symmetric (corrected premise)

Verified against the actual provisioning code, not assumed:

- **The orchestrator** is the machine running `apra-fleet` itself. It goes
  through `apra-fleet install`, whose apra-fleet-ire.3 Dolt step
  (`src/cli/install.ts:1368-1401`) really attempts
  `downloadAndExtractDolt(BIN_DIR)` + `verifyDolt` in-process. That step is
  NON-FATAL (try/catch, "a missing/broken dolt must never fail apra-fleet
  install", plus the `doltStepEnabled()` gate at install.ts:57-60), so even
  the orchestrator's binary must be verified, never assumed -- but at least
  a pinned install was *attempted* there, and re-running `apra-fleet
  install` locally is a complete repair path (the already-installed check at
  install.ts:1382 makes re-runs idempotent).
- **A fleet member never runs `apra-fleet` at all.** It is an SSH-reachable
  command target. Member onboarding (`src/tools/register-member.ts` +
  `src/services/agent-provisioner.ts`) provisions SSH auth, workspace
  overlays, LLM/agent assets, and credentials -- it installs neither `bd`
  nor `dolt`, and no code path anywhere dispatches `apra-fleet install` to a
  member (repo-wide search: the string appears only in orchestrator CLI help
  text and docs). `docs/beads.md:82`'s statement that "`apra-fleet install`
  also provisions a portable Dolt CLI" is true only of the machine running
  the install -- i.e. the orchestrator.

So the reason a member lacks a correctly-pinned dolt is not "the non-fatal
install step failed there" (this document's earlier framing -- wrong): it is
that **nothing has ever attempted to install one there, full stop**. What a
member *may* have is a stray, arbitrary-version dolt from manual operator
action -- fleet-win-dev1's winget 1.86.3 is a live example sitting on a real
member right now. Conclusion: on members, pin enforcement cannot be
delegated to any install-time mechanism, because none exists. It must be
done by the thing that needs the binary: settle itself.

### 5.3 Settle checks AND installs the pinned dolt on the member

`settleDoltConflicts()` is self-sufficient: step 1 probes for the pinned
binary and, if it is missing or the wrong version, **installs it itself over
`command()`** before proceeding. (This supersedes Part 3.2 step 1's sketch,
which called the orchestrator-local `downloadAndExtractDolt()` -- impossible
across a `command()` dispatch boundary -- and this document's earlier
throw-and-defer-to-readiness-gate design.)

**Step 1a -- probe.** The fleet-managed member-side location is
`~/.apra-fleet/bin/dolt(.exe)` -- the same `BIN_DIR` convention as the
orchestrator, resolved with the MEMBER's shell (`$env:USERPROFILE` /
`$HOME`), so the layout is identical everywhere and, on a machine that is
both orchestrator and local member, both writers produce identical bytes at
the identical path.

```js
const res = await command(`"<memberDoltPath>" version`);
// PASS requires BOTH: exit 0 with parseable "dolt version X.Y.Z" output
// (the remote functional equivalent of verifyDolt's throwing version
// check -- a file that exists but cannot run `dolt version` is BROKEN),
// AND the version equals the pin (2.2.0). Anything else -> step 1b.
```

**Step 1b -- install, via remote shell, from the SAME pinned asset URLs.**
Resolve the member's platform/arch first -- NOT `process.platform` (that is
the orchestrator's): take it from the member registry metadata the caller
already has (`detectOS` at registration), with a remote fallback probe
(`node -e "console.log(process.platform, process.arch)"` -- members
necessarily have node, since `bd` is npm-installed). Feed that pair through
the same platform->asset mapping `resolveDoltAsset` defines, yielding the
exact `.../download/v2.2.0/<asset>` URL. Then:

```powershell
# Windows member
New-Item -ItemType Directory -Force "$env:USERPROFILE\.apra-fleet\bin"
Invoke-WebRequest -Uri <assetUrl> -OutFile "$env:TEMP\dolt-settle.zip"
Expand-Archive -Force "$env:TEMP\dolt-settle.zip" "$env:TEMP\dolt-settle"
# Release archives nest the binary (e.g. dolt-windows-amd64/bin/dolt.exe) --
# locate by name, exactly like extractSingleFileFromZip does by basename:
Get-ChildItem -Recurse -Filter dolt.exe "$env:TEMP\dolt-settle" |
  Select-Object -First 1 | Copy-Item -Force -Destination "$env:USERPROFILE\.apra-fleet\bin\dolt.exe"
```
```bash
# POSIX member
mkdir -p "$HOME/.apra-fleet/bin"
curl -fL --max-time 300 <assetUrl> -o /tmp/dolt-settle.tgz
mkdir -p /tmp/dolt-settle && tar -xzf /tmp/dolt-settle.tgz -C /tmp/dolt-settle
install -m 0755 "$(find /tmp/dolt-settle -type f -name dolt | head -1)" "$HOME/.apra-fleet/bin/dolt"
```

Then **re-probe (step 1a again)**: the freshly installed binary must pass
the version check before settle continues. Cleanup of the temp
archive/extract dir happens in settle's existing `finally`.

Safety bounds, so a settle-time install can never make recovery worse than
the conflict it is fixing:

- **Bounded time:** a hard timeout on the download dispatch (300s;
  `--max-time` / `Invoke-WebRequest -TimeoutSec`, plus the `command()`
  timeout as backstop). The asset is a single ~100MB static binary; if it
  cannot arrive in that window, the member's network is the problem.
- **One attempt.** No retry loops inside settle; a failed install throws.
- **Classification:** download/HTTP failure, unsupported platform/arch, and
  a corrupted download (post-install re-probe fails) are typed operational
  errors (`DoltBinaryUnavailableError`: member, URL, failing output, exact
  manual repair command) -- ordinary infra failures under Part 2.2's
  degraded/fatal taxonomy, NOT escalation tiers. One deliberate exception --
  a blocked *replacement* of an existing binary -- degrades instead of
  throwing; that is 5.6.

The earlier objections to a settle-time download (unbounded mid-recovery
network dependency, second-installer drift risk) are answered rather than
dismissed: the time bound is explicit and single-shot; the drift risk is
closed structurally in 5.4 because the shell installer shares the pin/asset
source of truth under a drift guard, and on members there is no alternative
installer to drift *from* -- deferring repair to an install mechanism that
does not exist on members was the actual design error.

### 5.4 One pin, two executors -- kept from drifting; and `install.cjs`

Two pieces of code now materialize the pin: `downloadAndExtractDolt`
(in-process, orchestrator) and settle's remote-shell installer (members).
They must share one source of truth. `dolt-settle.mjs` cannot import the
TypeScript `src/cli/dolt-install.ts` across the package boundary at runtime,
so: `dolt-settle.mjs` exports its own `DOLT_VERSION`/asset-map constants,
and a mandatory unit test asserts them equal to the values parsed from
`src/cli/dolt-install.ts`'s source text -- the exact source-text drift-guard
convention this repo already uses (`test/dolt-literal-guard.test.mjs`,
`contracts-schema-dist-staleness-guard.test.mjs`). A pin bump that touches
one file and not the other fails CI.

`install.cjs` (repo root, read in full -- 22 lines): a thin launcher that
spawns `node dist/index.js install <args>` (install.cjs:8-21), i.e. the SAME
compiled `install.ts` path, same pin, same non-fatal semantics. It is not a
second mechanism and holds no second pin -- and per 5.2 it is
orchestrator-only; no member ever executes it. One precise caveat: it runs
whatever `dist/` is present, so a stale build carries a stale pin -- covered
by extending the dist-staleness guard above to assert the built `dist`
embeds the current `DOLT_VERSION`.

### 5.5 Is `v2.2.0` the right pin? Yes -- but the landmines are UNVERIFIED on it

Keep `v2.2.0`. It is the pin the apra-fleet-ire PoC validated
(dolt-install.ts:4-10) and no known bug motivates chasing the vendor's
2.2.3; bumping the pin is separate work with its own verification pass.

**The gap, stated as hard preconditions rather than a footnote:** every
mechanical landmine settle encodes -- `--no-tls` ordering before
`--host`/`--port`, omitting `--user`/`--password` entirely, the
`DOLT_CONFLICTS_RESOLVE` table-name requirement, the Part 3.2 step-4
`--theirs`-after-LWW-UPDATE interplay -- was live-verified against the stray
winget **1.86.3**, NOT against pinned **v2.2.0**. Numbered preconditions of
the Part 4 / Part 6 verification work:

1. **Precondition V0 (per OS):** before any Part 4 cell is marked verified
   for an OS, re-run the full flag-set/landmine matrix of
   `dolt-manual-recovery-verified.md` step 3 against the member-side binary
   settle itself installed (5.3), at v2.2.0, and record the exact
   `dolt version` output in that OS's Part 4 Notes cell. A row without a
   recorded v2.2.0 version string is not a verified row.
2. **Precondition V1:** the Part 6 integration script asserts, after
   settle's step 1 has run, that the member-side binary settle used reports
   exactly the pinned version -- thereby exercising settle's own installer
   on a member that never had a pinned dolt, and guaranteeing no green run
   is ever produced by an unpinned binary again. A run that completed via
   the 5.6 degraded fallback reports DEGRADED, never PASS.
3. **Precondition V2:** correct `dolt-manual-recovery-verified.md` step 1 to
   the settle-installer/`~/.apra-fleet/bin` path and mark the
   winget/apt/brew instructions as the historical mistake they were.

### 5.6 When the pinned install is BLOCKED: kill-first, then warn-and-fall-back

New failure mode, explicitly designed for: step 1b must *replace* an
existing wrong-version binary at `~/.apra-fleet/bin/dolt(.exe)`, and on
Windows an in-use executable cannot be overwritten -- a running `dolt`
process (most plausibly settle's own orphaned ephemeral server, the Part
7.2/3.3 residue class) holds the file. Handling ladder:

1. **Detect specifically.** The final copy/`install` step fails with a
   sharing-violation class error ("being used by another process",
   EBUSY/ETXTBSY/EPERM-on-replace). Only THIS class enters the ladder;
   download/extract failures remain hard operational errors per 5.3.
2. **Remediate first -- kill, then retry once.** Enumerate processes whose
   *executable path equals the target binary path*
   (`Get-Process | Where-Object { $_.Path -eq <path> }` /
   `lsof <path>` / `fuser`): any such process is by definition a fleet
   orphan -- nothing but settle and this installer ever launches the binary
   at the fleet-managed path -- so killing it is the same legitimate
   self-heal as Part 3.3's sweep, not collateral damage. Kill, wait
   briefly, retry the replacement once. A process holding the file that is
   NOT running our binary path (e.g. an operator's own dolt install
   elsewhere, an AV scanner) is not ours to kill -- skip to step 3.
3. **Only then: warn and fall back, per explicit direction -- but gated,
   not blind.** Settle logs and returns a WARNING ("pin not enforced on
   <member>: could not replace <path>; proceeding with dolt <version> at
   <path/PATH>"), selects a fallback binary -- the existing runnable binary
   at the fleet path first, else `dolt` on the member's PATH -- and
   requires it to pass a functional gate before any data is touched:
   `dolt version` must run, and the FIRST statement issued through the
   ephemeral server must be a harmless
   `dolt --no-tls --host=... --port=... sql -q "SELECT 1"` preflight. That
   one command exercises exactly the version-sensitive landmine surface
   (global-flag ordering, credential-less auth); if the fallback's parsing
   differs, settle fails fast with a clean operational error before the
   merge is ever reopened. Only if the preflight passes does settle proceed.
4. **Return-shape addendum to Part 3.1:** settle's result gains
   `warnings: string[]` and `doltVersionUsed: string`; callers log
   warnings, and the Part 6 script maps a non-pinned `doltVersionUsed` to
   DEGRADED (per V1).

Is the degraded path's "landmines unverified on this version" exposure
acceptable? **Yes, as a clearly-flagged last resort** -- on evidence, not
optimism: the entire landmine set was in fact discovered on and works on
1.86.3, and the pinned target is 2.2.0, so the flag surface is demonstrably
stable across a wide version span; the `SELECT 1` preflight converts the
residual risk into a fast, data-free failure; and the step-4 verification
(`dolt_conflicts` count must be 0 before commit/push) remains the hard
correctness gate regardless of which binary executed the SQL. The
alternative -- hard-failing settle because a file handle was held -- would
reintroduce exactly the "recovery that refuses to recover" posture this
redesign exists to eliminate. What is NOT acceptable, and remains a hard
throw: no runnable dolt at all after the ladder (missing pin install +
no usable fallback), an unsupported platform with no existing binary, or a
fallback that fails the functional gate.

---

## Part 6 -- the integration script: manufacture a real conflict, prove settle() recovers

Scope, deliberately narrow: **a reliable script, run from the orchestrator,
against any one member at a time**, that (a) deliberately manufactures a
genuine Dolt row-level merge conflict between the orchestrator's clone and
that member's clone, (b) invokes the real `settleDoltConflicts()` through the
real dispatch path, and (c) proves recovery with explicit assertions. It is
the executable form of Part 3.6 and the tool that fills in Part 4's table.
It is not a mocked unit test and it is not a CI suite.

### 6.1 File, invocation, and why that location

**File:** `packages/apra-fleet-se/scripts/dolt-settle-integration.mjs`.

Rationale: `packages/apra-fleet-se/scripts/` is this package's existing home
for runnable operator-facing launchers (`scripts/run-tests.mjs`), and --
decisive for gating -- the package's `test` script globs only
`test/*.test.mjs` (package.json:16), so nothing under `scripts/` can ever be
swept into `npm test` by accident. The mocked unit coverage for
`dolt-settle.mjs` (scripted `command()`, exactly how Path A was tested in
`test/dolt-sync-discipline.test.mjs`) is a separate, ordinary
`test/dolt-settle.test.mjs` that DOES run in `npm test`; this script is the
live complement, not a replacement for that.

**Invocation:**

```
node scripts/dolt-settle-integration.mjs --member fleet-win-dev1
node scripts/dolt-settle-integration.mjs --all        # win-dev1, lin-dev1, mac -- strictly sequential
node scripts/dolt-settle-integration.mjs --member fleet-mac --keep-sandbox   # debug aid: skip teardown of the sandbox remote/dirs
```

plus a package.json convenience entry:

```json
"test:dolt-settle-integration": "node scripts/dolt-settle-integration.mjs"
```

`--all` iterates the three members one at a time in a fixed order, never in
parallel (per the explicit requirement), with a full setup/teardown cycle per
member so a failure on one OS cannot contaminate the next.

### 6.2 Gating -- decisively NOT part of `npm test`

This script requires a live apra-fleet server and SSH-reachable members --
things no generic CI runner has. Decision: it is **never** wired into
`npm test`, `test:unit`, or `test:slow`; it is a manual / dedicated-runner
entry point only. The repo has no existing env-var gate convention for
live-fleet tests (searched: the closest precedent is
`test/dolt-sync-discipline.test.mjs`'s "skip with a clear message, never a
silent pass" posture for a missing dolt binary, lines 96-101). This script
adopts the same posture translated to a script: a **preflight** that calls
`fleet_status`/`list_members` and probes each target member with a trivial
`execute_command` echo; any unreachable prerequisite exits with code 2 and an
explicit "PRECONDITION FAILED (not a settle failure): ..." message. Exit 0 =
proven recovery; exit 1 = a real assertion failure; exit 2 = environment not
available. No silent green, ever.

### 6.3 Real plumbing, no reimplementation

The script connects exactly the way `bin/cli.mjs` does (imports from
`@apralabs/apra-fleet-client`): `resolveFleetServerConnection` from
`@apralabs/apra-fleet-client/server-resolution`, `McpClient` over the
resolved transport, wrapped in `ApraFleet`. The member-scoped command runner
is the same shape the sprint runner already injects everywhere
(cli.mjs:632-638):

```js
const commandFor = (member) => async (cmd, opts = {}) => {
  const res = await fleetApi.executeCommand({ command: cmd, member_name: member, ...opts });
  // parse stdout/stderr/exitCode from the execute_command result envelope,
  // identically to the runner's own parsing
};
```

Settle is invoked as the **real import** --
`import { settleDoltConflicts } from '../fleet-sprint/dolt-settle.mjs'` --
with `command: commandFor(member)`. Server side, that traverses the real
`src/tools/execute-command.ts` SSH dispatch. Nothing in the conflict path is
mocked or re-implemented; the only test-specific code is sandbox setup,
conflict manufacture, and assertions.

Before touching the member, the script takes a **member reservation** (the
same `member_reservation` tool `createMemberReservationClient` uses,
runner.js:1467-1490 / cli.mjs:730-734) so a concurrently-launched sprint
cannot dispatch onto the member mid-test, and releases it in the final
`finally`. The `dolt_push_mutex` is NOT taken: it serializes pushes to the
*production* remote, and per 6.4 this script never touches that remote.

### 6.4 Sandbox, not production -- decided

**The script never touches the real shared beads DB or any production
`.beads` clone. Mandatory, not optional.** Justification: the script's whole
purpose is to manufacture wedging conflicts and then run brand-new recovery
code against them; a settle bug mid-test would wedge or mis-merge whatever DB
it ran against. Doing that against the production remote -- while real
sprints may be pushing -- converts a test failure into a production incident.
A "disposable test bead inside the production DB" is therefore rejected too:
the bead may be disposable, but the *clone wedging and the merge commits* are
not scoped to the bead.

Concrete isolation, per member run:

- **Orchestrator side:** a fresh temp dir on the orchestrator machine;
  `bd init` a new beads DB there; create one test issue whose id/title are
  unmistakable (`[SETTLE-IT] disposable conflict fixture <runId>`).
- **Sandbox remote:** a dedicated database named
  `beads-settle-it-<runId>` on the **same remote endpoint and credentials
  the fleet's production beads DB already uses** -- reusing the one
  remote/auth path all three members have already proven reachable (a
  separate ad-hoc remote server would add an unproven network dependency and
  violate 6.2's "no new environment assumptions"). Distinct database name =
  full isolation from production data and refs. Configure the temp clone's
  sync remote to it; `bd dolt push` the baseline.
- **Member side:** a fresh temp dir on the member (`command()`-created),
  bootstrapped from the sandbox remote using the same clone-bootstrap
  sequence the fleet already uses for provisioning (the sequence Path B's
  re-bootstrap encodes in `dolt-recovery-path-b.mjs` -- lift it before that
  file is retired per Part 2.4). All member-side `bd`/`dolt` commands run
  with cwd set to this temp dir, so the member's real production clone is
  physically out of scope of every command the script issues.
- **Teardown (`finally`, always, unless `--keep-sandbox`):** delete the
  sandbox remote database, remove both temp dirs, release the reservation.

### 6.5 The per-member flow (sequential, two scenarios)

For the target member M, starting from both clones at the same sandbox head:

1. **Probe** (Precondition V1, Part 5.5): `"<memberDoltPath>" version` on M
   must report exactly the pinned 2.2.0; `bd dolt status` in M's sandbox
   clone must report embedded mode. Fail (exit 1) on mismatch.
2. **Orchestrator edit + push:** update the test bead's target field in the
   orchestrator clone (e.g. `bd update <id> --priority 1`), `bd dolt push`.
   Uncontested -- this becomes the remote ("theirs") side.
3. **Member conflicting edit:** on M, update the SAME field of the SAME bead
   to a different value (`bd update <id> --priority 3`) -- strictly
   wall-clock-after step 2, so M's row carries the later `updated_at` and the
   LWW-correct final value is unambiguous (3).
4. **Prove the conflict is real:** run `bd dolt pull` on M and **assert it
   FAILS** with output matching a genuine merge conflict
   (`isDoltPullConflict`-class patterns). If the pull succeeds -- e.g. a
   future bd auto-resolves it (Part 2.3's accelerator) -- the run is reported
   INCONCLUSIVE-FOR-SETTLE (exit 2), never PASS: the script must not claim
   settle recovered a conflict that never existed.
5. **Invoke `settleDoltConflicts(M, { command: commandFor(M), log })`** and
   assert it resolves with `ok: true` and `resolvedTables` containing
   `issues`.
6. **Assert, independently of settle's own return values:**
   a. M's `bd dolt status` is clean and reports embedded mode; a direct
      conflict re-check shows zero conflicts.
   b. `bd show <id> --json` on M: the contested field equals the
      LWW-correct value (3 -- M's later `updated_at` won) and `updated_at`
      equals the max of the two sides. Asserting the *value*, not just
      "conflicts empty", is what catches a wrong-direction resolve.
   c. M's republish push succeeded (settle step 5's push exit status,
      re-verified by the script via `bd dolt status` / push idempotency).
   d. Orchestrator convergence: `bd dolt pull` in the orchestrator clone,
      then `bd show <id> --json` there shows the same settled value.
   e. **Zero residue on M:** no process matching `dolt sql-server` in the
      settle port range (`Get-Process`/`pgrep -f`), TCP connect to the used
      port now refused, `bd dolt status` still embedded,
      `.beads/metadata.json` `dolt_mode` still `"embedded"`, ephemeral log
      file removed.
7. **Scenario 2 -- disjoint fields:** repeat 2-6 with the orchestrator
   changing `status` and M changing `priority`. This exercises the row-level
   (not cell-level) conflict shape from Part 1.2 and asserts BOTH sides'
   field values survive in the settled row -- the per-field merge, not a
   whole-row clobber.
8. **Report:** print one summary line per OS in exactly Part 4's column
   format (`| <OS> | <date> | yes/no | yes/no | yes/no | yes/no | dolt
   <version>, <notes> |`). **Filling Part 4 IS running this script once per
   member and pasting the emitted rows.** A Part 4 row filled any other way
   should say so explicitly in its Notes.

### 6.6 Relationship to `npm test`, restated decisively

- `npm test` (CI, every PR): mocked `dolt-settle` unit suite only
  (`test/dolt-settle.test.mjs`, scripted `command()`, no network, no fleet).
- `npm run test:dolt-settle-integration`: this script; run manually from an
  orchestrator with a live fleet, and required -- all three members green,
  on pinned v2.2.0 (Preconditions V0/V1) -- before this branch's redesign is
  declared verified. It is intentionally NOT in any default CI pass, and no
  CI configuration should be added that pretends otherwise.

---

## Part 7 -- persistent vs. ephemeral `dolt sql-server`, answered precisely

The question: is there any harm in leaving the dolt server running? If
multiple members share one OS, each with its own embedded-dolt database, can
each simply have its own long-lived server -- is the only issue knowing which
server belongs to which member?

### 7.1 Multiple members per machine, one server each: NOT a problem

Two (or N) independent `dolt sql-server` processes on the same machine, each
bound to a distinct loopback port and pointed at a **distinct** `--data-dir`,
have no meaningful interaction. This is confirmed against Dolt's own storage
architecture, not assumed: every lock Dolt takes lives *inside the served
data directory* -- the chunk-journal filesystem lock and the
`sql-server.info` running-server marker are both per-`.dolt`-dir artifacts --
so two servers over two directories share nothing but ordinary OS resources
(CPU, RAM, disk bandwidth) and the port namespace, which distinct ports
resolve by construction. There is no global dolt registry, no shared lock, no
cross-database state.

And "which server belongs to which member" is, exactly as the question
suspects, trivial bookkeeping, not a hard problem: each member's own
`.beads/metadata.json` already records its dolt routing (`dolt_mode`, and
host:port when in server mode -- the very fields `bd dolt status` reports,
Part 3.2 step 0). Member-local config records a member-local port; no
cross-member coordination is ever needed. **So per-member servers were never
rejected because of identification or co-tenancy. That was not the reason.**
For the ephemeral design, co-tenancy needs only one sentence of care: the
port-range probe in Part 3.2 step 2 already makes concurrent settles on two
co-located members pick different ports.

### 7.2 The real risk -- same data dir, two engines -- and its true severity

The hazard is the SAME member's data dir being open in two engines at once:
bd in embedded mode (which links Dolt's own storage libraries in-process) and
a separate `dolt sql-server`, both on one `--data-dir`.

What actually happens, per Dolt's storage design (verified against upstream,
consistent with this repo's prior findings): Dolt's chunk store is guarded by
a **per-directory exclusive-access lock** -- the sql-server acquires
exclusive access via a filesystem lock on the chunk journal and drops a
`sql-server.info` marker; the chunk journal itself is a **single-writer,
append-only** persistence structure, and manifest updates flow through that
same held lock. A second dolt-based process attempting to open the same
directory for writing does not silently corrupt anything -- it **fails
closed**: it either errors ("database is locked to another dolt process" /
`ErrDatabaseLocked`) or degrades to read-only. Since bd embeds these same
libraries, bd participates in the same protocol.

Two consequences, stated plainly:

1. **This design's corruption anxiety was over-cautious.** Concurrent
   dual-engine access to one data dir is not a demonstrated
   corrupt-the-chunk-store hazard; it is a deterministic
   **lock-failure/availability** hazard. The 5mqg incident's damage was an
   orphaned server *holding the lock and wedging subsequent embedded bd
   commands* plus un-reverted routing state -- not chunk-store corruption.
2. **It exposes a real ordering bug in Part 3.2, corrected there:** step 5
   was originally written to run `bd dolt pull` / `bd dolt push`
   (embedded-mode bd, which must open the data dir) while the ephemeral
   server was still up -- teardown was only step 6. Embedded bd would hit the
   server's exclusive lock and fail or fall back read-only. Part 3.2 above
   has been corrected in place: tear the server down FIRST -- kill the
   recorded pid and verify the port closed -- and only then run the
   republish. The `finally` teardown remains as the guarantee for throw
   paths; the happy path simply reaches it before, not after, republishing.

### 7.3 Option C -- permanent per-member server, bd committed to server mode

Option C: run one ALWAYS-ON `dolt sql-server` per member and flip that
member's bd permanently to `dolt_mode: "server"` against it -- no embedded
mode, no ephemeral side-channel. Evaluated on its actual merits:

- **Does it eliminate the detachment headache? No -- it converts it into a
  permanently-owned service-management problem.** The WMI dance exists
  because a process must outlive an SSH session. An always-on server must
  additionally outlive **reboots and crashes**, which on Windows means a real
  Windows Service -- requiring admin rights, which the fleet's install
  posture explicitly does not have (`dolt-install.ts` line 10: "no
  admin/system install needed"; the entire `BIN_DIR` design exists to avoid
  elevation) -- or a scheduled task, which is *proven broken* in this exact
  environment (`SCHED_S_TASK_QUEUED`, no interactive logon: the
  apra-fleet-i8qj failure, re-reproduced live in
  `dolt-manual-recovery-verified.md` step 2). The remaining option is a
  WMI-spawned session-0 process plus a bespoke supervisor watchdog for
  liveness, restart, and stale-port recovery, per member, forever. That is
  strictly MORE operational machinery than a 10-30 second ephemeral spawn
  whose entire lifecycle sits inside one `try/finally`. (Linux systemd user
  units need lingering enabled; macOS launchd is workable; but the design
  must be uniform across a Windows-heavy fleet, and Windows is the hard
  case.)
- **It reopens ga61's risk surface, permanently, for everything.** The
  corrected ga61 finding is precise: the interactive credential-prompt bug is
  specific to the raw manually-invoked dolt CLI with explicit
  `--user`/`--password` -- but bd's OWN compiled client in server mode
  showed a separate, real, live failure ("database 'beads' not found on Dolt
  server", suspected server-readiness race). Under Option C, **every bd
  command on that member, in every dispatch, forever** runs through that
  least-proven client path -- reintroducing at per-member scope the exact
  argument that killed full centralization in Part 2.1(1). The ephemeral
  design keeps bd embedded 100% of the time and exposes only the raw dolt
  CLI (with the fixed, verified flag set) to a server, for seconds. Settle
  never routes bd through a server at all.
- **It adds an availability coupling embedded mode does not have.** Server
  down (crash, reboot, upgrade window) means every bd command on that member
  fails until the watchdog wins -- Part 2.1(2)'s total-availability argument,
  at member scope. Embedded bd has no liveness dependency.
- **Security surface:** an always-listening loopback port whose
  authentication is the documented root/empty-password default (the very
  default settle exploits to avoid the credential bug) makes the member's
  full beads DB writable by any local process, indefinitely -- times N
  members per host. Loopback-only, so not critical, but it is a standing
  surface bought for zero functional gain, versus one that exists for
  seconds under a recorded pid.

### 7.4 Decision

**Keep the ephemeral design of Part 2, amended with the 7.2 ordering fix
(teardown before republish).** Per-member persistent servers are not rejected
because of co-tenancy or server-identification -- 7.1 shows those concerns
are empty -- but because Option C buys nothing the ephemeral design lacks
(the conflict path is rare and takes seconds) at the cost of: a permanent
per-member service-management subsystem with no admin-free Windows story, a
permanent commitment of every bd command to the fleet's least-proven client
path (the live ga61-class readiness failure), a new availability coupling,
and a standing open port.

Revisit Option C only when ALL of the following hold, none of which hold
today: (1) bd's server-mode client has closed the ga61-class races with
regression evidence, (2) the fleet has an elevation-capable,
cross-OS-uniform service management story, and (3) conflict/settle frequency
is demonstrably high enough that per-settle server spawns are a measured
throughput problem. Until then, embedded-always plus ephemeral-settle is the
configuration every piece of live evidence in this document actually
supports.

---

## Part 8 -- beads to evaluate once this work lands

A deep search of the shared beads DB (`bd search`, plus reading every hit and
its parent/child chain in full) turned up more than the two P0s this design
was already tracking. Several closed beads' close reasons are directly
contradicted by evidence gathered in the course of this design, and there is
a whole parent epic whose disposition assumed the old ladder was working.
None of this list should be actioned automatically -- each item needs a
deliberate close/reopen/comment decision once `dolt-settle.mjs` actually
lands and passes the Part 6 integration script, not before.

### 8.1 Close once settle() lands and is verified (Part 4/6 green on all 3 OSes)

- **`apra-fleet-ga61`** (P0, open) -- "bd/Dolt network client fails on
  Windows in non-interactive sessions." Settle's design closes this at the
  root: bd stays embedded 100% of the time (Part 7.2/7.4's decision), and
  the only code that ever talks to a `dolt sql-server` is settle's own raw
  CLI invocation using the exact fixed, landmine-safe flag set (Parts 3.2,
  5.5-5.6). Close with a comment citing the shipped `dolt-settle.mjs` and the
  Part 4 verification log as evidence, not just the design doc.
- **`apra-fleet-5mqg`** (P0, open) -- "Tier 2's server-mode revert is an LLM
  instruction step, not a guaranteed rollback." Directly and completely
  closed by this redesign: there is no more LLM-driven Tier 2 in the
  recovery path (Part 2.4/2.5), and settle's teardown is a real code
  `finally` (Part 3.2 step 6) plus a supervisor orphan sweep (Part 3.3) as a
  second layer. Close once the Part 6 script's residue assertions (6.5.6e)
  pass on all 3 OSes -- that is the actual regression test for this bead.

### 8.2 Reopen with evidence -- closed on a claim this design's own investigation disproves

- **`apra-fleet-vkc`** (closed 2026-08-10, "Wire or decommission the existing
  dolt-recovery ladder... currently unwired, same failure pattern as the
  id-allocator/mutex") -- close reason states "ladder wired as internal
  detail of dolt-sync.mjs." This is misleading at best: per Part 1.4 of this
  document, confirmed against `runner.js:1142` and 4 independent live sprint
  incidents, Path A is reached but its precondition guard throws on every
  single invocation (no `sql`/`spawnSqlServer` ever injected), and Path B is
  deliberately disabled -- so in production only Tier 2 (the LLM escalation)
  ever does anything. "Wired" in the literal sense (the function is called)
  is true; "wired" in the sense the bead title implies (capable of resolving
  a conflict without an LLM) is false. Reopen with this evidence, OR -- more
  likely the right call given settle() replaces the whole ladder outright --
  close it again for real once settle() ships, with a comment that
  supersedes the original (now-inaccurate) close reason rather than letting
  a false claim stand uncorrected in the historical record.
- **`apra-fleet-vkc.1`** (closed 2026-08-10, "Decide and execute: wire the
  dolt-recovery ladder into doltPushAfter() or decommission it") -- close
  reason cites "39/39 ladder unit tests, 14/14 wiring-shape test" passing.
  Those tests verify the *shape* of the wiring (opts flow through correctly,
  `enablePathB:false` is set) -- they do not appear to assert Path A ever
  successfully resolves a conflict with a real `sql()` runtime, which this
  design's own investigation shows was never possible in production. Same
  disposition as `vkc`: reopen with evidence, or supersede via a comment once
  settle() lands and the ladder modules it replaces are deleted.
- **`apra-fleet-vkc.2`** (closed 2026-08-10, "doltPushAfter conflict path
  reaches the recovery ladder (or ladder is provably absent)") -- narrower
  claim than vkc/vkc.1 ("reaches the ladder", not "the ladder resolves
  anything"), and that narrower claim does appear to still be literally true
  (Tier 2 is genuinely reached). Lower priority than vkc/vkc.1 -- just needs
  a comment once settle() lands noting the ladder it verified reaching has
  been replaced, not a reopen.

### 8.3 Review, not necessarily close -- epic and terminal-classification beads whose premises shift under this redesign

- **`apra-fleet-417`** (P1, open epic, "fleet-sprint dolt sync must be
  fault-tolerant") -- 9/10 children closed; the ONE thing keeping it open is
  `apra-fleet-66u`, an unrelated stall-detection-scoring bug that has nothing
  to do with dolt sync (confirmed by reading 66u's own description). So this
  epic is not blocked on dolt-sync work today -- BUT its own recorded
  disposition explicitly maps its "dolt-recovery-ladder" acceptance criterion
  onto `apra-fleet-vkc`/`vkc.1`/`vkc.2` ("live, under a different sprint
  root"), which 8.2 above shows was an inaccurate closure. Action: once
  settle() lands, add a comment to `apra-fleet-417` noting that the ladder
  criterion it deferred to vkc/vkc.1/vkc.2 has now been superseded by
  `dolt-settle.mjs`, so the epic's own acceptance criteria still fully hold
  (arguably more completely than before) -- this is a bookkeeping update, not
  a reopen, and should NOT touch `66u`'s unrelated blocking status.
- **`apra-fleet-k7b.4`** (closed, "Classify unmergeable beads Dolt conflicts
  as their own terminal state (BEADS_SYNC_CONFLICT)") and **`apra-fleet-
  k7b.8`** (closed, "[test] DOLT_DIVERGED surfaces as BEADS_SYNC_CONFLICT
  with captured conflict dump") -- not wrong, and not to be reopened; both
  describe real, still-correct behavior for settle's own genuine operational
  failures (Part 5.3's typed `DoltBinaryUnavailableError` and similar should
  still be able to surface as a `BEADS_SYNC_CONFLICT`-class terminal, or a
  clearly-named sibling, when settle itself cannot complete). Action: once
  settle() lands, review whether `BEADS_SYNC_CONFLICT` is still the right
  terminal name/semantics given that under the new design it should fire
  drastically less often (only on a genuine operational failure, never on an
  ordinary resolvable conflict) -- a naming/semantics comment update at most,
  not a functional change these beads need to re-litigate.

### 8.4 Cross-reference, do not touch -- a parallel initiative this design must not collide with

- **`apra-fleet-iiny`** (P2, open epic, "sprint-doctor: LLM-escalation
  mechanism for stalled/wedged fleet-sprint runs", 0/8 children, not
  started) -- a general-purpose, NOT dolt-specific, symptom/remedy registry
  for stalled/wedged sprints of any kind, actively being designed in
  parallel (see `packages/apra-fleet-se/fleet-sprint/docs/shared-
  orchestrator-reservation-design.md` and the most recent commit on this
  repo at design-doc-writing time). This is not a beads-hygiene item to close
  or reopen -- it is a real risk of architectural collision: once
  `dolt-settle.mjs` ships, Dolt conflicts must NOT become one of
  sprint-doctor's LLM-escalatable "symptoms" -- that would silently
  reintroduce the exact LLM-driven, no-guaranteed-rollback recovery class
  this whole redesign exists to eliminate (Part 2, Part 7.4). Action: when
  sprint-doctor's symptom/remedy registry (`apra-fleet-iiny.3`) is designed,
  cross-link it to this document and explicitly exclude Dolt/beads-sync
  wedging from its scope -- settle() (and its typed operational-failure
  throw, per Part 5.3) is the terminal answer for that failure class, not a
  sprint-doctor escalation.

### 8.5 Noted, out of scope -- found during the search, not related

- **`apra-fleet-spp`** (closed, auth-vs-divergence misclassification fix) --
  already correctly fixed in `dolt-sync.mjs`'s classification layer; settle()
  does not touch G-push/D-push classification and should not disturb this.
  No action.
- **`apra-fleet-eft.17.3`** (closed, golden-transcript no-remote D-pull
  gating) -- test-harness/golden-fixture issue, orthogonal to settle(). No
  action.
- **`apra-fleet-xuo.1`** (closed, committed the operator runbook) -- already
  done; `docs/dolt-operator-conflict-runbook.md` still needs the pointer
  update noted in Part 2.5, but that is tracked in this document already, not
  a reason to reopen xuo.1 itself.
- **`apra-fleet-4j2`** (P2, open, "integ-test-runner reported filing
  apra-fleet-bnb.1... bead does not exist") -- a Dolt-DB-adjacent data
  integrity bug (a filed bead reference vanished), but not a sync/conflict
  issue and not something settle() affects. Left open, unrelated.

