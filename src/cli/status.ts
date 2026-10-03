import fs from 'node:fs';
import http from 'node:http';
import { checkRunningInstance, describePreviousServer } from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import type { ServiceStatus } from '../services/service-manager/types.js';
import { SERVER_INFO_PATH } from '../paths.js';
import { readStoppedMarker, describeStoppedMarker } from '../services/stopped-marker.js';
import { serverVersion } from '../version.js';

function versionCore(v: string | undefined): string | null {
  // Capped like the client's versionCore: v comes from a server's /health reply.
  const m = /(\d{1,9}\.\d{1,9}\.\d{1,9})/.exec((v ?? '').slice(0, 64));
  return m ? m[1] : null;
}

interface HealthResponse {
  version?: string;
  uptime?: number;
  sessions?: number;
}

function getHealth(url: string): Promise<HealthResponse | null> {
  const healthUrl = url.replace(/\/mcp$/, '/health');
  const parsed = new URL(healthUrl);
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, timeout: 3000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function readServerInfo(): { pid?: number; port?: number; url?: string } {
  try {
    return JSON.parse(fs.readFileSync(SERVER_INFO_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** "installed (enabled)", "installed (disabled -- stopped by user ...)", "not installed". */
export function formatServiceLabel(svcStatus: ServiceStatus): string {
  if (!svcStatus.installed) return 'not installed';
  const state = svcStatus.enabled ? 'enabled' : 'disabled';
  return svcStatus.detail ? `installed (${state} -- ${svcStatus.detail})` : `installed (${state})`;
}

export async function runStatus(_args: string[]): Promise<void> {
  const instance = await checkRunningInstance();
  // GitHub #585: a stale server.json means the previous server died uncleanly.
  const previousNote = instance.state === 'gone' ? describePreviousServer(instance.previous) : null;
  if (previousNote) console.log(`Note: ${previousNote}; its stale server.json was removed.`);
  const svcMgr = await getServiceManager();
  const svcStatus: ServiceStatus = await svcMgr.query().catch(() => ({ installed: false, running: false }));

  const serviceLabel = formatServiceLabel(svcStatus);

  if (instance.state === 'unresponsive') {
    console.log('apra-fleet status');
    console.log(`  State:    unresponsive`);
    console.log(`  PID:      ${instance.pid}`);
    if (instance.port) console.log(`  Port:     ${instance.port}`);
    console.log(`  URL:      ${instance.url}`);
    console.log(`  Service:  ${serviceLabel}`);
    console.log('  The server process is alive but not answering /health. Run "apra-fleet stop" to stop it.');
    return;
  }

  if (!instance.running) {
    const marker = readStoppedMarker();
    console.log('apra-fleet status');
    console.log(`  State:    ${marker ? `stopped (${describeStoppedMarker(marker)})` : 'stopped'}`);
    console.log(`  Service:  ${serviceLabel}`);
    return;
  }

  const info = readServerInfo();
  const health = await getHealth(instance.url);

  const marker = readStoppedMarker();
  console.log('apra-fleet status');
  // A server running while the stop marker exists (e.g. a manual run): clients
  // will not auto-start it again if it dies until `apra-fleet start`.
  console.log(`  State:    running${marker ? " (stop marker set -- run 'apra-fleet start' to clear)" : ''}`);
  if (info.pid) console.log(`  PID:      ${info.pid}`);
  if (info.port) console.log(`  Port:     ${info.port}`);
  console.log(`  URL:      ${instance.url}`);
  if (health?.version) console.log(`  Version:  ${health.version}`);
  if (health?.uptime !== undefined) console.log(`  Uptime:   ${formatUptime(health.uptime)}`);
  if (health?.sessions !== undefined) console.log(`  Sessions: ${health.sessions}`);
  console.log(`  Service:  ${serviceLabel}`);
  const runningCore = versionCore(health?.version);
  const ownCore = versionCore(serverVersion);
  if (runningCore && ownCore && runningCore !== ownCore) {
    console.log(`  Warning:  the running server is ${health!.version} but this apra-fleet is ${serverVersion} -- stop it ('apra-fleet stop'), then run 'apra-fleet install' and 'apra-fleet start'.`);
  }
}
