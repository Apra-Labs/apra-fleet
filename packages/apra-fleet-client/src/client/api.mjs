/**
 * @typedef {Object} ExecutePromptOptions
 * @property {string} prompt - The prompt to send to the LLM on the remote member
 * @property {string} [agent] - Optional agent name to activate
 * @property {number} [max_total_s] - Hard ceiling in seconds
 * @property {number} [max_turns] - Max turns for claude -p (default: 50)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [model] - Model tier ("cheap", "standard", "premium") or a specific model ID
 * @property {boolean} [resume] - Resume the previous session if one exists (default: true)
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 * @property {number} [timeout_s] - Inactivity timeout in seconds (default: 300)
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


export class ApraFleet {
    /**
     * @param {{ callTool: (name: string, args: Record<string, any>) => Promise<any> }} mcpClient 
     */
    constructor(mcpClient) {
        this.mcpClient = mcpClient;
    }

    /**
     * Run an AI prompt on a member.
     * @param {ExecutePromptOptions} options
     */
    async executePrompt(options) {
        return this.mcpClient.callTool('execute_prompt', options);
    }

    /**
     * Run a shell command on a member.
     * @param {ExecuteCommandOptions} options
     */
    async executeCommand(options) {
        return this.mcpClient.callTool('execute_command', options);
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
}
