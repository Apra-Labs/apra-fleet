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
  apra-fleet --version        Print version
  apra-fleet --help           Show this help`);
  process.exit(0);
}

if (arg === 'install') {
  // Dynamic import so MCP deps aren't loaded for install
  import('./cli/install.js')
    .then(m => m.runInstall(process.argv.slice(3)))
    .catch(err => { console.error('Install failed:', err.message); process.exit(1); });
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
  const { executePromptSchema, executePrompt } = await import('./tools/execute-prompt.js');
  const { executeCommandSchema, executeCommand } = await import('./tools/execute-command.js');
  const { resetSessionSchema, resetSession } = await import('./tools/reset-session.js');
  const { provisionAuthSchema, provisionAuth } = await import('./tools/provision-auth.js');
  const { setupSSHKeySchema, setupSSHKey } = await import('./tools/setup-ssh-key.js');
  const { setupGitAppSchema, setupGitApp } = await import('./tools/setup-git-app.js');
  const { provisionVcsAuthSchema, provisionVcsAuth } = await import('./tools/provision-vcs-auth.js');
  const { revokeVcsAuthSchema, revokeVcsAuth } = await import('./tools/revoke-vcs-auth.js');
  const { fleetStatusSchema, fleetStatus } = await import('./tools/check-status.js');
  const { memberDetailSchema, memberDetail } = await import('./tools/member-detail.js');
  const { updateClaudeSchema, updateClaude } = await import('./tools/update-claude.js');
  const { shutdownServerSchema, shutdownServer } = await import('./tools/shutdown-server.js');
  const { composePermissionsSchema, composePermissions } = await import('./tools/compose-permissions.js');
  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');

  // serverVersion is "v0.0.1_abc123" — strip 'v' prefix for semver-like version field
  const versionNum = serverVersion.startsWith('v') ? serverVersion.slice(1) : serverVersion;

  const server = new McpServer({
    name: `apra-fleet ${serverVersion}`,
    version: versionNum,
  });

  // --- Core Member Management ---
  server.tool('register_member', 'Register a machine as a fleet member (worker). Use member_type "local" for same-machine members (no SSH needed) or "remote" (default) for SSH-based remote members. Tests connectivity, detects OS, checks Claude CLI.', registerMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await registerMember(input as any) }] }));
  server.tool('list_members', 'List all registered fleet members. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.', listMembersSchema.shape, async (input) => ({ content: [{ type: 'text', text: await listMembers(input as any) }] }));
  server.tool('remove_member', 'Unregister a fleet member by its ID.', removeMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await removeMember(input as any) }] }));
  server.tool('update_member', "Update a member's registration (rename, change host, folder, auth, etc.).", updateMemberSchema.shape, async (input) => ({ content: [{ type: 'text', text: await updateMember(input as any) }] }));

  // --- File Operations ---
  server.tool('send_files', "Upload local files to a remote member (worker) via SFTP. Files are placed in the member's remote folder.", sendFilesSchema.shape, async (input) => ({ content: [{ type: 'text', text: await sendFiles(input as any) }] }));

  // --- Prompt Execution ---
  server.tool('execute_prompt', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run a Claude prompt on a remote member. Supports session resume for conversational context.', executePromptSchema.shape, async (input) => ({ content: [{ type: 'text', text: await executePrompt(input as any) }] }));
  server.tool('execute_command', 'IMP: Never call this tool directly. Always wrap in a background subagent: Agent(run_in_background=true). Run a shell command directly on a member without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.', executeCommandSchema.shape, async (input) => ({ content: [{ type: 'text', text: await executeCommand(input as any) }] }));

  // --- Session Management ---
  server.tool('reset_session', 'Clear stored session ID so the next prompt starts a fresh Claude session. Omit member_id to reset all members.', resetSessionSchema.shape, async (input) => ({ content: [{ type: 'text', text: await resetSession(input as any) }] }));

  // --- Authentication & SSH ---
  server.tool('provision_auth', "Authenticate a fleet member (worker). Default: copies this machine's OAuth credentials to the member. Override: pass api_key to deploy an Anthropic API key instead.", provisionAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await provisionAuth(input as any) }] }));
  server.tool('setup_ssh_key', 'Generate an SSH key pair and migrate a member from password to key-based authentication.', setupSSHKeySchema.shape, async (input) => ({ content: [{ type: 'text', text: await setupSSHKey(input as any) }] }));
  server.tool('setup_git_app', "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps.", setupGitAppSchema.shape, async (input) => ({ content: [{ type: 'text', text: await setupGitApp(input as any) }] }));
  server.tool('provision_vcs_auth', 'Deploy VCS credentials to a member (worker). Supports GitHub (App or PAT), Bitbucket (API token), and Azure DevOps (PAT). Configures git credential helper and tests connectivity.', provisionVcsAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await provisionVcsAuth(input as any) }] }));
  server.tool('revoke_vcs_auth', 'Remove VCS credentials from a member. Specify the provider (github, bitbucket, or azure-devops) to revoke.', revokeVcsAuthSchema.shape, async (input) => ({ content: [{ type: 'text', text: await revokeVcsAuth(input as any) }] }));

  // --- Status & Monitoring ---
  server.tool('fleet_status', 'Get fleet member (worker) status. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.', fleetStatusSchema.shape, async (input) => ({ content: [{ type: 'text', text: await fleetStatus(input as any) }] }));
  server.tool('member_detail', 'Deep-dive status for one member. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.', memberDetailSchema.shape, async (input) => ({ content: [{ type: 'text', text: await memberDetail(input as any) }] }));

  // --- Maintenance ---
  server.tool('update_claude', "Update or install Claude Code CLI on members. Set install_if_missing=true to install on members that don't have it.", updateClaudeSchema.shape, async (input) => ({ content: [{ type: 'text', text: await updateClaude(input as any) }] }));
  server.tool('shutdown_server', 'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.', shutdownServerSchema.shape, async () => ({ content: [{ type: 'text', text: await shutdownServer() }] }));

  // --- Permissions ---
  server.tool('compose_permissions', 'Compose and deliver member permissions (.claude/settings.local.json). Detects project stack, merges base + stack profiles + project ledger. Use grant param for reactive mid-sprint permission additions.', composePermissionsSchema.shape, async (input) => ({ content: [{ type: 'text', text: await composePermissions(input as any) }] }));

  // --- Start Server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  idleManager.start();

  process.on('SIGINT', () => { closeAllConnections(); process.exit(0); });
  process.on('SIGTERM', () => { closeAllConnections(); process.exit(0); });
}
