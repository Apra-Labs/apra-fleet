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

function directSpawn(): void {
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
  child.unref();
  fs.closeSync(logFd);
  console.log('Server starting...');
}

export async function runStart(_args: string[]): Promise<void> {
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
      directSpawn();
    }
  } else {
    directSpawn();
  }

  await new Promise<void>(resolve => setTimeout(resolve, 2000));
  const result = await checkRunningInstance();
  if (result.running) {
    console.log(`Server started at ${result.url} pid=${result.pid}`);
  } else {
    console.error(`Server did not start in time. Check logs at: ${LOG_FILE_PATH}`);
    process.exit(1);
  }
}
