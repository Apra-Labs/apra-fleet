#!/usr/bin/env node

import fs from 'node:fs';
import { serverVersion } from './version.js';
import { getDeliveryInfo } from './delivery-mode.js';
import { logLine, logError } from './utils/log-helpers.js';

// --- CLI dispatch (before MCP server imports to keep --version fast) ---
const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  const info = getDeliveryInfo();
  console.log(`apra-fleet ${serverVersion}`);
  console.log(`  Mode:   ${info.mode}${info.mode !== 'sea' ? ' (node ' + info.nodeVersion + ')' : ''}`);
  console.log(`  Binary: ${info.binary}`);
  process.exit(0);
}

if (arg === '--help' || arg === '-h') {
  console.log(`apra-fleet ${serverVersion}

Usage:
  apra-fleet                  Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet run              Start MCP server (HTTP, default) -- used by LLM providers after install
  apra-fleet run --transport stdio   Start MCP server (stdio)
  apra-fleet --stdio          Alias for run --transport stdio (backward compat for existing MCP configs)
  apra-fleet start            Start the fleet server service
  apra-fleet stop             Stop the fleet server service
  apra-fleet restart          Restart the fleet server service
  apra-fleet status           Show server and service status
  apra-fleet update           Check for and install latest update
  apra-fleet update --check   Check for update
  apra-fleet watch            Stream live member logs (see 'watch --help')
  apra-fleet workflow <name> [args...]  Run an installed workflow (see 'workflow --help')
  apra-fleet workflow --list            List installed workflows
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet -- PM depends on fleet)
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
  apra-fleet join <member-jwt> [--hub-url <url>]  Activate a device using a member JWT obtained out-of-band from fleet-dashboard (apra-fleet-6bf)
  apra-fleet spoke <origin-member-id>        Run as an outbound hub-connected spoke (apra-fleet-jfn); requires apra-fleet join first
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
} else if (arg === 'join') {
  import('./cli/join.js')
    .then(m => m.runJoin(process.argv.slice(3)))
    .catch(err => { logError('cli', `Join failed: ${err.message}`); process.exit(1); });
} else if (arg === 'spoke') {
  import('./cli/spoke.js')
    .then(m => m.runSpokeCli(process.argv.slice(3)))
    .catch(err => { logError('cli', `Spoke failed: ${err.message}`); process.exit(1); });
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
} else if (arg === 'watch') {
  import('./cli/watch.js')
    .then(m => m.runWatch(process.argv.slice(3)))
    .catch(err => { logError('cli', `Watch failed: ${err.message}`); process.exit(1); });
} else if (arg === 'workflow') {
  // Import trampoline for ~/.apra-fleet/workflows/<name>. Everything after <name>
  // is passed to the workflow verbatim -- the launcher never re-parses it.
  import('./cli/workflow.js')
    .then(m => m.runWorkflow(process.argv.slice(3)))
    .then(code => { if (code !== 0) process.exit(code); })
    .catch(err => { logError('cli', `Workflow failed: ${err.message}`); process.exit(1); });
} else if (arg === 'run' || arg === '--stdio' || arg === '--transport') {
  // Start MCP server -- invoked by LLM providers via their MCP config, or manually.
  // 'run' takes optional --transport http|stdio (default http); bare --stdio /
  // --transport are kept for backward compat with existing MCP configs.
  const flagArgs = arg === 'run' ? process.argv.slice(3) : process.argv.slice(2);
  const transport = resolveTransport(flagArgs);
  if (transport === 'invalid') {
    console.error(`Error: invalid --transport value. Use 'http' or 'stdio'.`);
    process.exit(1);
  }
  if (transport === 'stdio') {
    startStdioServer();
  } else {
    startHttpServer();
  }
} else if (arg === 'start') {
  import('./cli/start.js')
    .then(m => m.runStart(process.argv.slice(3)))
    .catch(err => { logError('cli', `Start failed: ${err.message}`); process.exit(1); });
} else if (arg === 'stop') {
  import('./cli/stop.js')
    .then(m => m.runStop(process.argv.slice(3)))
    .catch(err => { logError('cli', `Stop failed: ${err.message}`); process.exit(1); });
} else if (arg === 'restart') {
  import('./cli/restart.js')
    .then(m => m.runRestart(process.argv.slice(3)))
    .catch(err => { logError('cli', `Restart failed: ${err.message}`); process.exit(1); });
} else if (arg === 'status') {
  import('./cli/status.js')
    .then(m => m.runStatus(process.argv.slice(3)))
    .catch(err => { logError('cli', `Status failed: ${err.message}`); process.exit(1); });
} else if (arg === undefined || arg === '--llm' || arg?.startsWith('--llm=')
        || arg === '--skill' || arg?.startsWith('--skill=')
        || arg === '--no-skill' || arg === '--force') {
  // Install flags forwarded directly so `apra-fleet --llm opencode` works as a short
  // form of `apra-fleet install --llm opencode`. Use slice(2) -- no 'install' to skip.
  //
  // Default (no flags) only runs the installer for the SEA binary, where double-clicking
  // is the expected install UX. In npm/dev mode, no-args defaults to starting the MCP
  // server (old behavior) -- install.cjs owns the npm install path.
  import('./cli/install.js').then(({ isSea }) => {
    if (arg === undefined && !isSea()) {
      startHttpServer();
    } else {
      import('./cli/install.js')
        .then(m => m.runInstall(process.argv.slice(2)))
        .catch(err => { logError('cli', `Install failed: ${err.message}`); process.exit(1); });
    }
  });
} else {
  console.error(`Error: unknown option '${arg}'`);
  console.error(`\nRun 'apra-fleet --help' for usage.`);
  process.exit(1);
}

function resolveTransport(args: string[]): 'http' | 'stdio' | 'invalid' {
  if (args.length === 0) return 'http';
  if (args[0] === '--stdio') return 'stdio';
  if (args[0] === '--transport') {
    const val = args[1];
    if (val === 'http') return 'http';
    if (val === 'stdio') return 'stdio';
    return 'invalid';
  }
  return 'invalid';
}

async function startStdioServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  // Load onboarding state once at server startup (in-memory singleton)
  const { loadOnboardingState, resetSessionFlags } = await import('./services/onboarding.js');
  const { VERBATIM_INSTRUCTIONS } = await import('./onboarding/text.js');
  const { getAllAgents: getAgentsForStartup } = await import('./services/registry.js');
  // Pass current member count so upgrade detection works: existing registry + no onboarding.json -> skip banner
  loadOnboardingState(getAgentsForStartup().length);
  resetSessionFlags();

  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');
  const { cleanupStaleTasks } = await import('./services/task-cleanup.js');
  const { checkForUpdate } = await import('./services/update-check.js');
  const { purgeExpiredCredentials } = await import('./services/credential-store.js');
  const { getStallDetector } = await import('./services/stall/index.js');

  // serverVersion is "v0.0.1_abc123" -- strip 'v' prefix for semver-like version field
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
  logLine('startup', `apra-fleet ${serverVersion} started transport=stdio${clientStr}${versionStr}${pidStr} FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  process.on('SIGINT', () => { cleanupAuthSocket().then(() => { closeAllConnections(); stallDetector.stop(); process.exit(0); }); });
  process.on('SIGTERM', () => { cleanupAuthSocket().then(() => { closeAllConnections(); stallDetector.stop(); process.exit(0); }); });
}

async function startHttpServer() {
  const { loadOnboardingState, resetSessionFlags } = await import('./services/onboarding.js');
  const { getAllAgents: getAgentsForStartup } = await import('./services/registry.js');
  // Pass current member count so upgrade detection works: existing registry + no onboarding.json -> skip banner
  loadOnboardingState(getAgentsForStartup().length);
  resetSessionFlags();

  const { checkRunningInstance, claimStartupLock } = await import('./services/singleton.js');
  const { createHttpTransport } = await import('./services/http-transport.js');
  const { registerAllTools } = await import('./services/tool-registry.js');
  const { FLEET_DIR, SERVER_INFO_PATH } = await import('./paths.js');
  const { closeAllConnections } = await import('./services/ssh.js');
  const { idleManager } = await import('./services/cloud/idle-manager.js');
  const { cleanupStaleTasks } = await import('./services/task-cleanup.js');
  const { checkForUpdate } = await import('./services/update-check.js');
  const { purgeExpiredCredentials } = await import('./services/credential-store.js');
  const { getStallDetector } = await import('./services/stall/index.js');
  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  const { setHttpHandle } = await import('./tools/shutdown-server.js');

  // Detect already-running instance before starting
  const instance = await checkRunningInstance();
  if (instance.running) {
    logLine('startup', `apra-fleet already running at ${instance.url} pid=${instance.pid} -- exiting`);
    process.exit(0);
  }

  // Atomic startup lock to prevent concurrent double-start race
  const lock = claimStartupLock();
  if (!lock.acquired) {
    logLine('startup', 'Another fleet instance is starting up -- exiting');
    process.exit(0);
  }

  const handle = await createHttpTransport({ registerTools: registerAllTools });

  // Write server.json so other processes can detect this instance
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  fs.writeFileSync(
    SERVER_INFO_PATH,
    JSON.stringify({
      pid: process.pid,
      port: handle.port,
      url: handle.url,
      version: serverVersion,
      startedAt: new Date().toISOString(),
    }),
  );

  // Release startup lock now that server.json is written (server.json is the long-lived detection mechanism)
  lock.release();

  // Make HTTP handle available to shutdown_server tool
  setHttpHandle(handle);

  const stallDetector = getStallDetector();
  stallDetector.start();

  logLine('startup', `apra-fleet ${serverVersion} started transport=http port=${handle.port} pid=${process.pid} FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  async function shutdown() {
    try { lock.release(); } catch {}
    try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
    try { await handle.close(); } catch {}
    try { await cleanupAuthSocket(); } catch {}
    try { closeAllConnections(); } catch {}
    try { stallDetector.stop(); } catch {}
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
