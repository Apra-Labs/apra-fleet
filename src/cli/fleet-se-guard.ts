/**
 * Install-time guard against upgrading under a running fleet-sprint
 * supervisor or sprint.
 *
 * A supervisor or sprint keeps running its old code after an upgrade, and
 * install --force replaces the fleet server underneath it. One started before
 * the member access secret existed (0.4.3 and earlier) never sends it, so
 * every call it makes gets HTTP 401 -- the sprint fails silently mid-run. In
 * general a running sprint should not have its server replaced underneath it,
 * so install refuses while one is running for
 * this OS user, unless the user explicitly passes IGNORE_RUNNING_SPRINTS_FLAG.
 * --force does NOT bypass this: --force only means "stop the running fleet
 * server", and `apra-fleet update` always passes it.
 *
 * The supervisor is not restarted automatically: this release never registers
 * a supervisor OS service (see services/supervisor-service-cleanup.ts), and the
 * supervisor writes no server.json, so there is nothing install could restart.
 *
 * Signals:
 *   - sprints: every fleet-sprint engine run (supervisor-launched or a direct
 *     `apra-fleet workflow fleet-sprint`) holds a pidfile lock under
 *     APRA_FLEET_SPRINT_LOCK_DIR or <tmpdir>/apra-fleet-sprint-locks
 *     (fleet-sprint/sprint-lock.mjs). A lock whose pid is alive is a running
 *     sprint. isPidAlive() is false on EPERM, so another user's sprints in a
 *     shared /tmp do not count. A lock left behind by a killed run can name a
 *     pid since reused by an unrelated process, so the pid's command line must
 *     also look like a fleet-sprint run; when it cannot be read the lock is
 *     skipped with a WARNING (fail open).
 *   - supervisor: GET /api/health on the default port 8787 and on the port the
 *     supervisor last logged in <FLEET_SE_DATA_DIR or ~/.apra-fleet-se>/logs/
 *     supervisor.log; a 200 with status ok + seams + a live pid is the
 *     supervisor. GET /api/sprints then names its sprints for the stop steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isPidAlive, processCommandLine } from '../utils/process-utils.js';
import { WORKFLOWS_DIR } from './config.js';

/** Installed supervisor entry point, resolved here (no shell ~ expansion). */
export const INSTALLED_SERVE_SCRIPT = path.join(WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs');

export const IGNORE_RUNNING_SPRINTS_FLAG = '--ignore-running-sprints';
export const DEFAULT_SUPERVISOR_PORT = 8787;

export interface RunningSupervisor { pid: number; port: number }
export interface RunningSprint { pid: number; sprintId?: string; lockFile?: string }
export interface RunningFleetSe {
  supervisor: RunningSupervisor | null;
  sprints: RunningSprint[];
  /** Detection caveats the caller prints as WARNINGs. */
  warnings?: string[];
}

/**
 * A fleet-sprint engine run: the supervisor's `node .../bin/cli.mjs ...`
 * (installed tree or an apra-fleet-se checkout) or the SEA's
 * `apra-fleet workflow fleet-sprint ...`.
 */
export function isFleetSprintCommandLine(cmd: string): boolean {
  return /apra-fleet|fleet-sprint|fleet-se|runner\.js|cli\.mjs/i.test(cmd);
}

export interface FleetSeProbes {
  lockDir: () => string;
  supervisorLogPath: () => string;
  readDir: (dir: string) => string[];
  readFile: (file: string) => string;
  isPidAlive: (pid: number) => boolean;
  /** Command line of a live pid, or null when it cannot be read. */
  commandLine: (pid: number) => string | null;
  /** Parsed JSON body of a 200 response, or null (refused, timeout, non-200, bad JSON). */
  getJson: (url: string) => Promise<unknown>;
  /** This process's own pid; a lock holding it is never a running sprint. */
  selfPid: () => number;
}

async function getJsonWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

export const realFleetSeProbes: FleetSeProbes = {
  lockDir: () => process.env.APRA_FLEET_SPRINT_LOCK_DIR || path.join(os.tmpdir(), 'apra-fleet-sprint-locks'),
  supervisorLogPath: () => path.join(
    process.env.FLEET_SE_DATA_DIR ? path.resolve(process.env.FLEET_SE_DATA_DIR) : path.join(os.homedir(), '.apra-fleet-se'),
    'logs', 'supervisor.log'),
  readDir: dir => fs.readdirSync(dir),
  readFile: file => fs.readFileSync(file, 'utf8'),
  isPidAlive,
  commandLine: processCommandLine,
  getJson: getJsonWithTimeout,
  selfPid: () => process.pid,
};

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Port from the supervisor's last "listening on http://localhost:<port>" log line, or null. */
function loggedSupervisorPort(probes: FleetSeProbes): number | null {
  let text: string;
  try { text = probes.readFile(probes.supervisorLogPath()); } catch (err) { if (isEnoent(err)) return null; throw err; }
  const matches = [...text.matchAll(/\[supervisor\] listening on http:\/\/localhost:(\d+)/g)];
  const port = matches.length > 0 ? Number(matches[matches.length - 1][1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * What fleet-se work is running for this OS user. Throws only on an
 * unexpected detection error (the caller then warns and proceeds).
 */
export async function detectRunningFleetSe(probes: FleetSeProbes = realFleetSeProbes): Promise<RunningFleetSe> {
  const sprints = new Map<number, RunningSprint>();
  const warnings: string[] = [];

  const lockDir = probes.lockDir();
  let lockFiles: string[] = [];
  try { lockFiles = probes.readDir(lockDir).filter(f => f.endsWith('.lock')); } catch (err) { if (!isEnoent(err)) throw err; }
  for (const f of lockFiles) {
    const lockFile = path.join(lockDir, f);
    let pid: number;
    try { pid = parseInt(probes.readFile(lockFile).trim(), 10); } catch (err) { if (isEnoent(err)) continue; throw err; }
    if (!Number.isInteger(pid) || pid <= 0 || pid === probes.selfPid() || !probes.isPidAlive(pid)) continue;
    const cmd = probes.commandLine(pid);
    if (cmd === null) {
      warnings.push(`could not read the command line of pid ${pid} (sprint lock ${lockFile}), so it is not treated as a running sprint. If it is one, stop it before upgrading.`);
      continue;
    }
    // Otherwise a stale lock whose pid was reused by an unrelated process.
    if (isFleetSprintCommandLine(cmd)) sprints.set(pid, { pid, lockFile });
  }

  let supervisor: RunningSupervisor | null = null;
  const ports = [DEFAULT_SUPERVISOR_PORT];
  const logged = loggedSupervisorPort(probes);
  if (logged !== null && logged !== DEFAULT_SUPERVISOR_PORT) ports.push(logged);
  for (const port of ports) {
    const health = await probes.getJson(`http://127.0.0.1:${port}/api/health`) as
      { status?: unknown; seams?: unknown; pid?: unknown } | null;
    if (!health || health.status !== 'ok' || typeof health.seams !== 'object' || health.seams === null) continue;
    if (typeof health.pid !== 'number' || !probes.isPidAlive(health.pid)) continue;
    supervisor = { pid: health.pid, port };
    const list = await probes.getJson(`http://127.0.0.1:${port}/api/sprints`) as
      { sprints?: Array<{ sprintId?: unknown; childPid?: unknown }> } | null;
    for (const s of list?.sprints ?? []) {
      if (typeof s.childPid !== 'number' || !probes.isPidAlive(s.childPid)) continue;
      const sprintId = typeof s.sprintId === 'string' ? s.sprintId : undefined;
      sprints.set(s.childPid, { ...sprints.get(s.childPid), pid: s.childPid, sprintId });
    }
    break;
  }

  return { supervisor, sprints: [...sprints.values()], warnings };
}

/** The refusal printed when fleet-se work is running. */
export function fleetSeRefusalText(found: RunningFleetSe, opts: {
  platform: NodeJS.Platform; rerunLines: string[]; ignoreLines: string[];
  /** Supervisor script to restart; defaults to the installed one. */
  serveScript?: string;
}): string {
  const serveScript = opts.serveScript ?? INSTALLED_SERVE_SCRIPT;
  const curl = opts.platform === 'win32' ? 'curl.exe' : 'curl';
  const sup = found.supervisor;
  const base = sup ? `http://localhost:${sup.port}` : `http://localhost:${DEFAULT_SUPERVISOR_PORT}`;
  const running: string[] = [];
  if (sup) running.push(`  - fleet-sprint supervisor: pid ${sup.pid}, ${base}`);
  for (const s of found.sprints) {
    const what = s.sprintId ? `sprint ${s.sprintId}` : 'fleet-sprint run';
    running.push(`  - ${what}: pid ${s.pid}${s.lockFile ? ` (lock file ${s.lockFile})` : ''}`);
  }
  const steps: string[] = [];
  if (found.sprints.length > 0) {
    steps.push('  1. Stop the running sprints or let them finish.');
    for (const s of found.sprints) {
      if (sup && s.sprintId) steps.push(`       ${curl} -X POST ${base}/api/sprints/${s.sprintId}/stop`);
    }
    if (found.sprints.some(s => !(sup && s.sprintId))) {
      steps.push('     A sprint started directly (apra-fleet workflow fleet-sprint) is stopped with Ctrl-C in its');
      steps.push('     console, or by ending its pid shown above. If that pid is not a fleet-sprint (a stale');
      steps.push('     lock whose pid was reused), delete the lock file instead.');
    }
  } else {
    steps.push('  1. No sprint is running.');
  }
  steps.push(sup
    ? `  2. Stop the supervisor:\n       ${curl} -X POST ${base}/api/shutdown`
    : '  2. No supervisor is running.');
  steps.push('  3. Upgrade:');
  for (const l of opts.rerunLines) steps.push(`       ${l}`);
  steps.push(sup
    ? [
      '  4. Restart the supervisor from your project folder (the one holding .beads), or add',
      '     --beads-dir <project folder>, then relaunch sprints:',
      `       node "${serveScript}"`,
    ].join('\n')
    : '  4. Relaunch the sprints.');
  return [
    '',
    'Error: E-FLEET-SE-RUNNING: fleet-sprint work is running for this user. Installing now replaces',
    'the fleet server underneath it while it keeps running its old code; a supervisor or sprint',
    'started before the member access secret existed (0.4.3 and earlier) then fails every call',
    'with HTTP 401. Nothing was stopped or installed.',
    '',
    'Running:',
    ...running,
    '',
    'To upgrade safely:',
    ...steps,
    '',
    'To install anyway (the processes above will fail until restarted):',
    ...opts.ignoreLines.map(l => `    ${l}`),
    '',
  ].join('\n');
}
