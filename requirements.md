# apra-fleet — Schema Usability Sprint

## Objective
Reduce friction in the MCP tool schema: remove a redundant tool, make member identification easier, add symmetric file transfer, improve path safety, and fix misleading descriptions.

**Branch:** `improve/schema-usability` (branch from `fix/version-in-json-output` to include prior uncommitted fixes)
**Repo:** Apra-Labs/apra-fleet

---

## Change 1: Remove `reset_session`

`reset_session` is fully redundant with `execute_prompt resume=false`. Delete it.

- Delete `src/tools/reset-session.ts`
- Remove the import and `server.tool('reset_session', ...)` registration from `src/index.ts`
- No migration needed — callers should use `execute_prompt` with `resume=false`

---

## Change 2: Unified member identification (DRY)

**Problem:** All tools take `member_id` (UUID) as required. The LLM must first call `list_members` to resolve a friendly name to a UUID — a wasted round trip. The server can resolve this internally.

**Solution:** Every tool that currently takes `member_id` must accept **either** `member_id` (UUID) or `member_name` (friendly name). Exactly one must be provided. If both are provided, `member_id` takes precedence and `member_name` is silently ignored.

### DRY implementation

Create `src/utils/resolve-member.ts`:

```typescript
import { getAgentOrFail } from './agent-helpers.js';
import { z } from 'zod';
import type { Agent } from '../types.js';

/**
 * Resolve a member from either member_id (UUID or name) or member_name.
 * member_id takes precedence if both are provided.
 * Returns the Agent or an error string.
 */
export function resolveMember(member_id?: string, member_name?: string): Agent | string {
  if (!member_id && !member_name) {
    return 'Error: provide either member_id (UUID) or member_name (friendly name).';
  }
  return getAgentOrFail(member_id ?? member_name!);
}

/**
 * Shared zod fragment for member identification.
 * Spread into tool schemas: z.object({ ...memberIdentifier, ...otherFields })
 * Add .refine(d => d.member_id || d.member_name, { message: 'Provide either member_id or member_name' })
 */
export const memberIdentifier = {
  member_id: z.string().optional().describe(
    'UUID of the member. Takes precedence over member_name if both are provided.'
  ),
  member_name: z.string().optional().describe(
    'Friendly name of the member. Use when UUID is not known. Ignored if member_id is also provided.'
  ),
};
```

Note: `getAgentOrFail` already supports both UUID and name lookup (added in Phase 7 of the prior sprint). `resolveMember` is a thin, consistent wrapper.

### Apply to all affected tools

Every tool with a `member_id: z.string()` field must be updated:

1. Replace `member_id: z.string().describe(...)` with `...memberIdentifier` (spread)
2. Add `.refine(d => d.member_id || d.member_name, { message: 'Provide either member_id or member_name' })` on the schema object
3. Replace `getAgentOrFail(input.member_id)` with `resolveMember(input.member_id, input.member_name)` in the handler
4. Update type annotations: the input type now has `member_id?: string` and `member_name?: string`

Affected tools (15 total):
`remove_member`, `update_member`, `send_files`, `execute_prompt`, `execute_command`,
`provision_auth`, `setup_ssh_key`, `provision_vcs_auth`, `revoke_vcs_auth`,
`member_detail`, `update_llm_cli`, `compose_permissions`, `cloud_control`,
`monitor_task`, `update_task_tokens`

**Important:** `member_id` in `update_member`'s schema describes the member to update, not a field to update. Keep its description accurate: "UUID of the member to update. Takes precedence over member_name if both provided."

---

## Change 3: `send_files` — rename param + path security + description

### Rename parameter
`remote_subfolder` → `destination_path`

Old: implied a subfolder beneath work_folder only.
New: accepts a relative path (resolved from `work_folder`) or an absolute path.

```typescript
destination_path: z.string().optional().describe(
  'Destination path on the member. Relative paths are resolved from work_folder. ' +
  'Absolute paths must remain within work_folder — paths outside it are rejected.'
),
```

### Path security enforcement (server-side)
Before writing any file, the server must resolve the final absolute path and verify it is inside `agent.workFolder`. If it escapes, return an error: `"destination_path resolves outside member work_folder — write blocked"`. Best-effort: resolve symlinks where the transport allows.

### Fix description
Old: `"Upload local files to a remote member via SFTP. Files are placed in the member's remote folder."`
New: `"Transfer local files to a member. Always batch multiple files into a single call — never invoke repeatedly for individual files. destination_path accepts a relative (from work_folder) or absolute path; paths outside work_folder are rejected."`

---

## Change 4: New `receive_files` tool

Symmetric counterpart to `send_files`. Pulls files from a member to a local directory.

Schema:
```typescript
receiveFilesSchema = z.object({
  ...memberIdentifier,
  remote_paths: z.array(z.string()).describe(
    'Paths on the member to download. Relative paths resolved from work_folder. ' +
    'Absolute paths must remain within work_folder — paths outside it are rejected. ' +
    'Always batch multiple files into a single call.'
  ),
  local_destination: z.string().describe(
    'Local directory to write the downloaded files into.'
  ),
}).refine(d => d.member_id || d.member_name, { message: 'Provide either member_id or member_name' });
```

Tool description: `"Download files from a member to a local directory. Always batch multiple files into a single call — never invoke repeatedly for individual files. remote_paths outside work_folder are rejected."`

Implementation: use the existing strategy/SFTP infrastructure (same pattern as `send_files` but pull direction). For local members, use file copy. Apply the same `workFolder` boundary enforcement as Change 3.

Register in `src/index.ts` in the `// --- File Operations ---` section immediately after `send_files`.

---

## Change 5: Fix `execute_prompt` and `execute_command` descriptions

`execute_prompt` tool description: remove "remote". Change:
> "Run an LLM prompt on a remote member."
to:
> "Run an LLM prompt on a member."

`execute_command` tool description: remove "without spinning up Claude". Change:
> "Run a shell command directly on a member without spinning up Claude."
to:
> "Run a shell command directly on a member without an LLM session."

Both changes are in `src/index.ts` in the `server.tool(...)` registration calls.

---

## Change 6: Collapse `cloud_ssh_key_path` into `key_path`

**Problem:** `cloud_ssh_key_path` and `key_path` both exist in `register_member` and `update_member`. They always end up holding the same value. The server already copies one to the other on registration.

**Solution:** Remove `cloud_ssh_key_path` as a separate parameter. `key_path` serves both purposes.

Steps:
1. Remove `cloud_ssh_key_path` from `registerMemberSchema` and `updateMemberSchema`
2. In the registration handler (`src/tools/register-member.ts`): wherever `cloud_ssh_key_path` was stored/used, use `key_path` instead
3. In the AWS provider (`src/services/cloud/aws.ts`) and any cloud lifecycle code: read `agent.keyPath` instead of any `cloud.sshKeyPath` field
4. In `src/types.ts`: remove `sshKeyPath` (or equivalent) from the `CloudConfig` type if present; the member-level `keyPath` is canonical
5. Update `key_path` description in both schemas to note it applies to both regular SSH and cloud lifecycle connections

---

## Acceptance Criteria

- `npm run build` passes with zero errors
- All existing tests pass
- `reset_session` tool is gone from the MCP tool list
- All 15 tools accept `member_name` in place of `member_id`; `member_id` takes precedence if both provided
- `send_files` parameter renamed; path outside work_folder returns error
- `receive_files` tool exists and works for both local and remote members
- `cloud_ssh_key_path` parameter gone from register_member and update_member
- Tool descriptions fixed as specified
