# Work Tools

The core workflow tools — pushing files to agents, running Claude prompts, and managing conversation sessions.

## send_files

Uploads local files to an agent's working directory.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the target agent |
| `local_paths` | string[] | yes | Array of absolute local file paths to upload |
| `remote_subfolder` | string | no | Optional subfolder within the agent's working directory |

**What it does:**

1. Looks up the agent by ID.
2. Calls `strategy.transferFiles()`:
   - **Remote agents:** uploads via SFTP (creates remote directories recursively, then uses `sftp.fastPut()` for each file). Falls back from SCP to SFTP transparently.
   - **Local agents:** uses `fs.copyFileSync()` to copy files to the target folder. Creates the destination directory with `fs.mkdirSync({ recursive: true })` if needed.
3. Updates the agent's `lastUsed` timestamp.

**Output:** Lists successfully uploaded files and any failures with error messages. Shows the remote destination path.

**Behavior details:**
- Files are placed flat in the destination — only the basename is used, not the full source path structure.
- If `remote_subfolder` is provided, files go to `{remoteFolder}/{remote_subfolder}/`.
- Each file is transferred independently — one failure doesn't stop the others.

## execute_prompt

Runs a Claude prompt on an agent. This is the primary tool for doing actual work across the fleet.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the target agent |
| `prompt` | string | yes | The prompt text to send to Claude |
| `resume` | boolean | no | Default: `true`. Continue the previous session if one exists |
| `timeout_ms` | number | no | Default: 300000 (5 minutes). Max time to wait for Claude's response |

**What it does:**

1. Looks up the agent by ID.
2. **Base64-encodes the prompt** — this avoids shell escaping issues when the prompt contains quotes, newlines, or special characters. The encoding is decoded on the target side before being passed to Claude.
3. **Builds the Claude command** — OS-specific:
   - Unix: `cd "{folder}" && claude -p "$(echo '{b64}' | base64 -d)" --output-format json --max-turns 50`
   - Windows: Uses PowerShell to decode base64, then pipes to Claude via `for /f`
4. **Appends `--resume {sessionId}`** if `resume=true` and the agent has a stored session ID.
5. **Executes via strategy** — `strategy.execCommand(claudeCmd, timeout_ms)`.
6. **Parses JSON output** — extracts `session_id` and `result` from Claude's JSON response.
7. **Handles stale sessions** — if the command fails and a resume was attempted, retries without `--resume` (starts a fresh session).
8. **Updates registry** — stores the new `sessionId` and `lastUsed` timestamp.

**Output:** Claude's response text, plus the session ID if one was returned.

**Session behavior:**
- First prompt on an agent: no session exists, Claude starts fresh.
- Subsequent prompts with `resume=true`: Claude continues the conversation with full context of prior exchanges.
- If a session becomes stale (e.g. expired server-side), the tool automatically retries without resume — the user sees the response, not an error.
- Use `reset_session` to explicitly start fresh.

## reset_session

Clears stored session IDs so the next prompt starts a fresh Claude conversation.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | no | UUID of a specific agent. Omit to reset ALL agents |

**What it does:**

1. If `agent_id` is provided: clears that agent's `sessionId` field in the registry.
2. If omitted: iterates all agents and clears every `sessionId`.
3. Persists the changes.

**Output:** Confirmation with the count of sessions reset.

**When to use:**
- The conversation has gone off-track and you want Claude to start with a clean slate.
- You're switching to a different task on the same agent.
- Debugging — you want to ensure no prior context influences the response.

**Note:** This does NOT kill any running Claude process on the agent. It only clears the stored session ID so the next `execute_prompt` won't pass `--resume`.
