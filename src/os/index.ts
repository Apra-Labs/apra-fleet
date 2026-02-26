import type { OsCommands } from './os-commands.js';
import type { RemoteOS } from '../utils/platform.js';
import { LinuxCommands } from './linux.js';
import { MacOSCommands } from './macos.js';
import { WindowsCommands } from './windows.js';

export type { OsCommands } from './os-commands.js';
export { LinuxCommands } from './linux.js';
export { MacOSCommands } from './macos.js';
export { WindowsCommands } from './windows.js';

const instances: Record<RemoteOS, OsCommands> = {
  linux: new LinuxCommands(),
  macos: new MacOSCommands(),
  windows: new WindowsCommands(),
};

/** Get the OsCommands implementation for a given OS. Instances are singletons. */
export function getOsCommands(os: RemoteOS): OsCommands {
  return instances[os];
}
