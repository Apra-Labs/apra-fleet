import path from 'node:path';
import os from 'node:os';

export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');

export const DEFAULT_PORT = parseInt(process.env.APRA_FLEET_PORT ?? '', 10) || 7523;

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
