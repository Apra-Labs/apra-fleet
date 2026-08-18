/**
 * @typedef {Object} ExecutePromptOptions
 * @property {string} prompt - The prompt to send to the LLM on the remote member
 * @property {string} [agent] - Optional agent name to activate
 * @property {number} [max_total_s] - Hard ceiling in seconds
 * @property {number} [max_turns] - Max turns for claude -p (default: 50)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [model] - Model tier ("cheap", "standard", "premium") or a specific model ID
 * @property {boolean|string} [resume] - Resume the previous session if one exists. Defaults to
 *   true at this client/transport layer when the field is omitted entirely. NOTE: the
 *   FleetWorkflow.agent() workflow layer (packages/apra-fleet-workflow/src/workflow/index.mjs)
 *   always sends this field explicitly, defaulting it to `false` for workflow-authored
 *   prompts (see AgentOptions.resume there and apra-fleet-unw.3 / F10) -- so workflow
 *   callers effectively opt out of this client-level default unless they ask for resume.
 * @property {string} [session_id] - Optional explicit session ID to resume (shorthand alias for resume: "<sessionId>")
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 * @property {number} [timeout_s] - Inactivity timeout in seconds (default: 300)
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
 * @typedef {Object} ListMembersOptions
 * @property {"compact" | "json"} [format] - Output format
 * @property {string[]} [tags] - Filter members by tags (AND semantics)
 */

/**
 * @typedef {Object} FleetStatusOptions
 * @property {"compact" | "json"} [format] - Output format
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
 * @property {string} work_folder - Working directory on the target machine (required). For remote members, must be a fully-qualified/absolute path -- "~" and relative paths are rejected.
 * @property {"local" | "remote"} [member_type] - Member type (default: "remote")
 * @property {string} [host] - IP address or hostname of the remote machine
 * @property {string} [username] - SSH username
 * @property {number} [port] - SSH port (default: 22)
 * @property {"password" | "key"} [auth_type] - Authentication method
 * @property {string} [password] - SSH password
 * @property {string} [key_path] - Path to SSH private key
 * @property {string} [llm_provider] - LLM provider for this member
 * @property {string} [category] - Optional group label
 * @property {string[]} [tags] - Optional list of free-form labels
 * @property {"false" | "auto" | "dangerous"} [unattended] - Permission mode for unattended execution
 */

/**
 * @typedef {Object} UpdateMemberOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [friendly_name] - New friendly name
 * @property {string} [work_folder] - New working directory. For non-local (remote/relay) members, must be a fully-qualified/absolute path -- "~" and relative paths are rejected.
 * @property {string} [host] - New host
 * @property {string} [username] - New SSH username
 * @property {number} [port] - New SSH port
 * @property {"password" | "key"} [auth_type] - New auth method
 * @property {string} [password] - New SSH password
 * @property {string} [key_path] - New SSH private key path
 * @property {string} [llm_provider] - Change the LLM provider
 * @property {string} [category] - Group label
 * @property {string[]} [tags] - Free-form labels
 * @property {"false" | "auto" | "dangerous"} [unattended] - Permission mode
 */

/**
 * @typedef {Object} RemoveMemberOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {boolean} [force] - Remove even if the member is currently busy
 */

/**
 * @typedef {Object} ProvisionLlmAuthOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [api_key] - AI provider API key. If omitted, the local OAuth
 *   session is copied to the member instead. Supports {{secure.NAME}} token --
 *   resolved from the credential store server-side before use.
 */

/**
 * @typedef {Object} ProvisionVcsAuthOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"github" | "bitbucket" | "azure-devops"} provider - VCS provider to configure
 * @property {string} [label] - Credential label (slug, e.g. "work-github"). Defaults to provider name.
 * @property {string} [scope_url] - Git credential scope URL (e.g. "https://github.com/my-org").
 *   Defaults to "https://<host>".
 * @property {"github-app" | "pat"} [github_mode] - GitHub auth mode: github-app (mint via
 *   configured app) or pat (personal access token)
 * @property {string} [token] - Personal access token (GitHub PAT or Azure DevOps PAT).
 *   Supports {{secure.NAME}} token -- resolved from the credential store server-side before use.
 * @property {"read" | "push" | "push+pr" | "admin" | "issues" | "full"} [git_access] - GitHub App access
 *   level override
 * @property {string[]} [repos] - GitHub App repository list override
 * @property {string} [email] - Bitbucket account email
 * @property {string} [api_token] - Bitbucket API token. Supports {{secure.NAME}} token --
 *   resolved from the credential store server-side before use.
 * @property {string} [workspace] - Bitbucket workspace slug
 * @property {string} [org_url] - Azure DevOps organization URL (e.g. https://dev.azure.com/myorg)
 * @property {string} [pat] - Azure DevOps personal access token. Supports {{secure.NAME}}
 *   token -- resolved from the credential store server-side before use.
 */

/**
 * @typedef {Object} ComposePermissionsOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {"doer" | "reviewer" | "deployer" | "integ-test-runner" | "regression-test-runner"} [role] - Base profile
 *   (doer/reviewer also select the compose mode; deployer/integ-test-runner/regression-test-runner select their
 *   own bounds-<role>.json). Provide at least one of role or tags.
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
 *   for every caller. When `role` is also supplied AND that role has a
 *   bounds-<role>.json profile in the INSTALLED (host-side) profiles
 *   directory, an out-of-bounds permission is additionally REJECTED -- see
 *   `allow_out_of_bounds`.
 * @property {string} [grant_reason] - Reason for the grant (stored in ledger)
 * @property {boolean} [allow_out_of_bounds] - OPERATOR ESCALATION ONLY.
 *   Downgrades the enforcing per-role bounds check back to informational
 *   (permission granted, ledger entry flagged outOfBounds) for a deliberate
 *   one-off human grant. Autonomous callers must never set it: a member
 *   escalating its own permissions is what the bounds check exists to
 *   prevent. Never loosens the NEVER_AUTO_GRANT denylist.
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
 * own timeout hints. Prefers max_total_s (a hard ceiling) over timeout_s
 * (an inactivity timeout) when both are present, then adds a grace margin.
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

export class ApraFleet {
    /**
     * @param {{ callTool: (name: string, args: Record<string, any>, opts?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<any> }} mcpClient
     */
    constructor(mcpClient) {
        this.mcpClient = mcpClient;
    }

    /**
     * Run an AI prompt on a member.
     * @param {ExecutePromptOptions} options
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
     * Get detailed status for one member: connectivity, session, work folder, provider.
     * @param {{ member_id?: string, member_name?: string, format?: 'compact'|'json' }} options
     */
    async memberDetail(options) {
        return this.mcpClient.callTool('member_detail', options);
    }

    /**
     * Get a member's cheap/standard/premium tier resolved to a concrete
     * model and its real per-1M-token price (apra-fleet-dv5.5/dv5.6).
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
     * Change a member's settings.
     * @param {UpdateMemberOptions} options
     */
    async updateMember(options) {
        return this.mcpClient.callTool('update_member', options);
    }

    /**
     * Remove a member from the fleet.
     * @param {RemoveMemberOptions} options
     */
    async removeMember(options) {
        return this.mcpClient.callTool('remove_member', options);
    }

    /**
     * Provision LLM auth (OAuth session copy or API key) onto a member.
     * @param {ProvisionLlmAuthOptions} options
     */
    async provisionLlmAuth(options) {
        return this.mcpClient.callTool('provision_llm_auth', options);
    }

    /**
     * Provision VCS (git host) auth -- GitHub App token / PAT, Bitbucket API
     * token, or Azure DevOps PAT -- onto a member.
     * @param {ProvisionVcsAuthOptions} options
     */
    async provisionVcsAuth(options) {
        return this.mcpClient.callTool('provision_vcs_auth', options);
    }

    /**
     * Compose and deliver a scoped permission profile to a member.
     * @param {ComposePermissionsOptions} options
     */
    async composePermissions(options) {
        return this.mcpClient.callTool('compose_permissions', options);
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
