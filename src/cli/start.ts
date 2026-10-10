import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  checkRunningInstance, describePreviousServer, isPortInUse, portInUseMessage, readServerInfoPid,
  unresponsiveInstanceMessage,
} from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { LOG_FILE_PATH, FLEET_DIR, DEFAULT_HOST, isNonDefaultInstance, resolveServerPort } from '../paths.js';
import { ensureOwnerOnlyDir, openOwnerOnlyAppend } from '../utils/owner-only-fs.js';
import { BIN_DIR } from './config.js';
import { serverVersion } from '../version.js';
import { clearStoppedMarker, readStoppedMarker } from '../services/stopped-marker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isSea(): boolean {
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}

function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'version.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find project root (version.json not found)');
}

/** Parsed `start` options. All optional; with none, start behaves as it always has. */
export interface StartOptions {
  /** Write the direct-spawned server's pid here (a standalone server the fleet started). */
  pidfile?: string;
  /** Same as APRA_FLEET_AUTOSTART=1: refuse (never clear) a user stop. Used by the fleet's member start. */
  autostart: boolean;
  /** How long to wait for /health after launching (default 2000ms). */
  timeoutMs: number;
}

const DEFAULT_START_WAIT_MS = 2000;
const START_POLL_MS = 500;
/** Lines of the server log printed when the server does not come up. */
export const START_LOG_TAIL_LINES = 20;

/** Parse `start` arguments. Unknown arguments are ignored (older callers pass none). */
export function parseStartArgs(args: string[]): StartOptions | { error: string } {
  const out: StartOptions = { autostart: false, timeoutMs: DEFAULT_START_WAIT_MS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--autostart') out.autostart = true;
    else if (a === '--pidfile' || a === '--timeout-ms') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} requires a value` };
      if (a === '--pidfile') out.pidfile = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return { error: `--timeout-ms must be a non-negative integer, got '${v}'` };
        out.timeoutMs = Math.max(n, DEFAULT_START_WAIT_MS);
      }
    }
  }
  return out;
}

/** The last `lines` lines of the server log, or null when there is none. */
export function serverLogTail(logPath: string = LOG_FILE_PATH, lines = START_LOG_TAIL_LINES): string | null {
  try {
    // Only the end of the log is read: fleet.log grows without bound.
    const MAX = 64 * 1024;
    const size = fs.statSync(logPath).size;
    let text: string;
    if (size > MAX) {
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(MAX);
        const n = fs.readSync(fd, buf, 0, MAX, size - MAX);
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = String(fs.readFileSync(logPath, 'utf8'));
    }
    text = text.replace(/\s+$/, '');
    if (!text) return null;
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return null;
  }
}

interface SpawnedServer {
  pid?: number;
  /** Set once the spawned server process has exited (it died during startup). */
  exited: () => { code: number | null; signal: string | null } | null;
}

function directSpawn(): SpawnedServer {
  let cmd: string;
  let spawnArgs: string[];
  if (isSea()) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    cmd = path.join(BIN_DIR, `apra-fleet${ext}`);
    spawnArgs = ['--transport', 'http'];
  } else {
    cmd = process.execPath;
    spawnArgs = [path.join(findProjectRoot(), 'dist', 'index.js'), '--transport', 'http'];
  }
  // The service log and data dir are owner-only (see owner-only-fs.ts);
  // a tightening failure is reported, never fatal.
  const permProblems = ensureOwnerOnlyDir(FLEET_DIR);
  const logFd = openOwnerOnlyAppend(LOG_FILE_PATH, permProblems);
  for (const why of permProblems) console.error(`Warning: ${why}`);
  // Never hand launch markers to the long-running server.
  const env = { ...process.env };
  delete env.APRA_FLEET_AUTOSTART;
  delete env.APRA_FLEET_SERVICE;
  const child = spawn(cmd, spawnArgs, {
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  let exit: { code: number | null; signal: string | null } | null = null;
  if (typeof (child as { once?: unknown }).once === 'function') {
    child.once('exit', (code, signal) => { exit = { code, signal }; });
  }
  child.unref();
  fs.closeSync(logFd);
  console.log('Server starting...');
  return { pid: child.pid, exited: () => exit };
}

export async function runStart(args: string[]): Promise<void> {
  const opts = parseStartArgs(args);
  if ('error' in opts) {
    console.error(`Error: ${opts.error}`);
    process.exit(1);
    return;
  }
  if (opts.autostart) process.env.APRA_FLEET_AUTOSTART = '1';
  // An explicit start ends a user stop: clients may auto-start again. A start
  // launched BY a client auto-start (APRA_FLEET_AUTOSTART=1) must never erase
  // a stop that raced it -- it refuses instead.
  // Read the auto-start flag once and drop it, so the server spawned below
  // (and everything it spawns) never inherits it -- a later `apra-fleet start`
  // from one of those processes must clear a stop normally.
  const autoStarted = process.env.APRA_FLEET_AUTOSTART === '1';
  delete process.env.APRA_FLEET_AUTOSTART;
  if (autoStarted) {
    const stopped = readStoppedMarker();
    if (stopped) {
      console.error(`apra-fleet was stopped by the user at ${stopped.stoppedAt} via '${stopped.by}'; not auto-starting it. Run 'apra-fleet start'.`);
      process.exit(1);
      return;
    }
  } else {
    clearStoppedMarker();
  }
  const instance = await checkRunningInstance();
  if (instance.running) {
    if (instance.version && instance.version !== serverVersion) {
      console.error(
        `Server already running at ${instance.url} pid=${instance.pid} is version ${instance.version}, `
        + `but the installed version is ${serverVersion}. Refusing to reuse a stale server -- `
        + `stop it (apra-fleet stop) and re-run start.`,
      );
      process.exit(1);
    }
    console.log(`Server already running at ${instance.url} pid=${instance.pid}`);
    return;
  }
  // GitHub #585: a stale server.json means the previous server died uncleanly.
  const previousNote = instance.state === 'gone' ? describePreviousServer(instance.previous) : null;
  if (previousNote) console.log(`Note: ${previousNote}; its stale server.json was removed.`);
  if (instance.state === 'unresponsive') {
    console.error(unresponsiveInstanceMessage(instance));
    process.exit(1);
    return;
  }
  // The server does not fall back to a random port when its configured
  // port is taken (GitHub #584): fail here with the actionable message
  // instead of spawning a server that exits immediately.
  const serverPort = resolveServerPort();
  if (await isPortInUse(serverPort, DEFAULT_HOST)) {
    // Name who holds it: another user's process (a second member install on
    // this host) gets its own refusal with the remedy; otherwise the holder
    // pid is appended when it is visible.
    const { findPortHolder, describePortConflict } = await import('../services/port-holder.js');
    const conflict = describePortConflict(serverPort, portInUseMessage(serverPort, readServerInfoPid()), await findPortHolder(serverPort));
    console.error(conflict.message);
    process.exit(1);
    return;
  }

  const svcMgr = await getServiceManager();
  const installed = await svcMgr.isInstalled();
  let spawned: SpawnedServer | null = null;

  // A sandboxed instance (non-default port or data dir) must never touch the
  // machine-global service registration -- always direct-spawn instead of
  // calling svcMgr.start(), even when the service manager reports installed.
  // See apra-fleet-eft.51.
  if (installed && !isNonDefaultInstance()) {
    try {
      await svcMgr.start();
      console.log('Server starting via service manager...');
    } catch (err: any) {
      // isInstalled() can report true from a unit file alone even when
      // registration never fully completed (e.g. daemon-reload failed for
      // lack of a D-Bus/systemd user session on a headless runner) -- in
      // that case svcMgr.start() fails the same way. Fall back to a direct
      // spawn instead of hard-failing, same as the "not installed" path.
      console.warn(`Service manager start failed (${err.message}); falling back to direct spawn.`);
      spawned = directSpawn();
    }
  } else {
    spawned = directSpawn();
  }
  // A standalone (direct-spawned) server: record its pid where the caller asked.
  if (spawned && opts.pidfile && spawned.pid) {
    try {
      fs.mkdirSync(path.dirname(opts.pidfile), { recursive: true });
      fs.writeFileSync(opts.pidfile, `${spawned.pid}\n`);
    } catch (err: unknown) {
      console.warn(`Warning: could not write the pidfile ${opts.pidfile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Wait for /health: the first check after 2s (as always), then poll until
  // the requested timeout, stopping early when the spawned server died.
  const deadline = Date.now() + opts.timeoutMs;
  await new Promise<void>(resolve => setTimeout(resolve, DEFAULT_START_WAIT_MS));
  let result = await checkRunningInstance();
  while (!result.running && !spawned?.exited() && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, START_POLL_MS));
    result = await checkRunningInstance();
  }
  if (result.running) {
    console.log(`Server started at ${result.url} pid=${result.pid}`);
    return;
  }
  const died = spawned?.exited();
  const why = died
    ? `Server process exited during startup (${died.signal ? `signal ${died.signal}` : `exit code ${died.code}`}).`
    : `Server did not start in time (no /health answer within ${Math.round(opts.timeoutMs / 1000)}s).`;
  console.error(`${why} Check logs at: ${LOG_FILE_PATH}`);
  const tail = serverLogTail();
  if (tail) console.error(`Last lines of ${LOG_FILE_PATH}:\n${tail}`);
  process.exit(1);
}
