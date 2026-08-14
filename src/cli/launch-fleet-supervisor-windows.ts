/**
 * Launch module for the fleet-sprint supervisor ("node bin/serve.mjs", port
 * 8787 -- see deploy.md's Caution note on `GET /api/sprints`).
 *
 * apra-fleet-5ti7.2: routes the Windows detached launch through the
 * hidden-launch helper (launchDetachedHidden, ../os/windows.ts) instead of a
 * hand-rolled per-session Invoke-CimMethod/`cmd /c start` incantation -- the
 * pattern that silently died from cmd.exe quote-stripping and left visible
 * console windows (apra-fleet-5ti7). On non-Windows this uses a detached
 * `spawn` + `unref()`, the programmatic equivalent of `nohup ... & disown`.
 *
 * This module intentionally lives in the root package rather than inside
 * packages/apra-fleet-se: apra-fleet-se does not (and should not) depend on
 * the root package -- see src/services/sprint-coordination.ts's header for
 * why that dependency direction is a deliberate boundary -- but launching
 * `bin/serve.mjs` detached is an operator/deploy-time action, not runtime
 * code executed BY the supervisor, so it has no need to live inside that
 * package; it only needs the supervisor's serve.mjs path as a target.
 *
 * CLI usage (after `npm run build`):
 *   node dist/cli/launch-fleet-supervisor-windows.js <repoRoot> [port]
 * `repoRoot` is the absolute path to the apra-fleet checkout whose
 * packages/apra-fleet-se/bin/serve.mjs should be launched. Exits non-zero
 * with the failure message on the console when the launch fails -- never a
 * silent no-op (apra-fleet-5ti7 AC4).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchDetachedHidden } from '../os/windows.js';
import type { DetachedLaunchExecutor, DetachedLaunchResult } from '../os/windows.js';
import { DATA_DIR } from './config.js';

/** The fleet-sprint supervisor's fixed HTTP port (see deploy.md). */
export const SUPERVISOR_PORT = 8787;

export interface LaunchSupervisorOptions {
  /** Absolute path to the apra-fleet checkout containing packages/apra-fleet-se. */
  repoRoot: string;
  /** Absolute path to the node executable to run serve.mjs with. Defaults to process.execPath. */
  nodeExecPath?: string;
  /** Absolute working directory for the child. Defaults to repoRoot. */
  cwd?: string;
  /** Absolute path of the file that receives the child's stdout/stderr. Defaults to DATA_DIR/fleet-supervisor.log. */
  logFile?: string;
}

function serveScriptPath(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'apra-fleet-se', 'bin', 'serve.mjs');
}

function resolveOptions(opts: LaunchSupervisorOptions): { command: string; args: string[]; cwd: string; logFile: string } {
  return {
    command: opts.nodeExecPath ?? process.execPath,
    args: [serveScriptPath(opts.repoRoot)],
    cwd: opts.cwd ?? opts.repoRoot,
    logFile: opts.logFile ?? path.join(DATA_DIR, 'fleet-supervisor.log'),
  };
}

/**
 * Windows: launch the fleet-sprint supervisor detached and hidden via the
 * shared helper. `exec` is an injectable executor seam so tests can spy on
 * the command without spawning a real process -- see
 * tests/windows-hidden-launch-helper.test.ts.
 */
export function launchFleetSupervisorWindows(
  opts: LaunchSupervisorOptions,
  exec?: DetachedLaunchExecutor,
): DetachedLaunchResult {
  const { command, args, cwd, logFile } = resolveOptions(opts);
  return launchDetachedHidden({ command, args, cwd, logFile }, exec);
}

/** POSIX: detached spawn + unref, the `nohup ... & disown` equivalent. */
export function launchFleetSupervisorPosix(
  opts: LaunchSupervisorOptions,
): { ok: true; pid: number } | { ok: false; error: string } {
  const { command, args, cwd, logFile } = resolveOptions(opts);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', out, err],
    });
    child.unref();
    if (child.pid == null) return { ok: false, error: 'spawn produced no pid' };
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isMainModule(): boolean {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const repoRoot = process.argv[2];
  if (!repoRoot) {
    console.error('Usage: node dist/cli/launch-fleet-supervisor-windows.js <repoRoot> [port]');
    process.exit(1);
  }
  const opts: LaunchSupervisorOptions = { repoRoot };

  if (process.platform === 'win32') {
    const result = launchFleetSupervisorWindows(opts);
    if (!result.ok) {
      console.error(`Failed to launch the fleet-sprint supervisor detached: ${result.error}\n${result.stderr}`);
      process.exit(1);
    }
    console.log(`Supervisor launched (pid=${result.pid}); poll port ${SUPERVISOR_PORT} and ${resolveOptions(opts).logFile} to confirm it came up.`);
  } else {
    const result = launchFleetSupervisorPosix(opts);
    if (!result.ok) {
      console.error(`Failed to launch the fleet-sprint supervisor detached: ${result.error}`);
      process.exit(1);
    }
    console.log(`Supervisor launched (pid=${result.pid}); poll port ${SUPERVISOR_PORT} and ${resolveOptions(opts).logFile} to confirm it came up.`);
  }
}
