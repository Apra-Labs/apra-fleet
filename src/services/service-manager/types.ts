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

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  enabled?: boolean;
}

/** 'reused': the platform kept an existing registration it could not recreate (Windows). */
export type RegisterResult = 'created' | 'reused';

export interface ServiceManager {
  register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult | void>;
  unregister(): Promise<void>;
  start(): Promise<void>;
  /** Resolves false when the server was left running (pid not verifiable as apra-fleet). */
  stop(): Promise<boolean | void>;
  query(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
