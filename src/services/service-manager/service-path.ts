import path from 'node:path';
import { findExecutableOnPath, splitPath, type FindOnPathOptions } from '../../utils/find-on-path.js';

/**
 * PATH written into the launchd plist / systemd user unit. Service managers
 * start the server with a minimal default PATH (launchd: /usr/bin:/bin:...,
 * systemd --user: no ~/.nvm), so without this the server cannot spawn npx
 * (and npx's `#!/usr/bin/env node` cannot find node) -- code intelligence goes
 * offline with "spawn npx ENOENT". Computed at register time, so re-running
 * install (which always rewrites the service definition) refreshes it.
 */

const MACOS_WELL_KNOWN = ['/opt/homebrew/bin', '/usr/local/bin'];
const POSIX_WELL_KNOWN = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export interface ServicePathInputs {
  /** Target platform: 'darwin' or 'linux' (default: process.platform). */
  platform?: NodeJS.Platform;
  /** The installing process's PATH (default: process.env.PATH). */
  envPath?: string;
  /** File-existence check used to resolve node/npx. Injected by tests. */
  isFile?: FindOnPathOptions['isFile'];
}

/** A PATH entry is kept only when absolute and free of control characters. */
function isSafeEntry(dir: string): boolean {
  return path.posix.isAbsolute(dir) && !/[\x00-\x1f\x7f]/.test(dir);
}

/**
 * Ordered, de-duplicated PATH entries: the dirs holding node and npx on the
 * installer's PATH, then the installer's own PATH, then platform well-known
 * dirs. Only absolute, control-char-free entries survive.
 */
export function computeServicePathEntries(inputs: ServicePathInputs = {}): string[] {
  const platform = inputs.platform ?? process.platform;
  const envPath = inputs.envPath ?? process.env.PATH ?? '';
  const find = (name: string) => findExecutableOnPath(name, { platform, envPath, isFile: inputs.isFile });
  const toolDirs = ['node', 'npx']
    .map(find)
    .filter((p): p is string => !!p)
    .map(p => path.posix.dirname(p));
  const wellKnown = platform === 'darwin' ? [...MACOS_WELL_KNOWN, ...POSIX_WELL_KNOWN] : POSIX_WELL_KNOWN;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...toolDirs, ...splitPath(envPath, platform), ...wellKnown]) {
    const dir = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (!isSafeEntry(dir) || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/** The PATH value (colon-joined) for a POSIX service definition. */
export function computeServicePath(inputs: ServicePathInputs = {}): string {
  return computeServicePathEntries(inputs).join(':');
}

/**
 * A systemd `Environment=` line for NAME=value, quoted per systemd.exec:
 * the whole assignment in double quotes, `\` and `"` backslash-escaped, and
 * `%` doubled so it is never taken as a unit specifier.
 */
export function systemdEnvironmentLine(name: string, value: string): string {
  const quoted = `${name}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `Environment="${quoted}"`;
}
