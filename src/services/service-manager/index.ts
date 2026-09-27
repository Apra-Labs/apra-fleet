import fs from 'node:fs';
import { SERVER_INFO_PATH } from '../../paths.js';
import type { RegisterOptions, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID } from './types.js';
import { isPidAlive, postShutdown } from '../../utils/process-utils.js';

export type { RegisterOptions, ServiceId, ServiceManager, ServiceStatus };

export async function gracefulStopByServerJson(fallbackKill?: (pid: number) => void): Promise<void> {
  let info: { pid?: number; url?: string };
  try {
    info = JSON.parse(fs.readFileSync(SERVER_INFO_PATH, 'utf8'));
  } catch {
    return;
  }
  const { pid, url } = info;
  if (!pid || !url) return;
  if (!isPidAlive(pid)) return;

  await postShutdown(url);

  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (isPidAlive(pid)) {
    if (fallbackKill) {
      fallbackKill(pid);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }

  try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
}

class NoopServiceManager implements ServiceManager {
  constructor(readonly serviceId: ServiceId = DEFAULT_SERVICE_ID) {}
  async register(_binaryPath: string, _args: string[], _logPath: string, _options?: RegisterOptions): Promise<void> {}
  async unregister(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async query(): Promise<ServiceStatus> { return { installed: false, running: false }; }
  async isInstalled(): Promise<boolean> { return false; }
}

/**
 * Platform service manager for one named service. `serviceId` defaults to the
 * apra-fleet MCP server, so every pre-existing `getServiceManager()` call site
 * keeps its exact previous behavior; pass 'fleet-supervisor' to manage the
 * fleet-sprint supervisor's own independent unit/plist/task.
 */
export async function getServiceManager(
  serviceId: ServiceId = DEFAULT_SERVICE_ID,
): Promise<ServiceManager> {
  switch (process.platform) {
    case 'win32': {
      const { WindowsServiceManager } = await import('./windows.js');
      return new WindowsServiceManager(serviceId);
    }
    case 'linux': {
      const { LinuxServiceManager } = await import('./linux.js');
      return new LinuxServiceManager(serviceId);
    }
    case 'darwin': {
      const { MacOSServiceManager } = await import('./macos.js');
      return new MacOSServiceManager(serviceId);
    }
    default: {
      console.warn(`apra-fleet: service management is not supported on platform '${process.platform}'. Using no-op stub.`);
      return new NoopServiceManager(serviceId);
    }
  }
}
