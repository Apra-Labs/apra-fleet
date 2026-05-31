import fs from 'node:fs';
import { SERVER_INFO_PATH } from '../../paths.js';
import type { ServiceManager, ServiceStatus } from './types.js';
import { isPidAlive, postShutdown } from '../../utils/process-utils.js';
import { WindowsServiceManager } from './windows.js';
import { LinuxServiceManager } from './linux.js';
import { MacOSServiceManager } from './macos.js';

export type { ServiceManager, ServiceStatus };

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
  async register(_binaryPath: string, _args: string[], _logPath: string): Promise<void> {}
  async unregister(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async query(): Promise<ServiceStatus> { return { installed: false, running: false }; }
  async isInstalled(): Promise<boolean> { return false; }
}

export async function getServiceManager(): Promise<ServiceManager> {
  switch (process.platform) {
    case 'win32':
      return new WindowsServiceManager();
    case 'linux':
      return new LinuxServiceManager();
    case 'darwin':
      return new MacOSServiceManager();
    default:
      console.warn(`apra-fleet: service management is not supported on platform '${process.platform}'. Using no-op stub.`);
      return new NoopServiceManager();
  }
}
