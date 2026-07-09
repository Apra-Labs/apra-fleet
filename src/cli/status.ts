import fs from 'node:fs';
import http from 'node:http';
import { checkRunningInstance } from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import type { ServiceStatus } from '../services/service-manager/types.js';
import { SERVER_INFO_PATH } from '../paths.js';

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

export async function runStatus(_args: string[]): Promise<void> {
  const instance = await checkRunningInstance();
  const svcMgr = await getServiceManager();
  const svcStatus: ServiceStatus = await svcMgr.query().catch(() => ({ installed: false, running: false }));

  let serviceLabel: string;
  if (!svcStatus.installed) {
    serviceLabel = 'not installed';
  } else if (svcStatus.enabled) {
    serviceLabel = 'installed (enabled)';
  } else {
    serviceLabel = 'installed (disabled)';
  }

  if (!instance.running) {
    console.log('apra-fleet status');
    console.log(`  State:    stopped`);
    console.log(`  Service:  ${serviceLabel}`);
    return;
  }

  const info = readServerInfo();
  const health = await getHealth(instance.url);

  console.log('apra-fleet status');
  console.log(`  State:    running`);
  if (info.pid) console.log(`  PID:      ${info.pid}`);
  if (info.port) console.log(`  Port:     ${info.port}`);
  console.log(`  URL:      ${instance.url}`);
  if (health?.version) console.log(`  Version:  ${health.version}`);
  if (health?.uptime !== undefined) console.log(`  Uptime:   ${formatUptime(health.uptime)}`);
  if (health?.sessions !== undefined) console.log(`  Sessions: ${health.sessions}`);
  console.log(`  Service:  ${serviceLabel}`);
}
