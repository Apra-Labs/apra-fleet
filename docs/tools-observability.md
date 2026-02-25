# Observability Tools

Two-layer monitoring — a fleet-wide summary and a per-agent deep dive.

## fleet_status

Provides a quick summary table of all fleet agents.

**Parameters:** None.

**What it does:**

1. Loads all registered agents from the registry.
2. **Checks each agent in parallel** with a 10-second timeout per agent:
   - Calls `strategy.testConnection()` — for remote agents, this opens (or reuses) an SSH connection. For local agents, this always returns online.
   - If online, runs the OS-appropriate process check command (`pgrep -f "claude"` on Unix, `tasklist /FI "IMAGENAME eq claude.exe"` on Windows) to determine if Claude is actively running.
3. Builds a formatted ASCII table.

**Output columns:**

| Column | Values | Meaning |
|--------|--------|---------|
| Name | agent's friendly name | — |
| Host | `host:port` or `(local)` | Connection target |
| Status | `online` / `OFFLINE` | Can we reach the agent right now? |
| Busy? | `BUSY` / `idle` / `unknown` / `-` | Is a Claude process currently running? |
| Session | first 8 chars of session ID or `(none)` | Active conversation thread |
| Last Activity | relative time (e.g. "5m ago", "2d ago") | When `execute_prompt` or `send_files` last touched this agent |

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
- Checks if `CLAUDE_CODE_OAUTH_TOKEN` is set in the environment (reads first 10 characters to confirm presence without exposing the full token).

### Section 3: Session
- Shows the stored session ID (or "none").
- Shows the `lastUsed` timestamp.
- If a session exists, checks whether Claude is actively running for that session:
  - Unix: `pgrep -af "claude.*{sessionId}"`
  - Windows: `tasklist /FI "IMAGENAME eq claude.exe"`
  - Reports `BUSY (Claude is running)` or `idle`.

### Section 4: System Resources
- **CPU:** `uptime` (Linux), `sysctl -n vm.loadavg` (macOS), `wmic cpu get loadpercentage` (Windows).
- **Memory:** `free -m` (Linux, parsed to show used/total MB), `vm_stat` + `hw.memsize` (macOS), `wmic OS` (Windows).
- **Disk:** `df -h "{folder}"` (Unix), `wmic logicaldisk` (Windows) — shows usage for the agent's working directory.

Each resource query has its own try/catch — if one fails (e.g. `wmic` not available), it reports "unavailable" and continues with the rest.

**Output:** A structured text report with section headers (`── Connectivity ──`, etc.) showing all gathered information.
