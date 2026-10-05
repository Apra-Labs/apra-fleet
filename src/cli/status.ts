import fs from 'node:fs';
import http from 'node:http';
import { checkRunningInstance, describePreviousServer } from '../services/singleton.js';
import { getServiceManager } from '../services/service-manager/index.js';
import type { ServiceStatus } from '../services/service-manager/types.js';
import { SERVER_INFO_PATH } from '../paths.js';
import { detectFleetSePrereqs, summarizeFleetSePrereqs } from './fleet-se-prereqs.js';
import type { FleetSePrereqResult } from './fleet-se-prereqs.js';
import { readStoppedMarker, describeStoppedMarker } from '../services/stopped-marker.js';
import { serverVersion } from '../version.js';

/**
 * Injection seam for the fleet-se prerequisite probe (apra-fleet-i9ag.13.8).
 * Defaults to the real, live detector so callers that pass nothing see
 * byte-identical output to before this seam existed. Tests supply a fake
 * here instead of relying on the host's actual node/npm.
 */
export interface RunStatusDeps {
  detectFleetSePrereqs: () => FleetSePrereqResult;
}

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
 *
 * A manager-supplied `detail` (GitHub #585: why a task is disabled -- stopped
 * by the user, or disabled outside apra-fleet -- or the HKCU Run fallback) is
 * appended inside the parentheses: "installed (disabled -- stopped by user ...)".
 */
export function formatServiceLabel(svcStatus: ServiceStatus): string {
  if (!svcStatus.installed) return 'not installed';
  const state = svcStatus.enabled === true ? 'enabled' : svcStatus.enabled === false ? 'disabled' : null;
  if (state === null) return svcStatus.detail ? `installed (${svcStatus.detail})` : 'installed';
  return svcStatus.detail ? `installed (${state} -- ${svcStatus.detail})` : `installed (${state})`;
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

export async function runStatus(
  _args: string[],
  deps: Partial<RunStatusDeps> = {},
): Promise<void> {
  const instance = await checkRunningInstance();
  // GitHub #585: a stale server.json means the previous server died uncleanly.
  const previousNote = instance.state === 'gone' ? describePreviousServer(instance.previous) : null;
  if (previousNote) console.log(`Note: ${previousNote}; its stale server.json was removed.`);
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

  const serviceLabel = `${formatServiceLabel(svcStatus)}${runStateFor(svcStatus)}`;
  const supervisorLabel = `${formatServiceLabel(supervisorStatus)}${runStateFor(supervisorStatus)}`;

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
    console.log(`  Service (MCP server):       ${serviceLabel}`);
    console.log(`  Service (fleet supervisor): ${supervisorLabel}`);
    console.log(fleetSeLine);
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
  console.log(`  Service (MCP server):       ${serviceLabel}`);
  console.log(`  Service (fleet supervisor): ${supervisorLabel}`);
  console.log(fleetSeLine);
  const runningCore = versionCore(health?.version);
  const ownCore = versionCore(serverVersion);
  if (runningCore && ownCore && runningCore !== ownCore) {
    console.log(`  Warning:  the running server is ${health!.version} but this apra-fleet is ${serverVersion} -- stop it ('apra-fleet stop'), then run 'apra-fleet install' and 'apra-fleet start'.`);
  }
}
