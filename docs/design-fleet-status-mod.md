# Design: fleet-status, a Claude Code mod for apra-fleet

Issue: #672. Status: phase 1 (status line and member pane) merged in #746;
phase 2 (secrets, removing a member) on `feat/fleet-status-secrets`.

## Goal

Basic fleet observability inside Claude Code, without leaving the session:
who is busy, who looks stalled, who is idle or offline -- at a glance, always
current, and the everyday actions on that view (manage secrets, remove a
member) without asking the model. Simplicity is the cornerstone: existing
server tools plus one read-only snapshot tool, one hooks file, no new
daemons.

Once the mod is installed, apra-fleet stops writing Claude Code's
`settings.statusLine` (the mod's status entry replaces it).

## What the user sees

1. **Status line entry**, always on (pinned under the prompt):

   ```
   fleet-status: <unknown> dgx-1  <busy> alice 02:14  <busy> carol 00:31  <idle> 2  <offline> 1
   ```

   Members that need attention (stalled `unknown`, then `busy` with the time
   since their task last showed activity) are named, at most three plus
   `+N`; idle and offline members are counted. Errors: `connecting...`
   (first minute after session start), `server not reachable`, or
   `server too old: update apra-fleet` (connected, but no fleet_snapshot).
   On an error the pane keeps the last known list under the error line.

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

3. **Remove** beside each member in the pane: a confirm row
   (`Remove bob from the fleet? [Remove] [Cancel]`), then `remove_member`
   by name, never with `force`. The server's own guards still apply: a busy
   or held member is refused, and the pane shows the refusal
   (`Not removed: Member "bob" is currently busy...`).

4. **Secrets** section under the members: every stored secret by name,
   scope, allowed members and expiry (`credential_store_list`; values are
   never listed), with `replace` and `delete` per row (delete confirms
   first), and `add`. Secrets that are expired or within an hour of
   expiring add `<key> N expiring` to the status line.

5. **Folding and "more"**: each section header (`Members 6`, `Secrets 4`)
   folds and unfolds its section; Members starts open and Secrets folded,
   its header still counting expiring secrets. Rows are compact by
   default (member: state, name, x; secret: name, an expiry only when it is
   close, replace, x); `more...` shows the less-used fields (quiet time,
   holder, stall note; scope, allowed members, expiry). The add/replace
   form asks only for the name: all members, persistent and never
   expiring are the defaults, with `more options...` for the rest. The
   layout is remembered across sessions (`$.store`).

6. **Insert a secret's token**: pressing a secret's name puts
   `{{secret.NAME}}` at the prompt's cursor (`$.prompt.fill`, mode
   `insert`), the placeholder the fleet resolves inside member-bound
   commands. Only the token is inserted, never the value.

## Secrets: the value never passes through Claude Code

The mod sends names and settings only. A value is typed in one of two
places, neither of which is Claude Code:

1. **Another terminal (shown first; works headless):** the pane shows
   `apra-fleet secret --set NAME --persist` with a Copy button. The CLI
   prompts with input hidden and stores the value encrypted. The pane's
   `Apply members and expiry` then calls `credential_store_update` with the
   members and TTL picked in the form. The command always persists; a
   session-only secret uses the browser link.
2. **The server's one-time form:** `Get browser link` calls
   `credential_store_set` with `return_url: true`; the server answers with a
   single-use link (10 minute TTL) to its own entry page, where the value is
   typed into a masked field and posted straight to the server. The pane
   shows the link with Copy, and warns when it is plain http to a
   non-loopback host (the value would cross the network unencrypted).
   A 0.4.x server has no `return_url`: it collects the value out of band
   itself (a hidden-input terminal window, or a request for the CLI command
   when it has no terminal). The pane reports "NAME stored" and re-lists,
   or points back to the command.

Claude Code's own `Input` is never used for a value: it is unmasked, and
any other plugin's `ui.input` hooks would see the text. Canary check
(2026-10-16, Claude Code 2.1.301, HTTP transport): one value entered
through the pane's browser link and one through the CLI, then the model
asked to list secrets; neither value (plain or base64) appeared in the
session transcript, the `--debug-file` log, the server log, the terminal
scrollback or any other file under the sandbox home, and both decrypted
correctly from the store.

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
  `MEMBER_BASE_TOOLS`): `{ version, members: [{ id, name, icon, category,
  status, quietForS?, reservedBy? }] }`. Reads only local state:
  no SSH probes, no writes, so it is safe to poll. `status` is the
  last-known state the server already persists for the old status line;
  `quietForS` comes from the live stall detector when this process runs the
  task, else from the persisted `busy(mm:ss)` label. A busy whose writer
  process (recorded in `statusline-owners.json`) is dead is reported `idle`;
  each server also resets such orphaned busy entries at startup. `fleet_status` remains
  the live, probing view. Client wrapper: `ApraFleet.fleetSnapshot()`.
- **Why the session's MCP connection** and not HTTP from the mod: it already
  carries whatever the install configured (stdio, or http plus the member
  access secret header), so the mod holds no secret and needs no port.
- **Refresh**: on session start (retrying every 3s while reads fail during
  the first 60s -- Claude Code reports a starting and a dead server with the
  same message, so time since start tells them apart), every 30s, 2s after any other
  `mcp__apra-fleet__*` tool call starts (`execute_prompt` marks the member
  busy at dispatch), and when that call settles. Overlapping refreshes
  collapse into one.
- **Permissions**: the plugin API's types say a plugin's `$.mcp.call` needs
  no permission prompt, but Claude Code 2.1.300 was observed to put it
  through the permission check (a prompt per poll in a session without an
  allow rule; the debug log shows the permission request). The
  `mcp__apra-fleet__*` allow rule that `apra-fleet install --llm claude`
  already writes covers it. A plugin's own hooks never answer for its own
  calls (the engine skips re-entry), so the mod cannot self-approve -- and
  should not. Polling calls only `fleet_snapshot` and
  `credential_store_list`; the write tools (`credential_store_set`,
  `credential_store_update`, `credential_store_delete`, `remove_member`)
  run only on a press in the pane.

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

## Not yet

- Sprint status (next): needs a read-only server tool, since the
  supervisor API takes a bearer token the mod must not hold.
- Tasks, KB/code-intel health; member actions beyond removal (stop,
  dispatch, reserve).
- A hosted view (`https://fleet.apralabs.com/<workspace>`) that would reach
  mobile and desktop panes beyond the local session; the mod's data shape
  (`fleet_snapshot`) is the seam for it.
- Linking the local console: shown later, once the URL is reliably known
  to the session.
