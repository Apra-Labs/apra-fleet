# Design: fleet-status, a Claude Code mod for apra-fleet (phase 1)

Issue: #672. Status: phase 1 implemented on `feat/fleet-status-mod`.

## Goal

Basic fleet observability inside Claude Code, without leaving the session:
who is busy, who looks stalled, who is idle or offline -- at a glance, always
current. Simplicity is the cornerstone: one read-only server tool, one hooks
file, no actions, no new daemons.

Once the mod is installed, apra-fleet stops writing Claude Code's
`settings.statusLine` (the mod's status entry replaces it).

## What the user sees

1. **Status line entry**, always on (pinned under the prompt):

   ```
   fleet-status: <unknown> dgx-1  <busy> alice 02:14  <busy> carol 00:31  <idle> 2  <offline> 1
   ```

   Members that need attention (stalled `unknown`, then `busy` with the time
   since their task last showed activity) are named, at most three plus
   `+N`; idle and offline members are counted. Unreachable server:
   `server down`; still starting: `connecting...`.

2. **`/fleet-status`** opens a pane (docked beside the transcript in a wide
   fullscreen terminal, inline above the prompt otherwise) and prints a
   one-line summary (`6 members: 3 busy, 2 idle, 1 offline`). The pane:

   ```
   apra-fleet  v0.5.0                                   as of 06:34:55
   <busy> 3 busy  <idle> 2 idle  <offline> 1 offline
   ----------------------------------------------------------------
   build
    <busy> [icon] alice  busy     quiet 02:14  .  held by sprint-42
    <idle> [icon] bob    idle
   gpu
    <unk>  [icon] dgx-1  unknown  no activity -- may be stalled
    <off>  [icon] dgx-2  offline
   refreshes every 30s . /fleet-status to reopen
   ```

   Grouped by member category, needs-attention first within a group,
   colored by state through the user's theme keys (warning / success /
   error / permission), so it follows light and dark themes.

## Architecture

```
Claude Code session
  fleet-status mod (plugins/claude-code/fleet-status/hooks/register.tsx)
    $.mcp.call('apra-fleet', 'fleet_snapshot')   <- session's own MCP connection
        |
apra-fleet server (stdio or http, already configured by install)
  fleet_snapshot (src/tools/fleet-snapshot.ts): registry + statusline-state.json
                                                + in-process stall detector
```

- **`fleet_snapshot`** (new MCP tool, FULL sessions only -- not in
  `MEMBER_BASE_TOOLS`): `{ version, updatedAt, members: [{ id, name, icon,
  category, status, quietForS?, reservedBy? }] }`. Reads only local state:
  no SSH probes, no writes, so it is safe to poll. `status` is the
  last-known state the server already persists for the old status line;
  `quietForS` comes from the live stall detector when this process runs the
  task, else from the persisted `busy(mm:ss)` label. `fleet_status` remains
  the live, probing view. Client wrapper: `ApraFleet.fleetSnapshot()`.
- **Why the session's MCP connection** and not HTTP from the mod: it already
  carries whatever the install configured (stdio, or http plus the member
  access secret header), so the mod holds no secret and needs no port.
- **Refresh**: on session start (retrying every 3s, at most 20 times, while
  the MCP server is still connecting), every 30s, 2s after any other
  `mcp__apra-fleet__*` tool call starts (`execute_prompt` marks the member
  busy at dispatch), and when that call settles. Overlapping refreshes
  collapse into one.
- **Permissions**: the snapshot call is a tool call like any other. The
  `mcp__apra-fleet__*` allow rule that `apra-fleet install --llm claude`
  already writes covers it. A plugin's own hooks never answer for its own
  calls (the engine skips re-entry), so the mod cannot self-approve -- and
  should not.

## Surfaces

| Surface | Status entry | `/fleet-status` pane |
|---|---|---|
| Terminal CLI | yes | yes (docked >= 110 cols fullscreen, else inline) |
| Desktop app | yes | yes (docked pane) |
| Mobile | yes | no (status only) |
| VS Code / JetBrains | not drawn today | not drawn today |
| `claude -p` | n/a | n/a |

VS Code users get nothing from the mod today, as they get nothing from the
old status line; no special case.

## Install

`apra-fleet install --llm claude` lays the mod out as a local plugin
marketplace under the apra-fleet home (`claude-plugins/`, marketplace
`apra-fleet-local`) and runs `claude plugin marketplace add` and
`claude plugin install fleet-status@apra-fleet-local` at user scope. Only
when both succeed does it stop writing `settings.statusLine` (removing the
entry only if it is the one apra-fleet wrote). If the claude CLI is missing
or too old, install keeps the old status line and says why. A user's own
status line is never overwritten. Other providers (AGY, Codex, Copilot,
Gemini) keep the status line script unchanged. Uninstall removes the plugin
and the marketplace.

Developer loop: `claude --plugin-dir plugins/claude-code/fleet-status`
(hot-reloads on save); `claude plugin validate` and `claude plugin test`
on the same folder.

## Out of scope for phase 1

- Sprints, tasks, KB/code-intel health.
- Actions (stop, dispatch, reserve) -- read-only by design.
- A hosted view (`https://fleet.apralabs.com/<workspace>`) that would reach
  mobile and desktop panes beyond the local session; the mod's data shape
  (`fleet_snapshot`) is the seam for it.
- Linking the local console: shown later, once the URL is reliably known
  to the session.
