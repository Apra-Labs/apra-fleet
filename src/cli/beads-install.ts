/**
 * Beads (bd) CLI install step for `apra-fleet install`.
 *
 * Order, first hit wins:
 *   1. a bd already on PATH that answers --version -> left untouched;
 *   2. a bd already in BIN_DIR (<home>/.apra-fleet/bin) -> left untouched;
 *   3. `npm install -g` of the pinned package, kept only when the result then
 *      resolves on PATH (the long-standing behaviour where it works);
 *   4. otherwise -- typically a root-owned global npm prefix (EACCES) for a
 *      plain user -- a NON-global `npm install --prefix <staging>` of the same
 *      pinned package, whose postinstall downloads bd's native binary; that
 *      binary is copied into BIN_DIR next to the fleet's portable dolt. No
 *      writable global prefix and no admin rights are needed.
 *
 * BIN_DIR is appended to PATH by every member-bound command the fleet builds
 * (src/os/linux.ts / windows.ts: dispatch and execute_command), so a bd placed
 * there resolves for dispatched sessions and fleet-sprint's own bd commands.
 *
 * Never throws: a failure is returned with a reason and a one-line fix so the
 * installer can print both and the summary can name them.
 */
import path from 'node:path';
import { BEADS_PACKAGE } from './beads-pin.js';

/** The ONE pin (src/cli/beads-pin.ts) -- never a second literal here. */
export const BEADS_NPM_PACKAGE = BEADS_PACKAGE;

export const BEADS_INSTALL_FIX =
  `install bd for this user so 'bd --version' works (for example 'npm install -g ${BEADS_NPM_PACKAGE}' with a user-writable npm prefix), then re-run the install`;

export interface BeadsInstallDeps {
  platform: NodeJS.Platform;
  /** execFileSync-shaped; returns stdout, throws on non-zero exit. */
  exec(cmd: string, args: string[], opts: { shell: boolean }): string;
  existsSync(p: string): boolean;
  mkdirSync(p: string): void;
  rmSync(p: string): void;
  copyFileSync(src: string, dest: string): void;
  chmodSync(p: string, mode: number): void;
}

export type BeadsInstallResult =
  | { state: 'present'; version: string; location: 'path' | 'bin-dir'; binPath?: string }
  | { state: 'installed'; version: string; location: 'npm-global' | 'bin-dir'; binPath?: string }
  | { state: 'missing'; reason: string; fix: string };

export function beadsBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'bd.exe' : 'bd';
}

/** First non-empty output line, e.g. "bd version 1.3.0 (abc)". */
function firstLine(out: unknown): string {
  return String(out ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
}

/** Short, single-line reason from a failed exec (prefers npm's own error code). */
export function describeExecFailure(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: string; code?: string };
  const text = `${String(e?.stderr ?? '')}\n${String(e?.stdout ?? '')}\n${e?.message ?? ''}`;
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) {
    const where = /(?:EACCES|EPERM)[^\n]*?['"]?((?:\/|[A-Za-z]:\\)[^'"\s]+)/.exec(text)?.[1];
    return `permission denied${where ? ` writing ${where}` : ''} (the global npm prefix is not writable by this user)`;
  }
  if (e?.code === 'ENOENT' || /npm(?:\.cmd)?: (?:command )?not found|'npm' is not recognized|not recognized as an internal or external command/i.test(text)) {
    return 'npm is not available on PATH';
  }
  const tail = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' ');
  return (tail || 'unknown error').slice(0, 300);
}

function probe(deps: BeadsInstallDeps, cmd: string, shell: boolean): string | null {
  try {
    return firstLine(deps.exec(cmd, ['--version'], { shell })) || 'installed';
  } catch {
    return null;
  }
}

/** Quote a path for the shell:true npm call (args are joined unquoted). */
function shellQuote(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function installBeads(binDir: string, deps: BeadsInstallDeps): BeadsInstallResult {
  const binPath = path.join(binDir, beadsBinaryName(deps.platform));

  // shell:true -- on Windows an npm-global bd is a .cmd wrapper Node cannot spawn directly.
  const onPath = probe(deps, 'bd', true);
  if (onPath) return { state: 'present', version: onPath, location: 'path' };
  if (deps.existsSync(binPath)) {
    const inBin = probe(deps, binPath, false);
    if (inBin) return { state: 'present', version: inBin, location: 'bin-dir', binPath };
  }

  let globalFailure: string | null = null;
  try {
    deps.exec('npm', ['install', '-g', BEADS_NPM_PACKAGE], { shell: true });
    const v = probe(deps, 'bd', true);
    if (v) return { state: 'installed', version: v, location: 'npm-global' };
    globalFailure = 'npm install -g succeeded but bd is not on PATH (the npm global bin dir is not on PATH)';
  } catch (err) {
    globalFailure = describeExecFailure(err);
  }

  const staging = path.join(path.dirname(binDir), 'staging', 'beads');
  try {
    try { deps.rmSync(staging); } catch { /* nothing to clear */ }
    deps.mkdirSync(staging);
    deps.exec('npm', [
      'install', '--prefix', shellQuote(staging, deps.platform),
      '--no-save', '--no-package-lock', '--no-audit', '--no-fund', BEADS_NPM_PACKAGE,
    ], { shell: true });
    const native = path.join(staging, 'node_modules', '@beads', 'bd', 'bin', beadsBinaryName(deps.platform));
    if (!deps.existsSync(native)) {
      return {
        state: 'missing',
        reason: `global install failed (${globalFailure}); the user-level install did not produce the bd binary (its postinstall download failed: ${native} is missing)`,
        fix: BEADS_INSTALL_FIX,
      };
    }
    deps.mkdirSync(binDir);
    deps.copyFileSync(native, binPath);
    if (deps.platform !== 'win32') deps.chmodSync(binPath, 0o755);
    const v = probe(deps, binPath, false);
    if (!v) {
      return { state: 'missing', reason: `global install failed (${globalFailure}); ${binPath} was installed but does not run`, fix: BEADS_INSTALL_FIX };
    }
    return { state: 'installed', version: v, location: 'bin-dir', binPath };
  } catch (err) {
    return {
      state: 'missing',
      reason: `global install failed (${globalFailure}); user-level install into ${binDir} failed (${describeExecFailure(err)})`,
      fix: BEADS_INSTALL_FIX,
    };
  } finally {
    try { deps.rmSync(staging); } catch { /* best effort */ }
  }
}
