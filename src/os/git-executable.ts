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
 * The PATH-only search itself lives in windows-executable.ts (shared with the
 * Windows shells the fleet server starts). The result is cached for the
 * process. A missing git throws GitNotFoundError, one clear error naming PATH, instead of a confusing failure in whichever
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
import {
  defaultIsFile,
  envValue,
  searchWindowsPath,
  type WindowsExecutableDeps,
} from './windows-executable.js';

export const GIT_NOT_FOUND_CODE = 'E-GIT-NOT-FOUND';

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

/** git has no preferred location: only the PATH fields of the shared deps apply. */
export type GitResolveDeps = Pick<WindowsExecutableDeps, 'platform' | 'pathValue' | 'pathext' | 'isFile'>;

export function defaultGitResolveDeps(): GitResolveDeps {
  return {
    platform: process.platform,
    pathValue: envValue(process.env, 'PATH'),
    pathext: envValue(process.env, 'PATHEXT'),
    isFile: defaultIsFile,
  };
}

/**
 * Pure resolution (no cache). Returns 'git' on non-Windows platforms; on win32
 * returns an absolute path from a PATH entry or throws GitNotFoundError.
 */
export function resolveGitExecutable(deps: GitResolveDeps): string {
  if (deps.platform !== 'win32') return 'git';
  const { found, searched } = searchWindowsPath('git', deps);
  if (found !== undefined) return found;
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
