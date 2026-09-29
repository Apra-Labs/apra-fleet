import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRunningInstance } from '../services/singleton.js';
import { SERVER_INFO_PATH, FLEET_DIR, isNonDefaultInstance } from '../paths.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { isPidAlive, postShutdown } from '../utils/process-utils.js';

/**
 * Stop the fleet-supervisor service when it is registered. Best-effort and
 * independent of the MCP server's own stop path -- the supervisor never writes
 * server.json, so its manager stops it through the platform supervisor
 * (systemctl stop / launchctl bootout on Unix; a process-tree kill on
 * Windows). Best-effort means tolerating "not registered"/"already stopped",
 * NOT reporting a failed termination as success: the manager throws when it
 * cannot confirm the process is gone, and that lands in the catch below as a
 * warning instead of "Fleet supervisor service stopped."
 *
 * The registration is machine-global, so a sandboxed (non-default port or
 * data dir) instance never touches it -- symmetric with
 * startSupervisorServiceIfInstalled() in start.ts.
 */
export async function stopSupervisorServiceIfInstalled(opts: { strict?: boolean } = {}): Promise<void> {
  if (isNonDefaultInstance()) return;
  try {
    const supervisorMgr = await getServiceManager('fleet-supervisor');
    if (!(await supervisorMgr.isInstalled())) return;
    await supervisorMgr.stop();
    if (opts.strict) {
      // restart path: a supervisor still reported running after stop must not
      // fall through to start's "already running" no-op.
      const status = await supervisorMgr.query().catch(() => ({ installed: true, running: false }));
      if (status.running) {
        throw new Error('service still reported running after stop');
      }
    }
    console.log('Fleet supervisor service stopped.');
  } catch (err: any) {
    if (opts.strict) {
      throw new Error(`Fleet supervisor service could not be confirmed stopped (${err?.message ?? err}); restart aborted.`);
    }
    console.warn(`Fleet supervisor service stop failed (${err?.message ?? err}).`);
  }
}

export async function runStop(_args: string[], opts: { strictSupervisor?: boolean } = {}): Promise<void> {
  // A sandboxed instance (non-default port or data dir) must never touch the
  // machine-global service registrations (MCP server or fleet-supervisor) --
  // symmetric with runStart(). It stops only its own server via its data
  // dir's server.json.
  const sandboxed = isNonDefaultInstance();
  if (sandboxed) {
    console.log('Non-default instance: stopping only this instance (registered OS services are not touched).');
  } else {
    await stopSupervisorServiceIfInstalled({ strict: opts.strictSupervisor });

    const svcMgr = await getServiceManager();
    if (await svcMgr.isInstalled()) {
      await svcMgr.stop();
      console.log('Server stopped.');
      return;
    }
  }

  const instance = await checkRunningInstance();
  if (!instance.running) {
    console.log('Server is not running.');
    return;
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
