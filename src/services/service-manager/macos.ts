import type { ServiceManager, ServiceStatus } from './types.js';
import { MACOS_PLIST_LABEL } from './types.js';

export class MacOSServiceManager implements ServiceManager {
  async register(_binaryPath: string, _args: string[], _logPath: string): Promise<void> {
    throw new Error(`MacOSServiceManager.register: not yet implemented (label: ${MACOS_PLIST_LABEL})`);
  }
  async unregister(): Promise<void> {
    throw new Error('MacOSServiceManager.unregister: not yet implemented');
  }
  async start(): Promise<void> {
    throw new Error('MacOSServiceManager.start: not yet implemented');
  }
  async stop(): Promise<void> {
    throw new Error('MacOSServiceManager.stop: not yet implemented');
  }
  async query(): Promise<ServiceStatus> {
    return { installed: false, running: false };
  }
  async isInstalled(): Promise<boolean> {
    return false;
  }
}
