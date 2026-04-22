# Design Decisions — 10-Issue Blitz Sprint

## Issue #151 — Preventing fleet-mcp from loading on local members

### Problem

When `execute_prompt` dispatches work to a **local** member (same machine as the controller), the launched Claude Code process loads its MCP configuration from the local `.claude/settings.json`. Since the controller machine has `apra-fleet` registered as an MCP server (installed by `apra-fleet install`), the member's Claude Code session also loads fleet-mcp. Doers and reviewers don't need fleet-mcp — it wastes startup time and memory.

### Options Evaluated

**Option A — `--no-mcp` flag or equivalent:**
Pass a flag to Claude Code in `execute_prompt` to suppress all MCP server loading. Rejected: too aggressive — members may legitimately need other MCP servers (e.g., browser tools, custom integrations).

**Option B — `compose_permissions` delivers member config disabling fleet-mcp (CHOSEN):**
`compose_permissions` already writes `.claude/settings.local.json` to members with the permissions allowlist. Extend this to include `"mcpServers": { "apra-fleet": { "disabled": true } }`. This uses Claude Code's built-in settings override mechanism — `settings.local.json` overrides `settings.json` per-key. The fleet-mcp server remains installed globally (PM can still use it), but member sessions disable it.

**Option C — PM-only profile:**
Move fleet-mcp to a PM-only config file. Rejected: this would require restructuring the install flow and doesn't compose well with the existing settings.json merge approach.

### Decision

**Option B.** Minimal disruption — leverages the existing `compose_permissions` delivery pipeline and Claude Code's settings layering.

### Implementation Notes

- `composePermissions()` in `src/tools/compose-permissions.ts` already writes `settings.local.json` to the member's work folder via SFTP or local file write.
- The MCP disable entry is added to the same JSON payload alongside permissions.
- If a future Claude Code version changes the MCP disable mechanism, only `compose_permissions` needs updating.

---

## Issue #72 — Full decommissioning protocol for remove_member

### Problem

`remove_member` currently:
1. Clears LLM auth credential files (remote only)
2. Unsets provider auth env vars (remote only)
3. Removes local SSH key pair (if not shared)
4. Removes known_hosts entry
5. Removes from registry

Missing: VCS credential cleanup, SSH public key removal from remote `authorized_keys`.

### Design

The decommission flow is extended to a 5-step protocol:

1. **Idle check** — Prevent decommissioning a busy member. Check `agent.sessionId` and whether a fleet process is running. If busy, return an error. Rationale: removing a member mid-task could leave dangling processes, half-written files, or orphaned cloud resources.

2. **VCS auth revoke** — If `agent.vcsProvider` is set, call the corresponding VCS provider's `revoke()` method. This removes the credential helper script and unsets the git config entry. Best-effort: if the member is offline, log a warning but proceed.

3. **SSH public key removal** — For remote members with a key pair, read the public key from `${agent.keyPath}.pub`, then execute `sed -i` on the remote to remove the matching line from `~/.ssh/authorized_keys`. Best-effort: failure is non-fatal.

4. **Existing cleanup** — LLM credentials, local key files, known_hosts (unchanged).

5. **Registry removal** — Remove from `registry.json` (unchanged).

### Skip Conditions

- **Local members:** Skip SSH key removal from authorized_keys (no remote to clean). Skip VCS revoke (credentials belong to the host machine).
- **Remote folder deletion:** Intentionally not included. Non-destructive default — the PM or user can clean up remote files manually. This avoids accidentally deleting work-in-progress or shared directories.

### Credential Cleanup Timer Integration

When T2.3 (auto-remove credential helper) is implemented, `remove_member` will also cancel any pending credential cleanup timer for the agent being removed. This prevents the timer from firing after the agent is already gone (which would fail silently but waste resources).

### Error Handling Strategy

Each decommission step is wrapped in try/catch and adds to `warnings[]` on failure. Only the idle check is a hard gate — all other steps are best-effort. The member is always removed from the registry even if some cleanup steps fail. This ensures a member can always be unregistered even if the remote machine is unreachable.
