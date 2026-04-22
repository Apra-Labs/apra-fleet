# Sprint Plan — 10-Issue Blitz

Branch: `sprint/10-issue-blitz` | Base: `main`
Baseline: **45 test files, 786 tests passing, 3 skipped**

---

## Phase 1 — Targeted Fixes

Issues: #167, #146, #144, #150

### T1.1 — Fix ESM `__dirname` shim in compose-permissions.ts (#167)

- **Description:** `findProfilesDir()` at `src/tools/compose-permissions.ts:63` uses bare `__dirname` which throws `ReferenceError` in dev mode under `tsx` (ESM). Add the same shim already used in `src/cli/install.ts:123-126`.
- **Files to modify:** `src/tools/compose-permissions.ts`
- **Implementation:**
  - Add at top of file:
    ```ts
    import { fileURLToPath } from 'url';
    import { dirname } from 'path';
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    ```
  - The existing `let dir = __dirname;` at line 63 will then resolve correctly.
- **Acceptance criteria:**
  - `tsx src/tools/compose-permissions.ts` does not throw `ReferenceError: __dirname is not defined`
  - `npm test` passes
- **Type:** task

### T1.2 — Fix receive_files Windows path rejection (#146)

- **Description:** `receiveFiles()` at `src/tools/receive-files.ts:35-54` uses `path.posix.resolve()` for remote members and `path.resolve()` for local members. On Windows local members, `agent.workFolder` has backslashes but the remote branch converts to posix — the local branch works correctly via `path.resolve()` + `path.sep`. The real bug: for **remote Windows members** (agentType='remote'), `workFolder` like `C:\Users\aUser\ODM` gets converted to `C:/Users/aUser/ODM` but `path.posix.resolve()` treats `C:` as a relative segment, producing `/C:/Users/aUser/ODM`. This breaks the prefix check because `path.posix.resolve(workFolderPosix, remotePath)` and `normalizedWorkFolder` may not match.
- **Files to modify:** `src/tools/receive-files.ts`, `src/tools/send-files.ts` (same pattern at lines 36-54)
- **Implementation:**
  - Extract a shared `isContainedInWorkFolder(workFolder: string, targetPath: string, isLocal: boolean): boolean` helper or inline fix.
  - For remote members: normalize both sides consistently. Use `path.normalize()` on both the work folder and the resolved path. Handle the case where the remote is Windows (backslash work_folder) by normalizing separators on both sides before comparing.
  - Key insight: if `workFolder` contains a Windows drive letter like `C:\`, we should NOT use `path.posix.resolve` — instead normalize both to forward slashes and do a string prefix comparison without `path.posix.resolve`.
- **Acceptance criteria:**
  - Unit tests cover all four path formats from the issue: `"build\logs\net.log"`, `"build/logs/net.log"`, `"net.log"`, `"C:\Users\aUser\ODM\net.log"` — all accepted when work_folder is `C:\Users\aUser\ODM`.
  - Paths outside work_folder still rejected.
  - Both `receive-files.ts` and `send-files.ts` fixed.
  - `npm test` passes
- **Type:** task

### T1.3 — Fix SSH usernames with spaces (#144)

- **Description:** Usernames like `"tester tester"` (valid on Windows) may fail registration. In `src/services/ssh.ts:49`, username is passed directly to ssh2 `ConnectConfig.username` — this is correct and does NOT split on spaces. However, input validation in `registerMemberSchema` at `src/tools/register-member.ts:25` uses `z.string().optional()` with no constraints, so spaces are technically accepted. The real risk: if the username is later interpolated into shell strings in OS commands (e.g., `src/os/linux.ts`, `src/os/windows.ts`).
- **Files to modify:** `src/tools/register-member.ts` (validation), audit `src/os/*.ts` for shell interpolation of username
- **Implementation:**
  - Verify `getSSHConfig()` passes username directly (already confirmed: line 49).
  - Audit all OS command functions that receive `agent.username` — ensure none interpolate it unsafely into shell strings.
  - Add explicit documentation in the schema that spaces are allowed.
  - Add a unit test that constructs SSH config with a username containing spaces and verifies it's passed through intact.
- **Acceptance criteria:**
  - `username = "tester tester"` produces correct `ConnectConfig.username` (not split)
  - No OS command function interpolates username unsafely
  - Unit test verifies space-containing username
  - `npm test` passes
- **Type:** task

### T1.4 — Improve SSH error messages in register_member (#150)

- **Description:** All SSH failures in `registerMember()` produce a generic `"Failed to connect to <host>:<port> — <error>"` message at `src/tools/register-member.ts:177`. The error from `strategy.testConnection()` is the raw ssh2 error message. Need to parse error codes and provide specific guidance.
- **Files to modify:** `src/tools/register-member.ts`, possibly extract a helper `src/utils/ssh-error-messages.ts`
- **Implementation:**
  - Create a `classifySshError(error: string): string` helper that maps:
    - `Authentication failed` / `All configured authentication methods failed` → `Authentication failed — wrong password or key not accepted`
    - `ECONNREFUSED` → `Connection refused — check host and port`
    - `ETIMEDOUT` / `ENOTFOUND` → `Host unreachable — check hostname and network`
    - OOB-related failures (check `collectOobPassword` error path) → `Password prompt could not be opened. Try passing the password directly via the 'password' field.`
  - Apply in `registerMember()` at line 177 where `connResult.error` is used.
  - **Post-register hook:** The onboarding nudge at `src/services/onboarding.ts:159` already gates on `✅` prefix — this is correct. Verify this is still true and add a test.
- **Acceptance criteria:**
  - Unit tests for each error code → message mapping
  - Hook only fires on success (already gated, verify with test)
  - `npm test` passes
- **Type:** task

### V1 — Phase 1 Verification Checkpoint

- **Description:** Build and test gate for Phase 1.
- **Steps:**
  1. `git fetch origin && git rebase origin/main`
  2. `npm run build` — 0 errors
  3. `npm test` — all pass, report count vs baseline (786)
  4. Verify each issue added ≥1 new test
  5. `git push origin sprint/10-issue-blitz`
  6. STOP — report status for PM review
- **Type:** verify

---

## Phase 2 — Cleanup & Safety

Issues: #70, #8, #69, #72

### T2.1 — send_files: detect basename collision (#70)

- **Description:** `uploadViaSFTP()` at `src/services/sftp.ts:76` extracts `path.basename(localPath)` and places files flat in `remoteBase`. Two files from different directories with the same name silently overwrite.
- **Files to modify:** `src/services/sftp.ts` (upload function), `src/tools/send-files.ts` (pre-flight check)
- **Implementation:** Option B — detect collision before transfer.
  - In `sendFiles()` (or in `uploadViaSFTP`), before uploading, collect all `path.basename()` values. If duplicates exist, return an error listing the conflicting paths.
  - This is simpler and safer than Option A (preserving paths), which would require changes to the SFTP mkdir logic and the remote file layout.
- **Acceptance criteria:**
  - Two files with the same basename from different directories → error returned before any transfer
  - Single files and files with unique basenames work normally
  - Unit test covers collision detection
  - `npm test` passes
- **Type:** task

### T2.2 — Stale task directory cleanup (#8)

- **Description:** Task directories `~/.fleet-tasks/<taskId>/` are created by `generateTaskWrapper()` (`src/services/cloud/task-wrapper.ts:34`) and never cleaned up.
- **Files to modify:** New file `src/services/task-cleanup.ts`, `src/index.ts` (startup scan), `src/services/cloud/task-wrapper.ts` (add retention marker)
- **Implementation:**
  - Create `src/services/task-cleanup.ts` with:
    - `cleanupStaleTasks()`: scan `~/.fleet-tasks/`, read each `status.json`, apply retention:
      - `completed` → 1 hour retention (configurable via `FLEET_TASK_RETENTION_HOURS_SUCCESS`, default 1)
      - `failed` → 7 day retention (configurable via `FLEET_TASK_RETENTION_HOURS`, default 168)
      - Running tasks (PID alive) → skip
      - No `status.json` or unreadable → treat as failed, use `mtime` of directory
    - `scheduleTaskCleanup(taskId: string, status: 'completed' | 'failed')`: schedule a `setTimeout` for cleanup after retention window
  - In `src/index.ts` `startServer()`: call `cleanupStaleTasks()` on startup (fire-and-forget)
  - The task wrapper script runs on the remote member, so the cleanup is local to the controller's view. For remote tasks, the controller only tracks via `monitor_task` — the remote cleanup is out of scope here.
- **Acceptance criteria:**
  - Tests confirm: completed task cleaned after 1h, failed retained 7d, running task skipped
  - `FLEET_TASK_RETENTION_HOURS` env var overrides default
  - Startup scan works
  - `npm test` passes
- **Type:** task

### T2.3 — Auto-remove credential helper after token expiry (#69)

- **Description:** `provisionVcsAuth()` writes a git credential helper (`~/.fleet-git-credential` on Linux, `.fleet-git-credential.bat` on Windows) and sets git config. Token expires (~1 hour for GitHub App tokens) but files linger.
- **Files to modify:** `src/tools/provision-vcs-auth.ts`, new `src/services/credential-cleanup.ts`
- **Implementation:**
  - Create `src/services/credential-cleanup.ts`:
    - `scheduleCredentialCleanup(agent: Agent, expiresAt?: string)`: sets a `setTimeout` to fire at `expiresAt` (or default 55 min TTL). On fire:
      - Call `revokeVcsAuth` logic (service.revoke) for the agent's VCS provider
      - Best-effort: catch all errors silently
    - `cancelCredentialCleanup(agentId: string)`: cancel timer if agent is removed or re-provisioned
    - Track timers per `agentId` in a `Map<string, NodeJS.Timeout>`
  - In `provisionVcsAuth()`: after successful deploy (line 145), call `scheduleCredentialCleanup(agent, deployResult.metadata?.expiresAt)`.
  - In `removeMember()`: call `cancelCredentialCleanup(agent.id)` before removal.
  - In `provisionVcsAuth()`: call `cancelCredentialCleanup(agent.id)` before deploying new credentials (cancel old timer).
- **Acceptance criteria:**
  - Timer scheduled at correct TTL based on `expiresAt`
  - Default 55 min TTL when no `expiresAt`
  - Re-provision cancels old timer
  - Multiple simultaneous credentials (different agents) don't clobber
  - Cleanup failure is silent
  - Unit tests cover all above
  - `npm test` passes
- **Type:** task

### T2.4 — Full decommissioning protocol for remove_member (#72)

- **Description:** `removeMember()` at `src/tools/remove-member.ts:19-84` currently clears LLM auth credentials and removes local SSH keys, but does NOT revoke VCS auth or remove the fleet SSH public key from the remote `~/.ssh/authorized_keys`.
- **Files to modify:** `src/tools/remove-member.ts`
- **Implementation:**
  1. **Idle check:** Before decommissioning, check if member is busy (has active session/running task). If busy, return error asking to wait or force.
  2. **VCS auth revoke:** If `agent.vcsProvider` is set and member is online, call the VCS provider's `revoke()` method (same as `revokeVcsAuth` tool). Best-effort.
  3. **SSH key removal from authorized_keys:** For remote members with `agent.keyPath`, read the `.pub` file, then execute on the remote: `sed -i '/KEY_CONTENT/d' ~/.ssh/authorized_keys`. Best-effort.
  4. **Local members:** Skip SSH key removal from authorized_keys (step 3). Skip remote folder deletion (non-destructive default per requirements).
  5. Cancel credential cleanup timer (`cancelCredentialCleanup(agent.id)`) from T2.3.
- **Acceptance criteria:**
  - Tests verify: idle check blocks busy members, VCS revoke called for remote, SSH key removal attempted for remote (not local)
  - Existing cleanup (LLM credentials, local key files, known_hosts) preserved
  - `npm test` passes
- **Type:** task

### V2 — Phase 2 Verification Checkpoint

- **Description:** Build and test gate for Phase 2.
- **Steps:**
  1. `git fetch origin && git rebase origin/main`
  2. `npm run build` — 0 errors
  3. `npm test` — all pass, report count vs V1
  4. Verify each issue added ≥1 new test
  5. `git push origin sprint/10-issue-blitz`
  6. STOP — report status for PM review
- **Type:** verify

---

## Phase 3 — Features & Perf

Issues: #161, #151

### T3.1 — Local members skip fleet-mcp loading (#151)

- **Description:** The issue states local members wastefully load fleet-mcp. Investigation shows: `execute_prompt` launches Claude Code on the member machine, which loads MCP servers from that machine's `.claude/settings.json`. The fleet MCP server (`apra-fleet`) is installed on the **controller** machine via `install.ts:276-317`. If a local member IS the controller machine, it loads fleet-mcp when Claude Code starts.
- **Files to modify:** `src/tools/compose-permissions.ts` (add `mcpServers` deny), `src/tools/execute-prompt.ts` (pass config flag)
- **Implementation:** Option B — `compose_permissions` delivers a member config that explicitly disables fleet-mcp.
  - In `composePermissions()`, when writing `.claude/settings.local.json` to the member, add:
    ```json
    { "mcpServers": { "apra-fleet": { "disabled": true } } }
    ```
    This uses Claude Code's settings.local.json override to disable the MCP server for that session without removing it globally.
  - Alternatively, if `settings.local.json` doesn't support MCP disable, use the `--no-mcp` approach: in `execute_prompt`, when building the claude command, add `--mcp-config /dev/null` or equivalent flag to prevent loading MCP servers for member sessions.
  - Decision documented in `design.md`.
- **Acceptance criteria:**
  - PM (controller) can still use fleet-mcp normally
  - Local member dispatches do not include fleet-mcp
  - Unit test verifies member config excludes fleet-mcp
  - `npm test` passes
- **Type:** task

### T3.2 — Release update notification in fleet_status (#161)

- **Description:** On server start, fetch latest release tag from GitHub API and cache. Surface update notice in `fleet_status` when a newer version exists.
- **Files to modify:** `src/services/update-check.ts` (new), `src/tools/check-status.ts`, `src/index.ts`
- **Implementation:**
  - Create `src/services/update-check.ts`:
    - `checkForUpdate()`: `GET https://api.github.com/repos/Apra-Labs/apra-fleet/releases/latest` → extract `tag_name`. Compare semver with `serverVersion` (from `version.ts`). Cache result. Fire-and-forget, never throws.
    - `getUpdateNotice(): string | null`: returns the notice string if update available, null otherwise.
    - Ignore pre-release tags (skip if `tag_name` contains `-alpha`, `-beta`, `-rc`).
    - Use native `fetch()` (Node 18+). Timeout after 5s.
  - In `src/index.ts` `startServer()`: call `checkForUpdate()` fire-and-forget on startup.
  - In `fleetStatus()` at `src/tools/check-status.ts`:
    - After building the response, prepend update notice if available.
    - Compact format: `ℹ️ apra-fleet v0.1.8 is available (installed: v0.1.7). Run \`/pm deploy apra-fleet\` to update.\n`
    - JSON format: add `updateAvailable: { latest: "v0.1.8", installed: "v0.1.7" }` to the response object.
- **Acceptance criteria:**
  - `fleet_status` shows notice when mock latest > installed
  - Silent when on latest
  - Network failure silent — no error in output
  - Unit tests: newer version notice, same version silent, network failure silent, pre-release ignored
  - `npm test` passes
- **Type:** task

### V3 — Phase 3 Verification Checkpoint (Final Gate)

- **Description:** Final build and test gate.
- **Steps:**
  1. `git fetch origin && git rebase origin/main`
  2. `npm run build` — 0 errors
  3. `npm test` — all pass, report count vs V2
  4. Verify each issue added ≥1 new test
  5. `npm run lint` if available
  6. `git push origin sprint/10-issue-blitz`
  7. STOP — final report for PM review
- **Type:** verify

---

## Task Summary

| ID   | Issue | Description                                    | Type   |
|------|-------|------------------------------------------------|--------|
| T1.1 | #167  | ESM __dirname shim in compose-permissions      | task   |
| T1.2 | #146  | receive_files Windows path rejection           | task   |
| T1.3 | #144  | SSH usernames with spaces                      | task   |
| T1.4 | #150  | SSH error messages + hook gating               | task   |
| V1   | —     | Phase 1 verification checkpoint                | verify |
| T2.1 | #70   | send_files basename collision detection        | task   |
| T2.2 | #8    | Stale task directory cleanup                   | task   |
| T2.3 | #69   | Auto-remove credential helper after expiry     | task   |
| T2.4 | #72   | Full decommissioning for remove_member         | task   |
| V2   | —     | Phase 2 verification checkpoint                | verify |
| T3.1 | #151  | Local members skip fleet-mcp                   | task   |
| T3.2 | #161  | Release update notification in fleet_status    | task   |
| V3   | —     | Final verification checkpoint                  | verify |

## Risk Assessment

- **Highest risk Phase 1:** T1.2 (Windows path logic) — cross-platform path handling is subtle
- **Highest risk Phase 2:** T2.4 (decommissioning) — touches multiple subsystems, SSH key removal is irreversible
- **Highest risk Phase 3:** T3.1 (fleet-mcp skip) — needs investigation of how Claude Code handles settings.local.json MCP overrides
