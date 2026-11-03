/**
 * The git executable every fleet-server git spawn uses.
 *
 * On Windows, CreateProcess (and libuv's own search, which Node's child_process
 * uses) looks in the CURRENT DIRECTORY before PATH when a bare program name is
 * given. Every KB / code-intelligence git call runs with a work folder as its
 * cwd, so `execFileSync('git', ..., { cwd: workFolder })` would run a git.exe
 * planted at the root of that work folder instead of the real git
 * (apra-fleet-rx6b).
 *
 * gitExecutable() therefore resolves git ONCE, on win32, to an absolute path
 * taken ONLY from PATH entries -- never the process cwd or any spawn cwd:
 *   - empty and relative PATH entries are skipped (a relative entry, like an
 *     empty one, would be resolved against the cwd);
 *   - surrounding double quotes on an entry are stripped;
 *   - PATHEXT order is honoured, restricted to the extensions a shell-less
 *     spawn can run directly (.EXE / .COM). A git.cmd / git.bat shim cannot be
 *     spawned without a shell (Node refuses it with EINVAL), so it is never
 *     returned; Git for Windows puts cmd\git.exe on PATH.
 * The result is cached for the process. A missing git throws GitNotFoundError,
 * one clear error naming PATH, instead of a confusing failure in whichever
 * caller ran first. A failed lookup is not cached, so installing git later
 * starts working without a restart.
 *
 * On every other platform the bare name 'git' is returned unchanged: execvp
 * never searches the cwd unless PATH itself says so.
 *
 * Out of scope: packages/apra-fleet-client git spawns (separate package).
 * Member-bound command STRINGS (src/os/*.ts builders, member-config-io, vcs
 * providers) run on the member through its own shell and are not spawns by
 * the fleet server's own process.
 */
import fs from 'node:fs';
import path from 'node:path';

export const GIT_NOT_FOUND_CODE = 'E-GIT-NOT-FOUND';

/** Extensions a shell-less CreateProcess spawn can execute directly. */
const SPAWNABLE_EXTS = new Set(['.EXE', '.COM']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export class GitNotFoundError extends Error {
  readonly code = GIT_NOT_FOUND_CODE;
  constructor(readonly searched: readonly string[]) {
    super(
      `${GIT_NOT_FOUND_CODE}: git was not found on PATH (searched ${searched.length} absolute PATH ` +
      `entr${searched.length === 1 ? 'y' : 'ies'}; the current directory is never searched). ` +
      'Install Git for Windows and make sure its cmd folder (e.g. C:\\Program Files\\Git\\cmd) is on PATH ' +
      'for the fleet server process, then retry.',
    );
    this.name = 'GitNotFoundError';
  }
}

export interface GitResolveDeps {
  platform: NodeJS.Platform;
  /** The PATH value (on Windows the env key may be spelled Path). */
  pathValue: string | undefined;
  pathext: string | undefined;
  /** True when p is an existing regular file. */
  isFile: (p: string) => boolean;
}

/** Look up an env var case-insensitively (Windows env keys are case-insensitive). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function defaultGitResolveDeps(): GitResolveDeps {
  return {
    platform: process.platform,
    pathValue: envValue(process.env, 'PATH'),
    pathext: envValue(process.env, 'PATHEXT'),
    isFile: defaultIsFile,
  };
}

/** An absolute Windows directory: drive-letter rooted (C:\...) or UNC (\\server\share). */
function isAbsoluteWindowsDir(dir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir);
}

/**
 * Pure resolution (no cache). Returns 'git' on non-Windows platforms; on win32
 * returns an absolute path from a PATH entry or throws GitNotFoundError.
 */
export function resolveGitExecutable(deps: GitResolveDeps): string {
  if (deps.platform !== 'win32') return 'git';
  const exts = (deps.pathext && deps.pathext.trim() ? deps.pathext : DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => SPAWNABLE_EXTS.has(e));
  const extOrder = exts.length > 0 ? [...new Set(exts)] : ['.EXE'];
  const searched: string[] = [];
  for (const raw of (deps.pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!dir || !isAbsoluteWindowsDir(dir)) continue;
    searched.push(dir);
    for (const ext of extOrder) {
      const candidate = path.win32.join(dir, 'git' + ext.toLowerCase());
      if (deps.isFile(candidate)) return candidate;
    }
  }
  throw new GitNotFoundError(searched);
}

let cached: string | undefined;

/**
 * The git executable for a fleet-server spawn: cached absolute PATH-only
 * resolution on win32, bare 'git' elsewhere. Throws GitNotFoundError on win32
 * when git is not on PATH.
 */
export function gitExecutable(): string {
  if (cached !== undefined) return cached;
  const resolved = resolveGitExecutable(defaultGitResolveDeps());
  cached = resolved;
  return resolved;
}

/** Test hook: forget the cached resolution. */
export function resetGitExecutableCache(): void {
  cached = undefined;
}
