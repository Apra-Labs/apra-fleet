import fs from 'node:fs';
import http from 'node:http';
import { checkRunningInstance } from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import type { ServiceStatus } from '../services/service-manager/types.js';
import { SERVER_INFO_PATH } from '../paths.js';
import { detectFleetSePrereqs, summarizeFleetSePrereqs } from './fleet-se-prereqs.js';
import type { FleetSePrereqResult } from './fleet-se-prereqs.js';

/**
 * Injection seam for the fleet-se prerequisite probe (apra-fleet-i9ag.13.8).
 * Defaults to the real, live detector so callers that pass nothing see
 * byte-identical output to before this seam existed. Tests supply a fake
 * here instead of relying on the host's actual node/npm.
 */
export interface RunStatusDeps {
  detectFleetSePrereqs: () => FleetSePrereqResult;
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

/**
 * Registration label for one service. `enabled` is only reported by the Linux
 * manager (systemd is-enabled); the other platforms leave it undefined, which
 * renders as "installed (disabled)" exactly as it did before this became
 * multi-service.
 */
function serviceLabelFor(status: ServiceStatus): string {
  if (!status.installed) return 'not installed';
  return status.enabled ? 'installed (enabled)' : 'installed (disabled)';
}

/** Running/stopped label for a service, used for the supervisor line. */
function runStateFor(status: ServiceStatus): string {
  if (!status.installed) return '';
  return status.running ? ', running' : ', stopped';
}

export async function runStatus(
  _args: string[],
  deps: Partial<RunStatusDeps> = {},
): Promise<void> {
  const instance = await checkRunningInstance();
  const svcMgr = await getServiceManager();
  const svcStatus: ServiceStatus = await svcMgr.query().catch(() => ({ installed: false, running: false }));

  // apra-fleet-i9ag.12.9: fleet-se's prerequisite (Node.js 22.16+ and npm) is
  // otherwise only ever checked once, at install time (src/cli/install.ts) --
  // an operator whose Node.js is later downgraded or removed gets no signal
  // at all. This is a host-level check, independent of whether the MCP
  // server/service is currently running, so it is probed and shown
  // unconditionally, in both branches below.
  //
  // apra-fleet-i9ag.13.8: the detector is injectable (defaults to the real,
  // live probe) and wrapped so an unexpected throw degrades to a single
  // "unknown" line instead of taking down the rest of `apra-fleet status`.
  const detect = deps.detectFleetSePrereqs ?? detectFleetSePrereqs;
  const fleetSeLine = (() => {
    try {
      return `  fleet-se: ${summarizeFleetSePrereqs(detect())}`;
    } catch {
      return '  fleet-se: unknown';
    }
  })();

  // The fleet-sprint supervisor is a SEPARATE OS service with its own
  // unit/plist/task -- reported on its own line so an operator can tell which
  // of the two is down.
  const supervisorMgr = await getServiceManager('fleet-supervisor');
  const supervisorStatus: ServiceStatus = await supervisorMgr.query()
    .catch(() => ({ installed: false, running: false }));

  const serviceLabel = serviceLabelFor(svcStatus);
  const supervisorLabel = `${serviceLabelFor(supervisorStatus)}${runStateFor(supervisorStatus)}`;

  if (!instance.running) {
    console.log('apra-fleet status');
    console.log(`  State:    stopped`);
    console.log(`  Service (MCP server):       ${serviceLabel}`);
    console.log(`  Service (fleet supervisor): ${supervisorLabel}`);
    console.log(fleetSeLine);
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
  console.log(fleetSeLine);
}
