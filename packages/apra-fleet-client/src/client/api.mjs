/**
 * @typedef {Object} ExecutePromptOptions
 * @property {string} prompt - The prompt to send to the LLM on the remote member
 * @property {string} [agent] - Optional agent name to activate
 * @property {number} [max_total_s] - Hard ceiling in seconds, measured from when the server
 *   receives the call (setup counts); exceeding it returns reason 'max_total_time'
 * @property {number} [max_turns] - Max turns for claude -p (default: 50)
 * @property {boolean} [fail_on_permission_denial] - Strict permission handling (default false).
 *   true: a refused tool call fails with reason 'permission_denied' (except a healable:false
 *   Claude refusal on a complete reply, which is a permissionWarning). Omitted/false: a complete
 *   Claude reply succeeds with the refusals in permissionWarning; AGY refusals still fail.
 *   A max_turns/auth/server/overloaded result keeps its own reason either way, with the
 *   refusals attached as permissionDenied.
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [model] - Model tier ("cheap", "standard", "premium") or a specific model ID
 * @property {boolean|string} [resume] - Resume the previous session if one exists. Defaults to
 *   true at this client/transport layer when the field is omitted entirely. NOTE: the
 *   FleetWorkflow.agent() workflow layer (packages/apra-fleet-workflow/src/workflow/index.mjs)
 *   always sends this field explicitly, defaulting it to `false` for workflow-authored
 *   prompts (see AgentOptions.resume there and apra-fleet-unw.3 / F10) -- so workflow
 *   callers effectively opt out of this client-level default unless they ask for resume.
 *   CALLER OBLIGATION: anything reaching executePrompt() WITHOUT going through that
 *   workflow layer must set this field explicitly. Omitting it is never neutral -- the
 *   server resumes the member's stored last session, so a one-off instruction silently
 *   lands in whatever unrelated (and possibly very large) conversation that member last
 *   ran. This client deliberately does NOT inject a default of its own: doing so would
 *   change the documented tool contract for every existing caller. State the intent at
 *   the call site: `true` to continue that member's prior session, a session-id string
 *   to continue a specific one, `false` for a self-contained dispatch.
 * @property {string} [session_id] - Optional explicit session ID to resume (shorthand alias for resume: "<sessionId>")
 * @property {boolean|string} [fork] - Branch a NEW session seeded from an existing one instead of continuing it in place. true = fork from the member's stored last session. A session-id STRING = fork from exactly that session. Mutually exclusive with resume (any non-default value) and with session_id.
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 * @property {number} [timeout_s] - Inactivity timeout in seconds -- always drives the stall detector's per-dispatch baseline threshold, measured against the member's own session transcript activity (default: 300). Per-provider, it ALSO arms the exec-level rolling timer against this dispatch's stdout/stderr channel for Codex and Copilot, which have no pollable transcript; Claude and AGY take that exec-channel ceiling from max_total_s instead; and OpenCode keeps BOTH signals armed at once (this exec-channel timer plus coarse log-directory-mtime polling, combined with OR semantics -- either advancing counts as not-stalled), since its transcript signal is directory-level only, not a per-turn file (see ProviderAdapter.execTimeoutSource() server-side)
 * @property {number} [expected_context_tokens] - Optional estimate of how many
 *   tokens this dispatch will add to the target session's context. When set (or context_size is
 *   set), the server compares it against the session's remaining context-window headroom BEFORE
 *   invoking the LLM: too little headroom rejects the call with {reason:
 *   "insufficient_context_headroom", detail: {demand, headroom, window}} and no spawn; a fit that
 *   lands inside the safety margin still proceeds but attaches a structured contextWarning. Wins
 *   over context_size when both are set. Omitting both fields disables the check entirely --
 *   pre-existing behavior is unchanged. Matches src/tools/execute-prompt.ts's
 *   expected_context_tokens field exactly (number, optional).
 * @property {'S'|'M'|'L'} [context_size] - Optional size-bucket shorthand for
 *   expected_context_tokens: S/M/L map to configured token estimates (fleet
 *   defaults, overridable via config.json's contextAdmission.sizeBucketTokens). Ignored when
 *   expected_context_tokens is also set. Matches src/tools/execute-prompt.ts's context_size field
 *   exactly (enum 'S'|'M'|'L', optional).
 * @property {number} [timeoutMs] - Client-side request timeout override (ms). Not sent to
 *   the server; consumed locally by McpClient.request(). When omitted, a default is derived
 *   from max_total_s/timeout_s (see deriveTimeoutMs in this file).
 * @property {AbortSignal} [signal] - Optional AbortSignal to cancel the client-side wait for
 *   a response. Not sent to the server. Aborting rejects the pending request locally; it
 *   cannot cancel a job already accepted by the remote fleet-server (see client.mjs).
 */

/**
 * apra-fleet-hzeb.2: a provider-agnostic "this dispatch cannot make progress until
 * `resumeAt`" signal, mirroring src/providers/provider.ts's UsageLimitSignal exactly.
 * @typedef {Object} UsageLimitSignal
 * @property {'usage_limit'} type
 * @property {string} resumeAt - ISO-8601 UTC instant at which work may resume. Never null:
 *   when the provider CLI exposes a real reset time it is parsed (resumeAtSource: 'parsed');
 *   otherwise it falls back to a guessed window (resumeAtSource: 'guessed').
 * @property {'parsed'|'guessed'} resumeAtSource
 * @property {string} message - The raw provider message/output that identified this as a
 *   usage/quota limit (for logging).
 */

/**
 * One tool call the member CLI refused, mirroring src/providers/provider.ts's PermissionDenialItem.
 * @typedef {Object} PermissionDenialItem
 * @property {string} action - Provider permission action, e.g. 'command', 'read_file', 'mcp'.
 * @property {string} [target] - The concrete target when the CLI named it, e.g. 'git status --short --branch'.
 * @property {string[]} [suggestedGrants] - compose_permissions grants that would allow this one
 *   call, primary first (empty when no grant maps to it).
 */

/**
 * execute_prompt's `permissionDenied` block, mirroring src/providers/provider.ts's PermissionDenial.
 * @typedef {Object} PermissionDenied
 * @property {string[]} actions - Unique denied actions, in first-seen order.
 * @property {PermissionDenialItem[]} denials - Each refused call, with its target when known.
 * @property {string[]} suggestedGrants - compose_permissions `grant` values that would allow the
 *   denied calls, primary first (for an agy command or unsandboxed denial, on any OS, a
 *   `Bash(<cmd>:*)` prefix grant, then the exact command as the narrow alternative); empty when no
 *   canonical mapping exists, and always empty when `healable` is false (never grant those).
 * @property {string} hint - One-line remediation.
 * @property {Array<'result_json'|'stderr'|'transcript'>} signals - Which CLI signals reported it.
 * @property {string} [permissionMode] - The permission mode the session ran in, when the
 *   provider knows it (Claude: 'auto' | 'acceptEdits' | 'bypassPermissions').
 * @property {boolean} [healable] - false when no grant may ever be added for these denials
 *   (Claude auto/bypass mode: the safety classifier or a deny rule refused the call, not a
 *   missing allow rule; or, in any mode, a fleet tool outside the member allowlist was refused
 *   -- see `cause`). Absent = a grant may heal it.
 * @property {'policy_deny'} [cause] - 'policy_deny' when at least one refused call was a fleet
 *   tool outside the member allowlist, denied by the member's own permission config on purpose.
 *   Always comes with `healable: false`; never grant it.
 */

/**
 * Result-side shape of execute_prompt's `structuredContent` -- the single place callers
 * should read the outcome of a dispatch rather than re-parsing the display text. This is
 * NOT exhaustive of every `reason` value (see src/tools/execute-prompt.ts's
 * ExecutePromptStructured for the full union); it documents the fields most callers key off.
 * @typedef {Object} ExecutePromptStructured
 * @property {boolean} [isError] - true on any failure path; absent/false on success.
 * @property {string} [reason] - Machine-readable failure/status classification, e.g.
 *   'busy' | 'nonzero_exit' | 'max_turns_exhausted' | 'empty_response' | 'overloaded' |
 *   'usage_limit' | 'workspace_not_trusted' | 'session_not_found' | 'permission_denied' |
 *   'stalled' (transcript froze past the stall threshold) |
 *   'agent_never_started' (session log never appeared at its authoritative path within
 *   timeout_s; the process was killed) |
 *   'max_total_time' (max_total_s, measured from the call including setup, ran out) |
 *   'secret_delivery_unavailable' (the member's stored credentials cannot be delivered
 *   without a command line -- relay member or SFTP disabled; deterministic, do not retry;
 *   no LLM call was made) | ...
 * @property {PermissionDenied} [permissionDenied] - Present when `reason === 'permission_denied'`:
 *   the member CLI refused tool calls (AGY headless mode auto-denies them and exits 0; Claude
 *   reports them in its result event's non-empty `permission_denials`). For Claude this needs the
 *   caller's `fail_on_permission_denial: true`; AGY fails this way either way. Pass
 *   `suggestedGrants` to compose_permissions `grant` to heal it; read it with
 *   {@link permissionDenialOf}. Any partial reply is in `response`. A healable:false Claude
 *   refusal (auto/bypass mode) on a complete reply is a `permissionWarning`, not this failure;
 *   on an incomplete one it fails here with `healable: false` and no suggested grants. Also
 *   present as an EXTRA field on a typed failure (max_turns_exhausted, auth, server,
 *   overloaded, ...) or a non-strict Claude failure whose turn carried refusals: the typed
 *   reason wins.
 * @property {PermissionDenied} [permissionWarning] - Present on a SUCCESSFUL dispatch whose
 *   session refused tool calls without failing it: a healable:false refusal (never grant it),
 *   or any Claude refusal when `fail_on_permission_denial` was not set. A logged warning.
 * @property {UsageLimitSignal} [usageLimit] - Present when `reason === 'usage_limit'`
 *   (apra-fleet-hzeb.2): the provider's detectUsageLimit() signal verbatim -- a 429/quota
 *   exhaustion that a fresh session cannot cure, so execute_prompt returns this INSTEAD of
 *   retrying via the stale-session or server-overloaded (529, reason: 'overloaded') retry
 *   paths. Read `usageLimit.resumeAt`/`resumeAtSource` to schedule a resume rather than
 *   re-parsing the failure text; `packages/apra-fleet-workflow` forwards this unchanged onto
 *   `AgentDispatchError.details.usageLimit`.
 * @property {false} [dispatched] - false when nothing was sent to the member: a
 *   'max_total_time' failure whose budget ran out during setup (cloud start, before the first
 *   attempt). No agent ran, so there is no partial work to publish. Absent on every other
 *   result (including a 'max_total_time' that stopped a running dispatch);
 *   `packages/apra-fleet-workflow` forwards it onto `AgentDispatchError.details.dispatched`.
 * @property {string} [response] - The LLM's actual reply text on success.
 * @property {string} [sessionId] - The session id this dispatch landed on, when known --
 *   present on success AND on a 'usage_limit'/'max_turns_exhausted' failure so the SAME
 *   session can be resumed later instead of losing context to a fresh one.
 * @property {ExecutePromptUsage} [usage]
 */

/**
 * @typedef {Object} ExecutePromptUsage
 * @property {number} input_tokens - Uncached prompt tokens.
 * @property {number} output_tokens - Completion tokens.
 * @property {number} cache_read_input_tokens - Prompt tokens served from the provider's
 *   prompt cache; billed, and NOT included in input_tokens (0 when the provider reports none).
 * @property {number} cache_creation_input_tokens - Prompt tokens written to the provider's
 *   prompt cache; billed, and NOT included in input_tokens (0 when the provider reports none).
 * @property {number} total_tokens - input_tokens + output_tokens only (the context-window
 *   figure context admission reads); it deliberately EXCLUDES the cache counts, so a cost
 *   figure must price all four counts rather than total_tokens.
 * @property {number} [cost_usd] - USD this dispatch cost as the provider CLI reported it
 *   (Claude: the per-dispatch share of the cumulative total_cost_usd). Use it as-is when
 *   present; price the token counts only when it is absent.
 */

/**
 * @typedef {Object} ModelPrice
 * @property {string} model - Concrete model the tier resolves to.
 * @property {number} promptPrice - $/1M input_tokens.
 * @property {number} completionPrice - $/1M output_tokens.
 * @property {number} cacheReadPrice - $/1M cache_read_input_tokens (the model's own cache-hit rate).
 * @property {number} cacheWritePrice - $/1M cache_creation_input_tokens (Claude: the 1-hour
 *   cache-write rate, 2x input, which the Claude Code CLI uses).
 */

/**
 * @typedef {Object} MemberModelPricingResult
 * @property {string} member_id
 * @property {string} member_name
 * @property {string} llm_provider
 * @property {{cheap: ModelPrice|null, standard: ModelPrice|null, premium: ModelPrice|null}} pricing
 *   - null for a tier whose resolved model has no known price.
 */

/**
 * @typedef {Object} ExecuteCommandOptions
 * @property {string} command - The shell command to execute
 * @property {boolean} [long_running] - Run as background task. Supported on linux and windows
 *   members. Windows launches the task detached via `Invoke-CimMethod Win32_Process.Create`
 *   (WMI provider host / session 0), independent of the SSH session's job object, since a plain
 *   background launch dies with the SSH channel there. darwin gets an advisory warning (the
 *   wrapper script is designed for Linux) but is not blocked. Matches
 *   src/tools/execute-command.ts's long_running branch exactly.
 * @property {number} [max_retries] - Max crash retries (long_running only)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [restart_command] - Command for retry runs, e.g. checkpoint resume
 * @property {string} [run_from] - Override directory to run from
 * @property {number} [timeout_s] - Timeout in seconds (default: 120)
 * @property {number} [timeoutMs] - Client-side request timeout override (ms). Not sent to
 *   the server; consumed locally by McpClient.request(). When omitted, a default is derived
 *   from timeout_s (see deriveTimeoutMs in this file).
 * @property {AbortSignal} [signal] - Optional AbortSignal to cancel the client-side wait for
 *   a response. Not sent to the server. Aborting rejects the pending request locally; it
 *   cannot cancel a job already accepted by the remote fleet-server (see client.mjs).
 */

/**
 * @typedef {Object} SessionStatsOptions
 * @property {string} [member_id] - Member uuid to read; omit on a member session (the calling member is used), required on a non-member session
 */

/**
 * @typedef {Object} SessionStatsResult
 * @property {string} member_id - Member uuid the counts belong to
 * @property {string} since - ISO time counting started (server start); a change between two snapshots means the server restarted
 * @property {number} kb - kb_* calls counted
 * @property {number} code - code_* calls counted
 * @property {number} total - kb + code
 * @property {Object<string, number>} tools - Per-tool counts (tools called at least once)
 */

/**
 * Result-side shape of execute_command's `structuredContent`. Mirrors
 * src/tools/execute-command.ts's ExecuteCommandStructured. A command that ran
 * reports its real `exitCode` (isError absent). A command that never produced an
 * exit code -- the exec timed out, the transport failed, a cloud member could
 * not be started, or the pre-dispatch check failed -- reports `isError: true`,
 * a `reason`, and `exitCode: -1` (never a fake 0). Read it with
 * {@link commandFailureOf}.
 * @typedef {Object} ExecuteCommandStructured
 * @property {number} exitCode - Exit code of the command; -1 when it never produced one.
 * @property {string} stdout - Command stdout (credential values redacted).
 * @property {string} stderr - Command stderr, or the failure detail when isError is true.
 * @property {boolean} [isError] - true when the command did not run to an exit code.
 * @property {string} [reason] - Present with isError: 'timeout' (inactivity timeout) |
 *   'max_total_time' (hard total-time cap) | 'transport_error' (connection/channel failure) |
 *   'cloud_start_failed' | 'preflight_offline' | 'preflight_auth_expired' |
 *   'preflight_auth_missing'.
 * @property {'secret_delivery_unavailable'} [storedEnvNotDelivered] - Present when the
 *   command ran WITHOUT the member's stored credential env vars because no
 *   owner-only file channel exists to deliver them (SFTP disabled, relay member).
 */

/**
 * @typedef {Object} ExecuteCommandFailure
 * @property {string} reason - The structured reason, or 'unflagged_failure' for a failure
 *   recognized only from the text of an older server that sent no structuredContent.
 * @property {string} message - Human-readable failure text.
 */

/**
 * @typedef {Object} ListMembersOptions
 * @property {"compact" | "json"} [format] - Output format
 * @property {string[]} [tags] - Filter members by tags (AND semantics)
 */

/**
 * @typedef {Object} FleetStatusOptions
 * @property {"compact" | "json"} [format] - Output format
 * @property {string} [repo_path] - Absolute path to a repo checkout; adds that repo's code-intelligence index health and its KB scope's bible drift. The server's own cwd is never used. KB health itself always covers every project KB scope plus the global KB.
 */

/**
 * @typedef {Object} SendFilesOptions
 * @property {string[]} local_paths - Array of local file paths to upload
 * @property {string} [dest_subdir] - Destination subdirectory relative to work_folder on the member
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 */

/**
 * @typedef {Object} ReceiveFilesOptions
 * @property {string[]} remote_paths - Paths on the member to download
 * @property {string} local_dest_dir - Local directory to write the downloaded files into
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 */

/**
 * @typedef {Object} RegisterMemberOptions
 * @property {string} friendly_name - Human-friendly name for this member (required)
 * @property {string} work_folder - Working directory on the target machine (required). For remote members, must be a fully-qualified/absolute path -- "~" and relative paths are rejected. A folder may hold at most one LLM member and one LLM-less (llm_provider none) member.
 * @property {"local" | "remote"} [member_type] - Member type (default: "remote")
 * @property {string} [host] - IP address or hostname of the remote machine
 * @property {string} [username] - SSH username
 * @property {number} [port] - SSH port (default: 22)
 * @property {"password" | "key"} [auth_type] - Authentication method
 * @property {string} [password] - SSH password
 * @property {string} [key_path] - Path to SSH private key
 * @property {"read" | "push" | "admin" | "issues" | "full"} [git_access] - Git access level for this member
 * @property {string[]} [git_repos] - Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])
 * @property {"github" | "bitbucket" | "azure-devops" | "none"} [vcs_provider] - VCS provider this member pushes to and opens pull requests against. Omit to auto-detect it from the member's git "origin" remote; "none" declares the member deliberately has no VCS provider.
 * @property {"aws"} [cloud_provider] - Cloud provider. When set, cloud_instance_id and key_path are required.
 * @property {string} [cloud_instance_id] - EC2 instance ID (e.g. "i-0abc123def456789a"). Required when cloud_provider is set.
 * @property {string} [cloud_region] - AWS region (default: "us-east-1")
 * @property {string} [cloud_profile] - AWS CLI profile name (e.g. "apra")
 * @property {number} [cloud_idle_timeout_min] - Minutes of inactivity before auto-stop (default: 30)
 * @property {string} [cloud_activity_command] - Custom shell command for workload detection. Must output "busy" or "idle" on stdout.
 * @property {"claude" | "codex" | "copilot" | "agy" | "opencode" | "none"} [llm_provider] - LLM provider for this member (default: "claude")
 * @property {"gpt-oss-120b" | "gpt-120" | "gemini-3.8-flash-low" | "haiku" | "gpt-5.4-mini"} [model_cheap] - Custom cheap model choice from a curated list
 * @property {"gemini-3.8-flash-high" | "gemini-3.8-flash-medium" | "gemini-3.1-pro-low" | "gpt-oss-120b" | "gpt-120" | "sonnet" | "gpt-5.4"} [model_standard] - Custom standard model choice from a curated list
 * @property {"sonnet" | "opus" | "gemini-3.1-pro-high" | "claude-opus-4-6-thinking" | "gpt-oss-120b"} [model_premium] - Custom premium model choice from a curated list
 * @property {{cheap?: string, standard?: string, premium?: string}} [model_tiers] - Per-member model tier map. A single model fills all tiers.
 * @property {"codebase-memory" | "gitnexus" | "none"} [code_intel_provider] - Code-intelligence provider for this member (default: fleet-wide config)
 * @property {string} [category] - Optional group label
 * @property {string[]} [tags] - Optional list of free-form labels
 * @property {"false" | "auto" | "dangerous"} [unattended] - Permission mode for unattended execution
 *   ("auto" on a Claude model without auto-mode support, such as Haiku, runs acceptEdits)
 * @property {boolean} [unreservable] - Mark this member as never exclusively reservable, so it can be shared by more than one sprint at once (e.g. fleet-sprint's shared "backlog" role)
 * @property {"auto" | "skip" | "replace-full"} [fleet_install] - Whether registration installs/updates apra-fleet on the member, writes its per-folder apra-fleet MCP entry and verifies it (default "auto"; local members only get the MEMBER-session probe; a full install without the member-install marker is never touched). "replace-full": also explicitly opts in to replacing such a full install with a member install (backup of data and fleet.key, uninstall, member install, self-register). "skip" performs no install and reports the probe result only. Registration succeeds either way; the result reports fleetMcp.
 * @property {"gitbash" | "pwsh7" | "powershell5"} [shell] - Override the probed Windows shell for this member. Windows members only -- ignored for non-windows members.
 */

/**
 * @typedef {Object} UpdateMemberOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"auto" | "skip" | "replace-full"} [fleet_install] - "auto": for a remote member, install/upgrade the member's own apra-fleet when missing or older (build-aware), self-register, write its per-folder apra-fleet MCP entry and verify, even when nothing else changed; a full install without the member-install marker is never touched. "replace-full": "auto" plus an explicit opt-in to replace such a full install with a member install (backup of data and fleet.key, uninstall, member install, self-register). "skip": never install. Omit: install only on a provider change. Unknown input keys are rejected by the server.
 * @property {string} [friendly_name] - New friendly name
 * @property {string} [work_folder] - New working directory. For non-local (remote/relay) members, must be a fully-qualified/absolute path -- "~" and relative paths are rejected. A folder may hold at most one LLM member and one LLM-less (llm_provider none) member.
 * @property {string} [host] - New host
 * @property {string} [username] - New SSH username
 * @property {number} [port] - New SSH port
 * @property {"password" | "key"} [auth_type] - New auth method
 * @property {string} [password] - New SSH password
 * @property {boolean} [rotate_password] - Trigger out-of-band password re-entry for a member already using password auth. Ignored if auth_type is not password.
 * @property {string} [key_path] - New SSH private key path
 * @property {"read" | "push" | "admin" | "issues" | "full"} [git_access] - Git access level for this member
 * @property {string[]} [git_repos] - Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])
 * @property {string} [icon] - Override the auto-assigned emoji icon. Use named aliases (e.g. blue-circle, green-square) or a raw emoji.
 * @property {string} [cloud_region] - AWS region for the cloud instance
 * @property {string} [cloud_profile] - AWS CLI profile name
 * @property {number} [cloud_idle_timeout_min] - Minutes of inactivity before auto-stop
 * @property {string} [cloud_activity_command] - Custom shell command for workload detection. Must output "busy" or "idle". Pass empty string to clear.
 * @property {"claude" | "codex" | "copilot" | "agy" | "opencode"} [llm_provider] - Change the LLM provider
 * @property {"gpt-oss-120b" | "gpt-120" | "gemini-3.8-flash-low" | "haiku" | "gpt-5.4-mini"} [model_cheap] - Change custom cheap model
 * @property {"gemini-3.8-flash-high" | "gemini-3.8-flash-medium" | "gemini-3.1-pro-low" | "gpt-oss-120b" | "gpt-120" | "sonnet" | "gpt-5.4"} [model_standard] - Change custom standard model
 * @property {"sonnet" | "opus" | "gemini-3.1-pro-high" | "claude-opus-4-6-thinking" | "gpt-oss-120b"} [model_premium] - Change custom premium model
 * @property {{cheap?: string, standard?: string, premium?: string}} [model_tiers] - Per-member model tier map with free-form model IDs. A single model fills all tiers.
 * @property {"codebase-memory" | "gitnexus" | "none"} [code_intel_provider] - Change the code-intelligence provider for this member
 * @property {string} [category] - Group label
 * @property {string[]} [tags] - Free-form labels
 * @property {"false" | "auto" | "dangerous"} [unattended] - Permission mode ("auto" on a
 *   Claude model without auto-mode support, such as Haiku, runs acceptEdits)
 * @property {boolean} [unreservable] - Mark/unmark this member as shared/never exclusively reservable
 * @property {"gitbash" | "pwsh7" | "powershell5"} [shell] - Override the probed Windows shell for this member. Windows members only -- ignored for non-windows members.
 * @property {"github" | "bitbucket" | "azure-devops" | "none"} [vcs_provider] - Directly set (override) this member's VCS provider. An explicit operator value, never auto-detected -- use this to correct a wrong auto-detect from register_member, or to set the provider without provisioning credentials. "none" clears it.
 */

/**
 * A member's own apra-fleet MCP observation (src/types.ts FleetMcpStatus).
 * @typedef {Object} FleetMcpStatus
 * @property {"available" | "unavailable"} state
 * @property {string} [reason] - Machine-readable cause when unavailable (e.g. install-too-old, E-FOLDER-TAKEN, mcp-entry-missing, role-agents-hide-member-tools, no-per-project-mcp)
 * @property {string} [version] - apra-fleet version the member's own install reports
 * @property {string} checkedAt - ISO 8601 time of the probe
 * @property {string} [detail] - Human-readable diagnostic
 * @property {boolean} [unverified] - KB/code tools could not be verified (e.g. agy)
 * @property {string} [fleetInstalledAt] - ISO 8601 time this fleet's own install run last succeeded on the member; carried across later probes; absent when the fleet never installed it (a refusal or observation-only probe never sets it)
 * @property {{reason: string, detail?: string}} [installFailure] - A requested apra-fleet upgrade that failed before the member was touched while the older install stayed in use; present on available and unavailable statuses, also named in detail
 * @property {{state: "missing" | "broken", detail: string, fix: string}} [beads] - Present only when the beads CLI (bd) is not usable on a remote member (not on its PATH nor in <home>/.apra-fleet/bin); independent of state; absent when bd works or could not be probed
 * @property {number} [port] - Remote members: the port of the member's own apra-fleet install, resolved from its member-install marker; the member MCP URL (per-folder entry and per-session config) uses it
 * @property {"marker" | "default"} [portSource] - Where port came from: the member-install marker, or the built-in default because the install recorded no port (detail says so)
 * @property {{previousVersion: string, removed: string[], backupPath: string}} [replacedFullInstall] - Set by the probe that replaced a full install with a member install (fleet_install "replace-full"): replaced version, what was removed or moved, and the timestamped backup directory on the member
 */

/**
 * Code intelligence availability reported by member_detail.
 * @typedef {Object} CodeIntelStatus
 * @property {string|null} provider - 'gitnexus' | 'codebase-memory' | 'none' (null when it could not be resolved)
 * @property {boolean} available
 * @property {string} [cause] - Why it is unavailable; absent when available
 * @property {string} [remedy] - What to do about the cause; absent when available
 */

/**
 * Structured result returned by memberDetail() when called with format: 'json'
 * (src/tools/member-detail.ts). When format is 'compact' (the default), memberDetail()
 * instead returns a plain multi-line text summary, not this shape.
 * @typedef {Object} MemberDetailResult
 * @property {string} server_version - Fleet server version string
 * @property {string} name - Friendly name of the member
 * @property {string} icon - Emoji icon for this member
 * @property {string} id - UUID of the member
 * @property {"local" | "remote"} type - Member type
 * @property {string} host - "(local)" for local members, or "host:port" for remote members
 * @property {string} [username] - SSH username (remote members)
 * @property {string} os - Detected/registered operating system
 * @property {"gitbash" | "pwsh7" | "powershell5"} [shell] - Registered Windows shell for this member (Windows members only)
 * @property {string} folder - Working directory on the target machine
 * @property {string} [repo_remote_url] - Origin URL of the git repo in `folder`, when known
 * @property {string} [vcsProvider] - VCS provider configured for this member
 * @property {"read" | "push" | "push+pr" | "admin" | "issues" | "full"} [gitAccess] - Git access level
 *   this member's VCS credentials are minted at (register_member/update_member's git_access). Absent
 *   when the member was registered without an explicit level. Consumers that need to know whether a
 *   minted token carries a given permission (e.g. GitHub's 'workflows', required to push any
 *   .github/workflows/** change) must read THIS, not their own provisioning default -- the two differ
 *   exactly for the members at risk.
 * @property {string[]} [permissionConfigPaths] - The member's provider permission config file(s)
 *   that compose_permissions writes (work-folder-relative, or home-anchored "~/..."), e.g.
 *   ['.claude/settings.local.json'] for Claude. [] when the provider cannot name them yet (agy before
 *   its project is provisioned). Reported even for an offline member. Absent on older servers.
 * @property {Object} connectivity - Connectivity check result (status, latencyMs, auth, keyPath, or error)
 * @property {boolean} [offline] - Set when the member could not be reached
 * @property {string} llmProvider - LLM provider for this member (default: "claude")
 * @property {string|null} [agyProjectId] - agy members only: id of the member's own agy project
 *   (~/.gemini/config/projects/<id>.json), passed as `--project <id>` on every dispatch; null until
 *   provisioned (compose_permissions/execute_prompt provision it on first use)
 * @property {FleetMcpStatus|null} fleetMcp - Last recorded state of the member's own apra-fleet MCP
 *   server (null when never probed). Recoverable: `member_detail { refresh: true }` re-probes and records.
 * @property {string|null} [fleetMcpFix] - One-line operator fix for `fleetMcp` when the member's KB/code tools are
 *   not usable (state "unavailable" or `unverified`); null when available and verified
 * @property {CodeIntelStatus|null} [codeIntel] - Whether code intelligence (code_* tools) can run for this member,
 *   with the cause and remedy when it cannot (e.g. npx/node missing from the apra-fleet service PATH). null for
 *   remote members: their code tools run on the member host, not on this server.
 * @property {Object} [llm_cli] - LLM CLI info: { version, auth }
 * @property {Object|string} [tokenUsage] - Cumulative token usage, or "compute only" for llmProvider "none"
 * @property {Object} [session] - Session info: { id, lastActivity, lastLlmActivityAt, status, idleSecs }
 * @property {Object} [resources] - System resource snapshot: { cpu, memory, disk, gpu }
 * @property {string} [branch] - Current git branch in `folder`, when it is a git repo
 * @property {Object} [cloud] - Cloud instance details, for cloud-backed members only
 */

/**
 * @typedef {Object} RemoveMemberOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {boolean} [force] - Remove even if the member is currently busy
 */

/**
 * @typedef {Object} MemberReservationOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"reserve" | "release" | "force_release"} action - "reserve" claims the member for
 *   sprint_id (fails if already reserved by someone else); "release" clears it only if sprint_id
 *   matches the current holder; "force_release" clears it regardless of owner.
 * @property {string} [sprint_id] - Sprint/session id claiming or releasing the reservation.
 *   Required for "reserve" and "release", ignored for "force_release".
 */

/**
 * @typedef {Object} MemberReservationStructured
 * @property {"reserved" | "reservation_refreshed" | "released" | "force_released" |
 *   "already_reserved_by_other" | "not_reserved" | "unreservable" | "invalid_input" |
 *   "member_not_found" | "failed"} outcome - Machine-readable outcome discriminator. Branch on
 *   this field; never string-match the human-readable summary text.
 * @property {boolean} ok - True when the requested operation took effect (or was already true).
 * @property {"reserve" | "release" | "force_release"} action - The action that was requested.
 * @property {string|null} memberId - Registry id of the resolved member, null when none resolved.
 * @property {string|null} memberName - Friendly name of the resolved member, null when none resolved.
 * @property {string|null} sprintId - The sprint id supplied by the caller, null when none.
 * @property {string|null} ownerSprintId - The sprint that held the reservation when the call
 *   arrived, null when the member was unreserved. On "already_reserved_by_other" this is the
 *   blocking owner.
 *
 * Mirrors src/tools/member-reservation.ts's MemberReservationStructured field-for-field
 * (apra-fleet-3swo.7.1). The tool still returns the same human-readable summary in
 * `content[0].text`; this shape is the machine-readable half of the same response.
 */

/**
 * @typedef {Object} ProvisionLlmAuthOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [api_key] - AI provider API key or Claude Code OAuth token
 *   (sk-ant-oat..., from `claude setup-token`; routed to CLAUDE_CODE_OAUTH_TOKEN). If
 *   omitted, a credential already stored for the member is re-deployed, else the local
 *   OAuth session is copied to the member. Supports {{secret.NAME}} token -- resolved
 *   from the credential store server-side before use.
 * @property {boolean} [force_oauth_copy] - Only without api_key: copy the local OAuth
 *   session even when the member has a stored env credential, and clear that credential
 *   (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) so the copied login applies.
 * @property {boolean} [clear_stored_credentials] - Remove ALL credential env vars stored for
 *   the member in the fleet registry and do nothing else (registry only; works for relay,
 *   offline and local members). The recovery for reason secret_delivery_unavailable.
 *   Cannot be combined with api_key or force_oauth_copy.
 */

/**
 * @typedef {Object} VcsCredentialExecOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} command - The credential-requiring command to run on the member. MUST
 *   contain at least one of two placeholders where the credential belongs (both may appear in
 *   the same command): {{vcs_token}}, referenced BARE (never inside your own quotes) -- the
 *   server substitutes it with the value ALREADY escaped AND quoted for that member's shell, so
 *   wrapping it in your own quotes double-escapes it and surfaces as a false 401; or
 *   {{vcs_token_inline}}, referenced INSIDE your own single quotes -- the server substitutes it
 *   with the value escaped for the interior of a single-quoted string, with no quotes of its
 *   own, for interpolating the token into a larger already-quoted value (e.g. an Authorization
 *   header) where a bare, self-quoting substitution cannot compose.
 * @property {string} [label] - Credential label provision_vcs_auth deployed the helper under
 *   (it defaults to the provider name there, e.g. "github" or "azure-devops"). Omit for the
 *   unlabelled helper.
 * @property {number} [timeout_s] - Inactivity timeout in seconds for the command (default: 120).
 *   On expiry the command's remote process tree is killed and the result is reason
 *   'dispatch_failed' with a "Command timed out" message.
 */

/**
 * @typedef {Object} VcsCredentialExecStructured
 * @property {boolean} ok - True when the credential-requiring command was dispatched. Read
 *   exitCode for the command's own outcome.
 * @property {"ok" | "member_not_found" | "placeholder_missing" | "unsupported_member_os" |
 *   "credential_read_failed" | "credential_empty" | "dispatch_failed"} reason - Machine-readable
 *   outcome code. Branch on this, never on the text.
 * @property {number|null} exitCode - Exit code of the dispatched command, null if it never ran.
 * @property {string} stdout - Command stdout, with every occurrence of the credential redacted.
 * @property {string} stderr - Command stderr, with every occurrence of the credential redacted.
 * @property {number} tokenRedactions - How many times the credential had to be redacted out of
 *   stdout+stderr. Normally 0; nonzero means the command echoed its own credential back.
 * @property {string|null} credentialLabel - Credential label used, or null for the unlabelled helper.
 * @property {string|null} memberId - Registry id of the resolved member, or null.
 * @property {string|null} memberName - Friendly name of the resolved member, or null.
 *
 * Mirrors src/tools/vcs-credential-exec.ts's VcsCredentialExecStructured field-for-field
 * (apra-fleet-3swo.7.3). The plaintext credential appears in NO field of this payload.
 */

/**
 * @typedef {Object} ProvisionAuthStructured
 * @property {boolean} ok - True when credentials were deployed (verified or not).
 * @property {"ok" | "deployed_unverified" | "deployed_with_errors" | "skipped_local_member" |
 *   "member_not_found" | "member_offline" | "secret_variable_not_found" |
 *   "secret_variable_denied" | "secret_variable_expired" | "oauth_not_supported" |
 *   "oauth_token_expired_no_refresh" | "oauth_credential_file_missing" |
 *   "oauth_credential_write_failed" | "oauth_settings_merge_failed" | "oauth_copy_failed" |
 *   "oob_cancelled" | "secret_delivery_unavailable" | "stored_credentials_cleared" |
 *   "invalid_arguments"} reason - Machine-readable outcome code.
 *   Branch on this, never on the text. secret_delivery_unavailable: the member has no channel
 *   that delivers the key without a command line (relay member, SFTP unavailable).
 *   stored_credentials_cleared: clear_stored_credentials removed the stored env vars (ok=true).
 * @property {string|null} provider - The resolved ProviderAdapter's own name (claude, codex,
 *   copilot, agy, opencode or none -- there is no gemini adapter), null when unresolved.
 * @property {string|null} credentialLabel - What was deployed, never the secret: the env var
 *   name for the API-key flow (e.g. ANTHROPIC_API_KEY) or "oauth" for the file-copy flow.
 * @property {string|null} expiresAt - Credential expiry as an ISO timestamp, or null meaning
 *   "no expiry tracked -> OK".
 * @property {boolean} verified - True when the post-deploy auth check confirmed working auth.
 * @property {string|null} memberId - Registry id of the resolved member, or null.
 * @property {string|null} memberName - Friendly name of the resolved member, or null.
 *
 * Mirrors src/tools/provision-auth.ts's ProvisionAuthStructured field-for-field
 * (apra-fleet-3swo.7.2). Carries no plaintext credential of any kind.
 */

/**
 * @typedef {Object} ProvisionVcsAuthStructured
 * @property {boolean} ok - True when the credential was actually deployed onto the member.
 * @property {"ok" | "deployed_unverified" | "deployed_verification_skipped" |
 *   "member_not_found" | "member_offline" | "secret_variable_not_found" |
 *   "secret_variable_denied" | "secret_variable_expired" | "oob_cancelled" |
 *   "credential_assembly_unsupported" | "credential_assembly_failed" | "deploy_threw" |
 *   "deploy_failed"} reason - Machine-readable outcome code. Branch on this, never on the text.
 * @property {string} provider - The VCS provider requested.
 * @property {string} credentialLabel - Credential label the helper was deployed under
 *   (defaults to the provider name).
 * @property {string|null} scopeUrl - Git credential scope URL the helper was registered for.
 * @property {string|null} expiresAt - Token expiry as an ISO timestamp, or null meaning "no
 *   expiry tracked -> OK" (the reading checkVcsTokenExpiry applies server-side). Read this
 *   instead of scraping an "expiresAt:" line out of the summary text.
 * @property {boolean} verified - True only when testConnectivity() actually ran AND succeeded.
 * @property {boolean} verificationSkipped - True when the connectivity check was not performed.
 * @property {Record<string, string>|null} metadata - The provider's own deploy metadata,
 *   filtered through a server-side key allowlist before it reaches this field (an unrecognised
 *   key is dropped, never passed through). Providers additionally mask the token value here to
 *   its first four characters plus asterisks, so this never carries the plaintext token.
 * @property {string|null} expiryWarning - Near-expiry warning text when one applies, else null.
 * @property {string|null} memberId - Registry id of the resolved member, or null.
 * @property {string|null} memberName - Friendly name of the resolved member, or null.
 * @property {string|null} message - Human-readable cause of a non-ok outcome (e.g. "No repos
 *   specified and none on agent config."), or null when ok is true. Previously this text only
 *   reached the caller inside the tool's `text` content, so a caller reading only
 *   structuredContent saw nothing but the bare `reason` code. Read this instead of parsing the
 *   `[FAIL] ...` prefix out of `text`.
 *
 * Mirrors src/tools/provision-vcs-auth.ts's ProvisionVcsAuthStructured field-for-field
 * (apra-fleet-3swo.7.2).
 */

/**
 * @typedef {Object} ProvisionVcsAuthOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"github" | "bitbucket" | "azure-devops"} provider - VCS provider to configure
 * @property {string} [label] - Credential label (slug, e.g. "work-github"). Defaults to provider name.
 * @property {string} [scope_url] - Git credential scope URL (e.g. "https://github.com/my-org").
 *   Defaults to "https://<host>". For an Azure DevOps repo on the legacy host, pass
 *   "https://ORG.visualstudio.com" so the PAT is bound to the host the member pushes to.
 * @property {"github-app" | "pat"} [github_mode] - GitHub auth mode: github-app (mint via
 *   configured app) or pat (personal access token)
 * @property {string} [token] - Personal access token (GitHub PAT or Azure DevOps PAT).
 *   Supports {{secret.NAME}} token -- resolved from the credential store server-side before use.
 * @property {"read" | "push" | "push+pr" | "admin" | "issues" | "full"} [git_access] - GitHub App access
 *   level override
 * @property {string[]} [repos] - GitHub App repository list override
 * @property {string} [email] - Bitbucket account email
 * @property {string} [api_token] - Bitbucket API token. Supports {{secret.NAME}} token --
 *   resolved from the credential store server-side before use.
 * @property {string} [workspace] - Bitbucket workspace slug
 * @property {string} [org_url] - Azure DevOps organization URL (e.g. https://dev.azure.com/myorg,
 *   or the legacy https://myorg.visualstudio.com)
 * @property {string} [pat] - Azure DevOps personal access token. Supports {{secret.NAME}}
 *   token -- resolved from the credential store server-side before use.
 * @property {string} [pat_expires_at] - ISO 8601 date/time the Azure DevOps PAT expires, as
 *   chosen when creating the token. Propagated to the member registry so provisioning can
 *   warn when the PAT is nearing expiry. Must be parseable by Date.parse -- the server
 *   REJECTS an unparseable value rather than storing it, because a NaN expiry silences the
 *   warning entirely (the credential-cleanup timer skips auto-revoke scheduling when no
 *   real expiry is known, rather than falling back to any default TTL).
 */

/**
 * @typedef {Object} VcsPullRequestResponseMapping
 * @property {string} idField - Body field carrying the PR identifier
 *   (GitHub: 'number', Azure DevOps: 'pullRequestId').
 * @property {string|null} webUrlField - Body field carrying the browsable PR
 *   URL, or null when the body carries none (Azure DevOps).
 * @property {string|null} webUrlTemplate - Template to CONSTRUCT the
 *   browsable URL when webUrlField is null, or null when the URL is read
 *   straight from the body.
 *
 * Mirrors the `pullRequestResponse` descriptor hook (apra-fleet-lzfv.4) from
 * packages/apra-fleet-se/fleet-sprint/vcs-providers/index.mjs and the
 * canonical src/services/vcs/types.ts `VcsPullRequestResponseMapping`
 * field-for-field, so the fleet-sprint provider registry, the server-side
 * VCS contract and this client never drift. Declaration-only: the
 * executable `map(body, ctx)` the JS descriptor also carries is
 * deliberately NOT restated here, because index.mjs's own contract comment
 * says a mirroring consumer restates `idField`/`webUrlField`/
 * `webUrlTemplate` while `map` stays the single executable source of truth
 * that reads those same declared fields. This typedef is declarative-only
 * today: no MCP tool in this client yet returns a create-pull-request
 * response for a caller to map.
 */

/**
 * @typedef {Object} ComposePermissionsOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"doer" | "reviewer"} [role] - Base profile. Provide at least one of role or tags.
 * @property {string[]} [tags] - Member tags; "doer"/"reviewer" sets the primary mode
 *   and wins over role when both are given. Other tags load tag-<name>.json profiles.
 * @property {string} [project_folder] - Local project folder containing the
 *   permissions.json ledger. Omit to skip ledger merge.
 * @property {string[]} [grant] - Reactive mode: additional permissions to grant.
 *   Each entry is checked against the NEVER_AUTO_GRANT denylist, which is
 *   wildcard-matched (not exact-matched) against a normalized form of the
 *   request: sudo/su/doas, `bash -c`/`sh -c`/eval, env/printenv, nc/nmap,
 *   `chmod 777`, any catch-all such as `Bash(*)`, and any payload containing a
 *   shell-chaining metacharacter (| ; && backtick $() are rejected outright,
 *   for every caller.
 * @property {string} [grant_reason] - Reason for the grant (stored in ledger)
 * @property {boolean} [dry_run] - Compose only: return the allow list the role/tags
 *   (plus detected stacks, plus the ledger when project_folder is given) would deliver, as
 *   JSON text `{"dry_run":true,"mode","stacks","allow"}`, without writing anything to the
 *   member. Ignored with `grant`. Use it to check whether a grant is within the member's
 *   composed policy.
 */

/**
 * @typedef {Object} KbExportOptions
 * No scope key: the KB is the calling session's own. The removed repo_path, repo and
 * repo_remote_url are refused with E-SCOPE-KEY-REMOVED (client-side and by the server).
 * @property {"project" | "global"} [scope] - project (default): export the project KB to
 *   .fleet/kb-canonical.json. global: export the GLOBAL KB to .fleet/kb-canonical-global.json.
 * @property {string} [baseBranch] - The target base branch (the branch the entries merge
 *   into), written to provenance.branch. Omitted: the export folder HEAD branch.
 * @property {string} [baseCommit] - The base commit the entries were verified against,
 *   written to provenance.commit. Omitted: the export folder HEAD commit.
 */

/**
 * @typedef {Object} KbBibleCommitOptions
 * @property {string[]} ids - Ids of the entries confirmed this round. Ids that are not
 *   live CONFIRMED entries are skipped (reason not_confirmed_or_unknown); a CONFIRMED id
 *   whose cited files at the repo's HEAD commit no longer match its recorded basis (the
 *   same rule kb_export applies; uncommitted edits never change the verdict) is skipped
 *   with reason basis_mismatch, and a CONFIRMED id citing no source file is skipped with
 *   reason no_source_files. Skips are reported in the result's skipped list.
 *   Independently of ids, bible entries the KB holds as superseded or invalidated are
 *   removed and reported in the result's removed list; an empty list with nothing to
 *   remove makes no commit.
 * @property {string} baseBranch - The target base branch, written to provenance.branch.
 * @property {string} baseCommit - The base commit the entries were verified against,
 *   written to provenance.commit.
 */

/**
 * One entry of the bible file (.fleet/kb-canonical.json) kb_export and
 * kb_bible_commit write and kb_import reads -- bible format v3, described by
 * memory-contract/v1/bible/kb-canonical.schema.json. The file itself is
 * {version: 3, provenance: {commit, branch, entry_count}, entries: KbBibleEntry[]};
 * readers also accept v2 (same envelope, no hashes) and v1 (a bare entry array).
 * @typedef {Object} KbBibleEntry
 * @property {string} id - Entry id (unique within the bible; writers refuse a duplicate id).
 * @property {string} type - Content type (knowledge, learning, runbook, context-cache, user-directive).
 * @property {string} title - Entry title.
 * @property {string} summary - Entry summary.
 * @property {string[]} symbols - Symbols the entry is about.
 * @property {string[]} source_files - Repo-relative files the entry cites.
 * @property {string} confidence - CONFIRMED, INFERRED or UNVERIFIED.
 * @property {string} updated_at - Promotion (or creation) timestamp.
 * @property {Object<string, string>} [source_file_hashes] - v3: the per-file hash basis
 *   (repo-relative path -> hash) the entry was admitted against, copied from the
 *   exporting KB's stored basis. kb_import stores it as the entry's basis exactly
 *   (never re-hashing local files); an entry without it gets a local
 *   freshness-only basis (it can go stale) that is never exported, so it is not
 *   re-published until recaptured.
 */

/**
 * @typedef {Object} SetupSshKeyOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 */

/**
 * @typedef {Object} SendEmailOptions
 * @property {"sendgrid" | "smtp"} [provider] - Email provider to use (default "sendgrid").
 *   Secrets are resolved server-side from the credential store ("sendgrid_api_key" / "smtp_password").
 * @property {string} from - Sender email address (required)
 * @property {string} [host] - SMTP server hostname (required for smtp provider)
 * @property {number} [port] - SMTP server port (default 587, or 465 when secure is true)
 * @property {string} [user] - SMTP username (required for smtp provider)
 * @property {boolean} [secure] - Use implicit TLS, e.g. port 465 (default false).
 *   When false, STARTTLS is required; plaintext AUTH is refused.
 * @property {string | string[]} to - Recipient email address, or list of addresses
 * @property {string} subject - Email subject line
 * @property {string} body - Plain-text email body
 * @property {string} [html] - Optional HTML email body
 * @property {string[]} [cc] - CC recipient addresses
 * @property {string[]} [bcc] - BCC recipient addresses
 * @property {{ filename: string, content: string, contentType?: string }[]} [attachments] - Optional file attachments (base64-encoded content)
 */


// Grace margin added on top of the payload's own timeout hint (timeout_s /
// max_total_s) so the client doesn't race the server's own deadline -- the
// server should have a chance to reply with its own timeout/error first.
//
// This single-budget (max_total_s * 1) + grace shape relies on the server
// (src/tools/execute-prompt.ts, apra-fleet-y8q.1) sharing ONE max_total_s
// deadline budget across an original dispatch attempt AND any single retry it
// runs on its own (e.g. the fresh-session retry after an SSH inactivity
// exception) -- a retry's own maxTotalMs/timeoutMs is capped to whatever
// remains of max_total_s since the dispatch started, and skipped entirely
// once that budget is exhausted. Without that server-side sharing, a retry
// could burn a second full max_total_s budget and the client's hard timeout
// here would fire before the server's own clean retry-and-report path ever
// gets a chance, surfacing a raw client transport timeout instead of the
// server's typed error. Do not widen this to max_total_s * 2 unless that
// server-side sharing invariant is removed.
const TIMEOUT_GRACE_MS = 30 * 1000;

/**
 * Derives a client-side McpClient.request() timeout (ms) from a payload's
 * own timeout hints. Intentionally prefers max_total_s (a hard ceiling) over
 * timeout_s (the stall-detector inactivity baseline) when both are present.
 * This reflects the post-apra-fleet-25yl.2 contract: max_total_s is the
 * primary exec deadline for Claude/AGY, while timeout_s drives only the stall
 * detector's per-dispatch baseline (other providers have different exec-timer
 * mappings per their own adapters). The client's own deadline thus uses the
 * appropriate upper bound for the dispatch. Adds a grace margin to account
 * for server-side retry overhead.
 * Returns undefined when neither hint is present, letting McpClient fall
 * back to its own conservative default (never infinite).
 *
 * See the TIMEOUT_GRACE_MS comment above: this budget is only sufficient
 * because the server shares a single max_total_s deadline across an attempt
 * and its own internal retry, rather than granting each a fresh full budget.
 *
 * @param {{ max_total_s?: number, timeout_s?: number }} payload
 * @returns {number | undefined}
 */
export function deriveTimeoutMs(payload = {}) {
    const hintSeconds = payload.max_total_s ?? payload.timeout_s;
    if (typeof hintSeconds !== 'number' || !Number.isFinite(hintSeconds) || hintSeconds <= 0) {
        return undefined;
    }
    return hintSeconds * 1000 + TIMEOUT_GRACE_MS;
}

/**
 * Extract the JSON payload from a raw MCP tool-call result.
 *
 * Every ApraFleet wrapper returns the raw callTool() result --
 * `{ content: [{ type: 'text', text }, ...] }` -- NOT a JSON string, so
 * `JSON.parse(result)` on it throws. Tool results can also carry
 * display-only items (e.g. an `<apra-fleet-display>` onboarding block)
 * AHEAD of the payload, so content[0] is not reliable either. This helper
 * returns the first content item that parses as JSON.
 *
 * @param {{ content?: { text?: string }[] }} result - raw callTool() result
 * @returns {any} the parsed JSON payload
 * @throws {Error} when no content item contains valid JSON
 */
export function parseToolJson(result) {
    for (const item of result?.content ?? []) {
        try { return JSON.parse(item.text); } catch { /* not the payload */ }
    }
    throw new Error('No JSON payload in tool result');
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * The pre-redesign kb_* scope keys. Every kb_* tool acts on the calling
 * session's own KB, so the server refuses a call carrying any of these with
 * E-SCOPE-KEY-REMOVED (src/services/knowledge/kb-removed-scope-keys.ts). The
 * kb_* wrappers below refuse them client-side with the same code, so a stale
 * caller fails fast and identically whichever side catches it.
 */
export const KB_REMOVED_SCOPE_KEYS = Object.freeze(['repo_path', 'repo', 'repo_remote_url']);

/**
 * Throw E-SCOPE-KEY-REMOVED when `options` carries a removed kb_* scope key
 * (any value other than undefined).
 * @param {string} tool - the kb_* tool name, for the message
 * @param {Record<string, unknown>} [options]
 */
export function assertNoRemovedKbScopeKeys(tool, options) {
    if (!options || typeof options !== 'object') return;
    const present = KB_REMOVED_SCOPE_KEYS.filter((k) => options[k] !== undefined);
    if (present.length === 0) return;
    const err = new Error(
        `E-SCOPE-KEY-REMOVED: ${tool} no longer accepts ${present.map((k) => `'${k}'`).join(', ')} ` +
        '(removed in the KB redesign); the call was not sent. Remediation: drop it -- every kb_* call acts on the ' +
        "calling session's own KB (a member session's registered work folder; a FULL session's fleet server working folder).",
    );
    err.code = 'E-SCOPE-KEY-REMOVED';
    throw err;
}

/**
 * Typed read of an execute_prompt permission denial. Accepts the raw executePrompt()
 * result or its `structuredContent`; returns the {@link PermissionDenied} block when
 * `reason === 'permission_denied'` and the block is well-formed, else null.
 *
 * @param {{structuredContent?: ExecutePromptStructured} | ExecutePromptStructured | null | undefined} result
 * @returns {PermissionDenied | null}
 */
export function permissionDenialOf(result) {
    const sc = result && typeof result === 'object' && 'structuredContent' in result ? result.structuredContent : result;
    if (!sc || sc.reason !== 'permission_denied') return null;
    const d = sc.permissionDenied;
    if (!d || typeof d !== 'object') return null;
    if (!isStringArray(d.actions) || !isStringArray(d.suggestedGrants) || typeof d.hint !== 'string') return null;
    if (!Array.isArray(d.denials) || !d.denials.every((x) => x && typeof x.action === 'string' && (x.target === undefined || typeof x.target === 'string'))) return null;
    return {
        actions: [...d.actions],
        denials: d.denials.map((x) => ({
            action: x.action,
            ...(x.target === undefined ? {} : { target: x.target }),
            ...(isStringArray(x.suggestedGrants) ? { suggestedGrants: [...x.suggestedGrants] } : {}),
        })),
        suggestedGrants: [...d.suggestedGrants],
        hint: d.hint,
        signals: isStringArray(d.signals) ? [...d.signals] : [],
        ...(typeof d.permissionMode === 'string' ? { permissionMode: d.permissionMode } : {}),
        ...(typeof d.healable === 'boolean' ? { healable: d.healable } : {}),
        ...(d.cause === 'policy_deny' ? { cause: 'policy_deny' } : {}),
    };
}

/**
 * Anchored text shapes of a fleet tool failure that reached the caller WITHOUT
 * a structured error flag (an older server, or a plain-string tool result).
 * Each pattern matches only at the START of the result text, so a genuine
 * LLM reply that merely mentions "connection refused" mid-body never matches
 * (a successful execute_prompt reply is display-wrapped or carried in
 * structuredContent.response, never bare).
 */
const FLEET_TOOL_FAILURE_TEXT_RES = Object.freeze([
    /^\s*(?:\[FAIL\]\s*)?Failed to execute (?:command|prompt) on "/,
    /^\s*\(SSH\)\s/,
    /^\s*(?:Error:\s*)?(?:connect\s+)?(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE)\b/,
    /^\s*(?:Error:\s*)?(?:Timed out while waiting for handshake|Connection lost before handshake|All configured authentication methods failed|Not connected)\b/,
]);

/**
 * Typed read of a fleet TOOL/TRANSPORT failure on a raw callTool() result --
 * as opposed to a successful tool call whose payload is the member's (or the
 * LLM's) answer. Returns null for a successful result.
 *
 * Signals, strongest first:
 *   - 'isError': the MCP-level `result.isError === true` flag. This is what the
 *     MCP server returns when a tool handler THROWS (e.g. an SSH channel that
 *     could not be opened): `{ content: [{ text: err.message }], isError: true }`
 *     with no structuredContent, so the text is the bare transport error.
 *   - 'text': fallback for a result carrying no structured flag and no
 *     `structuredContent.response`, whose text starts with a recognisable
 *     fleet failure shape (FLEET_TOOL_FAILURE_TEXT_RES).
 *
 * A result whose `structuredContent.isError` is set is NOT reported here:
 * that is the tool's own classified failure (it carries a `reason`), which
 * callers already read directly.
 *
 * @param {{ isError?: boolean, content?: { text?: string }[], structuredContent?: Record<string, any> } | null | undefined} result
 * @returns {{ source: 'isError' | 'text', text: string } | null}
 */
export function fleetToolFailureOf(result) {
    if (!result || typeof result !== 'object') return null;
    const sc = result.structuredContent;
    if (sc && sc.isError) return null;
    const text = Array.isArray(result.content)
        ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
        : '';
    if (result.isError === true) return { source: 'isError', text };
    if (sc && typeof sc.response === 'string') return null;
    if (FLEET_TOOL_FAILURE_TEXT_RES.some((re) => re.test(text))) return { source: 'text', text };
    return null;
}

// Older servers (before execute_command carried isError on its failure
// paths) returned a bare text with no structuredContent for a command that
// never ran. These are that text's two shapes.
const UNFLAGGED_COMMAND_FAILURE_RE = /^Failed to (execute command|launch task) on "/;

/**
 * Typed read of an execute_command failure that never produced an exit code.
 * Accepts the raw executeCommand() result. Returns `{ reason, message }` when the
 * result is an isError failure (structuredContent.isError, or the MCP-level
 * isError flag), or when an older server sent the bare "Failed to execute
 * command on ..." / "Failed to launch task on ..." text with no
 * structuredContent. Returns null for a command that ran (any exit code --
 * callers check a non-zero exitCode separately).
 *
 * @param {{content?: {text?: string}[], structuredContent?: ExecuteCommandStructured, isError?: boolean} | null | undefined} result
 * @returns {ExecuteCommandFailure | null}
 */
export function commandFailureOf(result) {
    if (!result || typeof result !== 'object') return null;
    const text = Array.isArray(result.content) && result.content.length > 0 && typeof result.content[0]?.text === 'string'
        ? result.content[0].text
        : '';
    const sc = result.structuredContent;
    if (sc && typeof sc === 'object' && sc.isError) {
        const reason = typeof sc.reason === 'string' && sc.reason ? sc.reason : 'unknown';
        const detail = typeof sc.stderr === 'string' ? sc.stderr : '';
        return { reason, message: text || detail || `execute_command failed (${reason})` };
    }
    if (result.isError) {
        return { reason: 'unknown', message: text || 'execute_command failed' };
    }
    if (!sc && UNFLAGGED_COMMAND_FAILURE_RE.test(text)) {
        return { reason: 'unflagged_failure', message: text };
    }
    return null;
}

export class ApraFleet {
    /**
     * @param {{ callTool: (name: string, args: Record<string, any>, opts?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<any> }} mcpClient
     */
    constructor(mcpClient) {
        this.mcpClient = mcpClient;
    }

    /**
     * Run an AI prompt on a member. A claude member's session gets the
     * member-scoped `apra-fleet` server per session (`--mcp-config`); see
     * docs/api-reference.md.
     * @param {ExecutePromptOptions} options
     * @returns {Promise<{content?: {type: string, text: string}[], structuredContent?: ExecutePromptStructured}>}
     *   the raw callTool() result -- see the {@link ExecutePromptStructured} typedef above
     *   for the structuredContent shape (reason, usageLimit, sessionId, usage, ...).
     */
    async executePrompt(options) {
        const { timeoutMs, signal, ...payload } = options;
        return this.mcpClient.callTool('execute_prompt', payload, {
            timeoutMs: timeoutMs ?? deriveTimeoutMs(payload),
            signal
        });
    }

    /**
     * Run a shell command on a member.
     * @param {ExecuteCommandOptions} options
     * @returns {Promise<{content?: {type: string, text: string}[], structuredContent?: ExecuteCommandStructured}>}
     *   the raw callTool() result. A command that never produced an exit code carries
     *   `structuredContent.isError` and `reason` -- read it with {@link commandFailureOf}.
     */
    async executeCommand(options) {
        const { timeoutMs, signal, ...payload } = options;
        return this.mcpClient.callTool('execute_command', payload, {
            timeoutMs: timeoutMs ?? deriveTimeoutMs(payload),
            signal
        });
    }

    /**
     * List all fleet members and their current status.
     * @param {ListMembersOptions} [options]
     */
    async listMembers(options = {}) {
        return this.mcpClient.callTool('list_members', options);
    }

    /**
     * Get status of all fleet members.
     * @param {FleetStatusOptions} [options]
     */
    async fleetStatus(options = {}) {
        return this.mcpClient.callTool('fleet_status', options);
    }

    /**
     * Get detailed status for one member: connectivity, session, work folder, provider, registered shell (Windows).
     * @param {{ member_id?: string, member_name?: string, format?: 'compact'|'json', refresh?: boolean }} options
     * @returns {Promise<string|MemberDetailResult>} A compact text summary when format is
     *   "compact" (default), or the structured MemberDetailResult object when format is "json".
     */
    async memberDetail(options) {
        return this.mcpClient.callTool('member_detail', options);
    }

    /**
     * Get a member's cheap/standard/premium tier resolved to a concrete
     * model and its real per-1M-token price (apra-fleet-dv5.5/dv5.6).
     * The tool result text is the JSON of a {@link MemberModelPricingResult}.
     * @param {{ member_id?: string, member_name?: string }} options
     */
    async getMemberModelPricing(options) {
        return this.mcpClient.callTool('get_member_model_pricing', options);
    }

    /**
     * Transfer local files to a member.
     * @param {SendFilesOptions} options
     */
    async sendFiles(options) {
        return this.mcpClient.callTool('send_files', options);
    }

    /**
     * Download files from a member to a local directory.
     * @param {ReceiveFilesOptions} options
     */
    async receiveFiles(options) {
        return this.mcpClient.callTool('receive_files', options);
    }

    /**
     * Add a machine to the fleet.
     * @param {RegisterMemberOptions} options
     */
    async registerMember(options) {
        return this.mcpClient.callTool('register_member', options);
    }

    /**
     * Change a member's settings. Changing `llm_provider` or `work_folder`
     * removes the composed permission/MCP config written for the old
     * provider/folder and re-composes for the member as updated (see
     * docs/api-reference.md).
     * @param {UpdateMemberOptions} options
     */
    async updateMember(options) {
        return this.mcpClient.callTool('update_member', options);
    }

    /**
     * Remove a member from the fleet. Member-side composed config (the
     * per-folder `apra-fleet` MCP entry, permission keys) is removed first;
     * what could not be removed is reported as a warning. The member-side registration on the
     * member's own apra-fleet install is removed only when that install carries the
     * member-install marker; otherwise (unmarked, or the marker probe failed) it is
     * skipped and the output says so and why.
     * @param {RemoveMemberOptions} options
     */
    async removeMember(options) {
        return this.mcpClient.callTool('remove_member', options);
    }

    /**
     * Reserve, release or force-release exclusive ownership of a member for a
     * sprint (src/tools/member-reservation.ts).
     *
     * The MCP result carries BOTH halves: `content[0].text` is the unchanged
     * human-readable summary, and `structuredContent` is a
     * MemberReservationStructured. Programmatic callers must branch on
     * `structuredContent.outcome` -- string-matching the prose is exactly what
     * apra-fleet-3swo.7.1 removed the need for.
     *
     * @param {MemberReservationOptions} options
     * @returns {Promise<{ content: Array<{type: string, text: string}>,
     *   structuredContent: MemberReservationStructured }>}
     */
    async memberReservation(options) {
        return this.mcpClient.callTool('member_reservation', options);
    }

    /**
     * Provision LLM auth (OAuth session copy or API key) onto a member.
     *
     * The MCP result carries both halves: `content[0].text` is the
     * human-readable summary (ASCII markers -- [OK]/[WARN]/[FAIL]/[SKIP], no
     * emoji) and `structuredContent` is a ProvisionAuthStructured. Branch on
     * `structuredContent.ok` / `.reason`, never on the summary text.
     *
     * @param {ProvisionLlmAuthOptions} options
     * @returns {Promise<{ content: Array<{type: string, text: string}>,
     *   structuredContent: ProvisionAuthStructured }>}
     */
    async provisionLlmAuth(options) {
        return this.mcpClient.callTool('provision_llm_auth', options);
    }

    /**
     * Provision VCS (git host) auth -- GitHub App token / PAT, Bitbucket API
     * token, or Azure DevOps PAT -- onto a member.
     *
     * Same two-halves result shape as provisionLlmAuth: read
     * `structuredContent.ok`/`.reason` for the outcome and
     * `structuredContent.expiresAt` for the token expiry, instead of parsing
     * an "expiresAt:" line out of the prose.
     *
     * @param {ProvisionVcsAuthOptions} options
     * @returns {Promise<{ content: Array<{type: string, text: string}>,
     *   structuredContent: ProvisionVcsAuthStructured }>}
     */
    async provisionVcsAuth(options) {
        return this.mcpClient.callTool('provision_vcs_auth', options);
    }

    /**
     * Run a credential-requiring git/VCS command on a member WITHOUT the
     * caller ever learning the credential (src/tools/vcs-credential-exec.ts).
     *
     * This is the server-side replacement for reading a token back out of the
     * deployed git-credential-helper: the server reads the credential
     * in-process, substitutes whichever placeholder(s) the command contains
     * -- {{vcs_token}} (bare, already quoted for the member's shell) and/or
     * {{vcs_token_inline}} (for use inside the caller's own single quotes,
     * escaped for that interior with no quotes of its own) -- dispatches the
     * command, and redacts the value from the returned stdout/stderr. The
     * plaintext appears in no field of the result.
     *
     * @param {VcsCredentialExecOptions} options
     * @returns {Promise<{ content: Array<{type: string, text: string}>,
     *   structuredContent: VcsCredentialExecStructured }>}
     */
    async vcsCredentialExec(options) {
        return this.mcpClient.callTool('vcs_credential_exec', options);
    }

    /**
     * Compose and deliver a scoped permission profile to a member. Also writes
     * the member's per-folder `apra-fleet` MCP entry (`?member=<uuid>`) through
     * the member provider's own per-project config (not for a local claude
     * member, whose dispatches get it per session: an entry an older compose
     * wrote for it is removed instead), with deny rules for every
     * fleet tool outside the member allowlist (claude, agy), merged by union
     * with any existing deny rules. The result states why a member config was
     * not edited (tracked by git, not strict JSON, unreadable) and when a stale
     * fleetMcp unavailable status was cleared; see docs/api-reference.md.
     * @param {ComposePermissionsOptions} options
     */
    async composePermissions(options) {
        return this.mcpClient.callTool('compose_permissions', options);
    }

    /**
     * Export the calling session's CONFIRMED KB entries to the canonical bible
     * file and auto-commit it locally (never pushed). Pass baseBranch/baseCommit
     * to record the target base branch and base commit in provenance. Writes
     * bible format v3: each added project entry is a KbBibleEntry carrying its
     * source_file_hashes basis; a bible holding a duplicate id is refused.
     * Result JSON: {exported, path, scope, committed}; extract with parseToolJson().
     * The removed scope keys (repo_path, repo, repo_remote_url) are refused
     * with E-SCOPE-KEY-REMOVED before anything is sent.
     * @param {KbExportOptions} [options]
     */
    async kbExport(options = {}) {
        assertNoRemovedKbScopeKeys('kb_export', options);
        return this.mcpClient.callTool('kb_export', options);
    }

    /**
     * Merge exactly the given confirmed entry ids into the bible at entry level
     * (existing entries kept unless this KB holds them as superseded or
     * invalidated -- those are removed, also when ids is empty; each merged
     * entry is a v3 KbBibleEntry carrying its source_file_hashes basis; a bible
     * holding a duplicate id is refused), write baseBranch/baseCommit
     * provenance, and make a local commit scoped to the bible path whose message
     * lists each removal. Never pushes; re-running with the
     * same ids after resetting to a newer HEAD re-merges, so a rejected push can
     * be retried. Result JSON: {path, merged, skipped, removed, entry_count,
     * committed}; extract with parseToolJson(). Each skipped item is {id, reason}
     * with reason not_confirmed_or_unknown, no_source_files (a CONFIRMED id
     * citing no source file) or basis_mismatch. Each removed item is {id, reason}
     * with reason superseded or invalidated.
     * A CONFIRMED id is admitted only if it passes the same basis rule as kb_export.
     * The removed scope keys (repo_path, repo, repo_remote_url) are refused
     * with E-SCOPE-KEY-REMOVED before anything is sent.
     * @param {KbBibleCommitOptions} options
     */
    async kbBibleCommit(options) {
        assertNoRemovedKbScopeKeys('kb_bible_commit', options);
        return this.mcpClient.callTool('kb_bible_commit', options);
    }

    /**
     * Convert a remote member from password to SSH key authentication.
     * @param {SetupSshKeyOptions} options
     */
    async setupSshKey(options) {
        return this.mcpClient.callTool('setup_ssh_key', options);
    }

    /**
     * Send an email. Pass provider config inline (provider, from, and for
     * SMTP: host, port, user, secure). Secrets resolve from the credential
     * store (sendgrid_api_key / smtp_password).
     * @param {SendEmailOptions} options
     */
    async sendEmail(options) {
        return this.mcpClient.callTool('send_email', options);
    }

    /**
     * Collect a secret from the user out-of-band and store it in the fleet
     * credential store. The secret value never passes through the caller.
     * @param {{ name: string, prompt: string, persist?: boolean,
     *           network_policy?: 'allow'|'confirm'|'deny', members?: string,
     *           ttl_seconds?: number }} options
     */
    async credentialStoreSet(options) {
        return this.mcpClient.callTool('credential_store_set', options);
    }

    /**
     * code_reindex -- rebuild the code index of the calling session's own repo
     * (a member session's work folder, otherwise the fleet server's folder;
     * there is no repo argument). Starts gitnexus analyze detached with its
     * output captured to <data>/code-index/<slug>/analyze.log and returns
     * after the first tick. Extract the JSON with parseToolJson(): `outcome`
     * is 'started' | 'up-to-date' | 'starting' | 'already-running' |
     * 'not-started'; a not-started result carries a typed `reason`
     * ('npx-not-found' | 'gitnexus-not-found' | 'analyze-failed' |
     * 'spawn-failed' | 'remote-member' | 'gitnexus-too-old' |
     * 'provider-not-supported'); 'gitnexus-too-old' means the installed
     * gitnexus rejects --index-only and its `detail` names the upgrade fix.
     * Every result also carries `injectedBlockFiles` (repo-relative agent docs
     * still holding a gitnexus block injected by an earlier plain analyze run;
     * detection only, the work tree is never edited). Only the
     * gitnexus provider is supported: provider 'none' makes the tool fail with
     * E-CODE-INTEL-DISABLED, and any other provider (e.g. codebase-memory)
     * yields { outcome: 'not-started', reason: 'provider-not-supported',
     * provider, indexedCommit: null, detail }. Every result carries
     * `indexedCommit` (the commit the index is built at, or null when there
     * is no index or the folder is remote). Poll codeStatus() for completion.
     */
    async codeReindex() {
        return this.mcpClient.callTool('code_reindex', {});
    }

    /**
     * code_status -- the calling session's own code index state: the last
     * analyze run (`analyze`: phase, result 'indexed' | 'up-to-date' |
     * 'incomplete' | 'failed', lastLine, ...), live `readiness`
     * ('ready' | 'building' | 'interrupted' | 'inconsistent' | 'missing';
     * 'building' also covers an analyze rewriting an existing index, which is
     * never served meanwhile; 'interrupted' = an analyze died mid-write and
     * none is running; 'inconsistent' = the gitnexus registry or the fleet
     * record of its last build names a different commit than meta.json, with
     * the reason in `inconsistency` (null otherwise) -- for both, the next
     * code_* call starts a rebuild), `indexedCommit`, `lockHeld`, and `logPath` (null
     * when no analyze log exists yet), and `autoReindexPaused` (null, or the
     * { result, lastLine, logPath, finished } of a failed automatic run --
     * automatic rebuilds stay paused until codeReindex() or a server
     * restart), `injectedBlockFiles` / `injectedBlockWarning` (agent docs still
     * holding a previously injected gitnexus block, and the one-line WARN with
     * the fix; [] / null when clean), and on a failed run
     * `analyze.failureCause` ('gitnexus-too-old' when gitnexus rejected
     * --index-only). A remote work folder returns { remote: true, repo,
     * indexedCommit: null, detail }. Same provider gate as codeReindex():
     * provider 'none' fails with E-CODE-INTEL-DISABLED; a non-gitnexus
     * provider returns the not-supported shape { outcome: 'not-started',
     * reason: 'provider-not-supported', provider, indexedCommit: null,
     * detail } rather than gitnexus readiness. Extract the JSON with
     * parseToolJson().
     */
    async codeStatus() {
        return this.mcpClient.callTool('code_status', {});
    }

    /**
     * session_stats -- a member's kb_* / code_* tool call counts on this
     * server, aggregated across that member's sessions (engine-origin
     * sessions excluded). On a member session the calling member is reported
     * and `member_id` may be omitted; a non-member session must pass it.
     * Extract the JSON with parseToolJson(): a SessionStatsResult.
     *
     * @param {SessionStatsOptions} [options]
     */
    async sessionStats(options = {}) {
        return this.mcpClient.callTool('session_stats', options);
    }

    /**
     * List stored credentials (names and metadata only -- no values).
     * The result payload is a JSON array of { name, scope, ... } entries;
     * extract it with parseToolJson().
     */
    async credentialStoreList() {
        return this.mcpClient.callTool('credential_store_list', {});
    }

    /**
     * Delete a named credential from the store.
     * @param {{ name: string }} options
     */
    async credentialStoreDelete(options) {
        return this.mcpClient.callTool('credential_store_delete', options);
    }

    /**
     * Update metadata (members, TTL, network policy) on an existing
     * credential without re-entering the secret.
     * @param {{ name: string, members?: string, ttl_seconds?: number,
     *           network_policy?: 'allow'|'confirm'|'deny' }} options
     */
    async credentialStoreUpdate(options) {
        return this.mcpClient.callTool('credential_store_update', options);
    }

    /**
     * Fleet-server-hosted global dolt push mutex (apra-fleet-f34.2,
     * src/tools/dolt-push-mutex.ts). Serializes cross-sprint `bd dolt push`
     * for sprints launched WITHOUT a supervisor to coordinate through.
     *
     * `acquire` is ticketed (an MCP call cannot long-poll): it returns
     * `{ granted, ticket, token? }` after a bounded wait, and the caller
     * re-`poll`s the SAME ticket until granted. Polling never dequeues the
     * waiter, so FIFO order is preserved. Pass the caller's real `pid` so a
     * crashed holder is reclaimed by the dead-pid probe.
     *
     * @param {{ action: 'acquire'|'poll'|'release'|'renew'|'cancel'|'status',
     *           sprint_id?: string, ticket?: string, token?: string,
     *           pid?: number, wait_ms?: number }} options
     */
    async doltPushMutex(options) {
        return this.mcpClient.callTool('dolt_push_mutex', options);
    }

    /**
     * Fleet-server-hosted global child-bead-id allocator (apra-fleet-f34.2,
     * src/tools/child-id-allocator.ts). Mints globally-distinct child ids under
     * a shared parent for sprints launched WITHOUT a supervisor, so two sprints
     * creating children under the same parent never derive the same id.
     * `floor` (allocate) is the parent's highest existing child seq: the
     * counter is never below it and released ids at or below it are dropped
     * from the reuse pool on every allocate.
     *
     * @param {{ action: 'allocate'|'confirm'|'release'|'status',
     *           parent_id?: string, token?: string, sprint_id?: string,
     *           pid?: number, floor?: number }} options
     */
    async childIdAllocator(options) {
        return this.mcpClient.callTool('child_id_allocator', options);
    }

    /**
     * Gracefully shut down the fleet server this client is connected to.
     * Self-terminates the server process (deletes the singleton pointer,
     * closes the HTTP transport and all SSH connections) -- does not touch
     * the OS service-manager layer at all, so it works even when service
     * registration (systemd/schtasks) never succeeded.
     *
     * The server closing its own transport as part of shutting down can race
     * this very request's response -- callers should treat ANY outcome
     * (resolve, reject, or timeout) as inconclusive on its own and verify via
     * a direct status check instead. opts.timeoutMs (default 5000) keeps a
     * lost response from hanging the caller up to the SDK's normal 15-minute
     * default.
     * @param {{ timeoutMs?: number }} [opts]
     */
    async shutdownServer(opts = {}) {
        return this.mcpClient.callTool('shutdown_server', {}, { timeoutMs: opts.timeoutMs ?? 5000 });
    }
}
