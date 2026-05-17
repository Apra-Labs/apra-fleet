# Gemini CLI Built-in Tools

> Last verified: **Gemini CLI v0.42.0**

### File Operations

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_directory` | List files and subdirectories | `dir_path` (req), `ignore` (opt), `file_filtering_options` (opt) |
| `read_file` | Read content of a specific file | `file_path` (req), `start_line` (opt), `end_line` (opt) |
| `write_file` | Create or overwrite a file | `file_path` (req), `content` (req) |
| `replace` | Surgical text replacement | `file_path` (req), `old_string` (req), `new_string` (req), `instruction` (req), `allow_multiple` (opt) |
| `glob` | Find files by pattern | `pattern` (req), `dir_path` (opt), `case_sensitive` (opt), `respect_git_ignore` (opt), `respect_gemini_ignore` (opt) |
| `grep_search` | Regex search in file contents | `pattern` (req), `dir_path` (opt), `include_pattern` (opt), `exclude_pattern` (opt), `max_matches_per_file` (opt), `total_max_matches` (opt), `names_only` (opt) |

### Shell

| Tool | Description | Parameters |
|------|-------------|------------|
| `run_shell_command` | Execute shell commands | `command` (req), `description` (req), `is_background` (opt), `dir_path` (opt), `delay_ms` (opt) |
| `list_background_processes` | List active background jobs | `wait_for_previous` (opt) |
| `read_background_output` | Read logs of a background job | `pid` (req), `lines` (opt), `delay_ms` (opt), `wait_for_previous` (opt) |

---

### Agents & Tasks

#### Subagents  -  `codebase_investigator`, `generalist`, `cli_help`

Invoke specialized agents to handle complex tasks in their own context. Subagents are called directly by their name.

**Available Subagents:**

| Agent Name | Function |
|------------|----------|
| `codebase_investigator` | Deep analysis, architectural mapping, and root-cause analysis. |
| `generalist` | Turn-intensive tasks, batch refactoring, and resource-heavy research. |
| `cli_help` | Questions about Gemini CLI configuration, features, and policy schemas. |

**Common Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string |  | The COMPLETE, detailed task instructions for the subagent. |
| `wait_for_previous` | boolean |  -  | If true, wait for preceding tools in the same turn to finish. |

---

#### `update_topic`  -  Manage narrative flow

Updates the user on progress and transitions between strategic phases.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `strategic_intent` | string |  | A mandatory one-sentence statement of the immediate high-level goal. |
| `title` | string |  -  | The title of the new Chapter or Topic. |
| `summary` | string |  -  | Detailed summary (5-10 sentences) of previous work and new intent. |

---

#### Task Tracker (`tracker_*`)

Granular tracking of tasks and dependencies within the session.

| Tool | Purpose | Parameters |
|------|---------|------------|
| `tracker_create_task` | Create a new task | `title` (req), `description` (opt), `type` (epic/task/bug) |
| `tracker_update_task` | Update task state | `id` (req), `status` (pending/in_progress/blocked/closed), `dependencies` |
| `tracker_get_task` | View full task details | `id` (req) |
| `tracker_list_tasks` | List session tasks | `status` (opt), `type` (opt), `parentId` (opt) |
| `tracker_visualize` | View task dependency tree | (None) |

---

### Planning & Interaction

| Tool | Purpose | Parameters |
|------|---------|------------|
| `enter_plan_mode` | Switch to read-only research/design mode | `reason` (req) |
| `ask_user` | Request structured user input | `questions` (req) |
| `activate_skill` | Load a specialized agent skill | `name` (req) |

### Web & Search

| Tool | Purpose | Parameters |
|------|---------|------------|
| `google_web_search` | Search the internet | `query` (req) |
| `web_fetch` | Extract content from URLs | `prompt` (req: URL + instructions) |

---

## Model Context Protocol (MCP)

Gemini CLI integrates with MCP servers. All MCP tools follow the pattern:
`mcp_<server_name>_<tool_name>`

Example: `mcp_apra-fleet_execute_prompt`

---

## Hooks

Hooks are shell commands executed on lifecycle events. Configure in `settings.json`. Payloads are **JSON via stdin**.

### Base Payload Fields (All Hooks)
`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`

### Available Hooks & Payloads

| Hook Name | Event Trigger | Unique Payload Fields |
|-----------|---------------|-----------------------|
| `SessionStart` | Session initialization | `source` (startup/resume/clear) |
| `BeforeTool` | Before a tool call | `tool_name`, `tool_input`, `mcp_context` |
| `AfterTool` | After tool completion | `tool_name`, `tool_input`, `tool_response` |
| `BeforeAgent` | Before processing message | `prompt` |
| `AfterAgent` | After model response | `response` |
| `SessionEnd` | End of session or turn | `reason` (exit/clear/logout/etc.) |
| `Notification` | Background event completion | `notification_type`, `message`, `details` |
| `PreCompress` | Before context compression | `trigger` (auto/manual) |

### Exit code behaviour

| Exit code | Meaning |
|-----------|---------|
| `0` | Success  -  proceed normally |
| `2` | **Block**  -  abort the tool call or prompt (`BeforeTool` and `BeforeAgent` only) |
| other non-zero | Error  -  logged but does not block |
