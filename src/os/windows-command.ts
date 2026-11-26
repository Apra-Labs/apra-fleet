/**
 * Spawn plan for a CLI the fleet server starts by name on Windows, where the
 * program may be an .exe or an npm-style .cmd shim (claude, npx, ...).
 *
 * windowsExecutable() (windows-executable.ts) only resolves .exe/.com, which a
 * shell-less spawn can run directly. A .cmd shim needs cmd.exe, and the old
 * call sites got it by passing the bare name with shell:true -- so cmd.exe
 * searched the spawn cwd (a member work folder or a repo the fleet does not
 * control) FIRST, and a planted claude.cmd / npx.cmd ran as the fleet-server
 * user (CWE-426/427).
 *
 * resolveWindowsCommand() walks ONLY absolute PATH entries (empty, relative
 * and drive-relative entries are skipped, the cwd is never searched), dir by
 * dir, trying .exe/.com/.cmd in PATHEXT order inside each directory -- the
 * first hit wins, the same precedence the member's own shell uses. The
 * extensionless candidate (e.g. the sh script `npx` next to npx.cmd) is never
 * considered. The hit becomes a spawn plan:
 *   - .exe / .com        -> run it directly, shell:false;
 *   - npm cmd-shim .cmd  -> node on the script the shim wraps, shell:false
 *     (node = the node.exe beside the shim, as the shim itself prefers, else
 *     node.exe resolved by windowsExecutable -- never process.execPath, which
 *     is apra-fleet.exe in the single-executable build);
 *   - any other .cmd     -> the ABSOLUTE shim path run by the ABSOLUTE cmd.exe
 *     (shell: <cmd.exe path>, file pre-quoted; callers keep cmd.exe argument
 *     quoting for this kind only).
 * Every plan carries NoDefaultCurrentDirectoryInExePath=1 for the child env as
 * a backstop: cmd.exe (and anything the child starts by bare name) then skips
 * the current directory too. It is a backstop only -- the program itself is
 * already an absolute path.
 *
 * Nothing found -> WindowsCommandNotFoundError naming every directory
 * searched; there is no fallback to the bare name or to shell:true.
 *
 * Off win32 resolveWindowsCommand returns null and callers keep their
 * original argv and options unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultIsFile,
  isAbsoluteWindowsPath,
  resolveWindowsExecutable,
  windowsExecutableDepsFromEnv,
  type WindowsExecutableDeps,
} from './windows-executable.js';

export const WINDOWS_COMMAND_NOT_FOUND_CODE = 'E-WINDOWS-COMMAND-NOT-FOUND';

/** Child-env backstop added to every Windows plan. */
export const NO_CWD_EXE_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: '1' } as const;

export type WindowsCommandKind = 'exe' | 'node-script' | 'cmd-shim';

export interface WindowsCommandPlan {
  kind: WindowsCommandKind;
  /** Absolute program to spawn (pre-quoted shim path for kind cmd-shim). */
  file: string;
  /** Leading args placed before the caller's own args (the script path for node-script). */
  args: string[];
  /** false, or the absolute cmd.exe path for kind cmd-shim. */
  shell: string | false;
  /** Absolute path of the PATH entry that was chosen (exe or .cmd). */
  source: string;
  /** Env entries to merge into the child env. */
  env: Record<string, string>;
}

export interface WindowsCommandDeps extends WindowsExecutableDeps {
  readFile: (p: string) => string;
}

export class WindowsCommandNotFoundError extends Error {
  readonly code = WINDOWS_COMMAND_NOT_FOUND_CODE;
  constructor(readonly program: string, readonly searched: readonly string[]) {
    super(
      `${WINDOWS_COMMAND_NOT_FOUND_CODE}: ${program} was not found. Searched ` +
      `${searched.length} absolute PATH entr${searched.length === 1 ? 'y' : 'ies'}` +
      (searched.length > 0 ? ` (${searched.join(', ')})` : '') +
      ` for ${program}.exe, ${program}.com and ${program}.cmd; the current directory and relative PATH ` +
      'entries are never searched. Install it on an absolute PATH entry of the fleet server process, then retry.',
    );
    this.name = 'WindowsCommandNotFoundError';
  }
}

export function windowsCommandDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WindowsCommandDeps {
  return {
    ...windowsExecutableDepsFromEnv(env, platform, defaultIsFile),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
  };
}

/**
 * The script an npm cmd-shim wraps: its last command is
 *   "%_prog%"  "%dp0%\node_modules\<pkg>\<bin>.js" %*
 * (older generators write %~dp0). Returns the absolute script path, or null
 * when the content is not that shape. A target that is not a .js file
 * (cmd-shim can wrap a native binary) is not a node script -> null.
 */
export function npmShimScript(content: string, shimDir: string): string | null {
  const m = content.match(/"%~?dp0%?\\([^"%]+\.[cm]?js)"\s*%\*/i);
  if (!m) return null;
  const rel = m[1];
  if (rel.split(/[\\/]/).includes('..')) return null;
  return path.win32.join(shimDir, rel);
}

const CANDIDATE_EXTS = new Set(['.EXE', '.COM', '.CMD']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Pure resolution. null off win32 (callers keep their original spawn); a plan
 * on win32; throws WindowsCommandNotFoundError when nothing usable is found.
 */
export function resolveWindowsCommand(name: string, deps: WindowsCommandDeps): WindowsCommandPlan | null {
  if (deps.platform !== 'win32') return null;
  const base = name.replace(/\.(exe|com|cmd)$/i, '');
  const exts = (deps.pathext && deps.pathext.trim() ? deps.pathext : DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => CANDIDATE_EXTS.has(e));
  const extOrder = exts.length > 0 ? [...new Set(exts)] : ['.COM', '.EXE', '.CMD'];
  const searched: string[] = [];
  for (const raw of (deps.pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!dir || !isAbsoluteWindowsPath(dir)) continue;
    searched.push(dir);
    for (const ext of extOrder) {
      const candidate = path.win32.join(dir, base + ext.toLowerCase());
      if (!deps.isFile(candidate)) continue;
      const env = { ...NO_CWD_EXE_SEARCH_ENV };
      if (ext !== '.CMD') {
        return { kind: 'exe', file: candidate, args: [], shell: false, source: candidate, env };
      }
      let content = '';
      try { content = deps.readFile(candidate); } catch { /* unreadable: run it under cmd.exe */ }
      const script = npmShimScript(content, dir);
      if (script !== null && deps.isFile(script)) {
        const besideNode = path.win32.join(dir, 'node.exe');
        const node = deps.isFile(besideNode) ? besideNode : resolveWindowsExecutable('node', deps);
        return { kind: 'node-script', file: node, args: [script], shell: false, source: candidate, env };
      }
      const cmd = resolveWindowsExecutable('cmd', deps);
      return { kind: 'cmd-shim', file: `"${candidate}"`, args: [], shell: cmd, source: candidate, env };
    }
  }
  throw new WindowsCommandNotFoundError(base, searched);
}

/** resolveWindowsCommand with the fleet server's own env (not cached: PATH may change). */
export function windowsCommand(name: string, deps?: WindowsCommandDeps): WindowsCommandPlan | null {
  return resolveWindowsCommand(name, deps ?? windowsCommandDepsFromEnv());
}

/** The child env for a plan: the base env (default process.env) plus plan.env. */
export function planEnv(plan: WindowsCommandPlan, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...plan.env };
}

