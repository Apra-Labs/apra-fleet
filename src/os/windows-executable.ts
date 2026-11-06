/**
 * Absolute-path executable lookup for fleet-server spawns on Windows.
 *
 * On Windows, CreateProcess (and libuv's own search, which Node's child_process
 * uses) looks in the CURRENT DIRECTORY before PATH when a bare program name is
 * given, and an empty or relative PATH entry resolves against the cwd too. So
 * every lookup here takes only ABSOLUTE PATH entries (drive-letter or UNC),
 * strips surrounding double quotes, and reads PATH / PATHEXT case-insensitively.
 *
 * The rules live here once: gitExecutable (git-executable.ts) restricts them to
 * what a shell-less spawn can run, and the live secret runner adds the system
 * tools it starts (cmd.exe, taskkill.exe, powershell.exe).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface WindowsLookupDeps {
  /** The PATH value (on Windows the env key may be spelled Path). */
  pathValue: string | undefined;
  /** True when p is an existing regular file. */
  isFile: (p: string) => boolean;
}

export interface SystemToolDeps extends WindowsLookupDeps {
  /** The SystemRoot value; ignored unless it is an absolute path. */
  systemRoot: string | undefined;
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

/** An absolute Windows directory: drive-letter rooted (C:\...) or UNC (\\server\share). */
export function isAbsoluteWindowsDir(dir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir);
}

/** The PATH entries a lookup may use: unquoted, absolute, in order. */
export function absoluteWindowsPathEntries(pathValue: string | undefined): string[] {
  const dirs: string[] = [];
  for (const raw of (pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (dir && isAbsoluteWindowsDir(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * The first `<dir>\<name><ext>` that exists, walking absolute PATH entries in
 * order and each entry's `exts` in order; null when none does. Use '' as an
 * extension to try the name as given.
 */
export function findOnAbsoluteWindowsPath(name: string, exts: readonly string[], deps: WindowsLookupDeps): string | null {
  for (const dir of absoluteWindowsPathEntries(deps.pathValue)) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, name + ext);
      if (deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Where each system tool lives under SystemRoot. */
const SYSTEM_TOOLS = {
  cmd: 'System32\\cmd.exe',
  taskkill: 'System32\\taskkill.exe',
  powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
} as const;

export type WindowsSystemTool = keyof typeof SYSTEM_TOOLS;

/**
 * Absolute path of a Windows system tool: under SystemRoot when that exists,
 * else from an absolute PATH entry, else null. ComSpec is not consulted and a
 * bare name is never returned, so neither the cwd nor a relative PATH entry can
 * supply the tool.
 */
export function resolveWindowsSystemTool(tool: WindowsSystemTool, deps: SystemToolDeps): string | null {
  const root = deps.systemRoot?.trim();
  if (root && isAbsoluteWindowsDir(root)) {
    const underRoot = path.win32.join(root, SYSTEM_TOOLS[tool]);
    if (deps.isFile(underRoot)) return underRoot;
  }
  return findOnAbsoluteWindowsPath(tool, ['.exe'], deps);
}

/**
 * True for the bash.exe Windows ships or installs as an app alias: the WSL
 * launcher, which runs in a Linux environment with a different filesystem view
 * and no fleet env vars. Never a bash for a fleet spawn.
 */
export function isWslLauncherBash(p: string): boolean {
  return /[\\/](system32|sysnative|windowsapps)[\\/]bash\.exe$/i.test(p);
}

export interface GitBashDeps extends WindowsLookupDeps {
  /** Well-known install locations, tried first (see git-bash-candidates.ts). */
  candidates: readonly string[];
}

/**
 * Absolute path of Git for Windows' bash: a well-known location, else next to
 * the git on PATH (<Git>\cmd\git.exe -> <Git>\bin\bash.exe), else a bash.exe on
 * an absolute PATH entry that is not the WSL launcher. Null when there is none.
 */
export function resolveGitBashExecutable(deps: GitBashDeps): string | null {
  const known = deps.candidates.find((c) => deps.isFile(c) && !isWslLauncherBash(c));
  if (known) return known;
  const git = findOnAbsoluteWindowsPath('git', ['.exe'], deps);
  if (git) {
    const beside = path.win32.join(path.win32.dirname(path.win32.dirname(git)), 'bin', 'bash.exe');
    if (deps.isFile(beside) && !isWslLauncherBash(beside)) return beside;
  }
  for (const dir of absoluteWindowsPathEntries(deps.pathValue)) {
    const candidate = path.win32.join(dir, 'bash.exe');
    if (!isWslLauncherBash(candidate) && deps.isFile(candidate)) return candidate;
  }
  return null;
}

/** The system tool for this process's own environment. */
export function windowsSystemTool(tool: WindowsSystemTool): string | null {
  return resolveWindowsSystemTool(tool, {
    systemRoot: envValue(process.env, 'SystemRoot'),
    pathValue: envValue(process.env, 'PATH'),
    isFile: defaultIsFile,
  });
}
