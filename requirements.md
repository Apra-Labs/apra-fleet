# Requirements: UX, Quality & Installer Fixes Sprint

**Issues:** #6, #9, #10, #37, #39, #42, #57, #67, #78  
**Branch:** `sprint/ux-quality-fixes`  
**Base branch:** `main`  
**Repo:** `C:\akhil\git\apra-fleet`

---

## Issue #42 — OOB terminal: no paste support, no Esc to cancel, window close doesn't unblock caller

### Problem
The out-of-band (OOB) terminal window used for secure input (passwords, API keys) has three UX issues:

1. **Cannot paste** — Ctrl+V, right-click paste do not work. API keys are long random strings that cannot be typed manually. Breaks `provision_auth` and `register_member` password flows.
2. **No Esc to cancel** — No way to abort the OOB prompt. User is stuck with no graceful exit.
3. **Window close doesn't unblock caller** — Closing the OOB terminal window via the X button leaves the calling tool (`provision_auth`, `register_member`) blocked indefinitely.

### Root cause area
`src/services/auth-socket.ts` — Unix domain socket server driving the OOB terminal. Terminal launch is from tool handlers.

### Expected behavior
- Paste works (Ctrl+V and right-click)
- Esc or Ctrl+C cancels and returns a cancellation result to the caller
- Window close (X button) triggers the same cancellation path — caller unblocks immediately

---

## Issue #78 — Installer: embed version in MCP server registration key

### Problem
The installer registers the MCP server under the static key `apra-fleet` in all config files. Claude Code derives the `/mcp` display title from this key: `apra-fleet` → **"Apra-fleet MCP Server"** — no version visible. The `serverInfo.name` in `src/index.ts:73` (`apra fleet server ${serverVersion}`) is NOT used as the dialog title.

To compensate, the server currently embeds the version in every tool call response — this is noise.

### Proposed fix
Change the registered key to `apra-fleet_v0.1.3_d10302` (underscore-separated, full `serverVersion` value).

**Affected locations in `src/cli/install.ts`:**
- `mergeGeminiConfig`: `settings.mcpServers['apra-fleet']`
- `mergeCopilotConfig`: `settings.mcpServers['apra-fleet']`
- `mergeCodexConfig`: `settings.mcp_servers['apra-fleet']`
- `claude mcp add --scope user apra-fleet` CLI command (~line 388)
- `claude mcp remove apra-fleet` CLI command (~line 384) — must remove old versioned entry

**Migration:** On upgrade, find and remove any existing `apra-fleet*` entry before registering the new versioned key.

**Follow-on:** Strip the version suffix from individual tool call responses once it's in the key.

---

## Issue #67 — .fleet-task* files must not be committed to member repos

### Problem
`.fleet-task*` files created by the fleet server during prompt delivery are being committed to member git repos — polluting history, leaking internal details.

### Fix locations
- `skills/pm/tpl-doer.md` — rule already present ("NEVER stage or commit `.fleet-task*.md`") — verify it's there and correct
- `src/tools/execute-prompt.ts` — where `.fleet-task*` files are written; consider writing to a temp path outside the work folder (e.g. OS temp dir) so they're never in the repo at all
- If files must remain in work folder: write a `.gitignore` guard — append `.fleet-task*` to the work folder's `.gitignore` before writing the task file

---

## Issue #57 — update_task_tokens: silent data loss on git commit failure

### Bug
`update_task_tokens` reports success but silently discards token counts when git commit fails.

**Reproduction:**
1. Call `update_task_tokens` on a progress.json outside a git repo
2. Tool reports: `reviewer.input += 12000 → 12000`
3. Call again — reports `→ 12000` again (should be `→ 24000`)
4. Read file — tokens still 0

**Root cause:** File write and git commit are coupled in `src/tools/update-task-tokens.ts`. When `git commit` exits 128, the write is rolled back or never flushed.

**Fix:**
1. Always write the file to disk first
2. Attempt git commit — failure logs an error but does NOT revert the file
3. Return success if the file was written, regardless of git commit result

---

## Issue #39 — De-registered member icon persists in Claude UI

### Bug
After `remove_member`, the member's icon/status in the Claude Code UI does not disappear.

**Version:** v0.1.2  
**Root cause area:** `src/tools/remove-member.ts` — removes from registry but cannot force Claude Code UI to refresh.

**Fix:** The tool response should instruct the user to run `/mcp` → Reconnect to refresh MCP server state, which clears stale UI entries. Add this to the `remove_member` success response text. Document as a known limitation if full programmatic removal is not possible.

---

## Issue #37 — --version reports wrong version

### Bug
`apra-fleet.exe --version` reports `v0.1.1_0e9238` when the installed binary is v0.1.2+.

**Root cause:** Version string not injected at build time from git tag. Check `src/version.ts` and `.github/workflows/ci.yml` — tag injection step is missing or broken.

**Acceptance criteria:**
- `--version` output matches the git tag / release version
- Version injected at build time from `git describe --tags` or equivalent, not hardcoded
- `_<commit-hash>` suffix is from HEAD at build time

---

## Issue #6 — Credential leakage test is a no-op

### Problem
`tests/security-hardening.test.ts:196-203` constructs a local string, calls `.slice(0, 50)`, and asserts `length === 50`. It does NOT import or call any code from `lifecycle.ts`. It validates JavaScript string behavior only.

**File:** `tests/security-hardening.test.ts:196-203`  
**Target:** `src/services/cloud/lifecycle.ts` — `ensureCloudReady` error handling  
**Fix:** Import and invoke the actual error path. The test should verify that when `ensureCloudReady` encounters an error containing a credential string, the thrown message is truncated to prevent leakage.

---

## Issue #9 — parseGpuUtilization accepts invalid values

### Problem
`parseGpuUtilization` uses `parseInt(stdout.trim())` and accepts negatives and values > 100.

**Files:** `src/utils/gpu-parser.ts`, `src/services/cloud/activity.ts`  
**Fix:** Return `undefined` for values < 0 or > 100. Extend `tests/gpu-parser.test.ts` with negative and >100 cases.

---

## Issue #10 — update_member silently ignores cloud fields on non-cloud members

### Problem
`update_member` called with `cloud_activity_command`, `cloud_idle_timeout_min`, etc. on a non-cloud member silently no-ops with a success response.

**File:** `src/tools/update-member.ts`  
**Fix:** Detect cloud-specific fields on non-cloud members and return a warning in the response: `"Warning: cloud fields (X, Y) are ignored — member 'name' is not a cloud member."` Do not reject — just warn. Add test coverage.
