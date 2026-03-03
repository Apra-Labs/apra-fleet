#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

// Append short git hash to version (e.g. 1.1.0.a1b2c3) — pure Node.js, no git binary needed
function getGitHash(): string | null {
  try {
    const repoRoot = join(__dirname, '..');
    const headPath = join(repoRoot, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(repoRoot, '.git', head.slice(5));
      if (!existsSync(refPath)) return null;
      return readFileSync(refPath, 'utf-8').trim().slice(0, 6);
    }
    // Detached HEAD — hash is directly in HEAD
    return head.slice(0, 6);
  } catch {
    return null;
  }
}

const gitHash = getGitHash();
const serverVersion = gitHash ? `${pkg.version}.${gitHash}` : pkg.version;

// Tool schemas and handlers
import { registerAgentSchema, registerAgent } from './tools/register-agent.js';
import { listAgentsSchema, listAgents } from './tools/list-agents.js';
import { removeAgentSchema, removeAgent } from './tools/remove-agent.js';
import { updateAgentSchema, updateAgent } from './tools/update-agent.js';
import { sendFilesSchema, sendFiles } from './tools/send-files.js';
import { executePromptSchema, executePrompt } from './tools/execute-prompt.js';
import { executeCommandSchema, executeCommand } from './tools/execute-command.js';
import { resetSessionSchema, resetSession } from './tools/reset-session.js';
import { provisionAuthSchema, provisionAuth } from './tools/provision-auth.js';
import { setupSSHKeySchema, setupSSHKey } from './tools/setup-ssh-key.js';
import { setupGitAppSchema, setupGitApp } from './tools/setup-git-app.js';
import { provisionGitAuthSchema, provisionGitAuth } from './tools/provision-git-auth.js';
import { fleetStatusSchema, fleetStatus } from './tools/check-status.js';
import { agentDetailSchema, agentDetail } from './tools/agent-detail.js';
import { updateClaudeSchema, updateClaude } from './tools/update-claude.js';
import { shutdownServerSchema, shutdownServer } from './tools/shutdown-server.js';

import { closeAllConnections } from './services/ssh.js';

const server = new McpServer({
  name: `claude-code-fleet v${serverVersion}`,
  version: serverVersion,
});

// --- Core Agent Management ---

server.tool(
  'register_agent',
  'Register a machine as a fleet agent. Use agent_type "local" for same-machine agents (no SSH needed) or "remote" (default) for SSH-based remote agents. Tests connectivity, detects OS, checks Claude CLI.',
  registerAgentSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await registerAgent(input as any) }],
  })
);

server.tool(
  'list_agents',
  'List all registered fleet agents. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.',
  listAgentsSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await listAgents(input as any) }],
  })
);

server.tool(
  'remove_agent',
  'Unregister a fleet agent by its ID.',
  removeAgentSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await removeAgent(input as any) }],
  })
);

server.tool(
  'update_agent',
  'Update an agent\'s registration (rename, change host, folder, auth, etc.).',
  updateAgentSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await updateAgent(input as any) }],
  })
);

// --- File Operations ---

server.tool(
  'send_files',
  'Upload local files to a remote agent via SFTP. Files are placed in the agent\'s remote folder.',
  sendFilesSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await sendFiles(input as any) }],
  })
);

// --- Prompt Execution ---

server.tool(
  'execute_prompt',
  'Run a Claude prompt on a remote agent. Supports session resume for conversational context.',
  executePromptSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await executePrompt(input as any) }],
  })
);

server.tool(
  'execute_command',
  'Run a shell command directly on an agent without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.',
  executeCommandSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await executeCommand(input as any) }],
  })
);

// --- Session Management ---

server.tool(
  'reset_session',
  'Clear stored session ID so the next prompt starts a fresh Claude session. Omit agent_id to reset all agents.',
  resetSessionSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await resetSession(input as any) }],
  })
);

// --- Authentication & SSH ---

server.tool(
  'provision_auth',
  'Authenticate a fleet agent. Default: copies this machine\'s OAuth credentials to the agent. Override: pass api_key to deploy an Anthropic API key instead.',
  provisionAuthSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await provisionAuth(input as any) }],
  })
);

server.tool(
  'setup_ssh_key',
  'Generate an SSH key pair and migrate an agent from password to key-based authentication.',
  setupSSHKeySchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await setupSSHKey(input as any) }],
  })
);

server.tool(
  'setup_git_app',
  'One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps.',
  setupGitAppSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await setupGitApp(input as any) }],
  })
);

server.tool(
  'provision_git_auth',
  'Mint a scoped, short-lived git token for an agent and deploy credentials. Requires setup_git_app to be configured first. Access level and repos can be set per-agent or overridden per call.',
  provisionGitAuthSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await provisionGitAuth(input as any) }],
  })
);

// --- Status & Monitoring ---

server.tool(
  'fleet_status',
  'Get fleet agent status. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.',
  fleetStatusSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await fleetStatus(input as any) }],
  })
);

server.tool(
  'agent_detail',
  'Deep-dive status for one agent. Default compact format fits in a few lines. Use format="json" when the user needs detailed data rendered as a markdown table.',
  agentDetailSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await agentDetail(input as any) }],
  })
);

// --- Maintenance ---

server.tool(
  'update_claude',
  'Update or install Claude Code CLI on agents. Set install_if_missing=true to install on agents that don\'t have it.',
  updateClaudeSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await updateClaude(input as any) }],
  })
);

server.tool(
  'shutdown_server',
  'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.',
  shutdownServerSchema.shape,
  async () => ({
    content: [{ type: 'text', text: await shutdownServer() }],
  })
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => {
    closeAllConnections();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeAllConnections();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
