/**
 * PATH-only resolution of a Windows executable to an ABSOLUTE path, shared by
 * every fleet-server spawn that would otherwise pass a bare program name.
 *
 * On Windows, CreateProcess (and libuv's own search, which Node's
 * child_process uses) looks in the CURRENT DIRECTORY before PATH when a bare
 * program name is given -- unless NoDefaultCurrentDirectoryInExePath is set in
 * the fleet server's own environment. LocalStrategy spawns a local member's
 * shell with cwd = the member work folder, so a bare 'powershell.exe' or
 * 'bash.exe' would run a same-named exe committed to a cloned repo, as the
 * fleet-server user. git-executable.ts closed that hole for git; this module
 * is the generalized resolver it now delegates to, and the shells use it too.
 *
 * The search, on win32:
 *   - a preferred absolute location first, when the program has one:
 *     powershell -> %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe,
 *     cmd -> an absolute %ComSpec% naming cmd.exe, then %SystemRoot%\System32\cmd.exe.
 *     A SystemRoot / ComSpec that is not an absolute drive or UNC path is
 *     ignored (a relative one would be resolved against the cwd);
 *   - then ONLY absolute PATH entries: empty and relative entries are skipped,
 *     surrounding double quotes are stripped;
 *   - PATHEXT order is honoured, restricted to the extensions a shell-less
 *     spawn can run directly (.EXE / .COM);
 *   - the process cwd and any spawn cwd are never searched.
 * windowsExecutable() caches a success per program for the process; a failed
 * lookup throws WindowsExecutableNotFoundError (one error code, naming every
 * location searched) and is not cached, so installing the program later starts
 * working without a restart.
 *
 * On every other platform the name is returned unchanged: execvp never
 * searches the cwd unless PATH itself says so.
 *
 * Absolute shell paths keep Node's quoting: normalizeSpawnArguments picks the
 * cmd.exe form (/d /s /c, verbatim args) by matching the shell against
 * /^(?:.*\\)?cmd(?:\.exe)?$/i, which a backslash-joined absolute cmd.exe path
 * still matches; every other shell gets ['-c', command] by name or by path.
 *
 * Out of scope: member-bound command STRINGS (src/os/*.ts builders sent over
 * SSH) -- they run in the member's own shell, not as fleet-server spawns.
 */
import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS_EXECUTABLE_NOT_FOUND_CODE = 'E-WINDOWS-EXECUTABLE-NOT-FOUND';

/** Extensions a shell-less CreateProcess spawn can execute directly. */
const SPAWNABLE_EXTS = new Set(['.EXE', '.COM']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface WindowsExecutableDeps {
  platform: NodeJS.Platform;
  /** The PATH value (on Windows the env key may be spelled Path). */
  pathValue: string | undefined;
  pathext: string | undefined;
  /** True when p is an existing regular file. */
  isFile: (p: string) => boolean;
  /** %SystemRoot% (falls back to %windir% in the defaults). */
  systemRoot?: string;
  /** %ComSpec%. */
  comSpec?: string;
}

export class WindowsExecutableNotFoundError extends Error {
  readonly code = WINDOWS_EXECUTABLE_NOT_FOUND_CODE;
  constructor(
    readonly program: string,
    readonly preferredTried: readonly string[],
    readonly searched: readonly string[],
  ) {
    super(
      `${WINDOWS_EXECUTABLE_NOT_FOUND_CODE}: ${program} was not found. ` +
      (preferredTried.length > 0 ? `Tried ${preferredTried.join(', ')}; then searched ` : 'Searched ') +
      `${searched.length} absolute PATH entr${searched.length === 1 ? 'y' : 'ies'}` +
      (searched.length > 0 ? ` (${searched.join(', ')})` : '') +
      '; the current directory is never searched. Make sure SystemRoot and PATH are set for the fleet server process, then retry.',
    );
    this.name = 'WindowsExecutableNotFoundError';
  }
}

/** Look up an env var case-insensitively (Windows env keys are case-insensitive). */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

export function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolution deps read from an env (default: the fleet server's own process.env). */
export function windowsExecutableDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = defaultIsFile,
): WindowsExecutableDeps {
  return {
    platform,
    pathValue: envValue(env, 'PATH'),
    pathext: envValue(env, 'PATHEXT'),
    isFile,
    systemRoot: envValue(env, 'SystemRoot') ?? envValue(env, 'windir'),
    comSpec: envValue(env, 'ComSpec'),
  };
}

/** An absolute Windows path: drive-letter rooted (C:\...) or UNC (\\server\share). */
export function isAbsoluteWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

function unquote(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/, '$1').trim();
}

/** 'powershell.exe' / 'POWERSHELL' -> 'powershell' (never appends .exe twice). */
function baseProgramName(name: string): string {
  return name.replace(/\.(exe|com)$/i, '');
}

/**
 * PATH-only search (no preferred locations, no cache, no throw). Returns the
 * first absolute match and the absolute PATH directories that were searched.
 */
export function searchWindowsPath(
  name: string,
  deps: Pick<WindowsExecutableDeps, 'pathValue' | 'pathext' | 'isFile'>,
): { found: string | undefined; searched: string[] } {
  const base = baseProgramName(name);
  const exts = (deps.pathext && deps.pathext.trim() ? deps.pathext : DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => SPAWNABLE_EXTS.has(e));
  const extOrder = exts.length > 0 ? [...new Set(exts)] : ['.EXE'];
  const searched: string[] = [];
  for (const raw of (deps.pathValue ?? '').split(';')) {
    const dir = unquote(raw);
    if (!dir || !isAbsoluteWindowsPath(dir)) continue;
    searched.push(dir);
    for (const ext of extOrder) {
      const candidate = path.win32.join(dir, base + ext.toLowerCase());
      if (deps.isFile(candidate)) return { found: candidate, searched };
    }
  }
  return { found: undefined, searched };
}

/** Preferred absolute locations for a program, checked before PATH. */
export function preferredWindowsLocations(name: string, deps: WindowsExecutableDeps): string[] {
  const base = baseProgramName(name).toLowerCase();
  const root = deps.systemRoot ? unquote(deps.systemRoot) : '';
  const rootOk = root !== '' && isAbsoluteWindowsPath(root);
  if (base === 'powershell') {
    return rootOk ? [path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')] : [];
  }
  if (base === 'cmd') {
    const out: string[] = [];
    const comSpec = deps.comSpec ? unquote(deps.comSpec) : '';
    if (comSpec && isAbsoluteWindowsPath(comSpec) && /^cmd\.exe$/i.test(path.win32.basename(comSpec))) {
      out.push(path.win32.normalize(comSpec));
    }
    if (rootOk) out.push(path.win32.join(root, 'System32', 'cmd.exe'));
    return out;
  }
  return [];
}

/**
 * Pure resolution (no cache). Returns the name unchanged on non-Windows
 * platforms; on win32 returns an absolute path (preferred location, then PATH)
 * or throws WindowsExecutableNotFoundError.
 */
export function resolveWindowsExecutable(name: string, deps: WindowsExecutableDeps): string {
  if (deps.platform !== 'win32') return name;
  const preferred = preferredWindowsLocations(name, deps);
  for (const candidate of preferred) {
    if (deps.isFile(candidate)) return candidate;
  }
  const { found, searched } = searchWindowsPath(name, deps);
  if (found !== undefined) return found;
  throw new WindowsExecutableNotFoundError(name, preferred, searched);
}

const cache = new Map<string, string>();

/**
 * The executable for a fleet-server spawn of `name` (e.g. 'powershell.exe',
 * 'cmd.exe'): cached absolute resolution on win32, the name unchanged
 * elsewhere. Throws WindowsExecutableNotFoundError on win32 when not found.
 * `deps` is a test seam; production callers pass nothing.
 */
export function windowsExecutable(name: string, deps?: WindowsExecutableDeps): string {
  const key = baseProgramName(name).toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const resolved = resolveWindowsExecutable(name, deps ?? windowsExecutableDepsFromEnv());
  cache.set(key, resolved);
  return resolved;
}

/** Test hook: forget every cached resolution. */
export function resetWindowsExecutableCache(): void {
  cache.clear();
}
