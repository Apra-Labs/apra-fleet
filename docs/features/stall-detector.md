# Stall Detector — Redesign Design Document

**Date:** 2026-05-05  
**Status:** Implemented — shipped in v0.1.9.0 (#241, PR #246)

---

## Problem Statement

The stall detector must fire when an `execute_prompt` session has produced no LLM output for
more than N seconds. This requires tracking the live session log file and checking whether the
last-written timestamp has advanced.

The current implementation (`feat/stall-detector`) is broken for 100% of sessions:

- `fs.watch()` only works on the local filesystem — useless for SSH-remote members
- Path encoding is wrong (`%2F`/`%5C` instead of `-`) so even local watch fails silently
- Every entry stays `provisional: true` forever — stall fires on spawn time only
- `toLocalISOString` appends offset string to UTC time without adjusting the hours
- When `execute_prompt` is cancelled by MCP client disconnect, the `finally` block does not
  run — stall entries and `inFlightAgents` are permanently dirty

---

## Experiment Findings (2026-05-05)

### Log file locations (verified live)

| Provider | OS | Log directory | File naming |
|----------|----|---------------|-------------|
| Claude | Windows local | `~/.claude/projects/<encoded>/` | `<sessionId>.jsonl` |
| Claude | macOS remote | `~/.claude/projects/<encoded>/` | `<sessionId>.jsonl` |
| Gemini | Windows local | `~/.gemini/tmp/<basename>/chats/` | `session-<ts>-<sid-prefix>.jsonl` |

### Path encoding (observed)

Claude encodes the work folder by replacing **every** `/`, `\`, and `:` with `-`:
- Windows: `C:\akhil\git\apra-fleet` → `C--akhil-git-apra-fleet`
- macOS: `/Users/akhil/git/apra-fleet` → `-Users-akhil-git-apra-fleet`

Current code uses `%2F`/`%5C` — completely wrong.

### Activity timestamp fields

- **Claude**: The `assistant` entry has a `timestamp` field. The final `last-prompt` entry has
  no timestamp. Poll must read the last line that has a `timestamp` field.
- **Gemini**: `{"$set":{"lastUpdated":"..."}}` lines are written after every LLM turn.
  These are the activity lines to read.

### resume=true behavior (verified live on fleet-dev)

Two calls (`resume=false` then `--resume <sessionId>`):
- Same session ID returned for both calls
- Same file — no new file created
- File grew from initial size to 15,329 bytes covering both turns
- The `queue-operation/enqueue` for the resumed call contains the **session ID** as content
  (not the prompt text)
- Timeline of first call: enqueue at T+0ms, first user entry at T+26ms — **file appears
  within ~30ms of session start**

**Implication**: For `resume=true`, no grep needed. We already have the session ID → direct
filename. Token approach only applies to `resume=false`.

### Gemini resume behavior (verified live on fleet-dev2)

`--resume latest` creates a **new file** per resume call with an updated timestamp component
but the **same 8-char session ID prefix**: `session-<new-ts>-<same-prefix>.jsonl`.
The previous session file is not modified. mtime filter after T0 correctly identifies the
new file.

### File appearance timing

- Claude: file created within ~30ms of session start (enqueue at T+0ms, first user entry T+26ms)
- Gemini: file appears at session start (timestamp embedded in filename)
- Both: mtime filter with T0 = PID-capture time reliably finds the file within the first
  10s retry window

---

## Proposed Design

### 1. Token = inv ID

The fleet server already generates a per-invocation ID (`inv`) for every `execute_prompt`
call (visible in logs as `"inv":"eobkp"`). Use this same ID as the token — prepend
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
  if (provider === 'gemini') {
    return join(home, '.gemini', 'tmp', basename(workFolder), 'chats');
  }
  return null;
}
```

For remote members, `homedir()` is not used — home dir is embedded inline in the scan
command (`$(echo $HOME)` or `$env:USERPROFILE`) so it resolves on the remote machine.

### 3. Log file discovery strategy

**Primary mechanism — mtime filter (both cases):**

After PID is captured at time T0, the session log file will be the one modified **after T0**.
Filter by `mtime > T0` instead of grepping content — this narrows from hundreds of files to
0–1 files instantly, with zero file reads.

- Local: `fs.readdirSync(dir)` + `fs.statSync(f).mtimeMs > t0`
- Remote: `find <dir> -newer <ref> -name "*.jsonl" 2>/dev/null | head -1`
  where `<ref>` is a temp file touched at T0, or use `-newermt <ISO timestamp>`

**Case A — resume=false (fresh session):**
1. After PID captured: scan log dir for files with `mtime > T0`
2. Retry every **10s**, max **3 retries** (30s total)
3. If exactly 1 file found: that's the log. Log `stall_log_resolved {path, inv, provider, method:"mtime"}`
4. If 0 files after 30s: log `stall_log_not_found {dir, inv, elapsed}`, stay provisional
5. If >1 files (two sessions started same second — very rare): verify by checking first line
   for `[<inv>]` token as tiebreaker

**Case B — resume=true:**
- **Claude**: same file as prior session. Stored session ID → `<logDir>/<sessionId>.jsonl`.
  Verify exists; if yes, use immediately. After server restart: session ID still in registry,
  same path. No scan needed.
- **Gemini**: resume creates a new file with same session ID prefix but new timestamp component
  (`session-<new-ts>-<sid-prefix>.jsonl`). Use mtime > T0 scan — same as Case A.

Verified by experiment: Claude resume appends to same file (same sessionId.jsonl, 1 file for
both turns). Gemini resume creates a new file with the same 8-char session prefix but a new
timestamp. mtime filter handles both correctly.

### 4. Activity polling (both cases)

Every **30 seconds** (soft-coded via `STALL_POLL_INTERVAL_MS` env var — default 30000):
- Read the last 500 bytes of the log file (tail)
- Extract the last `timestamp` (Claude) or `lastUpdated` in a `$set` entry (Gemini)
- If expected fields are missing: log `stall_poll_format_error {path, provider}` and skip cycle
- If timestamp advanced since last poll: reset `stallReported`, update `lastActivityAt`
- If not advanced and `now - lastActivityAt > STALL_THRESHOLD_MS`: fire `stall_detected`
  once (set `stallReported=true`, reset only when activity advances)

For remote members, polling runs a shell command via the **internal SSH/shell transport**
(same layer that backs the `execute_command` MCP tool, called directly from server code).
Running these internal shell calls concurrently with an active `execute_prompt` session on
the same member is permitted — verified empirically.

### 5. Local vs. remote scan

Primary method is **mtime filter** — not content grep. Do NOT assume local = Windows.

| Member type | Scan method |
|-------------|-------------|
| Local (any OS) | Node.js fs directly: `fs.readdirSync(dir).filter(f => fs.statSync(f).mtimeMs > t0)` |
| Remote | Run a shell command on the member via the **internal SSH/shell transport** (the same layer that backs the `execute_command` MCP tool, invoked directly from server code — not via the MCP tool itself) |

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

`[inv]` token check is a **tiebreaker only** — applied when mtime scan returns >1 file
(two sessions on same member started within the same second). Check first 3 lines of
each candidate for `[<inv>]`.

Abstract behind `findLogFile(member, t0, inv, logDir): Promise<string|null>` — two
implementations (local Node.js fs, remote shell via internal transport) selected by
`agent.agentType`. OS detected from `agent.os` for the remote command variant.

### 6. Fix MCP disconnect / dirty state (R8)

**Root cause (confirmed by code analysis):** `abortHandler` fires correctly when the MCP
signal aborts. It calls `tryKillPid(...).catch(() => {})` — fire-and-forget. Inside
`tryKillPid`, any kill failure is swallowed silently. `execCommand` is still `await`-ing
the subprocess and never unblocks. `finally` never runs → `inFlightAgents` and stall entry
stay dirty permanently.

The kill can fail for several reasons (PID not yet captured, kill races subprocess exit,
remote SSH kill times out) — all silently swallowed by the double catch.

**Fix:** Inject an `AbortSignal` into `execCommand` itself (or into the strategy's underlying
transport). When the MCP signal fires, abort `execCommand` directly — do not depend on
killing the subprocess to unblock the await. The subprocess kill continues in parallel as
best-effort cleanup, but `execCommand` resolves via the abort path regardless.

No live experiment required — the failure chain and fix are deterministic from code reading.

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

## Implementation Ready

All design decisions are finalized. No pending experiments. Ready to hand to fleet-dev for
implementation on `feat/stall-detector`.
