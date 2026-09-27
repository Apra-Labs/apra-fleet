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

/** Minimum Node.js version fleet-se requires (major.minor.patch). */
export const MIN_NODE_VERSION = '22.16.0';

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
  options?: { shell?: boolean },
) => string | Buffer;

function defaultExec(file: string, args: string[], options: { shell?: boolean } = {}): string {
  return String(
    execFileSync(file, args, { encoding: 'utf-8', stdio: 'pipe', ...options }),
  );
}

export interface FleetSePrereqDeps {
  /** Injectable process spawner -- defaults to a real execFileSync wrapper. */
  exec: FleetSePrereqExec;
  /** Injectable platform value -- defaults to process.platform. */
  platform: NodeJS.Platform;
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
    const raw = exec('node', ['--version']);
    const version = parseVersionString(raw);
    if (!version) return { present: false, version: null, satisfiesMin: false };
    return { present: true, version, satisfiesMin: compareVersions(version, MIN_NODE_VERSION) >= 0 };
  } catch {
    return { present: false, version: null, satisfiesMin: false };
  }
}

function probeNpm(exec: FleetSePrereqExec, platform: NodeJS.Platform): FleetSePrereqProbe {
  // npm on Windows resolves to an npm-generated `.cmd` shim, not a directly
  // spawnable executable -- handle that explicitly here rather than assuming
  // 'npm' resolves the same way it does on POSIX (see scripts/lib/exec-bd.mjs's
  // module doc for the same shim problem in bd's own cross-platform launcher).
  const file = platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = platform === 'win32' ? { shell: true } : {};
  try {
    const raw = exec(file, ['--version'], options);
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
 * function passed here (or the real default) always spawns via an argv
 * array, never a shell-interpolated string. Reports only -- callers decide
 * what to do (print, exit, etc.); this module never touches the console or
 * process.exit.
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
