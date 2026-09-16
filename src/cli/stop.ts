import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRunningInstance } from '../services/singleton.js';
import { SERVER_INFO_PATH, FLEET_DIR } from '../paths.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { isPidAlive, postShutdown } from '../utils/process-utils.js';

/**
 * Stop the fleet-supervisor service when it is registered. Best-effort and
 * independent of the MCP server's own stop path -- the supervisor never writes
 * server.json, so its manager stops it through the platform supervisor
 * (systemctl stop / launchctl bootout / schtasks /end).
 */
async function stopSupervisorServiceIfInstalled(): Promise<void> {
  try {
    const supervisorMgr = await getServiceManager('fleet-supervisor');
    if (!(await supervisorMgr.isInstalled())) return;
    await supervisorMgr.stop();
    console.log('Fleet supervisor service stopped.');
  } catch (err: any) {
    console.warn(`Fleet supervisor service stop failed (${err?.message ?? err}).`);
  }
}

export async function runStop(_args: string[]): Promise<void> {
  await stopSupervisorServiceIfInstalled();

  const svcMgr = await getServiceManager();
  if (await svcMgr.isInstalled()) {
    await svcMgr.stop();
    console.log('Server stopped.');
    return;
  }

  const instance = await checkRunningInstance();
  if (!instance.running) {
    console.log('Server is not running.');
    return;
  }

  const { pid, url } = instance;
  await postShutdown(url);

  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }

  if (isPidAlive(pid)) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  const lockPath = path.join(FLEET_DIR, 'server.lock');
  try { fs.unlinkSync(SERVER_INFO_PATH); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}

  console.log('Server stopped.');
}
