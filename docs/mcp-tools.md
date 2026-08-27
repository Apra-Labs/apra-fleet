# Apra Fleet MCP Tools Reference

Reference for the Model Context Protocol (MCP) tools provided by the `apra-fleet` server.
All tools are registered in `src/services/tool-registry.ts`; each tool's parameter
schema lives in `src/tools/<tool>.ts`.

Section 0 indexes every registered tool. Sections 1-4 go into depth on the
most commonly used ones; for the rest, the tool's own MCP description and its
schema file are the reference.

## Member identification

Every member-scoped tool accepts the same pair of optional identifier fields
(`src/utils/resolve-member.ts`):

| Name | Type | Description |
|------|------|-------------|
| `member_id` | string | UUID of the member. Takes precedence when both are given |
| `member_name` | string | Friendly name of the member. Use when the UUID is not known |

Exactly one of the two must be supplied. The per-tool parameter tables below list
this pair as "member identifier" rather than repeating it.

---

## 0. Tool index

**Member lifecycle:** `register_member`, `list_members`, `update_member`,
`remove_member`, `get_member_model_pricing`, `member_reservation`,
`dolt_push_mutex`, `child_id_allocator`.

**Files:** `send_files`, `receive_files`.

**Execution:** `execute_prompt`, `execute_command`, `stop_prompt`, `monitor_task`.

**Authentication and git:** `provision_llm_auth`, `setup_ssh_key`, `setup_git_app`,
`provision_vcs_auth`, `revoke_vcs_auth`.

**Status and maintenance:** `fleet_status`, `member_detail`, `update_llm_cli`,
`shutdown_server`, `version`, `compose_permissions`, `cloud_control`.

**Credential store:** `credential_store_set`, `credential_store_list`,
`credential_store_update`, `credential_store_delete`.

**Messaging:** `send_email`, `send_message`, `report_status`, `respond_to_message`.

**Code intelligence:** `code_graph`, `code_impact`, `code_query`, `code_context`,
`code_map`, `code_flow`, `code_tests`.

**Knowledge bank:** `kb_capture`, `kb_query`, `kb_list`, `kb_context`,
`kb_session_prime`, `kb_invalidate`, `kb_harvest`, `kb_promote`, `kb_feedback`,
`kb_freshness_sweep`, `kb_import`, `kb_export`, `kb_setup`, `kb_stats`,
`kb_reconcile_prefilter`, `kb_resolve_contradiction`.

The knowledge-bank family is described in
[knowledge-layer.md](knowledge-layer.md).

---

## 1. Lifecycle Tools

Tools that manage the fleet roster -- adding, listing, updating, and removing members.

### `register_member`

Registers a new machine as a fleet member. This is the entry point for every member -- nothing else works until a member is registered.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `friendly_name` | string | yes | Human-readable label (e.g. "web-server"). Letters, numbers, dots, dashes, underscores; 1-64 chars |
| `member_type` | `"local"` \| `"remote"` | no | Default: `"remote"`. Use `"local"` for same-machine members |
| `host` | string | remote only | IP or hostname of the remote machine. Optional for cloud members (auto-resolved from AWS when running) |
| `port` | number | no | SSH port, default 22 |
| `username` | string | remote only | SSH username. Spaces are allowed - the value is passed to SSH, never shell-interpolated |
| `auth_type` | `"password"` \| `"key"` | remote only | Authentication method. Cloud members default to `"key"` |
| `password` | string | conditional | SSH password. Omit for secure out-of-band entry (a prompt opens in a separate terminal). Supports the `{{secure.NAME}}` credential-store token |
| `key_path` | string | conditional | Path to SSH private key. Also used for cloud instance lifecycle |
| `work_folder` | string | yes | Working directory on the target machine. For remote members, must be a fully-qualified/absolute path (e.g. `/home/bella/repo` or `C:\Users\bella\repo`) -- `~` and relative paths are rejected |
| `llm_provider` | `"claude"` \| `"codex"` \| `"copilot"` \| `"agy"` \| `"opencode"` \| `"none"` | no | Default: `"claude"`. `"none"` is a plain command executor: `execute_prompt` is rejected for such members, use `execute_command` |
| `model_cheap` / `model_standard` / `model_premium` | string | no | Pick a model per tier from the curated lists in `src/cli/config.ts` |
| `model_tiers` | object | no | Free-form per-tier model map (`{cheap, standard, premium}`), e.g. `"ollama/qwen3-coder:30b"`. A single model fills all tiers |
| `unattended` | `"false"` \| `"auto"` \| `"dangerous"` | no | Permission mode for unattended execution. Default interactive (`"false"`) |
| `category` | string | no | Group label used to group devices in status output (max 64 chars) |
| `tags` | string[] | no | Free-form labels, max 10 tags of max 64 chars each. Used by `list_members` filtering and `compose_permissions` |
| `git_access` | `"read"` \| `"push"` \| `"admin"` \| `"issues"` \| `"full"` | no | Git access level for this member |
| `git_repos` | string[] | no | Repositories this member may access (e.g. `["Apra-Labs/ApraPipes"]`) |
| `vcs_provider` | `"github"` \| `"bitbucket"` \| `"azure-devops"` \| `"none"` | no | VCS provider this member pushes to and opens PRs against. Omit to auto-detect it from the member's git `origin` remote (see step 8b below); pass `"none"` to declare the member deliberately has no VCS provider and suppress the warning |
| `code_intel_provider` | `"codebase-memory"` \| `"gitnexus"` \| `"none"` | no | Code-intelligence provider. Defaults to the fleet-wide config |
| `shell` | `"gitbash"` \| `"pwsh7"` \| `"powershell5"` | no | Override the probed Windows shell. Ignored for non-Windows members. See [windows-shell-selection.md](windows-shell-selection.md) |
| `unreservable` | boolean | no | Mark the member as never exclusively reservable so several sprints can share it |
| `cloud_provider` | `"aws"` | no | When set, `cloud_instance_id` and `key_path` are required |
| `cloud_instance_id` | string | conditional | EC2 instance id matching `i-[0-9a-f]{8,17}` |
| `cloud_region` | string | no | AWS region, default `us-east-1` |
| `cloud_profile` | string | no | AWS CLI profile name |
| `cloud_idle_timeout_min` | number | no | Minutes of inactivity before auto-stop (1-1440, default 30) |
| `cloud_activity_command` | string | no | Custom workload-detection command; must print `busy` or `idle` |

**What it does, step by step:**

1. **Validates required fields** -- remote members must have `host`, `username`, and `auth_type`. Local members skip all SSH fields.
2. **Duplicate folder check** -- rejects if another member already uses the same folder on the same device (same host for remote, same machine for local).
3. **Tests connectivity** -- remote members get an SSH connection test with latency measurement. Local members always pass (they're on the same machine).
4. **Detects OS** -- remote members run `uname -s` and `cmd /c ver` to determine Linux/macOS/Windows. Local members read `process.platform` directly.
5. **Checks provider CLI** -- runs `<provider> --version` (e.g. `claude --version`, `codex --version`) to verify the LLM CLI is installed and capture the version.
6. **Auth test (remote only)** -- for Claude members, runs a quick `claude -p "hello"` to verify authentication. For non-Claude providers, the version check from step 5 serves as the CLI availability check; auth is verified separately via `provision_llm_auth`. Skipped for local members since they inherit the current session's auth.
7. **Creates working folder** -- `mkdir -p` (or equivalent) on the target.
8. **Provisions role-agent files (remote only)** -- hashes the canonical set of PM role-agent files (planner, doer, reviewer, etc., plus `_shared/` and `schemas/`) against what is already on the remote box and uploads anything missing or stale. Skipped for local members (they share the operator's home directory) and for providers with no agents directory (codex, copilot). A provisioning failure is reported as a warning but never blocks registration.
8b. **Resolves the VCS provider** -- an explicit `vcs_provider` always wins and skips this step entirely. Otherwise the member's git `origin` remote is read (best effort) and its host mapped to a provider: `github.com` -> `github`, `bitbucket.org` -> `bitbucket`, `dev.azure.com` / `*.visualstudio.com` -> `azure-devops`. On success the result carries `VCS Provider: <provider> (auto-detected from origin)`. On failure (no git repo in the work folder yet, or an unrecognized host) registration still SUCCEEDS -- the common flow is to register a member and clone into its work folder afterwards -- but a loud warning is emitted saying the member will be UNABLE to push or open a PR until a provider is set. Members with `llm_provider: "none"` never dispatch an agent and are exempt. A GitHub Enterprise host has no fixed domain and is never auto-detected: register those with an explicit `vcs_provider`.
9. **Persists** -- saves the member to `~/.apra-fleet/data/registry.json` with a generated UUID, including the `llmProvider` and `vcsProvider` fields.

**Output:** Member ID, name, type, OS, folder, auth method, LLM provider, VCS provider, latency, agent-file provisioning result, and any warnings (e.g. CLI not found, auth failed, VCS provider undetermined).

**Failure modes:**
- SSH connection fails: member is NOT registered, error returned
- Duplicate folder: member is NOT registered
- Claude CLI missing: member IS registered, but with a warning
- VCS provider undetermined: member IS registered, but with a loud warning (it cannot push or open a PR until one is set -- call `provision_vcs_auth` with an explicit `provider` (this also records `vcsProvider` as a side effect of provisioning credentials), or call `update_member` with `vcs_provider` set to record the provider directly without provisioning credentials. Re-registering the same folder path is rejected as a duplicate registration, so it is NOT a remedy. fleet-sprint's dispatch-time fallback can also heal it automatically once a git remote exists)

### `list_members`

Lists all registered fleet members with their details.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `format` | `"compact"` \| `"json"` | no | Default `"compact"`. `"json"` returns structured data |
| `tags` | string[] | no | Filter to members that have ALL the listed tags (AND semantics). Omit to return all members |

**What it does:**

Reads the registry and formats every member into a display block showing: ID, type (local/remote), host (remote only), OS, LLM provider, folder, auth type (remote only), session ID, created date, and last used date.

**Output:** Formatted list. Shows "No members registered" if the fleet is empty.

### `update_member`

Modifies an existing member's registration. All fields except `member_id` are optional -- only provided fields are changed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `friendly_name` | string | no | New display name |
| `host` | string | no | New host (remote only) |
| `port` | number | no | New SSH port (remote only) |
| `username` | string | no | New SSH username (remote only) |
| `auth_type` | `"password"` \| `"key"` | no | New auth method (remote only) |
| `password` | string | no | New password (encrypted before storage). Omit to trigger secure out-of-band entry. Supports `{{secure.NAME}}` |
| `rotate_password` | boolean | no | Re-open the out-of-band password prompt for a member already on password auth. Ignored unless `auth_type` is password |
| `key_path` | string | no | New private key path |
| `work_folder` | string | no | New working directory. For non-local (remote/relay) members, must be a fully-qualified/absolute path -- `~` and relative paths are rejected |
| `llm_provider` | `"claude"` \| `"codex"` \| `"copilot"` \| `"agy"` \| `"opencode"` | no | Switch LLM backend |
| `unattended` | `"false"` \| `"auto"` \| `"dangerous"` | no | Permission mode for unattended execution; `"false"` resets to interactive prompts |
| `icon` | string | no | Override the auto-assigned icon (named alias such as `blue-circle`, or a raw emoji) |
| `category` | string | no | Group label; empty string clears it |
| `tags` | string[] | no | Replaces existing tags; empty array clears them (max 10 tags, 64 chars each) |
| `git_access`, `git_repos` | - | no | Same shape as `register_member` |
| `vcs_provider` | `"github"` \| `"bitbucket"` \| `"azure-devops"` \| `"none"` | no | Directly set (override) this member's VCS provider. An explicit operator value, never auto-detected -- use to correct a wrong auto-detect from `register_member`, or to set the provider without provisioning credentials. `"none"` clears it |
| `model_cheap` / `model_standard` / `model_premium` / `model_tiers` | - | no | Same shape as `register_member` |
| `code_intel_provider` | `"codebase-memory"` \| `"gitnexus"` \| `"none"` | no | Switch code-intelligence provider |
| `shell` | `"gitbash"` \| `"pwsh7"` \| `"powershell5"` | no | Override the probed Windows shell |
| `unreservable` | boolean | no | Make the member shareable across sprints |
| `cloud_region` / `cloud_profile` / `cloud_idle_timeout_min` / `cloud_activity_command` | - | no | Cloud settings; pass an empty string to clear `cloud_activity_command` |

**What it does:**

1. Looks up the member by ID.
2. If the member is not local and `work_folder` is provided, rejects it up front unless it is a fully-qualified/absolute path.
3. If `work_folder` is changing, runs the duplicate folder check (same logic as `register_member`) -- rejects if the new folder is already in use by another member on the same device. The check excludes the current member's own ID so "updating to the same folder" doesn't falsely trigger.
4. Encrypts password if provided (AES-256-GCM).
5. Applies updates and persists to registry.
6. **Re-provisions role-agent files (remote only)** -- same hash-diff-and-upload check as `register_member`, so a member that was registered before an agent file was added or changed picks it up. Skipped for local members and providers with no agents directory (codex, copilot); a provisioning failure is returned as a warning and does not fail the update.

**Output:** Updated member details.

**Note:** This tool does NOT re-test SSH connectivity or re-detect the OS. It's a metadata update only. If you change the host or credentials, subsequent tool calls will use the new values.

### `remove_member`

Unregisters a fleet member and cleans up its connection.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `force` | boolean | no | Default `false`. Remove even if the member is currently busy |

**What it does:**

1. Looks up the member.
2. **Best-effort auth cleanup** -- tests connectivity to the member, and if reachable: removes the provider's credential file (e.g. `~/.claude/.credentials.json` for Claude) if the provider supports OAuth copy, and removes the provider's auth env var (e.g. `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex) from shell profiles (`~/.bashrc`, `~/.profile`, `~/.zshrc` on Unix; registry key on Windows). If the member is offline, a warning is returned but the removal still proceeds.
3. Calls `strategy.close()` -- for remote members, this closes the pooled SSH connection. For local members, this is a no-op.
4. Removes the member from the registry file.

**Output:** Confirmation message with member name and ID. Includes warnings if the token could not be cleared (e.g. member was offline).

**Note:** This does NOT delete the working folder on the target machine, nor does it remove any deployed SSH keys from the remote member's `authorized_keys` file. Those remain as-is.

### `shutdown_server`

Gracefully shuts down the MCP server process. Since MCP servers communicate over stdio, the server cannot self-restart -- the client owns the process lifecycle.

**Parameters:** None.

**What it does:**

1. Closes all pooled SSH connections.
2. Exits the process after a short delay (allowing the response to be sent).

**Usage:** Call this tool, then run `/mcp` to start a fresh instance with the latest code. Primarily useful during development when code changes need to be picked up.

---

## 2. Work Tools

The core workflow tools -- pushing files to members, running Claude prompts, and managing conversation sessions.

### `send_files`

Uploads local files to a member's working directory.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `local_paths` | string[] | yes | Array of local file paths to upload |
| `dest_subdir` | string | no | Destination subdirectory relative to the member's `work_folder`. Defaults to the work-folder root. Paths that escape `work_folder` are rejected |
| `substitutions` | object | no | Map of token name to replacement value. Every `{{name}}` occurrence in each file is replaced before transfer. Keys must match `[A-Za-z_][A-Za-z0-9_]*`; a missing token fails the call with no files written; extra keys are ignored; values are never logged |

**What it does:**

1. Looks up the member.
2. Calls `strategy.transferFiles()`:
   - **Remote members:** uploads via SFTP (creates remote directories recursively, then uses `sftp.fastPut()` for each file).
   - **Local members:** uses `fs.copyFileSync()` to copy files to the target folder. Creates the destination directory with `fs.mkdirSync({ recursive: true })` if needed.
3. Updates the member's `lastUsed` timestamp.

**Output:** Lists successfully uploaded files and any failures with error messages. Shows the remote destination path.

**Behavior details:**
- Files are placed flat in the destination -- only the basename is used, not the full source path structure.
- If `dest_subdir` is provided, files go to `{workFolder}/{dest_subdir}/`.
- Each file is transferred independently -- one failure doesn't stop the others.

### `receive_files`

Downloads files from a member into a local directory. The mirror of `send_files`.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `remote_paths` | string[] | yes | Paths on the member to download. Relative paths resolve from `work_folder`; absolute paths must stay inside `work_folder` or are rejected |
| `local_dest_dir` | string | yes | Local directory to write the downloaded files into |

Always batch multiple files into a single call rather than invoking the tool once
per file.

### `execute_prompt`

Runs an LLM prompt on a member. This is the primary tool for doing actual work across the fleet. The tool respects each member's `llm_provider` setting -- the correct CLI is invoked automatically.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `prompt` | string | yes | The prompt text to send to the LLM agent |
| `session_id` | string | no | Shorthand for explicit session resume; equivalent to `resume: "<session_id>"` and takes precedence over `resume` |
| `resume` | boolean \| string | no | Default: `true`. `true` continues the member's most recently stored session if one exists. A string value is an explicit session id to resume instead -- used when a caller must target one specific prior session rather than "whatever the member last used" (e.g. a retry that must reattach to the exact session that produced a prior failed attempt). An explicit-id resume that the provider reports as not found is terminal for that dispatch, not silently retried as a fresh session -- callers needing a fallback must re-dispatch with `resume: false` themselves. |
| `fork` | boolean \| string | no | Default: unset. Branches a NEW session from an existing one instead of continuing it in place -- mirrors `resume`'s shape, but the source session is left untouched and the dispatch gets a distinct new session id seeded from the source's context. `true` forks the member's stored last session (best-effort: a stale/unknown stored session logs a warning and falls back to a plain fresh session, never a hard error). A string value forks exactly that source session id (explicit: an unknown/expired source is a TERMINAL `session_not_found`, no LLM call, no fresh-session fallback). Mutually exclusive with `resume` (any non-default value) and with `session_id` -- specifying `fork` together with either is rejected as a validation error before member resolution or any LLM call. Requires a fork-capable provider; a `fork` request against a provider that does not support fork-mode dispatch is rejected with `reason: "fork_unsupported"` and no LLM call, never silently downgraded to a plain resume/fresh dispatch. |
| `timeout_s` | number | no | Default: 300 (5 min). **Inactivity timeout** -- resets on every output chunk; kills the session only when silent for this many seconds |
| `max_total_s` | number | no | Default: none. **Hard ceiling** -- kills the session after this total elapsed time in seconds regardless of activity |
| `model` | string | no | Model to use. Pass a tier name (`premium`, `standard`, `cheap`) or a provider-specific model ID. Defaults to `standard` tier when omitted. |
| `max_turns` | number | no | Max turns for Claude (1-500, default 50). Ignored by providers that have no turn limit |
| `substitutions` | object | no | Map of token name to replacement value. Replaces `{{name}}` patterns in the prompt before staging on the member. Keys must match `[A-Za-z_][A-Za-z0-9_]*`; a missing token fails the call with no CLI invoked; values are never logged |
| `agent` | string | no | Agent name to activate. Claude uses `claude --agent <name>`; AGY prepends `@<name>` to the prompt. The agent file must exist at the provider-specific project or home path or the call is rejected |
| `sprint_id` | string | no | Identity of the sprint issuing the dispatch, compared against the server-side member reservation instead of the `APRA_FLEET_SPRINT_ID` env var |
| `expected_context_tokens` | number | no | Estimated tokens this dispatch adds to the session's context. Checked against remaining headroom before the LLM is invoked; too little headroom rejects with `insufficient_context_headroom` and no spawn |
| `context_size` | `"S"` \| `"M"` \| `"L"` | no | Size-bucket shorthand for `expected_context_tokens`, mapped via `contextAdmission.sizeBucketTokens` in `config.json`. Ignored when `expected_context_tokens` is set |

**Provider-specific behavior:**

| Aspect | Claude | Codex | Copilot | OpenCode | AGY |
|--------|--------|-------|---------|----------|-----|
| CLI invocation | `claude -p "..." --output-format json` | `codex exec "..." --json` | `copilot -p "..."` | `opencode run` | `agy --output-format json` |
| `max_turns` | `--max-turns N` (default 50) | Not available (ignored) | Not available (ignored) | Not available (ignored) | Not available (ignored) |
| Skip permissions | `--dangerously-skip-permissions` | `--sandbox danger-full-access --ask-for-approval never` | `--allow-all-tools` | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` |
| Session resume | `--resume <session_id>` | positional `resume` | `--continue` | `--session <id>` or `--continue` | `--conversation <id>` or `--continue` |
| Role-agent files | `~/.claude/agents` | none | none | `~/.config/opencode/agents` | `~/.gemini/antigravity-cli/agents` |

Members registered with `llm_provider: "none"` have no LLM CLI at all; `execute_prompt`
is rejected for them and `execute_command` should be used instead.

**Unattended execution:** Use `update_member(unattended='auto')` or `update_member(unattended='dangerous')` to control permission bypass. The schema is strict -- passing unknown fields returns a validation error.

**What it does:**

1. Looks up the member by ID and resolves its LLM provider (`getProvider(agent.llmProvider)`). On the first dispatch to a remote member since the server started, it also checks that member's role-agent files (planner, doer, reviewer, etc.) are current and re-provisions any missing or stale ones before proceeding -- this is what carries an already-registered member's agent files forward after an orchestrator upgrade, without requiring a `register_member`/`update_member` call first. A provisioning failure never blocks the prompt dispatch; it is retried on the next `execute_prompt` call to that member. Skipped for local members and for providers with no agents directory (codex, copilot).
2. **Base64-encodes the prompt** -- this avoids shell escaping issues when the prompt contains quotes, newlines, or special characters. The encoding is decoded on the target side before being passed to the CLI.
3. **Builds the provider command** -- via `provider.buildPromptCommand()`, which produces the correct CLI call for the member's provider and OS. Max-turns flag is only appended for Claude (the only provider that supports it).
4. **Appends the resume flag** if `resume` is truthy (`true`, or an explicit session-id string) and the member has a matching stored session. Each provider uses its own resume flag. When `fork` is active instead, this step appends the provider's fork flag in place of the resume/session-id flags -- the two are mutually exclusive by construction (see "Session forking" below), so a dispatch never carries both.
5. **Executes via strategy** -- `strategy.execCommand(cmd, timeout_s * 1000)`.
6. **Parses the response** -- via `provider.parseResponse()`. Handles Codex NDJSON transparently; extracts text and session info from all providers.
7. **Handles stale sessions** -- when resuming via `resume=true` (the member's own stored session), a command failure after a resume attempt is retried transparently with a fresh minted session ID. This transparent fallback does **not** apply when `resume` was an explicit session-id string: an unresolvable explicit id is rejected outright as `session_not_found` with no LLM call made, since silently switching to a different session would defeat the caller's reason for naming one. The caller must explicitly re-dispatch (typically with `resume=false`) to recover.
8. **Updates registry** -- stores the new `sessionId` (Claude) and `lastUsed` timestamp.

**Output:** `structuredContent.response` carries the agent's reply text; `structuredContent.usage` carries token counts when available; `structuredContent.sessionId` carries the session ID if one was returned.

**Error handling:**
- If the prompt fails due to an authentication issue, returns actionable guidance (`provision_llm_auth`) instead of raw error output.
- Automatically retries once with a 5-second backoff on transient server errors.
- A `busy` rejection is not taken at face value: before rejecting, the tool verifies the locked session's backing process is actually still alive. If confirmed dead, the stale lock self-heals -- released with a warning -- and the dispatch proceeds instead of being rejected.
- A Claude session that terminates because it hit the turn limit always classifies as `max_turns_exhausted`.

**Token accumulation:**
After each successful prompt response, the server automatically accumulates `input_tokens` and `output_tokens` from the provider's usage metadata onto the member record. Running totals are accessible via `member_detail` and `fleet_status`.

**Session behavior:**
- First prompt on a member: no session exists, agent starts fresh.
- Subsequent prompts with `resume=true`: agent continues the conversation with full context of prior exchanges.
- Fleet mints and stores the session ID for Claude, which passes it via `--session-id` on the first run and `--resume <id>` on later runs. Codex and Copilot resume the most recent local session via a generic flag.
- If the member's own stored session (`resume=true`) becomes stale, the tool automatically retries without resume. An explicit session-id resume that turns out to be stale/unknown is terminal instead (`session_not_found`, no automatic retry) -- see "Handles stale sessions" above.

**Session forking:**

`fork` addresses a different need than `resume`: instead of continuing to write into the same session, it branches a new session that starts from an existing session's transcript/context, so the original session remains unaffected by anything that happens on the fork. The motivating use case is token savings in workflows with reusable priming -- build expensive shared context (e.g. codebase orientation, architecture-review setup) once in a source session, then fork it per task so each task starts already primed without re-spending tokens to rebuild that context every time, while unrelated dispatches keep starting clean.

- `resume` and `fork` express contradictory intents (continue in place vs. branch away) and are rejected together as a validation error, checked before any member resolution or LLM call -- there is no precedence rule to fall back on because the combination is never allowed through.
- Fork support is a provider capability, not a universal guarantee: a provider adapter opts in by implementing both a support check and a fork-flag builder. A provider that has not implemented these is fork-incapable by default (there is no fallback that fakes forking by other means), and a `fork` request against it is a terminal, no-LLM-call rejection rather than a silent downgrade to resume or a fresh session.
- For a fork-capable provider, the underlying CLI mints its own new output session id from the fork invocation -- the caller does not (and cannot) supply that id up front the way it can for a caller-minted fresh session. The tool tracks whatever id comes back and records it as the forked session's identity going forward; the source session's own stored id is never overwritten by a fork.
- Explicit-id fork (`fork: "<session-id>"`) has the same terminal, no-fallback contract as explicit-id resume: an unknown or expired source id fails the dispatch outright (`session_not_found`) rather than silently forking from nothing or falling back to a fresh session. Only `fork: true` (best-effort, targeting the member's own stored session) is allowed to degrade transparently to a fresh session when the stored session turns out to be stale or absent.
- Internal retry/self-heal paths (transient dispatch failure, stale-session retry, server-overload retry, self-heal after empty response) never re-fork on retry -- a retry after a fork attempt proceeds as an ordinary fresh dispatch, since re-forking from the same source on every retry would multiply, not save, token spend.

### `execute_command`

Runs a shell command directly on a member without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `command` | string | yes | The shell command to execute |
| `timeout_s` | number | no | Default: 120 (2 minutes). Max time to wait for the command to finish |
| `run_from` | string | no | Override directory to run from. Defaults to member's registered work folder |
| `long_running` | boolean | no | Default `false`. Run as a background task and return a `task_id` for `monitor_task` |
| `max_retries` | number | no | Default 3 (0-10). Max crash retries; `long_running` only |
| `restart_command` | string | no | Command used for retry runs, e.g. a checkpoint resume; `long_running` only |

**What it does:**

1. Looks up the member.
2. Resolves the working directory -- uses `run_from` if provided, otherwise the member's registered `workFolder`.
3. Wraps the command with a `cd` (Unix) or `Set-Location` (Windows) into the resolved folder.
4. Executes via `strategy.execCommand()` with the specified timeout.
5. Returns stdout, stderr, and exit code.

**Output:** Exit code followed by stdout (and stderr prefixed with `[stderr]` if present).

**Security warning:** This tool executes **raw shell commands** on the target machine with full privileges of the user.

**When to use `execute_command` vs `execute_prompt`:**

| Scenario | Tool |
|----------|------|
| Install a package (`npm install`, `apt-get install`) | `execute_command` |
| Check a version (`node --version`, `git --version`) | `execute_command` |
| Run a build or test script | `execute_command` |
| Ask Claude to analyze code, write code, or reason about a task | `execute_prompt` |
| Tasks requiring multi-step reasoning or tool use | `execute_prompt` |

### `stop_prompt`

Terminates the active LLM session on a member and prevents further `execute_prompt` dispatches until the next explicit call.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | one of | UUID of the target member |
| `member_name` | string | one of | Friendly name of the target member |

Always call `TaskStop` on the dispatching background agent after calling this.

**What it does:**

1. Kills the LLM process PID stored for the member using a platform-appropriate kill command (`kill -9` on Unix, `taskkill /F /T /PID` on Windows).
2. Sets a stopped flag on the member in the in-memory registry.
3. Returns a human-readable status message.

---

## 3. Infrastructure Tools

One-time setup and maintenance tools -- provisioning authentication, migrating to SSH keys, and updating the LLM CLI.

### `provision_llm_auth`

Authenticates a fleet member for LLM CLI usage. Two flows: copy master's OAuth credentials (Claude only) or deploy an API key (all providers).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `api_key` | string | no | API key for the member's LLM provider. If provided, deploys this key instead of copying OAuth credentials. Supports the `{{secure.NAME}}` credential-store token |

The correct env var name is automatically determined from the member's
`llm_provider` (`authEnvVar` in `src/providers/*.ts`):

| Provider | Env Var |
|----------|---------|
| Claude | `ANTHROPIC_API_KEY` |
| Codex | `OPENAI_API_KEY` |
| Copilot | `COPILOT_GITHUB_TOKEN` |
| AGY | `ANTIGRAVITY_API_KEY` |
| OpenCode | none (auth is handled by the OpenCode CLI itself) |

### `setup_ssh_key`

Generates an SSH key pair and migrates a remote member from password-based SSH
authentication to key-based authentication.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |

### `update_llm_cli`

Updates -- or, on request, installs -- the LLM provider CLI on a member.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `install_if_missing` | boolean | no | Default `false`. Install the CLI on the member when it is not already present |

---

## 4. Observability Tools

Two-layer monitoring -- a fleet-wide summary and a per-member deep dive.

### `fleet_status`

Provides a quick summary table of all fleet members.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `format` | `"compact"` \| `"json"` | no | Default `"compact"`. `"json"` returns structured data |

**What it does:**

1. Loads all registered members from the registry.
2. **Checks each member in parallel** with a 10-second timeout per member:
   - Calls `strategy.testConnection()` -- for remote members, this opens (or reuses) an SSH connection. For local members, this always returns online.
   - If online, runs a **fleet-aware process check** to determine if Claude is actively running for *this specific member*.
3. Builds a formatted ASCII table.

**Output columns:**

| Column | Values | Meaning |
|--------|--------|---------|
| Name | member's friendly name | -- |
| Host | `host:port` or `(local)` | Connection target |
| Status | `online` / `OFFLINE` | Can we reach the member right now? |
| Busy? | `BUSY` / `idle` / `idle*` / `unknown` / `-` | Is a fleet LLM process running? |
| Session | first 8 chars of session ID or `(none)` | Active conversation thread |
| Last Activity | relative time (e.g. "5m ago", "2d ago") | When `execute_prompt` or `send_files` last touched this member |
| Tokens | `in: N / out: N` or omitted | Accumulated token totals for this member |

### `member_detail`

Deep-dive status for a single member -- connectivity, provider CLI, session state, and system resources.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| member identifier | string | yes | `member_id` or `member_name` |
| `format` | `"compact"` \| `"json"` | no | Default `"compact"`. `"json"` returns structured data |

**What it does:**

Assembles a multi-section report covering:
- **Connectivity:** SSH status, latency in ms, and auth method.
- **LLM CLI:** Installed semver string and authentication method.
- **Session:** Active session ID and last-used timestamp.
- **System Resources:** CPU load, memory usage, and working folder disk space.
- **Git:** Current branch in the member's working folder.
- **Token Usage:** Accumulated lifetime token totals.
