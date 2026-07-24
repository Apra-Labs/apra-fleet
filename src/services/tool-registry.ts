import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function registerAllTools(server: McpServer): Promise<void> {
  // Load onboarding functions
  const { getFirstRunPreamble, isJsonResponse, isActiveTool, getOnboardingNudge, getWelcomeBackPreamble } = await import('./onboarding.js');

  // Tool schemas and handlers
  const { registerMemberSchema, registerMember } = await import('../tools/register-member.js');
  const { listMembersSchema, listMembers } = await import('../tools/list-members.js');
  const { getMemberModelPricingSchema, getMemberModelPricing } = await import('../tools/get-member-model-pricing.js');
  const { removeMemberSchema, removeMember } = await import('../tools/remove-member.js');
  const { updateMemberSchema, updateMember } = await import('../tools/update-member.js');
  const { memberReservationSchema, memberReservation } = await import('../tools/member-reservation.js');
  const { sendFilesSchema, sendFiles } = await import('../tools/send-files.js');
  const { receiveFilesSchema, receiveFiles } = await import('../tools/receive-files.js');
  const { executePromptSchema, executePrompt } = await import('../tools/execute-prompt.js');
  const { executeCommandSchema, executeCommand } = await import('../tools/execute-command.js');
  const { provisionAuthSchema, provisionAuth } = await import('../tools/provision-auth.js');
  const { setupSSHKeySchema, setupSSHKey } = await import('../tools/setup-ssh-key.js');
  const { setupGitAppSchema, setupGitApp } = await import('../tools/setup-git-app.js');
  const { provisionVcsAuthSchema, provisionVcsAuth } = await import('../tools/provision-vcs-auth.js');
  const { revokeVcsAuthSchema, revokeVcsAuth } = await import('../tools/revoke-vcs-auth.js');
  const { fleetStatusSchema, fleetStatus } = await import('../tools/check-status.js');
  const { memberDetailSchema, memberDetail } = await import('../tools/member-detail.js');
  const { updateAgentCliSchema, updateAgentCli } = await import('../tools/update-agent-cli.js');
  const { shutdownServerSchema, shutdownServer } = await import('../tools/shutdown-server.js');
  const { composePermissionsSchema, composePermissions } = await import('../tools/compose-permissions.js');
  const { cloudControlSchema, cloudControl } = await import('../tools/cloud-control.js');
  const { monitorTaskSchema, monitorTask } = await import('../tools/monitor-task.js');
  const { stopPromptSchema, stopPrompt } = await import('../tools/stop-prompt.js');
  const { versionSchema, version } = await import('../tools/version.js');
  const { credentialStoreSetSchema, credentialStoreSet } = await import('../tools/credential-store-set.js');
  const { credentialStoreListSchema, credentialStoreList } = await import('../tools/credential-store-list.js');
  const { credentialStoreDeleteSchema, credentialStoreDelete } = await import('../tools/credential-store-delete.js');
  const { credentialStoreUpdateSchema, credentialStoreUpdate } = await import('../tools/credential-store-update.js');
  const { sendMessageSchema, sendMessage } = await import('../tools/send-message.js');
  const { reportStatusSchema, reportStatus } = await import('../tools/report-status.js');
  const { respondToMessageSchema, respondToMessage } = await import('../tools/respond-to-message.js');

  // Onboarding helpers
  async function sendOnboardingNotification(srv: typeof server, text: string): Promise<void> {
    try {
      await srv.server.sendLoggingMessage({
        level: 'info',
        logger: 'apra-fleet-onboarding',
        data: text,
      });
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e));
      if (!/logging|method not found|not supported/i.test(msg)) {
        process.stderr.write(`[apra-fleet] onboarding notification failed: ${msg}\n`);
      }
    }
  }

  function sanitizeToolResult(s: string): string {
    return s.replace(/<\/?apra-fleet-display[^>]*(?:>|$)/gi, '[tag-stripped]');
  }

  function getOnboardingPreamble(toolName: string, isJson: boolean): string | null {
    if (!isActiveTool(toolName)) return null;
    if (isJson) return null;
    const banner = getFirstRunPreamble();
    if (banner) return banner;
    return getWelcomeBackPreamble();
  }

  // Most tools return a plain display string. A few (execute_command) return
  // { text, structuredContent } to give programmatic callers (e.g.
  // FleetWorkflow.command()) a machine-readable channel alongside the
  // human/LLM-facing text -- see ExecuteCommandResult in tools/execute-command.ts.
  function wrapTool(toolName: string, handler: (input: any, extra?: any) => Promise<string | { text: string; structuredContent?: Record<string, unknown> }>) {
    return async (input: any, extra?: any) => {
      const raw = await handler(input, extra);
      const result = typeof raw === 'string' ? raw : raw.text;
      const structuredContent = typeof raw === 'string' ? undefined : raw.structuredContent;
      const isJson = isJsonResponse(result);
      const preamble = getOnboardingPreamble(toolName, isJson);
      const suffix = isJson ? null : getOnboardingNudge(toolName, input, result);

      if (preamble) void sendOnboardingNotification(server, preamble);
      if (suffix)   void sendOnboardingNotification(server, suffix);

      const content: Array<{ type: 'text'; text: string; annotations?: { audience?: ('user' | 'assistant')[]; priority?: number } }> = [];
      if (preamble) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${preamble}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 1 } });
      }
      content.push({ type: 'text' as const, text: sanitizeToolResult(result) });
      if (suffix) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${suffix}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 0.8 } });
      }
      return structuredContent ? { content, structuredContent } : { content };
    };
  }

  // Core Member Management
  server.tool('register_member', 'Add a machine to the fleet. Use member_type "local" for this machine or "remote" for a machine reachable over SSH. Choose the AI provider the member will use for prompts. Optional: add tags for grouping and filtering members.', registerMemberSchema.shape, wrapTool('register_member', (input) => registerMember(input as any)));
  server.tool('list_members', 'List all fleet members and their current status. Use format="json" for structured data. Use tags=["gpu"] to filter to members that have ALL specified tags (AND semantics); omit tags to return all members.', listMembersSchema.shape, wrapTool('list_members', (input) => listMembers(input as any)));
  server.tool('get_member_model_pricing', "Returns a member's cheap/standard/premium tier resolved to a concrete model and its per-1M-token price (prompt/completion), for real per-dispatch cost tracking instead of a tier-band estimate. A tier is null when its resolved model has no known price.", getMemberModelPricingSchema.shape, wrapTool('get_member_model_pricing', (input) => getMemberModelPricing(input as any)));
  server.tool('remove_member', 'Remove a member from the fleet.', removeMemberSchema.shape, wrapTool('remove_member', (input) => removeMember(input as any)));
  server.tool('update_member', "Change a member's name, connection details, working directory, AI provider, tags, or other settings.", updateMemberSchema.shape, wrapTool('update_member', (input) => updateMember(input as any)));
  server.tool('member_reservation', 'Reserve, release, or force-release exclusive ownership of a member for a sprint (server-side reservation; does not yet block dispatch). "reserve" claims the member for sprint_id; "release" clears it if sprint_id matches the current holder; "force_release" clears a wedged reservation regardless of owner.', memberReservationSchema.shape, wrapTool('member_reservation', (input) => memberReservation(input as any)));

  // File Operations
  server.tool('send_files', 'Transfer local files to a member. Always batch multiple files into a single call — never invoke repeatedly for individual files.', sendFilesSchema.shape, wrapTool('send_files', (input, extra) => sendFiles(input as any, extra)));
  server.tool('receive_files', 'Download files from a member to a local directory. Always batch multiple files into a single call — never invoke repeatedly for individual files.', receiveFilesSchema.shape, wrapTool('receive_files', (input, extra) => receiveFiles(input as any, extra)));

  // Prompt Execution
  server.tool('execute_prompt', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run an AI prompt on a member. Supports session resume for multi-turn conversations.', executePromptSchema.shape, wrapTool('execute_prompt', (input, extra) => executePrompt(input as any, extra)));
  server.tool('execute_command', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run a shell command on a member. Use for quick tasks like installing packages, checking versions, or running scripts.', executeCommandSchema.shape, wrapTool('execute_command', (input, extra) => executeCommand(input as any, extra)));

  // Authentication & SSH
  server.tool('provision_llm_auth', "Authenticate a fleet member so it can run prompts. Copies your current login session to the member, or deploys an API key if provided. Run this before execute_prompt if the member reports no authentication.", provisionAuthSchema.shape, wrapTool('provision_llm_auth', (input) => provisionAuth(input as any)));
  server.tool('setup_ssh_key', 'Generate an SSH key pair and migrate a member from password to key-based authentication.', setupSSHKeySchema.shape, wrapTool('setup_ssh_key', (input) => setupSSHKey(input as any)));
  server.tool('setup_git_app', "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps.", setupGitAppSchema.shape, wrapTool('setup_git_app', (input) => setupGitApp(input as any)));
  server.tool('provision_vcs_auth', 'Set up git access credentials on a member. Supports GitHub, Bitbucket, and Azure DevOps. Tests connectivity after setup.', provisionVcsAuthSchema.shape, wrapTool('provision_vcs_auth', (input) => provisionVcsAuth(input as any)));
  server.tool('revoke_vcs_auth', 'Remove VCS credentials from a member. Specify the provider (github, bitbucket, or azure-devops) to revoke.', revokeVcsAuthSchema.shape, wrapTool('revoke_vcs_auth', (input) => revokeVcsAuth(input as any)));

  // Status & Monitoring
  server.tool('fleet_status', 'Get status of all fleet members. Use json format for structured data.', fleetStatusSchema.shape, wrapTool('fleet_status', (input) => fleetStatus(input as any)));
  server.tool('member_detail', 'Get detailed status for one member: connectivity, AI version, authentication, active session, resources, and git branch.', memberDetailSchema.shape, wrapTool('member_detail', (input) => memberDetail(input as any)));

  // Maintenance
  server.tool('update_llm_cli', "Update or install the AI provider CLI on members. Omit member to update all online members at once. Use install_if_missing to install on members that don't have it yet.", updateAgentCliSchema.shape, wrapTool('update_llm_cli', (input) => updateAgentCli(input as any)));
  server.tool('shutdown_server', 'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.', shutdownServerSchema.shape, wrapTool('shutdown_server', () => shutdownServer()));
  server.tool('version', 'Returns the installed apra-fleet server version', versionSchema.shape, wrapTool('version', () => version()));

  // Permissions
  server.tool('compose_permissions', 'Set up and deliver the right permissions to a member for their role or tags. Automatically tailors permissions to the project type. Pass tags (e.g. ["doer","gpu"]) to layer custom tag profiles additively on top of the base role; a doer/reviewer tag sets the primary mode and wins over role. Use grant to add specific permissions mid-sprint without a full recompose.', composePermissionsSchema.shape, wrapTool('compose_permissions', (input) => composePermissions(input as any)));

  // Cloud Control
  server.tool('cloud_control', 'Manually start, stop, or check status of a cloud fleet member. Start waits until the member is ready; stop is immediate.', cloudControlSchema.shape, wrapTool('cloud_control', (input) => cloudControl(input as any)));
  server.tool('monitor_task', 'Check status of a long-running background task on a cloud member. Optionally stop the cloud instance automatically when the task completes.', monitorTaskSchema.shape, wrapTool('monitor_task', (input) => monitorTask(input as any)));

  // Agent Lifecycle
  server.tool('stop_prompt', 'Kill the active LLM process on a member. Always call TaskStop on the dispatching background agent after calling this.', stopPromptSchema.shape, wrapTool('stop_prompt', (input) => stopPrompt(input as any)));

  // Credential Store
  server.tool('credential_store_set', 'Collect a secret from the user out-of-band and store it. Returns a handle (sec://NAME) and scope. Use {{secure.NAME}} tokens in execute_command to inject the value.', credentialStoreSetSchema.shape, wrapTool('credential_store_set', (input) => credentialStoreSet(input as any)));
  server.tool('credential_store_list', 'List all stored credentials (names and metadata only — no values).', credentialStoreListSchema.shape, wrapTool('credential_store_list', () => credentialStoreList()));
  server.tool('credential_store_delete', 'Delete a named credential from the store (both session and persistent tiers).', credentialStoreDeleteSchema.shape, wrapTool('credential_store_delete', (input) => credentialStoreDelete(input as any)));
  server.tool('credential_store_update', 'Update metadata (members, TTL, network policy) on an existing credential without re-entering the secret.', credentialStoreUpdateSchema.shape, wrapTool('credential_store_update', (input) => credentialStoreUpdate(input as any)));

  // Interactive Session Messaging
  server.tool('send_message', 'Send a task message to a connected interactive member session via SSE. Returns the message ID.', sendMessageSchema.shape, wrapTool('send_message', (input) => sendMessage(input as any)));
  server.tool('report_status', 'Called by a connected interactive member session (not the orchestrator) to report it is done responding to a send_message notification and available again ("online") or still connected but not actively engaged ("idle"). Closes the busy->online/idle status loop send_message opens.', reportStatusSchema.shape, wrapTool('report_status', (input, extra) => reportStatus(input as any, extra)));
  server.tool('respond_to_message', 'Called by a connected interactive member session to respond to a prompt delivered via execute_prompt or send_message. Pass reply_to as the msgid from the original notification\'s meta. If execute_prompt is waiting on this reply_to, its call resolves with this content; otherwise this is a no-op response with a clear "no pending call" result.', respondToMessageSchema.shape, wrapTool('respond_to_message', (input) => respondToMessage(input as any)));
}
