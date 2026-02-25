# Observability Tools

Two-layer monitoring — a fleet-wide summary and a per-agent deep dive.

## fleet_status

Provides a quick summary table of all fleet agents.

**Parameters:** None.

**What it does:**

1. Loads all registered agents from the registry.
2. **Checks each agent in parallel** with a 10-second timeout per agent:
   - Calls `strategy.testConnection()` — for remote agents, this opens (or reuses) an SSH connection. For local agents, this always returns online.
   - If online, runs a **fleet-aware process check** to determine if Claude is actively running for *this specific agent* (not just any Claude process on the machine).
3. Builds a formatted ASCII table.

**Fleet-aware busy detection:**

The process check (`getFleetProcessCheckCommand`) doesn't just grep for "claude" — it inspects the command lines of running Claude processes and matches them against the agent's working folder and session ID. This produces three possible states:

- **`BUSY`** — a Claude process is running that matches this agent's folder or session ID. This is a fleet task.
- **`idle*`** — Claude processes exist on the machine, but none are associated with this agent's folder or session. These are likely the user's own Claude sessions or other unrelated work.
- **`idle`** — no Claude processes running at all.

On Unix, this works by running `pgrep -f "claude"` to find PIDs, then `ps -o args=` to get their full command lines, then grepping for the folder path or session ID. On Windows, it uses `wmic process` to get command lines and `findstr` to match.

**Output columns:**

| Column | Values | Meaning |
|--------|--------|---------|
| Name | agent's friendly name | — |
| Host | `host:port` or `(local)` | Connection target |
| Status | `online` / `OFFLINE` | Can we reach the agent right now? |
| Busy? | `BUSY` / `idle` / `idle*` / `unknown` / `-` | Is a fleet Claude process running? |
| Session | first 8 chars of session ID or `(none)` | Active conversation thread |
| Last Activity | relative time (e.g. "5m ago", "2d ago") | When `execute_prompt` or `send_files` last touched this agent |

A footnote is appended to the table when any agent shows `idle*`, explaining that Claude processes were found but none are servicing that fleet agent.

**Performance:** All agents are checked concurrently via `Promise.allSettled`. A fleet of 20 agents completes in roughly the time of the slowest single connection (up to 10 seconds), not 20x that.

**Local agents** always show as `online` since there's no network connectivity to test.

## agent_detail

Deep-dive status for a single agent — connectivity, Claude CLI, session state, and system resources.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the agent to inspect |

**What it does:**

Runs a series of commands on the agent via `strategy.execCommand()` and assembles a multi-section report:

### Section 1: Connectivity
- Tests the connection via `strategy.testConnection()`.
- **Remote agents:** reports SSH status, latency in ms, and auth method (password or key, with key path if applicable).
- **Local agents:** reports "Connected (local)".
- If the connection fails, the report stops here with an offline warning — no point running further commands.

### Section 2: Claude CLI
- Runs `claude --version` to get the installed version.
- Checks for auth: `~/.claude/.credentials.json` (OAuth credentials file) and `ANTHROPIC_API_KEY` env var. Reports all detected methods or "No authentication detected".

### Section 3: Session
- Shows the stored session ID (or "none").
- Shows the `lastUsed` timestamp.
- Uses the same **fleet-aware process check** as `fleet_status` to determine busy state:
  - `BUSY (fleet Claude process running in {folder})` — a Claude process matches this agent's folder or session.
  - `idle (Claude processes found but none related to this agent)` — unrelated Claude activity.
  - `idle` — no Claude processes at all.

### Section 4: System Resources
- **CPU:** `uptime` (Linux), `sysctl -n vm.loadavg` (macOS), `wmic cpu get loadpercentage` (Windows).
- **Memory:** `free -m` (Linux, parsed to show used/total MB), `vm_stat` + `hw.memsize` (macOS), `wmic OS` (Windows).
- **Disk:** `df -h "{folder}"` (Unix), `wmic logicaldisk` (Windows) — shows usage for the agent's working directory.

Each resource query has its own try/catch — if one fails (e.g. `wmic` not available), it reports "unavailable" and continues with the rest.

**Output:** A structured text report with section headers (`── Connectivity ──`, etc.) showing all gathered information.
