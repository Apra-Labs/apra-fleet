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
  apra-fleet register-member --name <name> --path <folder> [options]  Register a fleet member from the shell (see 'register-member --help')
  apra-fleet remove-member --id <uuid> [--force]   Remove a member registration from this install (see 'remove-member --help')
  apra-fleet call --member <uuid> <tool> --args-file <path>   Call a tool as a member session (see 'call --help')
  apra-fleet call --member <uuid> --list-tools                List the member session's tools
  apra-fleet uninstall                 Remove binary, hooks, and MCP registration
  apra-fleet secret --set <name>       Deliver a secret to a waiting request
  apra-fleet secret --list             List secrets
  apra-fleet secret --delete <name>    Delete a secret
  apra-fleet secret --confirm <credential-name>               Confirm network egress for that credential (interactive)
  apra-fleet auth --oauth [--llm <provider>] <token>          Write OAuth token to provider credential file
  apra-fleet auth --oauth [--llm <provider>] secret.<name>    Resolve token from persistent credential store
  apra-fleet auth --oauth --member <name> secret.<name>       Provision a member's encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN directly (no credential file)
  apra-fleet auth --api-key [--llm <provider>] <token>        Set API key in shell profiles / system env
  apra-fleet auth --api-key [--llm <provider>] secret.<name>  Resolve API key from persistent credential store
  apra-fleet kb directives                             List pending + active user-directives
  apra-fleet kb approve-directive <id>                 Activate a pending directive proposal (human-only)
  apra-fleet kb reject-directive <id>                  Reject a proposal or retire an active directive
  apra-fleet kb add-directive "<text>" [--symbols a,b] Create an already-active directive (human-only)
  apra-fleet kb commit [--repo <path>] [--global]      Re-export + auto-commit the canonical bible (manual/recovery)
  apra-fleet join <member-jwt> [--hub-url <url>]  Activate a device using a member JWT obtained out-of-band from fleet-dashboard
  apra-fleet spoke <origin-member-id>        Run as an outbound hub-connected spoke; requires apra-fleet join first
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
} else if (arg === 'register-member') {
  import('./cli/register-member.js')
    .then(m => m.runRegisterMember(process.argv.slice(3)))
    .catch(err => { logError('cli', `Register-member failed: ${err.message}`); process.exit(1); });
} else if (arg === 'remove-member') {
  import('./cli/remove-member.js')
    .then(m => m.runRemoveMember(process.argv.slice(3)))
    .catch(err => { logError('cli', `Remove-member failed: ${err.message}`); process.exit(1); });
} else if (arg === 'call') {
  import('./cli/call.js')
    .then(m => m.runCallCli(process.argv.slice(3)))
    .catch(err => { logError('cli', `Call failed: ${err.message}`); process.exit(1); });
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
} else if (arg === 'kb-server') {
  import('./commands/kb-server.js')
    .then(async m => {
      const opts = m.parseKbServerArgs(process.argv.slice(3));
      await m.startKbServer(opts.port, opts.generateToken, opts.dbPath);
    })
    .catch(err => { logError('cli', `kb-server failed: ${err.message}`); process.exit(1); });
} else if (arg === 'kb') {
  const subCmd = process.argv[3];
  if (subCmd === 'invalidate') {
    const files = process.argv.slice(4);
    if (files.length === 0) {
      console.error('Usage: apra-fleet kb invalidate <file1> [file2 ...]');
      process.exit(1);
    }
    import('./services/knowledge/kb-providers.js')
      .then(async m => {
        const providers = await m.getKbProviders();
        const result = await providers.project.invalidate(files);
        console.log(`Invalidated ${result.invalidated} entries.`);
        process.exit(0);
      })
      .catch(err => { logError('cli', `kb invalidate failed: ${err.message}`); process.exit(1); });
  } else if (subCmd === 'directives' || subCmd === 'approve-directive' || subCmd === 'reject-directive' || subCmd === 'add-directive') {
    // F1 (D1): human-terminal directive activation surface -- the only
    // unforgeable channel for turning a pending proposal into an active
    // directive. Never exposed over MCP.
    import('./cli/kb-directives.js')
      .then(m => m.runKbDirectives(subCmd, process.argv.slice(4)))
      .then(code => process.exit(code))
      .catch(err => { logError('cli', `kb ${subCmd} failed: ${err.message}`); process.exit(1); });
  } else if (subCmd === 'commit') {
    // T3.7b: manual/recovery re-export + commit -- the command the amended-D5
    // fleet_status bible-drift anomaly message tells operators to run.
    // kb_export owns all commit/no-commit decisions; this is a thin wrapper.
    import('./cli/kb-commit.js')
      .then(m => m.runKbCommit(process.argv.slice(4)))
      .then(code => process.exit(code))
      .catch(err => { logError('cli', `kb commit failed: ${err.message}`); process.exit(1); });
  } else if (subCmd === 'import') {
    // T2.2 (F4, D3): post-merge entry point for absorbing a merged bible into
    // the local KB. Thin wrapper over the same kbImport the MCP tool uses.
    import('./cli/kb-import.js')
      .then(m => m.runKbImport(process.argv.slice(4)))
      .then(code => process.exit(code))
      .catch(err => { logError('cli', `kb import failed: ${err.message}`); process.exit(1); });
  } else {
    console.error(`Error: unknown kb subcommand '${subCmd}'`);
    process.exit(1);
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

/**
 * Exit code for "refusing to start because another/foreign server holds the
 * port or data dir" (GitHub #584). Under a service manager (systemd
 * Restart=on-failure, launchd KeepAlive SuccessfulExit=false) a non-zero exit
 * restarts the server every few seconds -- each attempt a new fleet-<pid>.log
 * that `apra-fleet watch` then follows -- while the cause persists. Only a
 * launch by such a service manager (launchedByServiceManager: the
 * APRA_FLEET_SERVICE marker, systemd INVOCATION_ID, launchd XPC_SERVICE_NAME)
 * exits 0, like the already-running case. Every other launch (terminal, CI,
 * nohup, containers, scripts) exits 1 so the refusal stays visible.
 */
// Captured once by startHttpServer (which also strips our markers from the
// env so children never inherit them). Still "any service-manager hint":
// installs predating the APRA_FLEET_SERVICE marker rely on systemd/launchd
// vars, and for a refusal the only cost of a false positive (a hand-run shell
// under systemd) is exit code 0 instead of 1 -- the refusal is still printed.
let serviceManagedLaunch: boolean | null = null;

async function refusalExitCode(): Promise<number> {
  if (serviceManagedLaunch === null) {
    const { launchedByServiceManager } = await import('./services/service-manager/types.js');
    serviceManagedLaunch = launchedByServiceManager();
  }
  return serviceManagedLaunch ? 0 : 1;
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

  // SF-18: the member home-dir cache is per-process, so members registered in
  // an earlier process start cold. Warm them once here (fire-and-forget; see
  // warmMemberHomeDirs) so path resolution uses probed ground truth instead of
  // the username-convention guess.
  {
    const { warmMemberHomeDirs } = await import('./services/member-home.js');
    const { getAllAgents } = await import('./services/registry.js');
    warmMemberHomeDirs(getAllAgents());
  }

  const clientStr = capturedClientInfo?.name ? ` client=${capturedClientInfo.name}` : '';
  const versionStr = capturedClientInfo?.version ? ` version=${capturedClientInfo.version}` : '';
  const pidStr = ` pid=${process.pid} ppid=${process.ppid}`;
  logLine('startup', `apra-fleet ${serverVersion} started transport=stdio${clientStr}${versionStr}${pidStr} FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  // GitHub #562: leave a trace when the event loop freezes.
  const { startEventLoopWatchdog } = await import('./services/event-loop-watchdog.js');
  const { getActiveLogFile } = await import('./utils/log-helpers.js');
  const watchdog = startEventLoopWatchdog({ logFile: getActiveLogFile() });

  const { cleanupAuthSocket } = await import('./services/auth-socket.js');
  // GitHub #585: every exit path (SIGINT/SIGTERM/SIGHUP/SIGBREAK, crashes)
  // writes one synchronous shutdown record before the process exits.
  const { installShutdownHandlers } = await import('./services/server-lifecycle.js');
  let stdioStopping = false;
  installShutdownHandlers(() => {
    if (stdioStopping) return;
    stdioStopping = true;
    void watchdog.stop();
    cleanupAuthSocket().then(() => { closeAllConnections(); stallDetector.stop(); process.exit(0); });
  });
}

async function startHttpServer() {
  // GitHub #585 recovery: a service launch (logon, the Windows task's repeating
  // revive trigger) that keeps failing backs off instead of retrying -- and
  // writing a new fleet-<pid>.log -- every interval. See service-start-guard.ts.
  const { consumeLaunchMarkers } = await import('./services/service-manager/types.js');
  const launch = consumeLaunchMarkers();
  serviceManagedLaunch = launch.managed;
  // The stopped-by-user skip and the start backoff decide whether to start at
  // all, so they apply ONLY to our own service templates (APRA_FLEET_SERVICE=1,
  // set by the task wrapper, the plist and the unit) -- never to a hand-run
  // `apra-fleet run` in a shell that merely inherited INVOCATION_ID or
  // XPC_SERVICE_NAME (systemd-run --shell, tmux from a user unit, CI runners).
  const startGuard = launch.service ? await import('./services/service-start-guard.js') : null;
  if (startGuard) {
    // A deliberate `apra-fleet stop` must stick across logon/boot on every OS:
    // launchd RunAtLoad, an enabled systemd unit, the Windows HKCU Run
    // fallback, or an old task that could not be disabled all launch us here.
    // Exit 0 (launchd SuccessfulExit=false / systemd Restart=on-failure do not
    // restart it) and KEEP the marker -- only `apra-fleet start`/install clear it.
    const { readStoppedMarker, describeStoppedMarker } = await import('./services/stopped-marker.js');
    const stopped = readStoppedMarker();
    if (stopped) {
      const line = `${new Date().toISOString()} apra-fleet service launch skipped: ${describeStoppedMarker(stopped)}`;
      // Someone is watching (a console, or stderr on a mintty/Git Bash tty
      // while stdout is piped): always say why.
      if (process.stdout.isTTY || process.stderr.isTTY) console.error(line);
      else if (startGuard.shouldLogServiceNotice('stopped-by-user')) console.log(line);
      process.exit(0);
    }
    const skip = startGuard.serviceStartBackoff();
    if (skip) {
      console.log(`${new Date().toISOString()} ${skip}`);
      process.exit(0);
    }
    startGuard.recordServiceStartAttempt();
  }

  const { loadOnboardingState, resetSessionFlags } = await import('./services/onboarding.js');
  const { getAllAgents: getAgentsForStartup } = await import('./services/registry.js');
  // Pass current member count so upgrade detection works: existing registry + no onboarding.json -> skip banner
  loadOnboardingState(getAgentsForStartup().length);
  resetSessionFlags();

  const {
    checkRunningInstance, claimStartupLock, unresponsiveInstanceMessage, portInUseMessage, readServerInfoPid,
    describePreviousServer,
  } = await import('./services/singleton.js');
  const { createHttpTransport, PortInUseError } = await import('./services/http-transport.js');
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
    const msg = `apra-fleet already running at ${instance.url} pid=${instance.pid} -- exiting`;
    if (startGuard) {
      // Service launches (a revive-trigger tick) go to the service log only,
      // not a fresh fleet-<pid>.log per tick, and at most once an hour (a
      // server running outside the task would otherwise log ~288 lines/day).
      if (startGuard.shouldLogServiceNotice('already-running')) {
        console.log(`${new Date().toISOString()} ${msg}`);
      }
      startGuard.clearServiceStartFailures();
    } else {
      logLine('startup', msg);
    }
    process.exit(0);
  }
  if (instance.state === 'gone') {
    const previousNote = describePreviousServer(instance.previous);
    if (previousNote) logLine('startup', `${previousNote}; removed its stale server.json`);
  }
  if (instance.state === 'unresponsive') {
    // A live server with a blocked event loop is not dead: starting a second
    // one would split the fleet (GitHub #584). Refuse; the operator stops it.
    logError('startup', unresponsiveInstanceMessage(instance));
    process.exit(await refusalExitCode());
  }

  // Atomic startup lock to prevent concurrent double-start race
  const lock = claimStartupLock();
  if (!lock.acquired) {
    logLine('startup', 'Another fleet instance is starting up -- exiting');
    process.exit(0);
  }

  let handle: Awaited<ReturnType<typeof createHttpTransport>>;
  try {
    handle = await createHttpTransport({ registerTools: registerAllTools });
  } catch (err) {
    lock.release();
    if (err instanceof PortInUseError) {
      logError('startup', portInUseMessage(err.port, readServerInfoPid()));
      process.exit(await refusalExitCode());
    }
    throw err;
  }

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
  // The stopped-by-user marker is NOT cleared here: only an explicit
  // `apra-fleet start` / `apra-fleet install` ends a deliberate stop. (A
  // service launch never gets this far while it exists; a manual `run`
  // leaves it, so if this server later dies clients still do not
  // auto-start -- the conservative side.)
  startGuard?.clearServiceStartFailures();

  // Make HTTP handle available to shutdown_server tool
  setHttpHandle(handle);

  const stallDetector = getStallDetector();
  stallDetector.start();

  // SF-18: warm the per-process member home-dir cache (see warmMemberHomeDirs).
  {
    const { warmMemberHomeDirs } = await import('./services/member-home.js');
    warmMemberHomeDirs(getAgentsForStartup());
  }

  logLine('startup', `apra-fleet ${serverVersion} started transport=http port=${handle.port} pid=${process.pid} FLEET_DIR=${FLEET_DIR}`);

  idleManager.start();
  void cleanupStaleTasks();
  purgeExpiredCredentials();
  void checkForUpdate();

  // GitHub #562: leave a trace when the event loop freezes.
  const { startEventLoopWatchdog } = await import('./services/event-loop-watchdog.js');
  const { getActiveLogFile } = await import('./utils/log-helpers.js');
  const watchdog = startEventLoopWatchdog({ logFile: getActiveLogFile() });

  async function shutdown() {
    try { lock.release(); } catch {}
    try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
    try { await watchdog.stop(); } catch {}
    try { await handle.close(); } catch {}
    try { await cleanupAuthSocket(); } catch {}
    try { closeAllConnections(); } catch {}
    try { stallDetector.stop(); } catch {}
    process.exit(0);
  }

  // GitHub #585: every exit path (SIGINT/SIGTERM/SIGHUP/SIGBREAK, POST
  // /shutdown, shutdown_server, crashes) writes one synchronous shutdown
  // record to fleet-<pid>.log before the process exits.
  const { installShutdownHandlers } = await import('./services/server-lifecycle.js');
  let stopping = false;
  installShutdownHandlers(() => {
    if (stopping) return;
    stopping = true;
    void shutdown();
  });
}
