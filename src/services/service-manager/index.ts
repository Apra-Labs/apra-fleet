import fs from 'node:fs';
import http from 'node:http';
import { SERVER_INFO_PATH } from '../../paths.js';
import type { ServiceManager, ServiceStatus } from './types.js';

export type { ServiceManager, ServiceStatus };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function postShutdown(url: string): Promise<void> {
  const shutdownUrl = url.replace('/mcp', '/shutdown');
  return new Promise((resolve) => {
    const req = http.request(shutdownUrl, { method: 'POST' }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.end();
  });
}

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
