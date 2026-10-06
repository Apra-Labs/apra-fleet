// fleet-se (fleet-sprint engine, fleet supervisor, bd) prerequisite detection
// (apra-fleet-i9ag.13.7.1).
//
// SCOPE NOTE: this module implements the owner re-scope recorded on
// apra-fleet-i9ag.13 (superseding that bead's original description): bd does
// NOT ship as a standalone release binary. fleet-se REQUIRES Node.js 22.16+
// and npm by design; apra-fleet core itself stays node-free. This is the
// single, shared definition of that prerequisite -- every consumer (the
// installer, `apra-fleet status`, the console Health page) is expected to
// import from here so there is exactly one operator-facing fix message.
//
// The exec function AND the platform value are both injectable (with real
// defaults) so the win32 and POSIX probe branches are exercisable from any
// host, mirroring the injected-asset-source convention in
// src/console/static.ts and the injected resolveWindowsBd convention in
// scripts/lib/exec-bd.mjs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Minimum Node.js version fleet-se requires (major.minor.patch). */
export const MIN_NODE_VERSION = '22.16.0';

/**
 * Wall-clock ceiling for a single `--version` probe (apra-fleet-i9ag.12.15).
 * A probe that never returns -- an interpreter wedged on a broken shim, a
 * network-mounted PATH entry that hangs, an npm prefix on an unresponsive
 * filesystem -- must never hang the installer indefinitely. execFileSync
 * kills the child at this deadline and throws, which the probes already
 * treat as "not present", so a hung prerequisite fails loudly and fast
 * instead of silently stalling `apra-fleet install`.
 */
export const PREREQ_PROBE_TIMEOUT_MS = 15_000;

/** Exact operator-facing fix line every consumer must surface verbatim. */
export const FLEET_SE_PREREQ_FIX_LINE =
  'fleet-se requires Node.js 22.16+ and npm: install them and re-run, or use --workflows none for the core console only';

/**
 * Injectable command runner used to probe `node --version` / `npm --version`.
 * Mirrors node:child_process's execFileSync signature closely enough that the
 * real implementation is a thin wrapper, while still being trivially fakeable
 * in tests. Must throw on a failed spawn (e.g. ENOENT) -- never return a
 * falsy/empty success value to signal absence.
 */
export type FleetSePrereqExec = (
  file: string,
  args: string[],
  options?: { shell?: boolean; timeout?: number },
) => string | Buffer;

function defaultExec(
  file: string,
  args: string[],
  options: { shell?: boolean; timeout?: number } = {},
): string {
  return String(
    execFileSync(file, args, { encoding: 'utf-8', stdio: 'pipe', ...options }),
  );
}

/**
 * Options every prerequisite probe spawns with.
 *
 * `shell: true` is NOT a POSIX-only nicety: on Windows both `node` and `npm`
 * routinely resolve to a `.cmd` shim rather than a directly spawnable `.exe`
 * (nvm-windows installs node exactly this way), and Node refuses to spawn a
 * `.cmd` without a shell -- so a shell-less probe reports a perfectly good
 * toolchain as NOT INSTALLED. The argv array is fixed literals with no
 * user/environment interpolation, so routing through a shell introduces no
 * expansion the CLAUDE.md rule warns about.
 */
const PROBE_OPTIONS = { shell: true, timeout: PREREQ_PROBE_TIMEOUT_MS } as const;

export interface FleetSePrereqDeps {
  /** Injectable process spawner -- defaults to a real execFileSync wrapper. */
  exec: FleetSePrereqExec;
  /** Injectable platform value -- defaults to process.platform. */
  platform: NodeJS.Platform;
  /** Injectable symlink resolver for the POSIX bd path -- defaults to fs.realpathSync. */
  realpath: (p: string) => string;
}

export interface FleetSePrereqProbe {
  present: boolean;
  version: string | null;
}

export interface FleetSeNodeProbe extends FleetSePrereqProbe {
  satisfiesMin: boolean;
}

export interface FleetSePrereqResult {
  node: FleetSeNodeProbe;
  npm: FleetSePrereqProbe;
  ok: boolean;
  missing: string[];
}

/**
 * Parses a version string (with or without a leading 'v', and tolerant of
 * trailing whitespace/build metadata) into a normalized "major.minor.patch"
 * string. Returns null when no version-like substring is found.
 */
function parseVersionString(raw: string | Buffer | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Numeric major.minor.patch comparison -- NEVER a string compare (22.9.0 < 22.16.0). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function probeNode(exec: FleetSePrereqExec): FleetSeNodeProbe {
  try {
    const raw = exec('node', ['--version'], { ...PROBE_OPTIONS });
    const version = parseVersionString(raw);
    if (!version) return { present: false, version: null, satisfiesMin: false };
    return { present: true, version, satisfiesMin: compareVersions(version, MIN_NODE_VERSION) >= 0 };
  } catch {
    return { present: false, version: null, satisfiesMin: false };
  }
}

function probeNpm(exec: FleetSePrereqExec, platform: NodeJS.Platform): FleetSePrereqProbe {
  // npm on Windows resolves to an npm-generated `.cmd` shim, not a directly
  // spawnable executable -- name it explicitly here rather than assuming
  // 'npm' resolves the same way it does on POSIX (see scripts/lib/exec-bd.mjs's
  // module doc for the same shim problem in bd's own cross-platform launcher).
  // PROBE_OPTIONS supplies the `shell: true` that makes spawning that shim
  // possible at all.
  const file = platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const raw = exec(file, ['--version'], { ...PROBE_OPTIONS });
    const version = parseVersionString(raw);
    return { present: version !== null, version };
  } catch {
    return { present: false, version: null };
  }
}

/**
 * Human-readable one-line summary of a FleetSePrereqResult, shared by every
 * fleet-se prerequisite consumer OTHER than the installer (which has its own
 * bd-inclusive format in src/cli/install.ts) -- currently `apra-fleet status`
 * (src/cli/status.ts) and the console Health page's server-side status route
 * (src/tools/check-status.ts). Never restates MIN_NODE_VERSION or
 * FLEET_SE_PREREQ_FIX_LINE as its own literal (apra-fleet-i9ag.12.9) -- both
 * are always sourced from this module's own constants, so there is exactly
 * one operator-facing fix message no matter which surface renders it.
 */
export function summarizeFleetSePrereqs(result: FleetSePrereqResult): string {
  if (result.ok) {
    return `ready (node ${result.node.version}, npm ${result.npm.version})`;
  }
  const reasons: string[] = [];
  if (!result.node.present) {
    reasons.push('node: NOT INSTALLED');
  } else if (!result.node.satisfiesMin) {
    reasons.push(`node: ${result.node.version} (requires ${MIN_NODE_VERSION}+)`);
  }
  if (!result.npm.present) {
    reasons.push('npm: NOT INSTALLED');
  }
  return `NOT INSTALLED (${reasons.join(', ')}) -- ${FLEET_SE_PREREQ_FIX_LINE}`;
}

/**
 * Detects whether the current host satisfies fleet-se's prerequisites
 * (Node.js >= MIN_NODE_VERSION and a working npm). Never rely on shell-level
 * variable expansion in the invoked command (CLAUDE.md rule) -- the exec
 * function passed here (or the real default) always passes the command and
 * its arguments as an argv array of fixed literals, never a caller- or
 * environment-interpolated command string, so the `shell: true` that
 * PROBE_OPTIONS needs for Windows `.cmd` shims expands nothing. Reports only
 * -- callers decide what to do (print, exit, etc.); this module never touches
 * the console or process.exit.
 */
export function detectFleetSePrereqs(deps: Partial<FleetSePrereqDeps> = {}): FleetSePrereqResult {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;

  const node = probeNode(exec);
  const npm = probeNpm(exec, platform);

  const missing: string[] = [];
  if (!node.present || !node.satisfiesMin) missing.push('node');
  if (!npm.present) missing.push('npm');

  return { node, npm, ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// resolveFleetSeToolchainPaths (apra-fleet-i9ag.19.1)
// ---------------------------------------------------------------------------
//
// The installed fleet-supervisor service resolves `node` (and `bd`) through
// whatever PATH its service manager hands it. macOS launchd and a Windows
// scheduled task do not inherit the login shell's PATH, so a node installed
// by nvm/fnm/volta is invisible to the service. Knowing the ABSOLUTE path of
// the node and bd the installer itself successfully probed is the first step
// toward recording that path for the service to use later
// (apra-fleet-i9ag.19.2). This function only resolves and reports -- it never
// writes config or touches the console/process.exit, mirroring
// detectFleetSePrereqs()'s own "report only" contract above.

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Result of resolving a single toolchain binary's absolute path. */
export interface FleetSeToolchainProbe {
  /** Absolute path to the resolved binary, or null if resolution failed. */
  path: string | null;
  /** Parsed version string, or null if unknown/unavailable. */
  version: string | null;
  /** True only when the path was resolved (and, for node, satisfies MIN_NODE_VERSION). */
  ok: boolean;
  /**
   * Human-readable diagnostic. For node, non-null exactly when ok is false
   * (why resolution/the version gate failed). For bd, resolution failing
   * (ok:false) sets this the same way, but a resolved bdPath whose OWN
   * version probe then failed also sets this to a non-null advisory while
   * ok stays true (apra-fleet-i9ag.19.27) -- bd's version is diagnostic
   * only, never load-bearing for `ok`. Always check `ok` first; a non-null
   * `reason` under `ok:true` is advisory, not a failure.
   */
  reason: string | null;
}

export interface FleetSeToolchainPaths {
  node: FleetSeToolchainProbe;
  bd: FleetSeToolchainProbe;
}

/**
 * Resolves node's absolute interpreter path by asking node itself
 * (`node -p process.execPath`) rather than trusting PATH resolution -- this
 * is what makes a version-manager shim (nvm/fnm/volta) resolve to the real
 * interpreter instead of to the shim script. Reuses probeNode() for the
 * version/satisfiesMin verdict so there is exactly one version-compare
 * implementation. Never throws: every probe failure becomes ok:false plus a
 * human reason naming which probe failed.
 */
function resolveNodePath(exec: FleetSePrereqExec): FleetSeToolchainProbe {
  let execPath: string | null = null;
  let pathReason: string | null = null;
  try {
    const raw = exec('node', ['-p', 'process.execPath'], { ...PROBE_OPTIONS });
    const text = String(raw).trim();
    if (text.length > 0) {
      execPath = text;
    } else {
      pathReason = 'node -p process.execPath returned no output';
    }
  } catch (err) {
    pathReason = `node -p process.execPath failed: ${errorMessage(err)}`;
  }

  const versionProbe = probeNode(exec);
  const isAbsolute = execPath !== null && path.isAbsolute(execPath);

  const reasons: string[] = [];
  if (execPath === null) {
    reasons.push(pathReason ?? 'node -p process.execPath produced no usable path');
  } else if (!isAbsolute) {
    reasons.push(`node -p process.execPath returned a non-absolute path: ${execPath}`);
  }
  if (!versionProbe.satisfiesMin) {
    reasons.push(
      versionProbe.present
        ? `node --version reported ${versionProbe.version}, below the minimum ${MIN_NODE_VERSION}`
        : `node --version probe failed, required ${MIN_NODE_VERSION}+`,
    );
  }

  return {
    path: execPath,
    version: versionProbe.version,
    ok: isAbsolute && versionProbe.satisfiesMin,
    reason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

/**
 * Extension-matcher for a Windows executable shim/binary. `where bd` can list
 * multiple candidates on PATH; only a `.cmd` or `.exe` line is something
 * cmd.exe can actually execute and resolveConfiguredWindowsBdScript()'s
 * `.cmd`-shape regex can parse.
 */
const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(cmd|exe)$/i;

/**
 * Picks the line `where bd` produced that resolveBdPath() should record on
 * win32. npm installs bd as BOTH an extensionless POSIX-shell shim
 * (`<prefix>\npm\bd`) and a `bd.cmd`, and `where bd` lists the extensionless
 * shim FIRST -- so selection here is by EXECUTABLE EXTENSION, never by line
 * index (apra-fleet-i9ag.19 judge defect D2). Swapping the order of the same
 * two lines must select the same `.cmd`/`.exe`. When only extensionless
 * candidates exist, that is an explicit, documented degraded outcome
 * (path: null, ok: false, reason naming what was found) -- never a silently
 * recorded unusable path.
 */
function pickWindowsBdLine(lines: string[]): { path: string | null; reason: string | null } {
  const executable = lines.find((line) => WINDOWS_EXECUTABLE_EXTENSION_RE.test(line));
  if (executable !== undefined) return { path: executable, reason: null };
  if (lines.length > 0) {
    return {
      path: null,
      reason: `where bd found no .cmd/.exe on PATH, only non-executable candidate(s) cmd.exe cannot run: ${lines.join(', ')}`,
    };
  }
  return { path: null, reason: 'where bd returned no output' };
}

/** Mirrors packages/apra-fleet-se/src/supervisor/node-version.mjs's
 *  quoteForWindowsShell() (not imported: this root build does not depend on the
 *  se workspace): wraps a whitespace-bearing token in double quotes, doubling
 *  embedded quotes (cmd.exe's convention). */
function quoteForWindowsShell(token: string): string {
  if (!/\s/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Resolves bd's absolute path via a platform lookup ('where bd' on win32,
 * preferring the .cmd/.exe candidate; 'which bd' elsewhere, first non-empty
 * line) and its version by probing THAT resolved path directly (never a
 * fresh bare-'bd' PATH lookup, which could silently resolve to a different
 * binary than the one just picked -- e.g. a PATH ordering difference between
 * the lookup and the probe, or a shell function/alias named `bd`). bd being
 * absent is NOT an error here -- unlike node, bd is not a hard fleet-se
 * prerequisite this module enforces (see the module doc comment's SCOPE
 * NOTE) -- it just yields ok:false plus a reason.
 *
 * ok reflects PATH resolution only: once an absolute bdPath is found, ok
 * stays true even if the version probe against that path then fails (bd's
 * version is diagnostic, not load-bearing for the install to proceed).
 * apra-fleet-i9ag.19.27: that failure is no longer silently dropped -- it is
 * surfaced in `reason` alongside `ok:true`, which is why this probe's
 * `reason` is NOT exclusively "why ok is false" the way resolveNodePath()'s
 * is; a caller must check `ok` first and treat a non-null `reason` under
 * `ok:true` as an advisory (bd's version could not be confirmed), not a
 * failure. Never throws.
 */
function resolveBdPath(
  exec: FleetSePrereqExec,
  platform: NodeJS.Platform,
  realpath: (p: string) => string = fs.realpathSync,
): FleetSeToolchainProbe {
  const lookupFile = platform === 'win32' ? 'where' : 'which';

  let bdPath: string | null = null;
  let reason: string | null = null;
  let realpathReason: string | null = null;
  try {
    const raw = exec(lookupFile, ['bd'], { ...PROBE_OPTIONS });
    const lines = String(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (platform === 'win32') {
      const picked = pickWindowsBdLine(lines);
      bdPath = picked.path;
      reason = picked.reason;
    } else if (lines.length > 0) {
      bdPath = lines[0];
      // Record the symlink-resolved real path: a PATH entry can be a per-shell
      // symlink dir (e.g. fnm multishell) that vanishes after this process
      // exits. A realpath failure is advisory only -- keep the PATH-found path.
      try {
        bdPath = realpath(bdPath);
      } catch (err) {
        realpathReason = `could not resolve the symlink-resolved real path of ${bdPath}; recording the PATH-found path (${errorMessage(err)})`;
      }
    } else {
      reason = `${lookupFile} bd returned no output`;
    }
  } catch (err) {
    reason = `bd not found on PATH (${lookupFile} bd failed: ${errorMessage(err)})`;
  }

  let version: string | null = null;
  let versionProbeReason: string | null = null;
  if (bdPath !== null) {
    try {
      // apra-fleet-i9ag.19.48: PROBE_OPTIONS' shell:true makes cmd.exe word-split
      // a win32 path containing a space (C:\Program Files\..., a profile under
      // C:\Users\Jane Doe\), so quote it for the win32 shell only. The recorded
      // `path` stays unquoted; the POSIX argv path is never quoted.
      const probeTarget = platform === 'win32' ? quoteForWindowsShell(bdPath) : bdPath;
      const raw = exec(probeTarget, ['--version'], { ...PROBE_OPTIONS });
      const parsed = parseVersionString(raw);
      const trimmed = String(raw).trim();
      version = parsed ?? (trimmed.length > 0 ? trimmed : null);
    } catch (err) {
      versionProbeReason = `bd --version failed for ${bdPath}: ${errorMessage(err)}`;
    }
  }

  return {
    path: bdPath,
    version,
    ok: bdPath !== null,
    // Path resolution failing is fatal to this probe (reason names why);
    // a resolved path whose version probe then failed is NOT fatal (ok
    // stays true) but the diagnostic is still surfaced, never discarded.
    reason: bdPath !== null
      ? ([realpathReason, versionProbeReason].filter((r): r is string => r !== null).join('; ') || null)
      : reason,
  };
}

/**
 * Resolves the absolute paths of node and bd that the installer itself
 * successfully probed, so a later step (apra-fleet-i9ag.19.2) can record
 * them into supervisor.config.json for a service manager that does not
 * inherit the login shell's PATH (macOS launchd, a Windows scheduled task).
 * Both the exec function and the platform value are injectable, mirroring
 * detectFleetSePrereqs() above, so both the win32 and POSIX lookup branches
 * are exercisable from any host with no real node/bd anywhere. Never throws.
 */
export function resolveFleetSeToolchainPaths(
  deps: Partial<FleetSePrereqDeps> = {},
): FleetSeToolchainPaths {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;

  return {
    node: resolveNodePath(exec),
    bd: resolveBdPath(exec, platform, deps.realpath ?? fs.realpathSync),
  };
}
