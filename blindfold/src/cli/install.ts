import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface McpConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

function getClaudeConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json');
}

function getClaudeCodeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function registerMcpServer(configPath: string, label: string): boolean {
  let config: any = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // Start with empty config
  }

  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers.blindfold) {
    console.error(`  ${label}: already registered`);
    return false;
  }

  config.mcpServers.blindfold = {
    command: 'blindfold',
    args: ['serve'],
  };

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.error(`  ${label}: registered ✓`);
  return true;
}

export async function runInstall(args: string[]): Promise<void> {
  const forTarget = args.indexOf('--for');
  const target = forTarget !== -1 ? args[forTarget + 1] : 'all';

  console.error('Registering blindfold as MCP server...\n');

  if (target === 'claude' || target === 'all') {
    registerMcpServer(getClaudeConfigPath(), 'Claude Desktop');
    registerMcpServer(getClaudeCodeSettingsPath(), 'Claude Code');
  }

  console.error('\nDone. Restart your AI client to load blindfold.');
}
