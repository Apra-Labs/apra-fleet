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
  /** Multi-line action the user should take (printed under the Service line by apra-fleet status). */
  notice?: string;
}

/**
 * 'reused': the platform kept an existing registration it could not recreate (Windows).
 * 'run-key': last-resort Windows fallback -- a per-user HKCU Run entry (logon
 * autostart only, nothing restarts a server that dies mid-session).
 */
export type RegisterResult = 'created' | 'reused' | 'run-key';

/**
 * Why a stop is happening. 'install' = install --force is stopping the service
 * and owns all operator guidance (it clears the stopped marker and prints the
 * legacy-task guidance once itself); default = a user-facing apra-fleet stop.
 */
export interface StopOptions {
  reason?: 'install';
}

export interface ServiceManager {
  register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult | void>;
  unregister(): Promise<void>;
  start(): Promise<void>;
  /** Resolves false when the server was left running (pid not verifiable as apra-fleet). */
  stop(opts?: StopOptions): Promise<boolean | void>;
  query(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
  /**
   * Windows only: the legacy-task upgrade guidance when the installed task is a
   * legacy (e.g. elevated) one that install had to reuse, else null. Lets install
   * print it instead of a start hint that would hit the same refusal.
   */
  legacyGuidance?(): string | null;
  /** Windows only: true once register() already printed the legacy-task guidance in this process, so install must not print it again. */
  legacyGuidanceShown?(): boolean;
}
