// Service name constants for each platform
export const WINDOWS_TASK_NAME = 'ApraFleet';
export const LINUX_UNIT_NAME = 'apra-fleet.service';
export const MACOS_PLIST_LABEL = 'com.apra-fleet.server';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  enabled?: boolean;
  /** Windows-only: raw 'Last Run Time' from 'schtasks /query /fo list /v'. */
  lastRunTime?: string;
  /** Windows-only: raw 'Last Result' from 'schtasks /query /fo list /v'. */
  lastResult?: string;
  /** Windows-only: true when the task is registered but has never fired. */
  registeredButNeverFired?: boolean;
}

export interface ServiceManager {
  register(binaryPath: string, args: string[], logPath: string): Promise<void>;
  unregister(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  query(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
