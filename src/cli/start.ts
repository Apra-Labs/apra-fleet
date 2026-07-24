import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { checkRunningInstance } from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { LOG_FILE_PATH, FLEET_DIR, isNonDefaultInstance } from '../paths.js';
import { BIN_DIR } from './config.js';

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
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE_PATH, 'a');
  const child = spawn(cmd, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  console.log('Server starting...');
}

export async function runStart(_args: string[]): Promise<void> {
  const instance = await checkRunningInstance();
  if (instance.running) {
    console.log(`Server already running at ${instance.url} pid=${instance.pid}`);
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
