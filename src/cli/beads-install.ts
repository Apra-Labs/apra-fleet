/**
 * Beads (bd) CLI install step for `apra-fleet install`.
 *
 * Order, first hit wins:
 *   1. a bd already on PATH that answers --version -> left untouched. Its
 *      major.minor must equal BEADS_VERSION's; otherwise the result is
 *      'version-mismatch' (a PATH bd is never uninstalled or overwritten --
 *      the installer does not own it);
 *   2. a bd already in BIN_DIR (<home>/.apra-fleet/bin) -> left untouched when
 *      its major.minor matches. A mismatched BIN_DIR bd (with no bd on PATH
 *      shadowing it) IS replaced: BIN_DIR is fleet-owned, so step 4's pinned
 *      user-level install overwrites it, and the result is re-verified; if that
 *      fails the result is 'version-mismatch', never a silent pass;
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
import { BEADS_PACKAGE, BEADS_VERSION } from './beads-pin.js';
import { checkPinnedVersion, type PinCheck } from './version-pin.js';

/** The ONE pin (src/cli/beads-pin.ts) -- never a second literal here. */
export const BEADS_NPM_PACKAGE = BEADS_PACKAGE;

/** One-line fix for a bd whose major.minor differs from the pin. */
export function beadsMismatchFix(where: 'path' | 'bin-dir', binPath?: string): string {
  const pinned = `install the pinned ${BEADS_NPM_PACKAGE} for this user (for example 'npm install -g ${BEADS_NPM_PACKAGE}' with a user-writable npm prefix)`;
  return where === 'path'
    ? `${pinned}, or remove the other bd from PATH, then re-run the install`
    : `remove ${binPath ?? 'the bd in the fleet bin dir'} and re-run the install so the pinned bd is installed there, or ${pinned} and re-run the install`;
}

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
  | { state: 'missing'; reason: string; fix: string }
  /**
   * A bd answers --version but its major.minor differs from BEADS_VERSION (or
   * its output is unparseable). `where` is 'PATH' or the BIN_DIR path.
   */
  | { state: 'version-mismatch'; found: string; expected: string; location: 'path' | 'bin-dir'; where: string; fix: string; binPath?: string; reason?: string };

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

/** First --version output line ('' when it printed nothing); null when bd does not run. */
function probe(deps: BeadsInstallDeps, cmd: string, shell: boolean): string | null {
  try {
    return firstLine(deps.exec(cmd, ['--version'], { shell }));
  } catch {
    return null;
  }
}

function mismatch(check: PinCheck, location: 'path' | 'bin-dir', binPath: string, reason?: string): BeadsInstallResult {
  return {
    state: 'version-mismatch',
    found: check.found,
    expected: check.expected,
    location,
    where: location === 'path' ? 'PATH' : binPath,
    fix: beadsMismatchFix(location, binPath),
    ...(location === 'bin-dir' ? { binPath } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Quote a path for the shell:true npm call (args are joined unquoted). */
function shellQuote(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function installBeads(binDir: string, deps: BeadsInstallDeps): BeadsInstallResult {
  const binPath = path.join(binDir, beadsBinaryName(deps.platform));

  // shell:true -- on Windows an npm-global bd is a .cmd wrapper Node cannot spawn directly.
  const onPath = probe(deps, 'bd', true);
  if (onPath !== null) {
    const check = checkPinnedVersion(onPath, BEADS_VERSION);
    if (check.ok) return { state: 'present', version: onPath, location: 'path' };
    // Not ours: never uninstalled or overwritten, only reported.
    return mismatch(check, 'path', binPath);
  }
  // A mismatched BIN_DIR bd that nothing on PATH shadows: replace it with the
  // pinned user-level install below (BIN_DIR is fleet-owned). npm -g is skipped
  // for it, so the replacement does not put a second bd on PATH.
  let staleBin: PinCheck | null = null;
  if (deps.existsSync(binPath)) {
    const inBin = probe(deps, binPath, false);
    if (inBin !== null) {
      const check = checkPinnedVersion(inBin, BEADS_VERSION);
      if (check.ok) return { state: 'present', version: inBin, location: 'bin-dir', binPath };
      staleBin = check;
    }
  }

  let globalFailure: string | null = null;
  if (staleBin) {
    globalFailure = `skipped: replacing the fleet-owned ${binPath} (found ${staleBin.found}, expected ${staleBin.expected})`;
  } else {
    try {
      deps.exec('npm', ['install', '-g', BEADS_NPM_PACKAGE], { shell: true });
      const v = probe(deps, 'bd', true);
      if (v !== null) {
        const check = checkPinnedVersion(v, BEADS_VERSION);
        if (check.ok) return { state: 'installed', version: v, location: 'npm-global' };
        return mismatch(check, 'path', binPath, 'npm install -g of the pinned bd succeeded but the bd on PATH reports another version');
      }
      globalFailure = 'npm install -g succeeded but bd is not on PATH (the npm global bin dir is not on PATH)';
    } catch (err) {
      globalFailure = describeExecFailure(err);
    }
  }
  /** A failed replacement of a mismatched BIN_DIR bd is a mismatch, not 'missing'. */
  const fail = (reason: string): BeadsInstallResult =>
    staleBin ? mismatch(staleBin, 'bin-dir', binPath, `replacing it with the pinned bd failed: ${reason}`) : { state: 'missing', reason, fix: BEADS_INSTALL_FIX };

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
      return fail(`global install failed (${globalFailure}); the user-level install did not produce the bd binary (its postinstall download failed: ${native} is missing)`);
    }
    deps.mkdirSync(binDir);
    deps.copyFileSync(native, binPath);
    if (deps.platform !== 'win32') deps.chmodSync(binPath, 0o755);
    const v = probe(deps, binPath, false);
    if (v === null) {
      return fail(`global install failed (${globalFailure}); ${binPath} was installed but does not run`);
    }
    const check = checkPinnedVersion(v, BEADS_VERSION);
    if (!check.ok) return mismatch(check, 'bin-dir', binPath, 'the pinned user-level install produced a bd reporting another version');
    return { state: 'installed', version: v, location: 'bin-dir', binPath };
  } catch (err) {
    return fail(`global install failed (${globalFailure}); user-level install into ${binDir} failed (${describeExecFailure(err)})`);
  } finally {
    try { deps.rmSync(staging); } catch { /* best effort */ }
  }
}

/**
 * Stable code on every bd version-mismatch line (and on the installer's last
 * stderr line), so a caller that keeps only the output tail -- the member
 * fleet_install path -- can tell "installed, but bd is off the pin" from a
 * failed install without parsing prose.
 */
export const BD_VERSION_MISMATCH_CODE = 'E-BD-VERSION-MISMATCH';

/** The [!] lines for a bd whose major.minor differs from the pin (also the final stderr line). */
export function beadsMismatchLines(r: Extract<BeadsInstallResult, { state: 'version-mismatch' }>, host: string): string[] {
  return [
    `${BD_VERSION_MISMATCH_CODE} Beads (bd) version mismatch on ${host}: found ${r.found} (${r.where}), expected ${r.expected} (pinned major.minor).${r.reason ? ` ${r.reason}.` : ''}`,
    `Fix: ${r.fix}`,
  ];
}

/**
 * One status Warning line when the bd on PATH runs but is off the pin; null
 * when it matches or cannot run (a missing bd is a separate, existing report).
 */
export function bdPinWarning(exec: BeadsInstallDeps['exec'], host: string): string | null {
  let out: string | null;
  try { out = firstLine(exec('bd', ['--version'], { shell: true })); } catch { return null; }
  const check = checkPinnedVersion(out, BEADS_VERSION);
  if (check.ok) return null;
  const lines = beadsMismatchLines(mismatch(check, 'path', '') as Extract<BeadsInstallResult, { state: 'version-mismatch' }>, host);
  return `  Warning:  ${lines.join(' ')}`;
}
