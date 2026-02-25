#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

// Append short git hash to version (e.g. 1.1.0.a1b2c3)
let serverVersion = pkg.version;
try {
  const gitHash = execSync('git rev-parse --short=6 HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
  if (gitHash) serverVersion = `${pkg.version}.${gitHash}`;
} catch {
  // Not in a git repo or git not available — use plain version
}

// Tool schemas and handlers
import { registerAgentSchema, registerAgent } from './tools/register-agent.js';
import { listAgentsSchema, listAgents } from './tools/list-agents.js';
import { removeAgentSchema, removeAgent } from './tools/remove-agent.js';
import { updateAgentSchema, updateAgent } from './tools/update-agent.js';
import { sendFilesSchema, sendFiles } from './tools/send-files.js';
import { executePromptSchema, executePrompt } from './tools/execute-prompt.js';
import { resetSessionSchema, resetSession } from './tools/reset-session.js';
import { provisionAuthSchema, provisionAuth } from './tools/provision-auth.js';
import { setupSSHKeySchema, setupSSHKey } from './tools/setup-ssh-key.js';
import { fleetStatusSchema, fleetStatus } from './tools/check-status.js';
import { agentDetailSchema, agentDetail } from './tools/agent-detail.js';
import { updateClaudeSchema, updateClaude } from './tools/update-claude.js';

import { closeAllConnections } from './services/ssh.js';

const server = new McpServer({
  name: 'claude-code-fleet',
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
  'List all registered fleet agents with their details.',
  listAgentsSchema.shape,
  async () => ({
    content: [{ type: 'text', text: await listAgents() }],
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
  'Set CLAUDE_CODE_OAUTH_TOKEN on a remote agent for Claude authentication.',
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

// --- Status & Monitoring ---

server.tool(
  'fleet_status',
  'Get a summary table of all fleet agents: online/offline, busy/idle, session info.',
  fleetStatusSchema.shape,
  async () => ({
    content: [{ type: 'text', text: await fleetStatus() }],
  })
);

server.tool(
  'agent_detail',
  'Deep-dive status for one agent: connectivity, Claude CLI, session, and system resources.',
  agentDetailSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await agentDetail(input as any) }],
  })
);

// --- Maintenance ---

server.tool(
  'update_claude',
  'Update Claude Code CLI on one or all remote agents. Reports version changes.',
  updateClaudeSchema.shape,
  async (input) => ({
    content: [{ type: 'text', text: await updateClaude(input as any) }],
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
