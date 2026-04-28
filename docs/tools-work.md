# Work Tools

The core workflow tools — pushing files to members, running Claude prompts, and managing conversation sessions.

## send_files

Uploads local files to a member's working directory.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `local_paths` | string[] | yes | Array of absolute local file paths to upload |
| `destination_path` | string | no | Optional subfolder within the member's working directory |

**What it does:**

1. Looks up the member by ID.
2. Calls `strategy.transferFiles()`:
   - **Remote members:** uploads via SFTP (creates remote directories recursively, then uses `sftp.fastPut()` for each file).
   - **Local members:** uses `fs.copyFileSync()` to copy files to the target folder. Creates the destination directory with `fs.mkdirSync({ recursive: true })` if needed.
3. Updates the member's `lastUsed` timestamp.

**Output:** Lists successfully uploaded files and any failures with error messages. Shows the remote destination path.

**Behavior details:**
- Files are placed flat in the destination — only the basename is used, not the full source path structure.
- If `destination_path` is provided, files go to `{workFolder}/{destination_path}/`.
- Each file is transferred independently — one failure doesn't stop the others.

## execute_prompt

Runs an LLM prompt on a member. This is the primary tool for doing actual work across the fleet. The tool respects each member's `llm_provider` setting — the correct CLI is invoked automatically.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `prompt` | string | yes | The prompt text to send to the LLM agent |
| `resume` | boolean | no | Default: `true`. Continue the previous session if one exists |
| `timeout_ms` | number | no | Default: 300000 (5 min). **Inactivity timeout** — resets on every output chunk; kills the session only when silent for this many ms |
| `max_total_ms` | number | no | Default: none. **Hard ceiling** — kills the session after this total elapsed time regardless of activity |
| `dangerously_skip_permissions` | boolean | no | Default: `false`. Passes the provider's skip-permissions flag so the agent can execute tools without interactive approval |
| `model` | string | no | Model to use. Pass a tier name (`premium`, `standard`, `cheap`) or a provider-specific model ID. Defaults to `standard` tier when omitted. |

**Provider-specific behavior:**

| Aspect | Claude | Gemini | Codex | Copilot |
|--------|--------|--------|-------|---------|
| CLI invocation | `claude -p "..."` | `gemini -p "..."` | `codex exec "..."` | `copilot -p "..."` |
| JSON output | Single JSON object | Single JSON object | NDJSON (parsed automatically) | Single JSON object |
| `max_turns` | `--max-turns N` (default 50) | Not available (ignored) | Not available (ignored) | Not available (ignored) |
| Skip permissions | `--dangerously-skip-permissions` | `--yolo` | `--sandbox danger-full-access --ask-for-approval never` | `--allow-all-tools` |
| Session resume | `--resume <session_id>` | `-r` (most recent) | positional `resume` | `--continue` |

**When to use `dangerously_skip_permissions`:**

This flag is intended for specific unattended workflows where no human is present at the remote terminal to approve tool calls:
- Installing software or dependencies on a remote member
- Running build/test scripts that require shell access
- Automated CI/CD-style tasks dispatched across the fleet

Do NOT enable this for open-ended prompts on members with access to sensitive data or production systems. The remote agent will execute any tool call — file edits, shell commands, network requests — without confirmation.

**What it does:**

1. Looks up the member by ID and resolves its LLM provider (`getProvider(agent.llmProvider)`).
2. **Base64-encodes the prompt** — this avoids shell escaping issues when the prompt contains quotes, newlines, or special characters. The encoding is decoded on the target side before being passed to the CLI.
3. **Builds the provider command** — via `provider.buildPromptCommand()`, which produces the correct CLI call for the member's provider and OS. Max-turns flag is only appended for Claude (the only provider that supports it).
4. **Appends the resume flag** if `resume=true` and the member has a stored session. Each provider uses its own resume flag.
5. **Executes via strategy** — `strategy.execCommand(cmd, timeout_ms)`.
6. **Parses the response** — via `provider.parseResponse()`. Handles Codex NDJSON transparently; extracts text and session info from all providers.
7. **Handles stale sessions** — if the command fails and a resume was attempted, retries without resume (starts a fresh session).
8. **Updates registry** — stores the new `sessionId` (Claude only) and `lastUsed` timestamp.

**Output:** The agent's response text, plus the session ID if one was returned.

**Error handling:**
- If the prompt fails due to an authentication issue, returns actionable guidance (`provision_llm_auth`) instead of raw error output.
- Automatically retries once with a 5-second backoff on transient server errors.

**Token accumulation:**
After each successful prompt response, the server automatically accumulates `input_tokens` and `output_tokens` from the provider's usage metadata onto the member record. Running totals are accessible via `member_detail` and `fleet_status`. No manual token reporting is needed from agents or the PM.

**Session behavior:**
- First prompt on a member: no session exists, agent starts fresh.
- Subsequent prompts with `resume=true`: agent continues the conversation with full context of prior exchanges.
- Claude stores a server-side session ID. Gemini, Codex, and Copilot resume the most recent local session via a generic flag.
- If a session becomes stale, the tool automatically retries without resume — the user sees the response, not an error.

## execute_command

Runs a shell command directly on a member without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `command` | string | yes | The shell command to execute |
| `timeout_ms` | number | no | Default: 120000 (2 minutes). Max time to wait for the command to finish |
| `run_from` | string | no | Override directory to run from. Defaults to member's registered work folder — rarely needed. |

**What it does:**

1. Looks up the member by ID.
2. Resolves the working directory — uses `run_from` if provided, otherwise the member's registered `workFolder`. Tilde (`~`) at the start of either path is expanded server-side to the master machine's home directory before the command runs.
3. Wraps the command with a `cd` (Unix) or `Set-Location` (Windows) into the resolved folder.
4. Executes via `strategy.execCommand()` with the specified timeout.
5. Returns stdout, stderr, and exit code.

**Output:** Exit code followed by stdout (and stderr prefixed with `[stderr]` if present).

**Security warning:** This tool executes **raw shell commands** on the target machine. It is not sandboxed — the command runs with the full privileges of the SSH user (remote members) or the local process user (local members). Do not pass untrusted input as the command string. Access is gated by member registration (same as `execute_prompt`), and output is subject to the existing 10MB stdout/stderr cap.

**When to use `execute_command` vs `execute_prompt`:**

| Scenario | Tool |
|----------|------|
| Install a package (`npm install`, `apt-get install`) | `execute_command` |
| Check a version (`node --version`, `git --version`) | `execute_command` |
| Run a build or test script | `execute_command` |
| Ask Claude to analyze code, write code, or reason about a task | `execute_prompt` |
| Tasks requiring multi-step reasoning or tool use | `execute_prompt` |

## stop_prompt

Terminates the active LLM session on a member and prevents further `execute_prompt` dispatches until the next explicit call.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | one of | UUID of the target member |
| `member_name` | string | one of | Friendly name of the target member |

**What it does:**

1. Kills the LLM process PID stored for the member (if any) using a platform-appropriate kill command (`kill -9` on Unix, `taskkill /F /T /PID` on Windows). Kill errors (e.g., process already gone) are swallowed.
2. Sets a stopped flag on the member in the in-memory registry — subsequent `execute_prompt` calls return an error and do not spawn, until the next `execute_prompt` explicitly clears the flag.
3. Returns a human-readable status message.

**Output:** A status string indicating whether a running process was killed or the member was already idle.

**Behavior details:**
- Calling `stop_prompt` with no active session is a safe no-op — it sets the stopped flag and returns normally.
- The stopped flag acts as a **single-prompt interlock**: the PM must explicitly re-dispatch (issue a new `execute_prompt`) to resume the member after a stop.
- `stop_prompt` kills the LLM process on the **member machine** (the PID tracked by the fleet server). It does not directly terminate the local background Agent that issued the dispatch — but the stopped flag causes that Agent's next `execute_prompt` call to fail, which ends the dispatch loop.

