#!/usr/bin/env node
import { initBlindfold } from '../config.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === '--version' || command === '-v') {
  console.log('blindfold 0.1.0');
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  console.error('Usage: blindfold [command]');
  console.error('');
  console.error('Commands:');
  console.error('  (none)    Start MCP server (stdio)');
  console.error('  secret    Manage secrets (--set, --list, --update, --delete)');
  console.error('  auth      Out-of-band authentication (--confirm)');
  console.error('  install   Register blindfold as an MCP server');
  console.error('  serve     Start MCP server (stdio) — alias for no command');
  console.error('');
  console.error('Options:');
  console.error('  --version  Show version');
  console.error('  --help     Show this help');
  process.exit(0);
}

// Initialize with defaults (can be overridden by env vars)
initBlindfold();

if (command === 'secret') {
  const { runSecret } = await import('./secret.js');
  await runSecret(args.slice(1));
} else if (command === 'auth') {
  const { runAuth } = await import('./auth.js');
  await runAuth(args.slice(1));
} else if (command === 'install') {
  const { runInstall } = await import('./install.js');
  await runInstall(args.slice(1));
} else if (command === 'serve' || !command) {
  const { startMcpServer } = await import('../mcp/server.js');
  await startMcpServer();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "blindfold --help" for usage.');
  process.exit(1);
}
