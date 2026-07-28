/**
 * @typedef {Object} ExecutePromptOptions
 * @property {string} prompt - The prompt to send to the LLM on the remote member
 * @property {string} [agent] - Optional agent name to activate
 * @property {number} [max_total_s] - Hard ceiling in seconds
 * @property {number} [max_turns] - Max turns for claude -p (default: 50)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [model] - Model tier ("cheap", "standard", "premium") or a specific model ID
 * @property {boolean} [resume] - Resume the previous session if one exists. Defaults to
 *   true at this client/transport layer when the field is omitted entirely. NOTE: the
 *   FleetWorkflow.agent() workflow layer (packages/apra-fleet-workflow/src/workflow/index.mjs)
 *   always sends this field explicitly, defaulting it to `false` for workflow-authored
 *   prompts (see AgentOptions.resume there and apra-fleet-unw.3 / F10) -- so workflow
 *   callers effectively opt out of this client-level default unless they ask for resume.
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 * @property {number} [timeout_s] - Inactivity timeout in seconds (default: 300)
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
 * @property {boolean} [long_running] - Run as background task
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
 * @property {string} work_folder - Working directory on the target machine (required)
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
 * @property {string} [work_folder] - New working directory
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
 * @property {"read" | "push" | "admin" | "issues" | "full"} [git_access] - GitHub App access
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
 * @property {"doer" | "reviewer"} [role] - Base profile. Provide at least one of role or tags.
 * @property {string[]} [tags] - Member tags; "doer"/"reviewer" sets the primary mode
 *   and wins over role when both are given. Other tags load tag-<name>.json profiles.
 * @property {string} [project_folder] - Local project folder containing the
 *   permissions.json ledger. Omit to skip ledger merge.
 * @property {string[]} [grant] - Reactive mode: additional permissions to grant.
 * @property {string} [grant_reason] - Reason for the grant (stored in ledger)
 */

/**
 * @typedef {Object} SetupSshKeyOptions
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 */


// Grace margin added on top of the payload's own timeout hint (timeout_s /
// max_total_s) so the client doesn't race the server's own deadline -- the
// server should have a chance to reply with its own timeout/error first.
const TIMEOUT_GRACE_MS = 30 * 1000;

/**
 * Derives a client-side McpClient.request() timeout (ms) from a payload's
 * own timeout hints. Prefers max_total_s (a hard ceiling) over timeout_s
 * (an inactivity timeout) when both are present, then adds a grace margin.
 * Returns undefined when neither hint is present, letting McpClient fall
 * back to its own conservative default (never infinite).
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
