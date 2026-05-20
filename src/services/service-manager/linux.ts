import type { ServiceManager, ServiceStatus } from './types.js';
import { LINUX_UNIT_NAME } from './types.js';

export class LinuxServiceManager implements ServiceManager {
  async register(_binaryPath: string, _args: string[], _logPath: string): Promise<void> {
    throw new Error(`LinuxServiceManager.register: not yet implemented (unit: ${LINUX_UNIT_NAME})`);
  }
  async unregister(): Promise<void> {
    throw new Error('LinuxServiceManager.unregister: not yet implemented');
  }
  async start(): Promise<void> {
    throw new Error('LinuxServiceManager.start: not yet implemented');
  }
  async stop(): Promise<void> {
    throw new Error('LinuxServiceManager.stop: not yet implemented');
  }
  async query(): Promise<ServiceStatus> {
    return { installed: false, running: false };
  }
  async isInstalled(): Promise<boolean> {
    return false;
  }
}
