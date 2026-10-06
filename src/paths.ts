import path from 'node:path';
import {
  fleetDataDir,
  fleetKeyPath,
  supervisorIdDir,
  installConfigPath,
  codeIntelligenceDir,
} from '@apralabs/apra-fleet-client/fleet-paths';

// apra-fleet-q1ku: every fleet-owned per-instance path (data dir, fleet.key,
// supervisor id-allocator dir, install-config, code-intelligence) is derived
// from APRA_FLEET_DATA_DIR by ONE resolver,
// packages/apra-fleet-client/src/fleet-paths.mjs, shared with the JS
// packages (local-token.mjs, the supervisor's id-allocator.mjs) so signer and
// readers can never disagree. Its header documents the layout. The functions
// are lazy (read env at call time); use them rather than the eager FLEET_DIR
// wherever the env may change after import.
export { fleetDataDir, fleetKeyPath, supervisorIdDir, installConfigPath, codeIntelligenceDir };

/** Eager snapshot of fleetDataDir() at first import (see tests/setup.ts). */
export const FLEET_DIR = fleetDataDir();

const RAW_DEFAULT_PORT = 7523;

/** The built-in fleet port, ignoring any APRA_FLEET_PORT override of THIS
 *  process -- the port a member's own default install listens on. */
export const BUILTIN_DEFAULT_PORT = RAW_DEFAULT_PORT;

export const DEFAULT_PORT = parseInt(process.env.APRA_FLEET_PORT ?? '', 10) || RAW_DEFAULT_PORT;

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

/**
 * Resolve the absolute origin a human should open to reach this server's
 * console (apra-fleet-i9ag.11.9). The server binds to DEFAULT_HOST, which is
 * frequently 0.0.0.0 or a LAN interface -- not something a browser can be
 * pointed at directly -- so an out-of-band collection link (credential_store_set
 * return_url) needs an EXPLICIT, operator-declared origin rather than a
 * guess. APRA_FLEET_CONSOLE_BASE_URL is that explicit opt-in; unset, this
 * falls back to the server's own bound origin (DEFAULT_HOST:DEFAULT_PORT),
 * which is at least correct for an on-box/loopback reader even if it is not
 * reachable off-box.
 *
 * A SET-BUT-INVALID value fails loudly (ok: false) rather than silently
 * falling back -- an operator who mistyped the variable needs to know their
 * printed URL is wrong, not receive a URL that quietly points somewhere else.
 */
export function resolveConsoleBaseUrl(): { ok: true; baseUrl: string } | { ok: false; error: string } {
  const raw = process.env.APRA_FLEET_CONSOLE_BASE_URL?.trim();
  if (raw) {
    const stripped = raw.replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(stripped);
    } catch {
      return { ok: false, error: `APRA_FLEET_CONSOLE_BASE_URL "${raw}" is not a valid URL` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: `APRA_FLEET_CONSOLE_BASE_URL "${raw}" has unsupported scheme "${parsed.protocol}" (only http: and https: are supported)`,
      };
    }
    return { ok: true, baseUrl: stripped };
  }
  return { ok: true, baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}` };
}

/**
 * Join a console base URL (from resolveConsoleBaseUrl(), which may include a
 * reverse-proxy sub-path such as 'https://fleet.example.com/fleet') with a
 * console-relative path (e.g. '/ui/#/secret-entry/<token>') into one absolute
 * URL. Plain `new URL(relativePath, baseUrl)` cannot be used for this: per
 * RFC 3986/WHATWG URL resolution, a root-relative path (one starting with
 * '/') REPLACES the base's entire path rather than appending to it, so any
 * sub-path segment in baseUrl (e.g. '/fleet') is silently discarded --
 * 'https://fleet.example.com/fleet' + '/ui/#/x' would resolve to
 * 'https://fleet.example.com/ui/#/x', losing '/fleet'. A reverse proxy
 * mounting the console under a sub-path is an explicitly supported,
 * documented deployment (docs/console-architecture.md's 'Console-hosted
 * secret entry' section), so this join preserves the base's path instead
 * (apra-fleet-i9ag.11.18). Sole caller: src/tools/credential-store-set.ts.
 *
 * If relativePath is already an absolute http(s) URL (defensive: callers are
 * documented to always hand back a console-relative path, but a future
 * regression here should still resolve to something sane rather than
 * double-origin garbage), it is returned as-is.
 */
export function joinConsoleUrl(baseUrl: string, relativePath: string): string {
  if (/^https?:\/\//i.test(relativePath)) {
    return new URL(relativePath).toString();
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${base.origin}${basePath}${rel}`;
}

export const SERVER_INFO_PATH = path.join(FLEET_DIR, 'server.json');

export const LOG_FILE_PATH = path.join(FLEET_DIR, 'fleet.log');

/**
 * Log file for the fleet-sprint supervisor service (bin/serve.mjs). Kept
 * separate from LOG_FILE_PATH so the two OS-registered services never
 * interleave their output in one file.
 */
export const SUPERVISOR_LOG_FILE_PATH = path.join(FLEET_DIR, 'fleet-supervisor.log');
