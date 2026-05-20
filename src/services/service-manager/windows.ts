import type { ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME } from './types.js';

export class WindowsServiceManager implements ServiceManager {
  async register(_binaryPath: string, _args: string[], _logPath: string): Promise<void> {
    throw new Error(`WindowsServiceManager.register: not yet implemented (task: ${WINDOWS_TASK_NAME})`);
  }
  async unregister(): Promise<void> {
    throw new Error('WindowsServiceManager.unregister: not yet implemented');
  }
  async start(): Promise<void> {
    throw new Error('WindowsServiceManager.start: not yet implemented');
  }
  async stop(): Promise<void> {
    throw new Error('WindowsServiceManager.stop: not yet implemented');
  }
  async query(): Promise<ServiceStatus> {
    return { installed: false, running: false };
  }
  async isInstalled(): Promise<boolean> {
    return false;
  }
}
