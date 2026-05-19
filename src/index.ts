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
  apra-fleet update           Check for and install latest update
  apra-fleet update --check   Check for update
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet — PM depends on fleet)
  apra-fleet install --skill none      Skip skill installation
  apra-fleet install --no-skill        Same as --skill none
  apra-fleet uninstall                 Remove binary, hooks, and MCP registration
  apra-fleet secret --set <name>       Deliver a secret to a waiting request
  apra-fleet secret --list             List secrets
  apra-fleet secret --delete <name>    Delete a secret
  apra-fleet secret --confirm <credential-name>               Confirm network egress for that credential (interactive)
  apra-fleet auth --oauth [--llm <provider>] <token>          Write OAuth token to provider credential file
  apra-fleet auth --oauth [--llm <provider>] secure.<name>    Resolve token from persistent credential store
  apra-fleet auth --api-key [--llm <provider>] <token>        Set API key in shell profiles / system env
  apra-fleet auth --api-key [--llm <provider>] secure.<name>  Resolve API key from persistent credential store
  apra-fleet --version        Print version
  apra-fleet --help           Show this help`);
  process.exit(0);
}

if (arg === 'install') {
  // Dynamic import so MCP deps aren't loaded for install
  import('./cli/install.js')
    .then(m => m.runInstall(process.argv.slice(3)))
    .catch(err => { logError('cli', `Install failed: ${err.message}`); process.exit(1); });
} else if (arg === 'secret') {
  import('./cli/secret.js')
    .then(m => m.runSecret(process.argv.slice(3)))
    .catch(err => { logError('cli', `Secret failed: ${err.message}`); process.exit(1); });
} else if (arg === 'uninstall') {
  import('./cli/uninstall.js')
    .then(m => m.runUninstall(process.argv.slice(3)))
    .catch(err => { logError('cli', `Uninstall failed: ${err.message}`); process.exit(1); });
} else if (arg === 'auth') {
  import('./cli/auth.js')
    .then(m => m.runAuth(process.argv.slice(3)))
    .catch(err => { logError('cli', `Auth failed: ${err.message}`); process.exit(1); });
} else if (arg === 'update') {
  const rest = process.argv.slice(3);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`apra-fleet update

Checks GitHub for the latest stable release and installs it.

Usage:
  apra-fleet update           Check for and install the latest release.
                              Stops and restarts the running server
                              (the installer is run with --force).
  apra-fleet update --check   Check for an update without installing.
  apra-fleet update --help    Show this help.`);
    process.exit(0);
  }
  if (rest.includes('--check')) {
    import('./services/update-check.js')
      .then(async m => {
        await m.checkForUpdate();
        const notice = m.getUpdateNotice();
        if (notice) console.log(notice);
        else console.log('apra-fleet is up to date.');
      })
      .catch(err => { logError('cli', `Update check failed: ${err.message}`); process.exit(1); });
  } else {
    import('./cli/update.js')
      .then(m => m.runUpdate())
      .catch(err => { logError('cli', `Update failed: ${err.message}`); process.exit(1); });
  }
} else if (arg === undefined || arg === '--stdio') {
  // Default: start MCP server
  startServer();
} else {
  console.error(`Error: unknown option '${arg}'`);
  console.error(`\nRun 'apra-fleet --help' for usage.`);
  process.exit(1);
}

async function startServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  // Load onboarding state once at server startup (in-memory singleton)
  const { loadOnboardingState, resetSessionFlags } = await import('./services/onboarding.js');
  const { VERBATIM_INSTRUCTIONS } = await import('./onboarding/text.js');
  const { getAllAgents: getAgentsForStartup } = await import('./services/registry.js');
  // Pass current member count so upgrade detection works: existing registry + no onboarding.json → skip banner
  loadOnboardingState(getAgentsForStartup().length);
  resetSessionFlags();

  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');
  const { cleanupStaleTasks } = await import('./services/task-cleanup.js');
  const { checkForUpdate } = await import('./services/update-check.js');
  const { purgeExpiredCredentials } = await import('./services/credential-store.js');
  const { getStallDetector } = await import('./services/stall/index.js');

  // serverVersion is "v0.0.1_abc123" — strip 'v' prefix for semver-like version field
  const versionNum = serverVersion.startsWith('v') ? serverVersion.slice(1) : serverVersion;

  let capturedClientInfo: any = null;

  const server = new McpServer(
    { name: `apra fleet server ${serverVersion}`, version: versionNum },
    {
      capabilities: { logging: {} },
      instructions: VERBATIM_INSTRUCTIONS,
    },
  );

  // Capture MCP clientInfo during initialize handshake for logging
  const originalInitialize = (server as any).initialize?.bind(server);
  if (originalInitialize) {
    (server as any).initialize = async function (request: any) {
      capturedClientInfo = request.clientInfo ?? null;
      return originalInitialize(request);
    };
  }

  // Register all tools
  const { registerAllTools } = await import('./services/tool-registry.js');
  await registerAllTools(server);

  // --- Start Server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const { FLEET_DIR } = await import('./paths.js');
  const stallDetector = getStallDetector();
  stallDetector.start();

  const clientStr = capturedClientInfo?.name ? ` client=${capturedClientInfo.name}` : '';
  const versionStr = capturedClientInfo?.version ? ` version=${capturedClientInfo.version}` : '';
  const pidStr = ` pid=${process.pid} ppid=${process.ppid}`;
  logLine('startup', `apra-fleet ${serverVersion} started${clientStr}${versionStr}${pidStr} FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  process.on('SIGINT', () => { cleanupAuthSocket().then(() => { closeAllConnections(); stallDetector.stop(); process.exit(0); }); });
  process.on('SIGTERM', () => { cleanupAuthSocket().then(() => { closeAllConnections(); stallDetector.stop(); process.exit(0); }); });
}
