#!/usr/bin/env node

import { serverVersion } from './version.js';
import { logLine, logError } from './utils/log-helpers.js';

// --- CLI dispatch (before MCP server imports to keep --version fast) ---
const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(`apra-fleet ${serverVersion}`);
  process.exit(0);
}

if (arg === '--help' || arg === '-h') {
  console.log(`apra-fleet ${serverVersion}

Usage:
  apra-fleet                  Start MCP server (stdio)
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet — PM depends on fleet)
  apra-fleet install --skill none      Skip skill installation
  apra-fleet install --no-skill        Same as --skill none
  apra-fleet auth <name>      Provide password for pending registration (auto-launched)
  apra-fleet --version        Print version
  apra-fleet --help           Show this help`);
  process.exit(0);
}

if (arg === 'install') {
  // Dynamic import so MCP deps aren't loaded for install
  import('./cli/install.js')
    .then(m => m.runInstall(process.argv.slice(3)))
    .catch(err => { logError('cli', `Install failed: ${err.message}`); process.exit(1); });
} else if (arg === 'auth') {
  import('./cli/auth.js')
    .then(m => m.runAuth(process.argv.slice(3)))
    .catch(err => { logError('cli', `Auth failed: ${err.message}`); process.exit(1); });
} else {
  // Default: start MCP server
  startServer();
}

async function startServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  // Load onboarding state once at server startup (in-memory singleton)
  const { loadOnboardingState, resetSessionFlags, getFirstRunPreamble, isJsonResponse, isActiveTool, getOnboardingNudge, getWelcomeBackPreamble } = await import('./services/onboarding.js');
  const { VERBATIM_INSTRUCTIONS } = await import('./onboarding/text.js');
  const { getAllAgents: getAgentsForStartup } = await import('./services/registry.js');
  // Pass current member count so upgrade detection works: existing registry + no onboarding.json → skip banner
  loadOnboardingState(getAgentsForStartup().length);
  resetSessionFlags();

  // Tool schemas and handlers
  const { registerMemberSchema, registerMember } = await import('./tools/register-member.js');
  const { listMembersSchema, listMembers } = await import('./tools/list-members.js');
  const { removeMemberSchema, removeMember } = await import('./tools/remove-member.js');
  const { updateMemberSchema, updateMember } = await import('./tools/update-member.js');
  const { sendFilesSchema, sendFiles } = await import('./tools/send-files.js');
  const { receiveFilesSchema, receiveFiles } = await import('./tools/receive-files.js');
  const { executePromptSchema, executePrompt } = await import('./tools/execute-prompt.js');
  const { executeCommandSchema, executeCommand } = await import('./tools/execute-command.js');
  const { provisionAuthSchema, provisionAuth } = await import('./tools/provision-auth.js');
  const { setupSSHKeySchema, setupSSHKey } = await import('./tools/setup-ssh-key.js');
  const { setupGitAppSchema, setupGitApp } = await import('./tools/setup-git-app.js');
  const { provisionVcsAuthSchema, provisionVcsAuth } = await import('./tools/provision-vcs-auth.js');
  const { revokeVcsAuthSchema, revokeVcsAuth } = await import('./tools/revoke-vcs-auth.js');
  const { fleetStatusSchema, fleetStatus } = await import('./tools/check-status.js');
  const { memberDetailSchema, memberDetail } = await import('./tools/member-detail.js');
  const { updateAgentCliSchema, updateAgentCli } = await import('./tools/update-agent-cli.js');
  const { shutdownServerSchema, shutdownServer } = await import('./tools/shutdown-server.js');
  const { composePermissionsSchema, composePermissions } = await import('./tools/compose-permissions.js');
  const { cloudControlSchema, cloudControl } = await import('./tools/cloud-control.js');
  const { monitorTaskSchema, monitorTask } = await import('./tools/monitor-task.js');
  const { stopPromptSchema, stopPrompt } = await import('./tools/stop-prompt.js');
  const { versionSchema, version } = await import('./tools/version.js');
  const { credentialStoreSetSchema, credentialStoreSet } = await import('./tools/credential-store-set.js');
  const { credentialStoreListSchema, credentialStoreList } = await import('./tools/credential-store-list.js');
  const { credentialStoreDeleteSchema, credentialStoreDelete } = await import('./tools/credential-store-delete.js');
  const { credentialStoreUpdateSchema, credentialStoreUpdate } = await import('./tools/credential-store-update.js');
  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');
  const { cleanupStaleTasks } = await import('./services/task-cleanup.js');
  const { checkForUpdate } = await import('./services/update-check.js');
  const { purgeExpiredCredentials } = await import('./services/credential-store.js');

  // serverVersion is "v0.0.1_abc123" — strip 'v' prefix for semver-like version field
  const versionNum = serverVersion.startsWith('v') ? serverVersion.slice(1) : serverVersion;

  const server = new McpServer(
    { name: `apra fleet server ${serverVersion}`, version: versionNum },
    {
      capabilities: { logging: {} },
      instructions: VERBATIM_INSTRUCTIONS,
    },
  );

  // --- Onboarding helpers ---
  // isActiveTool guards passive tools (version, shutdown_server) from consuming the banner.
  // First-run banner bypasses the JSON check — passive guard is sufficient protection.
  // Welcome-back and nudges still respect the JSON check.

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
    // First-run banner always shows regardless of response format
    const banner = getFirstRunPreamble();
    if (banner) return banner;
    // Welcome-back still respects JSON check
    if (isJson) return null;
    return getWelcomeBackPreamble();
  }

  function wrapTool(toolName: string, handler: (input: any) => Promise<string>) {
    return async (input: any) => {
      const result = await handler(input);
      const isJson = isJsonResponse(result);
      const preamble = getOnboardingPreamble(toolName, isJson);
      const suffix = isJson ? null : getOnboardingNudge(toolName, input, result);

      // Channel 1: out-of-band notifications (best effort, never throws)
      if (preamble) void sendOnboardingNotification(server, preamble);
      if (suffix)   void sendOnboardingNotification(server, suffix);

      // Channel 2 + 3: content blocks with markers + audience annotation
      const content: Array<{ type: 'text'; text: string; annotations?: { audience?: ('user' | 'assistant')[]; priority?: number } }> = [];
      if (preamble) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${preamble}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 1 } });
      }
      content.push({ type: 'text' as const, text: sanitizeToolResult(result) });
      if (suffix) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${suffix}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 0.8 } });
      }
      return { content };
    };
  }

  // --- Core Member Management ---
  server.tool('register_member', 'Add a machine to the fleet. Use member_type "local" for this machine or "remote" for a machine reachable over SSH. Choose the AI provider the member will use for prompts.', registerMemberSchema.shape, wrapTool('register_member', (input) => registerMember(input as any)));
  server.tool('list_members', 'List all fleet members and their current status. Use format="json" for structured data.', listMembersSchema.shape, wrapTool('list_members', (input) => listMembers(input as any)));
  server.tool('remove_member', 'Remove a member from the fleet.', removeMemberSchema.shape, wrapTool('remove_member', (input) => removeMember(input as any)));
  server.tool('update_member', "Change a member's name, connection details, working directory, AI provider, or other settings.", updateMemberSchema.shape, wrapTool('update_member', (input) => updateMember(input as any)));

  // --- File Operations ---
  server.tool('send_files', 'Transfer local files to a member. Always batch multiple files into a single call — never invoke repeatedly for individual files.', sendFilesSchema.shape, wrapTool('send_files', (input) => sendFiles(input as any)));
  server.tool('receive_files', 'Download files from a member to a local directory. Always batch multiple files into a single call — never invoke repeatedly for individual files.', receiveFilesSchema.shape, wrapTool('receive_files', (input) => receiveFiles(input as any)));

  // --- Prompt Execution ---
  server.tool('execute_prompt', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run an AI prompt on a member. Supports session resume for multi-turn conversations.', executePromptSchema.shape, wrapTool('execute_prompt', (input) => executePrompt(input as any)));
  server.tool('execute_command', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run a shell command on a member. Use for quick tasks like installing packages, checking versions, or running scripts.', executeCommandSchema.shape, wrapTool('execute_command', (input) => executeCommand(input as any)));

  // --- Authentication & SSH ---
  server.tool('provision_llm_auth', "Authenticate a fleet member so it can run prompts. Copies your current login session to the member, or deploys an API key if provided. Run this before execute_prompt if the member reports no authentication.", provisionAuthSchema.shape, wrapTool('provision_llm_auth', (input) => provisionAuth(input as any)));
  server.tool('setup_ssh_key', 'Generate an SSH key pair and migrate a member from password to key-based authentication.', setupSSHKeySchema.shape, wrapTool('setup_ssh_key', (input) => setupSSHKey(input as any)));
  server.tool('setup_git_app', "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps.", setupGitAppSchema.shape, wrapTool('setup_git_app', (input) => setupGitApp(input as any)));
  server.tool('provision_vcs_auth', 'Set up git access credentials on a member. Supports GitHub, Bitbucket, and Azure DevOps. Tests connectivity after setup.', provisionVcsAuthSchema.shape, wrapTool('provision_vcs_auth', (input) => provisionVcsAuth(input as any)));
  server.tool('revoke_vcs_auth', 'Remove VCS credentials from a member. Specify the provider (github, bitbucket, or azure-devops) to revoke.', revokeVcsAuthSchema.shape, wrapTool('revoke_vcs_auth', (input) => revokeVcsAuth(input as any)));

  // --- Status & Monitoring ---
  server.tool('fleet_status', 'Get status of all fleet members. Use json format for structured data.', fleetStatusSchema.shape, wrapTool('fleet_status', (input) => fleetStatus(input as any)));
  server.tool('member_detail', 'Get detailed status for one member: connectivity, AI version, authentication, active session, resources, and git branch.', memberDetailSchema.shape, wrapTool('member_detail', (input) => memberDetail(input as any)));

  // --- Maintenance ---
  server.tool('update_llm_cli', "Update or install the AI provider CLI on members. Omit member to update all online members at once. Use install_if_missing to install on members that don't have it yet.", updateAgentCliSchema.shape, wrapTool('update_llm_cli', (input) => updateAgentCli(input as any)));
  server.tool('shutdown_server', 'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.', shutdownServerSchema.shape, wrapTool('shutdown_server', () => shutdownServer()));
  server.tool('version', 'Returns the installed apra-fleet server version', versionSchema.shape, wrapTool('version', () => version()));

  // --- Permissions ---
  server.tool('compose_permissions', 'Set up and deliver the right permissions to a member for their role. Automatically tailors permissions to the project type. Use grant to add specific permissions mid-sprint without a full recompose.', composePermissionsSchema.shape, wrapTool('compose_permissions', (input) => composePermissions(input as any)));

  // --- Cloud Control ---
  server.tool('cloud_control', 'Manually start, stop, or check status of a cloud fleet member. Start waits until the member is ready; stop is immediate.', cloudControlSchema.shape, wrapTool('cloud_control', (input) => cloudControl(input as any)));
  server.tool('monitor_task', 'Check status of a long-running background task on a cloud member. Optionally stop the cloud instance automatically when the task completes.', monitorTaskSchema.shape, wrapTool('monitor_task', (input) => monitorTask(input as any)));

  // --- Agent Lifecycle ---
  server.tool('stop_prompt', 'Kill the active LLM process on a member. Use when a member is hung, working on the wrong thing, or needs to be cancelled. Always call TaskStop on the dispatching background agent before calling stop_prompt — otherwise the agent re-dispatches immediately. Then re-dispatch with resume=false.', stopPromptSchema.shape, wrapTool('stop_prompt', (input) => stopPrompt(input as any)));
  // --- Credential Store ---
  server.tool('credential_store_set', 'Collect a secret from the user out-of-band and store it. Returns a handle (sec://NAME) and scope. Use {{secure.NAME}} tokens in execute_command to inject the value.', credentialStoreSetSchema.shape, wrapTool('credential_store_set', (input) => credentialStoreSet(input as any)));
  server.tool('credential_store_list', 'List all stored credentials (names and metadata only — no values).', credentialStoreListSchema.shape, wrapTool('credential_store_list', () => credentialStoreList()));
  server.tool('credential_store_delete', 'Delete a named credential from the store (both session and persistent tiers).', credentialStoreDeleteSchema.shape, wrapTool('credential_store_delete', (input) => credentialStoreDelete(input as any)));
  server.tool('credential_store_update', 'Update metadata (members, TTL, network policy) on an existing credential without re-entering the secret.', credentialStoreUpdateSchema.shape, wrapTool('credential_store_update', (input) => credentialStoreUpdate(input as any)));

  // --- Start Server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const { FLEET_DIR } = await import('./paths.js');
  logLine('startup', `apra-fleet ${serverVersion} started — FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  process.on('SIGINT', () => { cleanupAuthSocket(); closeAllConnections(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupAuthSocket(); closeAllConnections(); process.exit(0); });
}
