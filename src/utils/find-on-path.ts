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

function defaultIsFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Split a PATH string with the target platform's delimiter, dropping empty entries. */
export function splitPath(envPath: string, platform: NodeJS.Platform = process.platform): string[] {
  return envPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
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
