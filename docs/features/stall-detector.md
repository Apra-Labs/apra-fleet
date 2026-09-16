# Stall Detector -- Redesign Design Document

**Status:** Implemented

> **Historical design record.** This document captures the redesign that
> produced the shipped stall detector, including the live experiments that
> established how session log files behave. It is not a current API
> reference: the log-path resolution described here now lives behind each
> provider adapter's `resolveSessionLogDir()` /
> `resolveSessionLogPath()` (`src/services/stall/log-path-resolver.ts`
> delegates to them), and timing constants have since been tuned. See
> `docs/stall-detector-resilience.md` for current behavior.

---

## Problem Statement

The stall detector must fire when an `execute_prompt` session has produced no LLM output for
more than N seconds. This requires tracking the live session log file and checking whether the
last-written timestamp has advanced.

The pre-redesign implementation was broken for essentially every session:

- `fs.watch()` only works on the local filesystem -- useless for SSH-remote members
- Path encoding was wrong (`%2F`/`%5C` instead of `-`) so even local watch failed silently
- Every entry stayed `provisional: true` forever -- stall fired on spawn time only
- `toLocalISOString` appended an offset string to UTC time without adjusting the hours
- When `execute_prompt` was cancelled by MCP client disconnect, the `finally` block did not
  run -- stall entries and `inFlightAgents` were left permanently dirty

---

## Experiment Findings

### Log file locations (verified live)

| Provider | OS | Log directory | File naming |
|----------|----|---------------|-------------|
| Claude | Windows local | `~/.claude/projects/<encoded>/` | `<sessionId>.jsonl` |
| Claude | macOS remote | `~/.claude/projects/<encoded>/` | `<sessionId>.jsonl` |

### Path encoding (observed)

Claude encodes the work folder by replacing **every** `/`, `\`, and `:` with `-`:
- Windows: `C:\akhil\git\apra-fleet` -> `C--akhil-git-apra-fleet`
- macOS: `/Users/akhil/git/apra-fleet` -> `-Users-akhil-git-apra-fleet`

The pre-redesign code used `%2F`/`%5C`, which never matched.

### Activity timestamp fields

- **Claude**: The `assistant` entry has a `timestamp` field. The final `last-prompt` entry has
  no timestamp. Poll must read the last line that has a `timestamp` field.

### resume=true behavior (verified live on fleet-dev)

Two calls (`resume=false` then `--resume <sessionId>`):
- Same session ID returned for both calls
- Same file -- no new file created
- File grew from initial size to 15,329 bytes covering both turns
- The `queue-operation/enqueue` for the resumed call contains the **session ID** as content
  (not the prompt text)
- Timeline of first call: enqueue at T+0ms, first user entry at T+26ms -- **file appears
  within ~30ms of session start**

**Implication**: For `resume=true`, no grep needed. We already have the session ID -> direct
filename. Token approach only applies to `resume=false`.

### File appearance timing

- Claude: file created within ~30ms of session start (enqueue at T+0ms, first user entry T+26ms)
- mtime filter with T0 = PID-capture time reliably finds the file within the first
  10s retry window

---

## Design

### 1. Token = inv ID

The fleet server already generates a per-invocation ID (`inv`) for every `execute_prompt`
call (visible in logs as `"inv":"eobkp"`). Use this same ID as the token -- prepend
`[<inv>] ` to the `-p` argument value (the "read .fleet-task.md" string). This makes
log-to-session correlation trivial by cross-referencing the fleet log.

The actual task content in `.fleet-task.md` is untouched.

### 2. Log directory resolution (corrected)

```typescript
function sessionLogDir(provider: string, workFolder: string): string {
  const home = homedir();
  if (provider === 'claude') {
    const encoded = workFolder.replace(/[\/\\:]/g, '-');
    return join(home, '.claude', 'projects', encoded);
  }
  if (provider === 'agy') {
    throw new Error("Stall detection log polling not supported");
  }
  return null;
}
```

For remote members, `homedir()` is not used -- home dir is embedded inline in the scan
command (`$(echo $HOME)` or `$env:USERPROFILE`) so it resolves on the remote machine.

### 3. Log file discovery strategy

**Primary mechanism -- mtime filter (both cases):**

After PID is captured at time T0, the session log file will be the one modified **after T0**.
Filter by `mtime > T0` instead of grepping content -- this narrows from hundreds of files to
0-1 files instantly, with zero file reads.

- Local: `fs.readdirSync(dir)` + `fs.statSync(f).mtimeMs > t0`
- Remote: `find <dir> -newer <ref> -name "*.jsonl" 2>/dev/null | head -1`
  where `<ref>` is a temp file touched at T0, or use `-newermt <ISO timestamp>`

**Case A -- resume=false (fresh session):**
1. After PID captured: scan log dir for files with `mtime > T0`
2. Retry every **10s**, max **3 retries** (30s total)
3. If exactly 1 file found: that's the log. Log `stall_log_resolved {path, inv, provider, method:"mtime"}`
4. If 0 files after 30s: log `stall_log_not_found {dir, inv, elapsed}`, stay provisional
5. If >1 files (two sessions started same second -- very rare): verify by checking first line
   for `[<inv>]` token as tiebreaker

**Case B -- resume=true:**
- **Claude**: same file as prior session. Stored session ID -> `<logDir>/<sessionId>.jsonl`.
  Verify exists; if yes, use immediately. After server restart: session ID still in registry,
  same path. No scan needed.

Verified by experiment: Claude resume appends to the same file (same `<sessionId>.jsonl`, one
file covering both turns), so the mtime filter handles it correctly.

### 4. Activity polling (both cases)

Every **30 seconds** (soft-coded via `STALL_POLL_INTERVAL_MS` env var -- default 30000):
- Read the last 500 bytes of the log file (tail)
- Extract the last `timestamp` field (Claude)
- If expected fields are missing: log `stall_poll_format_error {path, provider}` and skip cycle
- If timestamp advanced since last poll: reset `stallReported`, update `lastActivityAt`
- If not advanced and `now - lastActivityAt > STALL_THRESHOLD_MS`: fire `stall_detected`
  once (set `stallReported=true`, reset only when activity advances)

For remote members, polling runs a shell command via the **internal SSH/shell transport**
(same layer that backs the `execute_command` MCP tool, called directly from server code).
Running these internal shell calls concurrently with an active `execute_prompt` session on
the same member is permitted -- verified empirically.

### 5. Local vs. remote scan

Primary method is **mtime filter** -- not content grep. Do NOT assume local = Windows.

| Member type | Scan method |
|-------------|-------------|
| Local (any OS) | Node.js fs directly: `fs.readdirSync(dir).filter(f => fs.statSync(f).mtimeMs > t0)` |
| Remote | Run a shell command on the member via the **internal SSH/shell transport** (the same layer that backs the `execute_command` MCP tool, invoked directly from server code -- not via the MCP tool itself) |

Remote command (Linux/macOS):
```bash
find <dir> -newermt "<T0-iso>" -name "*.jsonl" 2>/dev/null | head -1
```

Remote command (Windows):
```powershell
Get-ChildItem <dir> -Filter "*.jsonl" | Where-Object { $_.LastWriteTime -gt [datetime]"<T0-iso>" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
```

Remote home resolved inline in the command:
- Linux/macOS: `$(echo $HOME)`
- Windows: `$env:USERPROFILE`

`[inv]` token check is a **tiebreaker only** -- applied when mtime scan returns >1 file
(two sessions on same member started within the same second). Check first 3 lines of
each candidate for `[<inv>]`.

Abstract behind `findLogFile(member, t0, inv, logDir): Promise<string|null>` -- two
implementations (local Node.js fs, remote shell via internal transport) selected by
`agent.agentType`. OS detected from `agent.os` for the remote command variant.

### 6. Fix MCP disconnect / dirty state (R8)

**Root cause (confirmed by code analysis):** `abortHandler` fires correctly when the MCP
signal aborts. It calls `tryKillPid(...).catch(() => {})` -- fire-and-forget. Inside
`tryKillPid`, any kill failure is swallowed silently. `execCommand` is still `await`-ing
the subprocess and never unblocks. `finally` never runs -> `inFlightAgents` and stall entry
stay dirty permanently.

The kill can fail for several reasons (PID not yet captured, kill races subprocess exit,
remote SSH kill times out) -- all silently swallowed by the double catch.

**Fix:** Inject an `AbortSignal` into `execCommand` itself (or into the strategy's underlying
transport). When the MCP signal fires, abort `execCommand` directly -- do not depend on
killing the subprocess to unblock the await. The subprocess kill continues in parallel as
best-effort cleanup, but `execCommand` resolves via the abort path regardless.

No live experiment required -- the failure chain and fix are deterministic from code reading.

### 7. Fix toLocalISOString

```typescript
function toLocalISOString(ms: number): string {
  const d = new Date(ms);
  const offsetMin = d.getTimezoneOffset(); // positive = west of UTC (e.g. EDT = 240)
  const sign = offsetMin <= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Subtract offset to get local time as a UTC-labelled Date, then replace Z
  const local = new Date(ms - offsetMin * 60000);
  return local.toISOString().replace('Z', `${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`);
}
```

---

## Adaptive Probe Cadence

**Implemented in apra-fleet-25yl.3 and refined in apra-fleet-25yl.4.**

The stall detector polls each tracked entry on an adaptive cadence tuned to its effective
threshold, rather than once per tick. This reduces probe volume for long-threshold entries
while preserving detection latency for short-threshold ones.

### Probe Interval Formula

For each entry, the effective probe interval is:

```
probeIntervalMs = max(
  tickIntervalMs,
  min(300_000, stallThresholdMs / 5)
)
```

Where:
- `tickIntervalMs` = `STALL_POLL_INTERVAL_MS` env override (default: 30,000ms)
- `stallThresholdMs` = per-entry `thresholdMs` (set by dispatch's timeout_s) or falls back to
  `STALL_THRESHOLD_MS` env override (default: 150,000ms)

### Floor

The **floor** is the loop's own tick interval (`tickIntervalMs`), not a separate constant.
There is no `STALL_PROBE_FLOOR_MS` constant and no `STALL_PROBE_FLOOR_MS` environment
variable -- both were removed after apra-fleet-25yl.3. The floor value is the same
`STALL_POLL_INTERVAL_MS` that determines the shared `setInterval()` cadence in `start()`.
This means a probe is never skipped within a single tick cycle, preserving the invariant that
probes arrive at least as often as the detector loop itself.

### Ceiling

The **ceiling** is 300,000ms (5 minutes). This prevents absurdly long probe gaps: a
threshold of 9,000s would otherwise cause a 30-minute probe cadence, making the operator
busy status equally stale and stall detection equally delayed. The ceiling is hard-coded
and unoverridden by any environment variable.

### Gating Behavior

- A probe is **issued** (calling `pollLogFile()` or `pollDirectoryActivity()`) only once
  `now - entry.lastPolledAt >= probeIntervalMs` for that entry.
- A skipped tick (one where the gate prevents a probe) **performs no stall evaluation**: it
  does not increment or decrement idle counters, does not read as activity, and does not
  trigger a stall kill. The entry remains as-is until the next scheduled probe.
- `entry.lastPolledAt` (wall-clock `Date.now()`) is set only on ticks where a probe is
  actually issued; undefined until the first successful probe on a freshly added entry.

### Trusted Threshold

The gate uses the **stable, trusted threshold value** (`stallThresholdMs`), never the
post-clamp effective threshold from a pending tool timeout. This means an extraordinary
timeout declared in a tool call does not affect the long-term probe schedule; it only
affects the stall detection threshold on that one tick.

---

## Observability: stall_poll_tick Fields

**Implemented in apra-fleet-25yl.3.3.**

At the end of each poll tick, the detector emits a single `stall_poll_tick` log line
summarizing the outcomes of that tick's probing. This line is JSON plus an elapsed suffix
(appended by `LogScope.ok()`), so the entire line is not valid JSON by itself, but the
payload is:

### Tick-Level Summary Fields

The JSON payload of each `stall_poll_tick` scope contains:

- **`probesIssued`** (number): count of live probes actually issued on this tick
  (entries whose adaptive cadence gate fired)
- **`probesSkipped`** (number): count of entries whose probes were gated out by the
  adaptive cadence check
- **`entryProbeIntervals`** (array): for each tracked entry, an object with:
  - `memberName` (string): the entry's assigned member name
  - `probeIntervalMs` (number): the computed effective probe interval for that entry,
    reflecting the entry's threshold and the floor/ceiling clamp

The `entryProbeIntervals` list is emitted in the same order as the detector's internal
`stallCheckList` iteration, regardless of which entries actually probed on this tick, so
an operator can compare before-and-after snapshots of the list to see which entries
changed their computed cadence (e.g., after a threshold override).

### Example Log Line

```
{"timestamp":"2026-09-16T14:23:45.123Z","scope":"stall_poll_tick","level":"info","inv":"xyz123","msg":"{\"activeWatched\":2,\"provisional\":0,\"members\":[\"alice\",\"bob\"]} elapsed=5ms","ok":"{\"probesIssued\":1,\"probesSkipped\":1,\"entryProbeIntervals\":[{\"memberName\":\"alice\",\"probeIntervalMs\":30000},{\"memberName\":\"bob\",\"probeIntervalMs\":300000}]}","elapsed":"5ms"}
```

The `ok` field contains the actual probe summary. The `msg` field (which closes at the
scope's entry) is separate JSON that includes tick-level metadata: `activeWatched`,
`provisional` count, and member list.
