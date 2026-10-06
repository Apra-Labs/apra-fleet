// Service name constants for each platform
export const WINDOWS_TASK_NAME = 'ApraFleet';
export const LINUX_UNIT_NAME = 'apra-fleet.service';
export const MACOS_PLIST_LABEL = 'com.apra-fleet.server';

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

export interface ServiceManager {
  register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult | void>;
  unregister(): Promise<void>;
  start(): Promise<void>;
  /** Resolves false when the server was left running (pid not verifiable as apra-fleet). */
  stop(): Promise<boolean | void>;
  query(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
