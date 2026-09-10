import type { OsCommands, MemberShell } from './os-commands.js';
import type { RemoteOS } from '../utils/platform.js';
import { LinuxCommands } from './linux.js';
import { MacOSCommands } from './macos.js';
import { WindowsCommands } from './windows.js';
import { WindowsGitBashCommands } from './windows-gitbash.js';

export type { OsCommands, MemberShell } from './os-commands.js';
export { LinuxCommands } from './linux.js';
export { MacOSCommands } from './macos.js';
export { WindowsCommands } from './windows.js';
export { WindowsGitBashCommands } from './windows-gitbash.js';

const instances: Record<RemoteOS, OsCommands> = {
  linux: new LinuxCommands(),
  macos: new MacOSCommands(),
  windows: new WindowsCommands(),
};

/** Windows members whose registered shell is Git-for-Windows bash get POSIX
 *  command strings instead of PowerShell ones (apra-fleet-7dir.2.1). */
const windowsGitBash: OsCommands = new WindowsGitBashCommands();

/**
 * Get the OsCommands implementation for a given OS. Instances are singletons.
 *
 * `shell` is the member's registered shell (Agent.shell). Only
 * `windows` + `gitbash` selects a different implementation; every other
 * combination -- including a windows member with no shell recorded, or with
 * `pwsh7`/`powershell5` -- resolves exactly as it did before the shell
 * parameter existed.
 */
export function getOsCommands(os: RemoteOS, shell?: MemberShell): OsCommands {
  if (os === 'windows' && shell === 'gitbash') return windowsGitBash;
  return instances[os];
}
