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
   - **Remote agents:** uploads via SFTP (creates remote directories recursively, then uses `sftp.fastPut()` for each file).
   - **Local agents:** uses `fs.copyFileSync()` to copy files to the target folder. Creates the destination directory with `fs.mkdirSync({ recursive: true })` if needed.
3. Updates the agent's `lastUsed` timestamp.

**Output:** Lists successfully uploaded files and any failures with error messages. Shows the remote destination path.

**Behavior details:**
- Files are placed flat in the destination — only the basename is used, not the full source path structure.
- If `remote_subfolder` is provided, files go to `{workFolder}/{remote_subfolder}/`.
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
| `dangerously_skip_permissions` | boolean | no | Default: `false`. Runs Claude with `--dangerously-skip-permissions` so it can execute tools without interactive approval |
| `model` | string | no | Model to use (e.g. `opus`, `sonnet`, `haiku`, or full model ID like `claude-sonnet-4-6`). Applies to both new and resumed sessions |

**When to use `dangerously_skip_permissions`:**

This flag is intended for specific unattended workflows where no human is present at the remote terminal to approve tool calls:
- Installing software or dependencies on a remote agent
- Running build/test scripts that require shell access
- Automated CI/CD-style tasks dispatched across the fleet

Do NOT enable this for open-ended prompts on agents with access to sensitive data or production systems. The remote Claude will execute any tool call — file edits, shell commands, network requests — without confirmation.

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

**Error handling:**
- If the prompt fails due to an authentication issue, returns actionable guidance (run `/login` + `provision_auth`) instead of raw error output.
- Automatically retries once with a 5-second backoff on transient server errors (HTTP 500/502/503/529).

**Session behavior:**
- First prompt on an agent: no session exists, Claude starts fresh.
- Subsequent prompts with `resume=true`: Claude continues the conversation with full context of prior exchanges.
- If a session becomes stale (e.g. expired server-side), the tool automatically retries without resume — the user sees the response, not an error.
- Use `reset_session` to explicitly start fresh.

## execute_command

Runs a shell command directly on an agent without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the target agent |
| `command` | string | yes | The shell command to execute |
| `timeout_ms` | number | no | Default: 120000 (2 minutes). Max time to wait for the command to finish |
| `work_folder` | string | no | Directory to cd into before running the command. Defaults to the agent's registered work folder |

**What it does:**

1. Looks up the agent by ID.
2. Resolves the working directory — uses `work_folder` if provided, otherwise the agent's registered `workFolder`.
3. Wraps the command with a `cd` (Unix) or `Set-Location` (Windows) into the resolved folder.
4. Executes via `strategy.execCommand()` with the specified timeout.
5. Returns stdout, stderr, and exit code.

**Output:** Exit code followed by stdout (and stderr prefixed with `[stderr]` if present).

**Security warning:** This tool executes **raw shell commands** on the target machine. It is not sandboxed — the command runs with the full privileges of the SSH user (remote agents) or the local process user (local agents). Do not pass untrusted input as the command string. Access is gated by agent registration (same as `execute_prompt`), and output is subject to the existing 10MB stdout/stderr cap.

**When to use `execute_command` vs `execute_prompt`:**

| Scenario | Tool |
|----------|------|
| Install a package (`npm install`, `apt-get install`) | `execute_command` |
| Check a version (`node --version`, `git --version`) | `execute_command` |
| Run a build or test script | `execute_command` |
| Ask Claude to analyze code, write code, or reason about a task | `execute_prompt` |
| Tasks requiring multi-step reasoning or tool use | `execute_prompt` |

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
