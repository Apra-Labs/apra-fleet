import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Owner-only file-system helpers for the server's data dir and logs.
 *
 * POSIX: directories are created/tightened to 0700 and files to 0600 with
 * chmod (the mkdir/open `mode` alone is filtered by the umask and never
 * tightens an existing path).
 *
 * Windows: chmod cannot express an ACL, and relying on the user-profile ACL
 * the data dir would inherit is not enough -- APRA_FLEET_DATA_DIR can point
 * anywhere (e.g. C:\fleet-data, readable by every local user). So the path's
 * inherited ACEs are removed and only the current user is granted full
 * control: `icacls <path> /inheritance:r /grant:r <user>:F` (directories get
 * `(OI)(CI)F` so new children inherit it). icacls runs through execFile, never
 * a shell, so the path needs no quoting.
 *
 * Every helper reports failure by return value (a reason string), never by
 * throwing: a log or data dir that cannot be tightened must not stop the
 * server. Callers log the reason.
 */

export interface OwnerOnlyDeps {
  platform?: NodeJS.Platform;
  execFile?: (file: string, args: string[]) => void;
  /** Windows account to grant (default: USERDOMAIN\USERNAME of this process). */
  windowsUser?: string;
}

function defaultExecFile(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
}

/** The account icacls grants on Windows: DOMAIN\user when the domain is known. */
export function currentWindowsUser(): string {
  const user = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Restrict `target` (an existing file or directory) to the current user.
 * Returns null on success, else a one-line reason.
 */
export function restrictToOwner(target: string, kind: 'file' | 'dir', deps: OwnerOnlyDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'win32') {
      const user = deps.windowsUser ?? currentWindowsUser();
      const grant = kind === 'dir' ? `${user}:(OI)(CI)F` : `${user}:F`;
      (deps.execFile ?? defaultExecFile)('icacls', [target, '/inheritance:r', '/grant:r', grant]);
    } else {
      fs.chmodSync(target, kind === 'dir' ? 0o700 : 0o600);
    }
    return null;
  } catch (err) {
    return `could not restrict ${target} to its owner: ${(err as Error).message}`;
  }
}

/** mkdir -p `dir` (0700) and restrict it to the owner. Returns failure reasons. */
export function ensureOwnerOnlyDir(dir: string, deps: OwnerOnlyDeps = {}): string[] {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const why = restrictToOwner(dir, 'dir', deps);
  return why ? [why] : [];
}

/**
 * Open `file` for append, created 0600, and restrict it (new or pre-existing)
 * to the owner. Throws only when the open itself fails; restriction failures
 * are pushed onto `problems`.
 */
export function openOwnerOnlyAppend(file: string, problems: string[] = [], deps: OwnerOnlyDeps = {}): number {
  const fd = fs.openSync(file, 'a', 0o600);
  const why = restrictToOwner(file, 'file', deps);
  if (why) problems.push(why);
  return fd;
}
