# apra-fleet — Schema Usability Sprint

**Branch:** `improve/schema-usability` (branch from `fix/version-in-json-output`)
**Requirements:** `requirements.md`

---

## Phase 1: Remove reset_session + DRY member resolution

### Task 1.1 — Delete reset_session tool
**Type:** code | **Tier:** cheap

Steps:
1. Delete `src/tools/reset-session.ts`
2. In `src/index.ts`: remove the import line `const { resetSessionSchema, resetSession } = await import('./tools/reset-session.js');`
3. In `src/index.ts`: remove the `server.tool('reset_session', ...)` registration
4. Commit: `refactor: remove reset_session tool (redundant with execute_prompt resume=false)`

Done when: file deleted, no import or registration remains, `npm run build` passes.

---

### Task 1.2 — Create resolveMember utility
**Type:** code | **Tier:** cheap

Create `src/utils/resolve-member.ts` with:
- `resolveMember(member_id?: string, member_name?: string): Agent | string` — delegates to `getAgentOrFail` using `member_id ?? member_name`; returns error string if neither provided
- `memberIdentifier` — exported zod object fragment `{ member_id: z.string().optional(), member_name: z.string().optional() }` with descriptions per requirements.md

Commit: `feat: add resolveMember utility and memberIdentifier zod fragment`

Done when: file created, exports both `resolveMember` and `memberIdentifier`, `npm run build` passes.

---

### Task 1.3 — Apply memberIdentifier to all 15 affected tools
**Type:** code | **Tier:** standard

For each of the 15 tools listed in requirements.md Change 2:
1. Import `{ memberIdentifier, resolveMember }` from `'../utils/resolve-member.js'`
2. Replace `member_id: z.string().describe(...)` with `...memberIdentifier` spread in the schema
3. Add `.refine(d => d.member_id || d.member_name, { message: 'Provide either member_id or member_name' })` on the schema object
4. Update the exported type alias (e.g. `MemberDetailInput`) — add `member_id?: string; member_name?: string`
5. Replace `getAgentOrFail(input.member_id)` with `resolveMember(input.member_id, input.member_name)` in the handler

Tools: remove_member, update_member, send_files, execute_prompt, execute_command, provision_auth, setup_ssh_key, provision_vcs_auth, revoke_vcs_auth, member_detail, update_llm_cli, compose_permissions, cloud_control, monitor_task, update_task_tokens

One commit per tool batch is fine (e.g. commit after every 3-4 tools). Final commit message: `feat: all tools accept member_name as alternative to member_id`

Done when: all 15 tools updated, no remaining direct `getAgentOrFail(input.member_id)` calls in tool files, `npm run build` passes.

---

### Task 1.4 — VERIFY Phase 1
**Type:** verify

1. `npm run build` — must pass with zero errors
2. `npm test` — all tests must pass
3. Confirm: `grep -r "reset_session" src/` returns nothing
4. Confirm: `grep -r "getAgentOrFail" src/tools/` only appears in any tool that imports it directly (should be zero — all tools should use resolveMember now)
5. `git push origin improve/schema-usability`
6. STOP

---

## Phase 2: File transfer improvements + description fixes

### Task 2.1 — send_files: rename param + path security
**Type:** code | **Tier:** standard

In `src/tools/send-files.ts`:
1. Rename `remote_subfolder` → `destination_path` in the schema (update description per requirements.md Change 3)
2. In the handler: update the variable name and path construction logic
3. Add path security: before transferring, resolve the final absolute destination and verify it starts with `agent.workFolder`. If it escapes, return `"destination_path resolves outside member work_folder — write blocked"`.
   - For remote members: build the absolute path server-side using `path.posix.resolve(agent.workFolder, destination_path ?? '')` and check `resolvedPath.startsWith(agent.workFolder)`
   - For local members: use `path.resolve(agent.workFolder, destination_path ?? '')` and check with `path.resolve`

Commit: `feat(send_files): rename remote_subfolder to destination_path, add work_folder boundary enforcement`

Done when: old parameter name gone, security check in place, `npm run build` passes.

---

### Task 2.2 — Implement receive_files tool
**Type:** code | **Tier:** standard

Create `src/tools/receive-files.ts`:
- Schema: `receiveFilesSchema` per requirements.md Change 4 (uses `memberIdentifier`, `remote_paths: string[]`, `local_destination: string`, refine for member identification)
- Handler: `receiveFiles(input)` — resolves member, iterates `remote_paths`, downloads each to `local_destination`
  - Remote members: use SFTP `fastGet` (mirror of `fastPut` in send_files)
  - Local members: use `fs.copyFile` (mirror of local copy in send_files)
  - Apply work_folder boundary check on each `remote_path` (same logic as send_files)
  - Return summary: files downloaded, any errors

In `src/index.ts`:
- Add import: `const { receiveFilesSchema, receiveFiles } = await import('./tools/receive-files.js');`
- Register: `server.tool('receive_files', '...description...', receiveFilesSchema.shape, ...)` immediately after `send_files` registration

Commit: `feat: add receive_files tool for downloading files from a member`

Done when: tool registered, works for both local and remote members, `npm run build` passes.

---

### Task 2.3 — Fix execute_prompt and execute_command descriptions
**Type:** code | **Tier:** cheap

In `src/index.ts`, update the two `server.tool(...)` description strings:

`execute_prompt`: remove "remote" from "Run an LLM prompt on a remote member" → "Run an LLM prompt on a member"

`execute_command`: remove "without spinning up Claude" → "without an LLM session"

(Full descriptions already in requirements.md Change 5)

Commit: `fix(schema): remove provider-specific and topology-specific language from tool descriptions`

Done when: both strings updated, `npm run build` passes.

---

### Task 2.4 — VERIFY Phase 2
**Type:** verify

1. `npm run build` — must pass
2. `npm test` — all tests must pass
3. Confirm `receive_files` appears in the tool registrations in `index.ts`
4. Confirm `remote_subfolder` no longer appears anywhere in `src/`
5. `git push origin improve/schema-usability`
6. STOP

---

## Phase 3: Collapse cloud_ssh_key_path into key_path

### Task 3.1 — Remove cloud_ssh_key_path parameter
**Type:** code | **Tier:** standard

Read these files first to understand the full impact:
- `src/tools/register-member.ts`
- `src/tools/update-member.ts`
- `src/types.ts`
- `src/services/cloud/aws.ts`
- `src/services/registry.ts`

Then:
1. In `src/tools/register-member.ts`: remove `cloud_ssh_key_path` from schema. Where the handler previously set `cloud.sshKeyPath` from `cloud_ssh_key_path`, instead use `input.key_path`. Update `key_path` description: "Path to SSH private key. Used for both regular SSH connections and cloud instance lifecycle."
2. In `src/tools/update-member.ts`: same — remove `cloud_ssh_key_path`, update description.
3. In `src/types.ts`: if `CloudConfig` has a `sshKeyPath` field, remove it. Cloud lifecycle uses `agent.keyPath`.
4. In `src/services/cloud/aws.ts` and any other cloud code: replace any `agent.cloud.sshKeyPath` references with `agent.keyPath`.
5. In `src/services/registry.ts`: if migration/storage code handles `sshKeyPath` in cloud config, remove it.

Commit: `refactor: collapse cloud_ssh_key_path into key_path — single SSH key field`

Done when: `cloud_ssh_key_path` parameter gone from both schemas, cloud code uses `agent.keyPath`, `npm run build` passes.

---

### Task 3.2 — VERIFY Phase 3
**Type:** verify

1. `npm run build` — must pass
2. `npm test` — all tests must pass
3. Confirm: `grep -r "cloud_ssh_key_path\|sshKeyPath" src/` returns nothing
4. `git push origin improve/schema-usability`
5. STOP
