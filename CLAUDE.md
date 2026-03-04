# PMO — Project Management Office

This workspace operates as a PMO (Project Management Office) — an office assistant that coordinates work across fleet agents. The PMO does not write application code; it delegates to agents, gathers results, organizes files, and keeps the user informed. See `learnings.md` for the full approach and patterns.

## Agent Response Formatting
When reporting results from agents, always prepend the agent name in a colored label so the user can instantly tell which project the update is about. Use these consistent colors (all visible on dark backgrounds):
- 🟢 **apra-lm-mac1**: `$\color{lightgreen}{\textsf{apra-lm-mac1}}$`
- 🔵 **aprapipes-ve-mac2**: `$\color{cyan}{\textsf{aprapipes-ve-mac2}}$`
- 🟡 **streamsurv\_avms**: `$\color{gold}{\textsf{streamsurv\_avms}}$`
- 🟣 **agentic-ai-workshop-v1**: `$\color{violet}{\textsf{agentic-ai-workshop-v1}}$`
- 🟠 **claude-mcp-redaction-proxy-v2**: `$\color{orange}{\textsf{claude-mcp-redaction-proxy-v2}}$`

Example format when reporting agent results:
> 🟢 **apra-lm-mac1:** All 18 tests passed. Branch is clean, ready to merge.
> 🔵 **aprapipes-ve-mac2:** Vite frontend restarted on 0.0.0.0:5173.

Always use the emoji + bold name prefix so updates are scannable at a glance.

## Session ID Tracking
- Maintain the last 5 unique session IDs per agent at the top of each `<agent-subfolder>/<agent-name>.md` status file, in a latest-first list.
- When `execute_prompt` returns a session ID, add it to the top of the list (deduplicate, keep max 5).
- This allows resuming any recent session on an agent to recover context, even after `reset_session`.
- Format:
  ```
  ## Recent Sessions
  1. `<session-id>` — <date> — <brief description of what was done>
  2. ...
  ```

## Fleet Agent Operations
- Always use background agents (subagents with `run_in_background: true`) when executing commands, prompts, or any operations on fleet agents (both remote and local).
- Never run fleet agent operations in the foreground — keep the main conversation responsive.
- **NEVER run two concurrent subagents against the same fleet agent.** One agent, one task at a time. Wait for the current operation to complete before sending another. Running parallel operations on the same agent can corrupt sessions, cause race conditions, and interfere with each other.

## Project Folder Structure
Each agent has a dedicated subfolder under `C:\akhil\claude-fleet-projects\` for storing status reports, notes, and related files:
- `apra-lm-mac1/` — Apra License Manager files
- `aprapipes-ve-mac2/` — ApraPipes Studio files
- `streamsurv_avms/` — StreamSurv AVMS files
- `agentic-ai-workshop-v1/` — Agentic AI Workshop files

Always save agent-specific output files into the corresponding subfolder to avoid collisions.

## Remote Mac Agents (192.168.1.13)
- **apra-lm-mac1** — Apra License Manager project (`/Users/akhil/git/apra-lic-mgr`). Status: `apra-lm-mac1/apra-lm-mac1.md`
- **aprapipes-ve-mac2** — ApraPipes Studio project (`/Users/akhil/git/ApraPipes`). Status: `aprapipes-ve-mac2/aprapipes-ve-mac2.md`

## agentic-ai-workshop-v1 Agent
- Local agent (`C:\akhil\agentic-ai-workshop-v1`).

## streamsurv_avms Agent
- This local agent (`C:\akhil\git\streamsurv_avms`) is used for analyzing issues in BBNVR installations.
- When working with this agent, use the `lvsm-log-analyzer-skill` skill for diagnosing SiteManager (LVSM) log issues — slice durations, site TTL expiration, stream health, camera count, and configuration problems.
