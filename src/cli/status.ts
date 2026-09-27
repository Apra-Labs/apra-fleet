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

/**
 * Registration label for one service. THREE-STATE on purpose, because
 * `ServiceStatus.enabled` is genuinely tri-valued:
 *
 *   enabled === true       -> "installed (enabled)"
 *   enabled === false      -> "installed (disabled)"
 *   enabled === undefined  -> "installed", with NO enable claim at all
 *
 * The undefined case is not "disabled": it means this platform's manager could
 * not determine the auto-start state (macOS never reports one, and a Windows
 * host that cannot run the Get-ScheduledTask probe falls back to a schtasks
 * read that honestly declines to guess). Collapsing it into "disabled" is what
 * made `apra-fleet status` tell fresh Windows installs that both services were
 * disabled while they were running and answering /health -- a definite wrong
 * claim where saying less is correct. Loud honesty over a silent falsehood.
 */
function serviceLabelFor(status: ServiceStatus): string {
  if (!status.installed) return 'not installed';
  if (status.enabled === true) return 'installed (enabled)';
  if (status.enabled === false) return 'installed (disabled)';
  return 'installed';
}

/**
 * Running/stopped label for a service. Appended to BOTH service lines: a user
 * checking health needs to see the run state of the MCP server too, not only
 * the supervisor's.
 */
function runStateFor(status: ServiceStatus): string {
  if (!status.installed) return '';
  return status.running ? ', running' : ', stopped';
}

export async function runStatus(_args: string[]): Promise<void> {
  const instance = await checkRunningInstance();
  const svcMgr = await getServiceManager();
  const svcStatus: ServiceStatus = await svcMgr.query().catch(() => ({ installed: false, running: false }));

  // The fleet-sprint supervisor is a SEPARATE OS service with its own
  // unit/plist/task -- reported on its own line so an operator can tell which
  // of the two is down.
  const supervisorMgr = await getServiceManager('fleet-supervisor');
  const supervisorStatus: ServiceStatus = await supervisorMgr.query()
    .catch(() => ({ installed: false, running: false }));

  const serviceLabel = `${serviceLabelFor(svcStatus)}${runStateFor(svcStatus)}`;
  const supervisorLabel = `${serviceLabelFor(supervisorStatus)}${runStateFor(supervisorStatus)}`;

  if (!instance.running) {
    console.log('apra-fleet status');
    console.log(`  State:    stopped`);
    console.log(`  Service (MCP server):       ${serviceLabel}`);
    console.log(`  Service (fleet supervisor): ${supervisorLabel}`);
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
  console.log(`  Service (MCP server):       ${serviceLabel}`);
  console.log(`  Service (fleet supervisor): ${supervisorLabel}`);
}
