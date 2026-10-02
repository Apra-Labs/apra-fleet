import fs from 'node:fs';
import { SERVER_INFO_PATH } from '../../paths.js';
import type { ServiceManager, ServiceStatus } from './types.js';
import { isApraFleetProcess, isPidAlive, postShutdown } from '../../utils/process-utils.js';

export type { ServiceManager, ServiceStatus };

/**
 * Graceful stop via server.json: POST /shutdown, then force-kill a verified
 * apra-fleet pid. Resolves false when the server was left running because its
 * pid could not be verified as apra-fleet; true otherwise (stopped, or nothing
 * to stop).
 */
export async function gracefulStopByServerJson(fallbackKill?: (pid: number) => void): Promise<boolean> {
  let info: { pid?: number; url?: string };
  try {
    info = JSON.parse(fs.readFileSync(SERVER_INFO_PATH, 'utf8'));
  } catch {
    return true;
  }
  const { pid, url } = info;
  if (!pid || !url) return true;
  if (!isPidAlive(pid)) return true;

  await postShutdown(url);

  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (isPidAlive(pid)) {
    // GitHub #584 review: never force-kill a reused pid that is no longer an
    // apra-fleet server; leave server.json for the operator to inspect.
    if (isApraFleetProcess(pid) !== true) {
      console.error(`Server pid ${pid} did not exit after /shutdown and could not be verified as an apra-fleet process -- not force-killing it.`);
      return false;
    }
    if (fallbackKill) {
      fallbackKill(pid);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }

  try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
  return true;
}

class NoopServiceManager implements ServiceManager {
  async register(_binaryPath: string, _args: string[], _logPath: string): Promise<void> {}
  async unregister(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async query(): Promise<ServiceStatus> { return { installed: false, running: false }; }
  async isInstalled(): Promise<boolean> { return false; }
}

export async function getServiceManager(): Promise<ServiceManager> {
  switch (process.platform) {
    case 'win32': {
      const { WindowsServiceManager } = await import('./windows.js');
      return new WindowsServiceManager();
    }
    case 'linux': {
      const { LinuxServiceManager } = await import('./linux.js');
      return new LinuxServiceManager();
    }
    case 'darwin': {
      const { MacOSServiceManager } = await import('./macos.js');
      return new MacOSServiceManager();
    }
    default: {
      console.warn(`apra-fleet: service management is not supported on platform '${process.platform}'. Using no-op stub.`);
      return new NoopServiceManager();
    }
  }
}
