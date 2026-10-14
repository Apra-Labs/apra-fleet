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
  /** Windows account to grant (default: currentWindowsUser()). */
  windowsUser?: string;
}

function defaultExecFile(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
}

function defaultWhoami(): string {
  return execFileSync('whoami', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 });
}

let cachedWindowsUser: string | undefined;

/**
 * The account icacls (and the service task) grants on Windows, read from this
 * process's token: `whoami` prints DOMAIN\user (<COMPUTERNAME>\user for a local
 * account). Never env USERDOMAIN: Win32-OpenSSH sets it to WORKGROUP on a
 * workgroup machine, a name that maps to no account. Falls back to the bare
 * token user name (os.userInfo), which icacls/schtasks resolve themselves.
 */
export function currentWindowsUser(whoami?: () => string): string {
  if (!whoami && cachedWindowsUser) return cachedWindowsUser;
  let name: string | undefined;
  try {
    const out = (whoami ?? defaultWhoami)().trim();
    if (/^[^\\\s]+\\[^\\]+$/.test(out) && !out.includes(String.fromCharCode(0xfffd))) name = out;
  } catch { /* fall back below */ }
  if (!name) {
    try { name = os.userInfo().username; } catch { name = 'unknown'; }
  }
  if (!whoami) cachedWindowsUser = name;
  return name;
}

/**
 * Windows install step: restrict each path to the owner and return one loud
 * `[!]` line per failure, naming the file and the manual fix (empty on
 * success). Callers gate on win32; POSIX keeps its chmod path.
 */
export function ownerOnlyInstallWarnings(targets: Array<{ path: string; kind: 'file' | 'dir' }>, deps: OwnerOnlyDeps = {}): string[] {
  const out: string[] = [];
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    const why = restrictToOwner(t.path, t.kind, deps);
    if (!why) continue;
    const user = deps.windowsUser ?? currentWindowsUser();
    const grant = t.kind === 'dir' ? `${user}:(OI)(CI)F` : `${user}:F`;
    out.push(`    [!] ${t.path} is NOT owner-only (${why}). Other local users may read it. Fix: icacls "${t.path}" /inheritance:r /grant:r "${grant}"`);
  }
  return out;
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
