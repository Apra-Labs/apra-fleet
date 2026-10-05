/**
 * Service identity for the OS-level service registrations this CLI manages.
 *
 * Historically there was exactly ONE registered service per platform (the
 * apra-fleet MCP server), so each platform implementation hardcoded a single
 * unit/plist/task name constant. Two long-running processes now need their own
 * auto-starting registration:
 *
 *   'mcp-server'       -- the apra-fleet MCP server (unchanged names/behavior).
 *   'fleet-supervisor' -- the fleet-sprint supervisor (bin/serve.mjs), which
 *                         serves the sprint dashboard/API and must survive a
 *                         reboot independently of the MCP server.
 *
 * Every platform manager is constructed with a ServiceId (defaulting to
 * 'mcp-server'), so existing call sites -- getServiceManager() with no
 * argument -- keep their exact previous behavior.
 */
export type ServiceId = 'mcp-server' | 'fleet-supervisor';

export const DEFAULT_SERVICE_ID: ServiceId = 'mcp-server';

export interface ServiceDescriptor {
  id: ServiceId;
  /** Human-readable label -- systemd Description=, status output, log text. */
  description: string;
  /** systemd --user unit file name, including the .service suffix. */
  linuxUnitName: string;
  /** launchd LaunchAgent label (plist file is "<label>.plist"). */
  macosPlistLabel: string;
  /** Windows Scheduled Task name. */
  windowsTaskName: string;
  /** Windows wrapper .bat file written into BIN_DIR for the task to run. */
  windowsWrapperFileName: string;
  /**
   * Supervisor restart policy. The MCP server is restarted on failure
   * (systemd Restart=on-failure / launchd KeepAlive.SuccessfulExit=false);
   * the fleet supervisor is deliberately Restart=no -- it is started at
   * boot/login and an exit is treated as intentional (matching the unit that
   * was manually verified on a real Linux box).
   */
  restartOnFailure: boolean;
  /**
   * Whether stop() should go through the MCP server's graceful
   * server.json/HTTP shutdown handshake. Only the MCP server writes
   * server.json, so any other service must be stopped through the platform
   * supervisor instead (systemctl stop / launchctl bootout on Unix; on
   * Windows a taskkill /F /T of the wrapper's process tree, because the
   * scheduled task's own process is only the wrapper -- see the mechanism
   * comment in windows.ts stop()).
   */
  gracefulStopViaServerJson: boolean;
}

export const SERVICE_DESCRIPTORS: Record<ServiceId, ServiceDescriptor> = {
  'mcp-server': {
    id: 'mcp-server',
    description: 'Apra Fleet MCP Server',
    linuxUnitName: 'apra-fleet.service',
    macosPlistLabel: 'com.apra-fleet.server',
    windowsTaskName: 'ApraFleet',
    windowsWrapperFileName: 'apra-fleet-service.bat',
    restartOnFailure: true,
    gracefulStopViaServerJson: true,
  },
  'fleet-supervisor': {
    id: 'fleet-supervisor',
    description: 'Apra Fleet Sprint Supervisor',
    linuxUnitName: 'fleet-supervisor.service',
    macosPlistLabel: 'com.apra-fleet.supervisor',
    windowsTaskName: 'ApraFleetSupervisor',
    windowsWrapperFileName: 'apra-fleet-supervisor-service.bat',
    restartOnFailure: false,
    gracefulStopViaServerJson: false,
  },
};

export function getServiceDescriptor(id: ServiceId = DEFAULT_SERVICE_ID): ServiceDescriptor {
  const descriptor = SERVICE_DESCRIPTORS[id];
  if (!descriptor) throw new Error(`Unknown service id "${id}"`);
  return descriptor;
}

// Back-compat single-service constants -- these are, and must stay, the
// MCP server's names (src/cli/install.ts prints them in operator hints).
export const WINDOWS_TASK_NAME = SERVICE_DESCRIPTORS['mcp-server'].windowsTaskName;
export const LINUX_UNIT_NAME = SERVICE_DESCRIPTORS['mcp-server'].linuxUnitName;
export const MACOS_PLIST_LABEL = SERVICE_DESCRIPTORS['mcp-server'].macosPlistLabel;

/** Env var the service definitions (systemd unit, launchd plist, Windows task
 *  wrapper) set so the server can tell it runs under a service manager. */
export const SERVICE_ENV_MARKER = 'APRA_FLEET_SERVICE';

/**
 * True when this process was launched by a service manager (GitHub #584
 * review): the explicit APRA_FLEET_SERVICE=1 marker (new installs), systemd's
 * INVOCATION_ID, or launchd's XPC_SERVICE_NAME for our own label (installs
 * predating the marker).
 */
export function launchedByServiceManager(env: Record<string, string | undefined> = process.env): boolean {
  return env[SERVICE_ENV_MARKER] === '1'
    || !!env.INVOCATION_ID
    || env.XPC_SERVICE_NAME === MACOS_PLIST_LABEL;
}

/** Env var set by a client auto-start on the `apra-fleet start` it spawns (cli/start.ts). */
export const AUTOSTART_ENV_MARKER = 'APRA_FLEET_AUTOSTART';

export interface LaunchMarkers {
  /** APRA_FLEET_SERVICE=1: launched by one of OUR service templates (task wrapper, plist, unit). */
  service: boolean;
  /** Any service-manager hint, including systemd/launchd vars that also leak to hand-run shells. */
  managed: boolean;
}

/**
 * Read the launch markers ONCE at server start and remove ours from the
 * environment, so nothing the server spawns (local agents, execute_command,
 * a later `apra-fleet start`) inherits APRA_FLEET_SERVICE / APRA_FLEET_AUTOSTART
 * and is mistaken for a service or auto-start launch. INVOCATION_ID and
 * XPC_SERVICE_NAME are not ours to remove.
 */
export function consumeLaunchMarkers(env: Record<string, string | undefined> = process.env): LaunchMarkers {
  const markers = { service: env[SERVICE_ENV_MARKER] === '1', managed: launchedByServiceManager(env) };
  delete env[SERVICE_ENV_MARKER];
  delete env[AUTOSTART_ENV_MARKER];
  return markers;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  enabled?: boolean;
  /** Extra human-readable state for apra-fleet status (e.g. why it is disabled). */
  detail?: string;
}

/**
 * 'reused': the platform kept an existing registration it could not recreate (Windows).
 * 'run-key': last-resort Windows fallback -- a per-user HKCU Run entry (logon
 * autostart only, nothing restarts a server that dies mid-session).
 */
export type RegisterResult = 'created' | 'reused' | 'run-key';

export interface RegisterOptions {
  /**
   * Directory the service process runs in (systemd WorkingDirectory=, launchd
   * WorkingDirectory, a `cd /d` in the Windows wrapper .bat). The MCP server
   * does not need one; the fleet supervisor resolves package-relative paths
   * from its own install directory and does.
   */
  workingDirectory?: string;
}

export interface ServiceManager {
  /** Which registered service this manager instance operates on. */
  readonly serviceId: ServiceId;
  register(binaryPath: string, args: string[], logPath: string, options?: RegisterOptions): Promise<RegisterResult | void>;
  unregister(): Promise<void>;
  start(): Promise<void>;
  /** Resolves false when the server was left running (pid not verifiable as apra-fleet). */
  stop(): Promise<boolean | void>;
  query(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
