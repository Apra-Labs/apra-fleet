#!/usr/bin/env node

import { serverVersion } from './version.js';

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
  apra-fleet install          Install: binary + hooks + statusline + register MCP
  apra-fleet install --skill  Same + PM skill to ~/.claude/skills/pm/
  apra-fleet auth <name>      Provide password for pending registration (auto-launched)
  apra-fleet --version        Print version
  apra-fleet --help           Show this help`);
  process.exit(0);
}

if (arg === 'install') {
  // Dynamic import so MCP deps aren't loaded for install
  import('./cli/install.js')
    .then(m => m.runInstall(process.argv.slice(3)))
    .catch(err => { console.error('Install failed:', err.message); process.exit(1); });
} else if (arg === 'auth') {
  import('./cli/auth.js')
    .then(m => m.runAuth(process.argv.slice(3)))
    .catch(err => { console.error('Auth failed:', err.message); process.exit(1); });
} else {
  // Default: start MCP server
  startServer();
}

async function startServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

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
  const { updateTaskTokensSchema, updateTaskTokens } = await import('./tools/update-task-tokens.js');
  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');

  // serverVersion is "v0.0.1_abc123" — strip 'v' prefix for semver-like version field
  const versionNum = serverVersion.startsWith('v') ? serverVersion.slice(1) : serverVersion;

  const server = new McpServer({
    name: `apra fleet server ${serverVersion}`,
    version: versionNum,
  });

  // --- Core Member Management ---
  server.tool('register_member', 'Add a machine to the fleet. Use member_type "local" for this machine or "remote" for a machine reachable over SSH. Choose the AI provider the member will use for prompts.', registerMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await registerMember(input as any) }] }));
  server.tool('list_members', 'List all fleet members and their current status. Use format="json" for structured data.', listMembersSchema.shape, async (input) => ({ content: [{ type: 'text', text: await listMembers(input as any) }] }));
  server.tool('remove_member', 'Remove a member from the fleet.', removeMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await removeMember(input as any) }] }));
  server.tool('update_member', "Change a member's name, connection details, working directory, AI provider, or other settings.", updateMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await updateMember(input as any) }] }));

  // --- File Operations ---
  server.tool('send_files', 'Transfer local files to a member. Always batch multiple files into a single call — never invoke repeatedly for individual files.', sendFilesSchema.shape, async (input) => ({ content: [{ type: 'text', text: await sendFiles(input as any) }] }));
  server.tool('receive_files', 'Download files from a member to a local directory. Always batch multiple files into a single call — never invoke repeatedly for individual files.', receiveFilesSchema.shape, async (input) => ({ content: [{ type: 'text', text: await receiveFiles(input as any) }] }));

  // --- Prompt Execution ---
  server.tool('execute_prompt', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run an AI prompt on a member. Supports session resume for multi-turn conversations.', executePromptSchema.shape, async (input) => ({ content: [{ type: 'text', text: await executePrompt(input as any) }] }));
  server.tool('execute_command', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run a shell command on a member. Use for quick tasks like installing packages, checking versions, or running scripts.', executeCommandSchema.shape, async (input) => ({ content: [{ type: 'text', text: await executeCommand(input as any) }] }));

  // --- Authentication & SSH ---
  server.tool('provision_auth', "Authenticate a fleet member so it can run prompts. Copies your current login session to the member, or deploys an API key if provided. Run this before execute_prompt if the member reports no authentication.", provisionAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await provisionAuth(input as any) }] }));
  server.tool('setup_ssh_key', 'Generate an SSH key pair and migrate a member from password to key-based authentication.', setupSSHKeySchema.shape, async (input) => ({ content: [{ type: 'text', text: await setupSSHKey(input as any) }] }));
  server.tool('setup_git_app', "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps.", setupGitAppSchema.shape, async (input) => ({ content: [{ type: 'text', text: await setupGitApp(input as any) }] }));
  server.tool('provision_vcs_auth', 'Set up git access credentials on a member. Supports GitHub, Bitbucket, and Azure DevOps. Tests connectivity after setup.', provisionVcsAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await provisionVcsAuth(input as any) }] }));
  server.tool('revoke_vcs_auth', 'Remove VCS credentials from a member. Specify the provider (github, bitbucket, or azure-devops) to revoke.', revokeVcsAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await revokeVcsAuth(input as any) }] }));

  // --- Status & Monitoring ---
  server.tool('fleet_status', 'Get status of all fleet members. Use json format for structured data.', fleetStatusSchema.shape, async (input) => ({ content: [{ type: 'text', text: await fleetStatus(input as any) }] }));
  server.tool('member_detail', 'Get detailed status for one member: connectivity, AI version, authentication, active session, resources, and git branch.', memberDetailSchema.shape, async (input) => ({ content: [{ type: 'text', text: await memberDetail(input as any) }] }));

  // --- Maintenance ---
  server.tool('update_llm_cli', "Update or install the AI provider CLI on members. Omit member to update all online members at once. Use install_if_missing to install on members that don't have it yet.", updateAgentCliSchema.shape, async (input) => ({ content: [{ type: 'text', text: await updateAgentCli(input as any) }] }));
  server.tool('shutdown_server', 'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.', shutdownServerSchema.shape, async () => ({ content: [{ type: 'text', text: await shutdownServer() }] }));

  // --- Permissions ---
  server.tool('compose_permissions', 'Set up and deliver the right permissions to a member for their role. Automatically tailors permissions to the project type. Use grant to add specific permissions mid-sprint without a full recompose.', composePermissionsSchema.shape, async (input) => ({ content: [{ type: 'text', text: await composePermissions(input as any) }] }));

  // --- Cloud Control ---
  server.tool('cloud_control', 'Manually start, stop, or check status of a cloud fleet member. Start waits until the member is ready; stop is immediate.', cloudControlSchema.shape, async (input) => ({ content: [{ type: 'text', text: await cloudControl(input as any) }] }));
  server.tool('monitor_task', 'Check status of a long-running background task on a cloud member. Optionally stop the cloud instance automatically when the task completes.', monitorTaskSchema.shape, async (input) => ({ content: [{ type: 'text', text: await monitorTask(input as any) }] }));
  server.tool('update_task_tokens', 'Add token usage to a task\'s running total on a member. Always accumulates — never overwrites.', updateTaskTokensSchema.shape, async (input) => ({ content: [{ type: 'text', text: await updateTaskTokens(input as any) }] }));

  // --- Start Server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  idleManager.start();

  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  process.on('SIGINT', () => { cleanupAuthSocket(); closeAllConnections(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupAuthSocket(); closeAllConnections(); process.exit(0); });
}
