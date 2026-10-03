import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRunningInstance } from '../services/singleton.js';
import { SERVER_INFO_PATH, FLEET_DIR, isNonDefaultInstance } from '../paths.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { isApraFleetProcess, isPidAlive, postShutdown } from '../utils/process-utils.js';
import { writeStoppedMarker } from '../services/stopped-marker.js';

export async function runStop(_args: string[]): Promise<void> {
  // Record the deliberate stop FIRST, so no client auto-starts the server
  // while (or after) it goes down; 'apra-fleet start' / install clear it.
  writeStoppedMarker('apra-fleet stop');
  // A sandboxed instance (non-default port or data dir) must never touch the
  // machine-global service registration -- symmetric with runStart(). It
  // stops only its own server via its data dir's server.json.
  const sandboxed = isNonDefaultInstance();
  if (sandboxed) {
    console.log('Non-default instance: stopping only this instance (registered OS services are not touched).');
  } else {
    const svcMgr = await getServiceManager();
    if (await svcMgr.isInstalled()) {
      if (await svcMgr.stop() === false) {
        // The refusal reason was already printed; the server is still up.
        process.exitCode = 1;
        return;
      }
      console.log('Server stopped.');
      return;
    }
  }

  const instance = await checkRunningInstance();
  // An unresponsive server (alive, not answering /health) is still a server:
  // fall through to the graceful-then-forced stop below.
  if (!instance.running && instance.state !== 'unresponsive') {
    console.log('Server is not running.');
    return;
  }
  if (!instance.running) {
    console.log(`Server pid ${instance.pid} is not answering /health; stopping it.`);
  }

  // Port-only override shares the default data dir, so server.json may
  // describe another instance (e.g. production) -- refuse unless it is ours.
  if (sandboxed && !process.env.APRA_FLEET_DATA_DIR) {
    const expectedPort = parseInt(process.env.APRA_FLEET_PORT ?? '', 10) || 7523;
    let port = NaN;
    try { port = Number(new URL(instance.url).port); } catch {}
    if (port !== expectedPort) {
      console.log(`Server is not running on port ${expectedPort} (found ${instance.url}; not stopping it).`);
      return;
    }
  }

  const { pid, url } = instance;
  await postShutdown(url);

  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }

  if (isPidAlive(pid)) {
    // GitHub #584 review: pids are reused -- only force-kill a process that
    // is verifiably still an apra-fleet server.
    const isFleet = isApraFleetProcess(pid);
    if (isFleet !== true) {
      console.error(
        `Server pid ${pid} did not exit after /shutdown, and it ${isFleet === false ? 'is not' : 'could not be verified as'} `
        + `an apra-fleet process -- not force-killing it. Check pid ${pid} yourself; server.json was left in place.`,
      );
      process.exitCode = 1;
      return;
    }
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'pipe', windowsHide: true, timeout: 10_000 }); } catch {}
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  const lockPath = path.join(FLEET_DIR, 'server.lock');
  try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}

  console.log('Server stopped.');
}
