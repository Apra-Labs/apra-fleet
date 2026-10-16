import { statSync } from 'node:fs';
import path from 'node:path';

export interface FindOnPathOptions {
  /** PATH string to search (default: process.env.PATH). */
  envPath?: string;
  /** Platform whose PATH rules apply (default: process.platform). */
  platform?: NodeJS.Platform;
  /** PATHEXT for win32 (default: process.env.PATHEXT). */
  pathExt?: string;
  /** File-existence check (default: statSync(...).isFile()). Injected by tests. */
  isFile?: (p: string) => boolean;
}

/**
 * A regular file; off Windows it must also carry an execute bit, so a plain
 * (non-executable) file named node/npx is skipped the way the shell would.
 */
function defaultIsFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    return process.platform === 'win32' || (st.mode & 0o111) !== 0;
  } catch { return false; }
}

/**
 * Split a PATH string with the target platform's delimiter, dropping empty
 * entries. On win32 an entry may be wrapped in double quotes (to carry a `;`
 * or spaces); those are stripped, since a quoted dir is not a valid path.
 */
export function splitPath(envPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const parts = envPath.split(platform === 'win32' ? ';' : ':');
  return (platform === 'win32' ? parts.map((d) => d.trim().replace(/^"(.*)"$/, '$1')) : parts).filter(Boolean);
}

/** Resolve an executable on PATH (PATHEXT-aware on Windows) without a shell. */
export function findExecutableOnPath(name: string, opts: FindOnPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const isFile = opts.isFile ?? defaultIsFile;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const exts = platform === 'win32'
    ? ['', ...(opts.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of splitPath(envPath, platform)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Actionable text for "npx (or the node it runs under) is not on this
 * server's PATH". A service-managed server gets the PATH recorded in its
 * service definition at install time, so re-running install refreshes it.
 */
export function missingOnServerPathMessage(name: string, envPath: string = process.env.PATH ?? ''): string {
  return `${name} was not found on the apra-fleet server's PATH (searched: ${envPath || '<empty>'}). ` +
    `Install Node.js (which provides node and npx), then re-run 'apra-fleet install' to refresh the service PATH ` +
    `and restart the server.`;
}

/**
 * Null when npx (and, off Windows, the node its `#!/usr/bin/env node` shebang
 * needs) resolve on PATH; otherwise the actionable missing-on-PATH message.
 */
export function npxUnavailableReason(opts: FindOnPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const o = { ...opts, platform, envPath };
  if (!findExecutableOnPath('npx', o)) return missingOnServerPathMessage('npx', envPath);
  if (platform !== 'win32' && !findExecutableOnPath('node', o)) return missingOnServerPathMessage('node (required by npx)', envPath);
  return null;
}

/**
 * The install-time warning line when node and/or npx cannot be resolved from
 * the installer's PATH (the PATH a service definition records), naming each
 * missing tool; null when both resolve. Code intelligence runs through npx, so
 * without them it stays unavailable until fixed.
 */
export function codeIntelPathWarning(opts: FindOnPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const o = { ...opts, platform, envPath };
  const missing = ['node', 'npx'].filter((name) => !findExecutableOnPath(name, o));
  if (missing.length === 0) return null;
  return `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not resolvable from the installer PATH: code intelligence will be unavailable until it is fixed. ` +
    `Install Node.js (which provides node and npx) or add it to PATH, then re-run 'apra-fleet install'.`;
}
