# Claude Code Built-in Tools

> Last verified: **Claude Code v2.1.140**

### File Operations
| Tool | Description |
|------|-------------|
| `Read` | Read a file from the local filesystem |
| `Write` | Write/overwrite a file |
| `Edit` | Exact string replacement in a file |
| `Glob` | Find files by pattern (e.g. `**/*.ts`) |
| `Grep` | Search file contents with regex (ripgrep) |
| `NotebookEdit` | Edit a cell in a Jupyter notebook |

### Shell
| Tool | Description |
|------|-------------|
| `Bash` | Run a shell command (bash/zsh) |
| `PowerShell` | Run a PowerShell command (Windows) |

---

### Agents & Tasks

#### `Agent`  -  Launch a subagent

Spawns a new agent to handle a complex, multi-step task in its own context window. Can run in foreground (blocking) or background (non-blocking).

**Available `subagent_type` values:**

| Type | Description | Tools |
|------|-------------|-------|
| `claude` | General catch-all  -  use when no other type fits | All (`*`) |
| `claude-code-guide` | Questions about Claude Code CLI, Agent SDK, or Claude API | Glob, Grep, Read, WebFetch, WebSearch |
| `Explore` | Fast read-only code search  -  find files, symbols, references | All except Agent, ExitPlanMode, Edit, Write, NotebookEdit |
| `general-purpose` | Multi-step research, open-ended searches | All |
| `Plan` | Architecture design and implementation planning | All except Agent, ExitPlanMode, Edit, Write, NotebookEdit |
| `statusline-setup` | Configure the Claude Code status line setting | Read, Edit |

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `description` | string |  |  -  | Short (3-5 word) description of the task |
| `prompt` | string |  |  -  | The task for the agent to perform |
| `subagent_type` | string |  -  | `general-purpose` | Agent type (see table above) |
| `model` | enum |  -  | agent default | Model override: `sonnet`, `opus`, or `haiku` |
| `run_in_background` | boolean |  -  | `false` | Run async; you are notified on completion |
| `isolation` | enum |  -  |  -  | `"worktree"`  -  agent works in a temp git worktree, auto-cleaned if no changes |

---

#### `TaskCreate`  -  Create a tracked task

Creates a task in the session task list. All tasks start as `pending`. Use `TaskUpdate` to set dependencies after creation.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string |  | Brief, imperative title (e.g. "Fix auth bug") |
| `description` | string |  | What needs to be done |
| `activeForm` | string |  -  | Present-continuous label shown in spinner when `in_progress` (e.g. "Fixing auth bug") |
| `metadata` | object |  -  | Arbitrary key/value metadata to attach |

---

#### `TaskGet`  -  Retrieve a task by ID

Returns full task details: subject, description, status, owner, `blocks`, and `blockedBy` lists.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string |  | ID of the task to retrieve |

---

#### `TaskList`  -  List all tasks

Returns a summary of every task in the session: ID, subject, status, owner, and `blockedBy`. No parameters.

---

#### `TaskUpdate`  -  Update a task

Updates status, ownership, dependencies, or metadata. Always call `TaskGet` first to read current state before updating.

**Status workflow:** `pending` -> `in_progress` -> `completed` (use `deleted` to remove permanently)

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string |  | ID of the task to update |
| `status` | enum |  -  | `pending`, `in_progress`, `completed`, or `deleted` |
| `subject` | string |  -  | New title |
| `description` | string |  -  | New description |
| `activeForm` | string |  -  | New spinner label |
| `owner` | string |  -  | Agent name to assign |
| `metadata` | object |  -  | Keys to merge in (set a key to `null` to delete it) |
| `addBlocks` | string[] |  -  | Task IDs that cannot start until this one completes |
| `addBlockedBy` | string[] |  -  | Task IDs that must complete before this one can start |

---

#### `TaskStop`  -  Kill a running background task

Terminates a running background task by ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string |  -  | ID of the background task to stop |
| `shell_id` | string |  -  |  Deprecated  -  use `task_id` instead |

---

#### `TaskOutput`  -  Get output from a background task  Deprecated

> **Deprecated.** Background tasks return their output file path in the tool result; use `Read` on that path instead. For local agent tasks, use the `Agent` tool result directly  -  do **not** Read the `.output` file (it is a full JSONL transcript and will overflow context).

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task_id` | string |  |  -  | ID of the task |
| `block` | boolean |  | `true` | Wait for completion before returning |
| `timeout` | number |  | `30000` | Max wait time in ms (max 600000) |

---

#### `Monitor`  -  Stream events from a long-running process

Runs a shell command in the background and delivers each stdout line as a notification. Use this for ongoing event streams (log tails, file watches, poll loops). Exit ends the watch.

**When to use vs. Bash `run_in_background`:**
- **Single notification** ("tell me when build finishes") -> use `Bash` with `run_in_background` and an `until` loop
- **One notification per occurrence, indefinitely** ("every time an ERROR appears") -> `Monitor` with unbounded command
- **One per occurrence until a known end** ("each CI step until run completes") -> `Monitor` with a command that exits when done

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `description` | string |  |  -  | Human-readable label shown in every notification |
| `command` | string |  |  -  | Shell command; each stdout line is one event |
| `timeout_ms` | number |  | `300000` | Kill after this many ms (max 3600000). Ignored when `persistent: true` |
| `persistent` | boolean |  | `false` | Run for the full session lifetime. Stop with `TaskStop` |

---

### Scheduling
| Tool | Description |
|------|-------------|
| `CronCreate` | Schedule a prompt to fire on a cron schedule (recurring or one-shot) |
| `CronDelete` | Cancel a cron job by ID |
| `CronList` | List all active cron jobs in this session |
| `ScheduleWakeup` | Schedule a wakeup delay for `/loop` dynamic mode |

### Planning & Worktrees
| Tool | Description |
|------|-------------|
| `EnterPlanMode` | Switch into plan mode for design/approval before coding |
| `ExitPlanMode` | Exit plan mode and request user approval of the plan |
| `EnterWorktree` | Create or enter an isolated git worktree |
| `ExitWorktree` | Leave a worktree session (keep or remove) |

### Web & Search
| Tool | Description |
|------|-------------|
| `WebFetch` | Fetch a URL and return its content |
| `WebSearch` | Search the web |

### Interaction & Notifications
| Tool | Description |
|------|-------------|
| `AskUserQuestion` | Present structured multiple-choice questions to the user |
| `PushNotification` | Send a desktop/phone notification to the user |
| `RemoteTrigger` | Call the claude.ai remote-trigger API |
| `ShareOnboardingGuide` | Upload ONBOARDING.md and return a shareable link for teammates (since Claude Code v2.1.140) |
| `Skill` | Invoke a named skill (slash command) |
| `ToolSearch` | Fetch full schemas for deferred tools by name or keyword |

---

## Hooks

Hooks are shell commands Claude Code executes automatically in response to lifecycle events. Configure them in `settings.json` under the `"hooks"` key.

### Hook structure

```json
"hooks": {
  "<HookName>": [
    {
      "matcher": "<tool-name-or-glob-or-empty>",
      "hooks": [
        { "type": "command", "command": "<shell command>" }
      ]
    }
  ]
}
```

- **`matcher`**  -  filters when the hook fires. For tool hooks (`PreToolUse`, `PostToolUse`), match a specific tool name (e.g. `"mcp__apra-fleet__register_member"`) or glob (e.g. `"mcp__apra-fleet__*"`). Leave empty (`""`) to match all.
- **`type`**  -  always `"command"` currently.
- **`command`**  -  shell command to run. Receives context on **stdin as JSON**.

### Exit code behaviour

| Exit code | Meaning |
|-----------|---------|
| `0` | Success  -  proceed normally |
| `2` | **Block**  -  abort the tool call or prompt (`PreToolUse` and `UserPromptSubmit` only) |
| other non-zero | Error  -  logged but does not block |

Hook stdout is shown to the user (or injected into context). stderr is logged.

---

### Available hooks

#### `SessionStart`
Fires when a conversation session initialises  -  including when you **switch to a conversation in the agents view**.

**stdin payload:**
```json
{ "session_id": "...", "session_title": "project icarus" }
```

**Common uses:**
- Prime context (`bd prime`)
- Write a signal file so the status line knows which project is active
- Load project-specific env vars

**Example (from this project):**
```json
"SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bd prime" }] }]
```

> **Status line filtering:** `SessionStart` is the hook to use for per-conversation status line filtering. Write `session_title` to a signal file; the status line script reads it and filters members by prefix. Payload field name (`session_title`) needs verification from docs.

---

#### `PreToolUse`
Fires **before** a tool call executes. Can block the call with exit code `2`.

**stdin payload:**
```json
{ "tool_name": "Bash", "tool_input": { "command": "..." } }
```

**Common uses:**
- Audit or log tool calls
- Block dangerous commands
- Enforce policy (e.g. never allow pushes to main)

---

#### `PostToolUse`
Fires **after** a tool call completes, with the result. Matcher filters by tool name or glob.

**stdin payload:**
```json
{
  "tool_name": "mcp__apra-fleet__register_member",
  "tool_input": { ... },
  "tool_response": { ... }
}
```

**Common uses:**
- Trigger side effects after specific MCP calls (e.g. `post-register-member.sh`)
- Log tool usage
- Update external state

**Example (from this project):**
```json
"PostToolUse": [{
  "matcher": "mcp__apra-fleet__register_member",
  "hooks": [{ "type": "command", "command": "bash ~/.apra-fleet/hooks/post-register-member.sh" }]
}]
```

---

#### `UserPromptSubmit`
Fires when the user submits a message, before Claude processes it. Can block with exit code `2`.

**stdin payload:**
```json
{ "prompt": "lets work on project icarus", "session_id": "..." }
```

**Common uses:**
- Inject context at the start of each turn
- Validate or guard input
- Rate limiting

---

#### `Stop`
Fires when Claude finishes a turn (end of response).

**stdin payload:**
```json
{ "session_id": "...", "stop_reason": "end_turn" }
```

**Common uses:**
- Post-turn notifications
- Auto-commit or auto-push triggers
- Session close checklists

---

#### `Notification`
Fires when Claude Code emits a notification (e.g. background agent completion, push notification).

**stdin payload:**
```json
{ "message": "...", "notification_type": "..." }
```

**Common uses:**
- Forward to Slack / desktop
- Log agent completions
- Trigger downstream pipelines

---

#### `PreCompact`
Fires before context compaction runs. Use it to inject a summary or reminder that survives into the next context window.

**stdin payload:** session metadata only (no tool context).

**Common uses:**
- Re-prime workflow context (`bd prime`) so it survives compaction
- Inject CLAUDE.md summary

**Example (from this project):**
```json
"PreCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bd prime" }] }]
```
