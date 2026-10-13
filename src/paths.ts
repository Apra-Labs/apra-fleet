import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');

const RAW_DEFAULT_PORT = 7523;

/** The built-in fleet port, ignoring any APRA_FLEET_PORT override of THIS
 *  process -- the port a member's own default install listens on. */
export const BUILTIN_DEFAULT_PORT = RAW_DEFAULT_PORT;

export const DEFAULT_PORT = parseInt(process.env.APRA_FLEET_PORT ?? '', 10) || RAW_DEFAULT_PORT;

/** Name of the member-install marker file inside an install's data dir
 *  (written by `install --member`, see src/cli/install-guard.ts). */
export const MEMBER_INSTALL_MARKER_FILE = 'member-install.json';

/** A usable TCP port number, or undefined. */
export function validPort(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

/**
 * The port the member-install marker in `dataDir` records, or undefined when
 * there is no marker, it predates port recording, or it is unreadable. Read
 * at call time (never cached): install writes the marker partway through a run.
 */
export function recordedMemberInstallPort(
  dataDir: string = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data'),
): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, MEMBER_INSTALL_MARKER_FILE), 'utf8');
    return validPort((JSON.parse(raw) as { port?: unknown }).port);
  } catch {
    return undefined;
  }
}

/**
 * The port THIS process's server binds (and start/install check): an explicit
 * APRA_FLEET_PORT, else the port this data dir's member install recorded,
 * else the built-in default. Resolved at call time, so a service launch with
 * no environment of its own still listens on the member install's port.
 */
export function resolveServerPort(): number {
  return validPort(process.env.APRA_FLEET_PORT ?? '') ?? recordedMemberInstallPort() ?? RAW_DEFAULT_PORT;
}

/**
 * True when this process invocation targets a non-default fleet instance --
 * either a custom port (APRA_FLEET_PORT set to something other than the
 * built-in default) or a custom data directory (APRA_FLEET_DATA_DIR set at
 * all). cli/start.ts's runStart() uses this to keep a sandboxed instance
 * from ever touching the machine-global service registration: a sandbox
 * must always direct-spawn, never call svcMgr.start() (apra-fleet-eft.51).
 */
export function isNonDefaultInstance(): boolean {
  const portOverride = process.env.APRA_FLEET_PORT;
  const hasPortOverride =
    portOverride !== undefined && portOverride !== '' && parseInt(portOverride, 10) !== RAW_DEFAULT_PORT;
  const hasDataDirOverride = !!process.env.APRA_FLEET_DATA_DIR;
  return hasPortOverride || hasDataDirOverride;
}

/**
 * Bind address for the local MCP/HTTP server (src/services/http-transport.ts).
 * Defaults to 127.0.0.1 -- the trust boundary several unauthenticated code
 * paths assume (the ?member= URL-param fallback, /shutdown's admin-key
 * check; see apra-fleet-2xs.11). Set APRA_FLEET_HOST=0.0.0.0 (or a specific
 * LAN interface address) to allow LAN-reachable connections, e.g. for
 * apra-fleet-fnz.4's enrollment flow -- this is a deliberate, explicit
 * opt-in per install, never a default, since it changes what an
 * unauthenticated caller on the same network can reach.
 */
export const DEFAULT_HOST = process.env.APRA_FLEET_HOST?.trim() || '127.0.0.1';

export const SERVER_INFO_PATH = path.join(FLEET_DIR, 'server.json');

export const LOG_FILE_PATH = path.join(FLEET_DIR, 'fleet.log');
