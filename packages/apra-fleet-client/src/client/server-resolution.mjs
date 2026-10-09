/**
 * Shared fleet-server resolution -- the ONE implementation of "how does a client
 * process reach the apra-fleet MCP server".
 *
 * Binding design doc: docs/adr-workflow-server-resolution.md (apra-fleet-7pm.6).
 * Consumers: src/cli/workflow.ts (the `apra-fleet workflow` launcher) and
 * packages/apra-fleet-se/bin/cli.mjs (auto-sprint). Neither duplicates this logic.
 *
 * Resolution order (ADR Decision 1):
 *   1. APRA_FLEET_TRANSPORT override ('http' | 'stdio').
 *      - 'stdio'                       -> stdio self-spawn, no probe.
 *      - APRA_FLEET_SERVER_CMD/_BIN set (and transport is not forced 'http')
 *                                      -> explicit stdio request, no probe.
 *      - 'http'                        -> probe only; never starts a server, never stdio.
 *      - unset                         -> http is the product default: probe, then step 3.
 *   2. HTTP singleton probe -- checkRunningInstance(): ~/.apra-fleet/data/server.json
 *      {pid, url}, pid-alive check + GET <url with /mcp -> /health> (2s timeout),
 *      self-healing (deletes server.json only for a dead pid or a refused port;
 *      a live-but-unresponsive server keeps it). On success: attach over
 *      StreamableHttpTransport, spawn nothing.
 *   3. The singleton is verifiably GONE (no server.json, dead pid, or refused
 *      port): start the SHARED HTTP server exactly as `apra-fleet start` does
 *      (auto-start.mjs -- detached, user-level, outlives this client; a lock
 *      serialises racing clients; capped at N starts per M minutes), wait for
 *      /health, then attach over HTTP. An UNRESPONSIVE singleton (alive, not
 *      answering) is never replaced: actionable error. (GitHub #585 recovery;
 *      this replaced the old private stdio self-spawn, which is now only
 *      reachable via APRA_FLEET_TRANSPORT=stdio or APRA_FLEET_SERVER_CMD/_BIN.)
 *
 * Long-lived HTTP clients get a ReconnectingHttpTransport (connectFleet /
 * createFleetHttpTransport): on a refused connection it re-probes, auto-starts
 * a gone server and retries a request ONCE only when it provably never reached
 * the server -- never an in-flight execute_prompt/execute_command.
 *
 * Claude Code and other MCP hosts connect by URL and never use this module;
 * they are covered by the OS user-level service (install), not by this.
 *
 * Scope guard (ADR): the launcher/auto-sprint client and the MCP server are ALWAYS
 * separate processes. This module decides only the transport, never merges them.
 *
 * Every branch is unit-testable: all filesystem/env/network access goes through the
 * injectable `deps` bag.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioTransport, StreamableHttpTransport } from './transport.mjs';
import { McpClient } from './client.mjs';
import { ApraFleet } from './api.mjs';
import { autoStartFleetServer, readStoppedByUser, stoppedByUserError } from './auto-start.mjs';
import { ReconnectingHttpTransport } from './reconnecting-transport.mjs';

export {
    autoStartFleetServer, resolveFleetStartCommand, lastServerLog, FleetAutoStartError,
    readStoppedByUser, stoppedByUserError, STOPPED_BY_USER_FILE,
    AUTOSTART_MAX_STARTS, AUTOSTART_WINDOW_MS, AUTOSTART_TIMEOUT_MS,
} from './auto-start.mjs';
export { ReconnectingHttpTransport, isNeverDeliveredError } from './reconnecting-transport.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string} ~/.apra-fleet/data (honors APRA_FLEET_DATA_DIR, like src/paths.ts) */
export function getFleetDataDir(env = process.env) {
    return env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');
}

/** @returns {string} path to the running server's server.json */
export function getServerInfoPath(env = process.env) {
    return path.join(getFleetDataDir(env), 'server.json');
}

/**
 * pid-liveness check. Mirrors src/utils/process-utils.ts isPidAlive().
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but is owned by another user -- alive.
        return err && err.code === 'EPERM';
    }
}

/**
 * GET <url with a trailing /mcp replaced by /health>, 2s timeout.
 * @param {string} url
 * @returns {Promise<boolean|'foreign'>} 'foreign' when something answered with a non-200
 *   (a blocked fleet server cannot answer at all, so the port belongs to someone else)
 */
function checkHealthEndpoint(url) {
    const healthUrl = url.replace(/\/mcp$/, '/health');
    return new Promise((resolve) => {
        const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200 ? true : 'foreign');
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/**
 * Plain TCP connect probe (mirrors src/services/singleton.ts probeTcpPort).
 * @param {number} port
 * @param {string} host
 * @returns {Promise<'open'|'refused'|'timeout'|'error'>}
 */
function probeTcpPort(port, host) {
    return new Promise((resolve) => {
        let settled = false;
        const sock = net.connect({ port, host });
        const finish = (r) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* ignore */ }
            resolve(r);
        };
        sock.setTimeout(3000); // Windows takes ~2s to report a refused loopback connect
        sock.once('connect', () => finish('open'));
        sock.once('timeout', () => finish('timeout'));
        sock.once('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
    });
}

/**
 * The HTTP-singleton probe. Same semantics as src/services/singleton.ts's
 * checkRunningInstance() (pid + /health + tri-state self-heal), so the launcher's
 * probe and the server's own startup-dedup can never disagree.
 *
 * Tri-state: running (pid alive + /health 200), unresponsive (pid alive, /health
 * silent, recorded port still accepts TCP -- server.json is KEPT), gone (no
 * server.json, dead pid, or the recorded port refuses TCP -- server.json removed).
 *
 * @param {{ env?: Record<string, string|undefined>, readFile?: (p: string) => string,
 *           unlink?: (p: string) => void, pidAlive?: (pid: number) => boolean,
 *           health?: (url: string) => Promise<boolean>,
 *           tcpProbe?: (port: number, host: string) => Promise<'open'|'refused'|'timeout'|'error'> }} [deps]
 * @returns {Promise<{running: true, state: 'running', url: string, pid: number}
 *                 | {running: false, state: 'unresponsive', url: string, pid: number, port?: number}
 *                 | {running: false, state: 'gone'}>}
 */
export async function checkRunningInstance(deps = {}) {
    const env = deps.env || process.env;
    const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const unlink = deps.unlink || ((p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } });
    const pidAlive = deps.pidAlive || isPidAlive;
    const health = deps.health || checkHealthEndpoint;
    const tcpProbe = deps.tcpProbe || probeTcpPort;

    const serverInfoPath = getServerInfoPath(env);

    let info;
    try {
        info = JSON.parse(readFile(serverInfoPath));
    } catch {
        return { running: false, state: 'gone' };
    }

    if (!info || !info.pid || !info.url) return { running: false, state: 'gone' };

    if (!pidAlive(info.pid)) {
        unlink(serverInfoPath);
        return { running: false, state: 'gone' };
    }

    const healthResult = await health(info.url);
    if (healthResult === 'foreign') {
        unlink(serverInfoPath);
        return { running: false, state: 'gone' };
    }
    if (healthResult !== true) {
        let port;
        let host = '127.0.0.1';
        try {
            const u = new URL(info.url);
            port = Number(info.port) > 0 ? Number(info.port) : (Number(u.port) > 0 ? Number(u.port) : undefined);
            host = u.hostname || host;
        } catch { /* keep defaults */ }
        if (port !== undefined && (await tcpProbe(port, host)) === 'refused') {
            unlink(serverInfoPath);
            return { running: false, state: 'gone' };
        }
        return { running: false, state: 'unresponsive', url: info.url, pid: info.pid, port };
    }

    return { running: true, state: 'running', url: info.url, pid: info.pid };
}

/**
 * Tier 3 of the ADR: the stdio self-spawn command, four resolution tiers.
 * This is the single implementation; packages/apra-fleet-se/bin/cli.mjs re-exports it
 * under its historical name with identical behavior.
 *
 * @param {{ env?: Record<string, string|undefined>, dirname?: string,
 *           exists?: (candidate: string) => boolean }} [deps]
 * @returns {{ command: string, args: string[] }}
 */
export function resolveFleetServerCommand(deps = {}) {
    const env = deps.env || process.env;
    // Default dirname: the *consumer's* location matters, so callers that care
    // (cli.mjs) pass their own __dirname. Falling back to this module's dirname
    // keeps the dev-monorepo tier working for direct callers.
    const dirname = deps.dirname || __dirname;
    const exists = deps.exists || fs.existsSync;

    if (env.APRA_FLEET_SERVER_CMD) {
        const parts = env.APRA_FLEET_SERVER_CMD.split(' ').filter(Boolean);
        if (parts.length === 0) {
            throw new Error('APRA_FLEET_SERVER_CMD is set but empty.');
        }
        return { command: parts[0], args: parts.slice(1) };
    }
    if (env.APRA_FLEET_SERVER_BIN) {
        return { command: env.APRA_FLEET_SERVER_BIN, args: ['run', '--transport', 'stdio'] };
    }

    const bundledSiblingEntry = path.join(dirname, 'index.js');
    const devMonorepoEntry = path.resolve(dirname, '..', '..', '..', 'dist', 'index.js');

    for (const entry of [bundledSiblingEntry, devMonorepoEntry]) {
        if (exists(entry)) {
            return { command: 'node', args: [entry, 'run', '--transport', 'stdio'] };
        }
    }

    throw new Error(
        '[apra-fleet-se] Could not locate the apra-fleet MCP server entry point. Tried:\n' +
            `  - ${bundledSiblingEntry} (bundled layout)\n` +
            `  - ${devMonorepoEntry} (dev-monorepo layout)\n` +
            'Set APRA_FLEET_SERVER_CMD (a full "<command> <args...>" string) or ' +
            'APRA_FLEET_SERVER_BIN (a server executable resolved via PATH) to point at your ' +
            'apra-fleet server explicitly.',
    );
}

/**
 * The ADR's resolution order. Returns a connection descriptor; nothing is
 * connected. The only side effect: when the shared HTTP server is verifiably
 * gone, it is started (step 3) -- inject `autoStartFleetServer` to fake that.
 *
 * @param {{ env?: Record<string, string|undefined>, dirname?: string,
 *           exists?: (candidate: string) => boolean,
 *           checkRunningInstance?: (deps?: object) => Promise<object>,
 *           autoStartFleetServer?: (deps: object) => Promise<{url: string, pid: number, started?: boolean}> }} [deps]
 * @returns {Promise<{mode: 'http', url: string, pid: number, reason: string, started?: boolean}
 *                 | {mode: 'stdio', command: string, args: string[], reason: string}>}
 */
export async function resolveFleetServerConnection(deps = {}) {
    const env = deps.env || process.env;
    const probe = deps.checkRunningInstance || checkRunningInstance;

    const forced = (env.APRA_FLEET_TRANSPORT || '').trim().toLowerCase();
    if (forced && forced !== 'http' && forced !== 'stdio') {
        throw new Error(
            `APRA_FLEET_TRANSPORT is set to '${env.APRA_FLEET_TRANSPORT}'. Valid values are 'http' or 'stdio'.`,
        );
    }

    // Step 1 -- forced-transport / explicit stdio escape hatches.
    const explicitStdioCmd = Boolean(env.APRA_FLEET_SERVER_CMD || env.APRA_FLEET_SERVER_BIN);
    if (forced === 'stdio' || (forced !== 'http' && explicitStdioCmd)) {
        const cmd = resolveFleetServerCommand(deps);
        return {
            mode: 'stdio',
            ...cmd,
            reason: forced === 'stdio'
                ? 'APRA_FLEET_TRANSPORT=stdio forced'
                : 'APRA_FLEET_SERVER_CMD/APRA_FLEET_SERVER_BIN set (explicit stdio request)',
        };
    }

    // Step 2 -- HTTP singleton probe (the default path).
    const instance = await probe({ env });
    if (instance && instance.running) {
        return {
            mode: 'http',
            url: instance.url,
            pid: instance.pid,
            reason: `attached to HTTP singleton at ${instance.url} (pid ${instance.pid})`,
        };
    }

    // An explicit APRA_FLEET_TRANSPORT=http must never silently become a private
    // stdio server (ADR Decision 1, step 1).
    if (forced === 'http') {
        throw new Error(
            'APRA_FLEET_TRANSPORT=http was requested, but no healthy apra-fleet HTTP singleton was found.\n' +
                `  Checked: ${getServerInfoPath(env)} (pid alive + GET /health)\n` +
                "  Start one with 'apra-fleet start' (or 'apra-fleet install'), or unset " +
                'APRA_FLEET_TRANSPORT to let the client start the shared server itself.',
        );
    }

    // A live-but-unresponsive HTTP singleton still owns this data dir: a
    // self-spawned stdio server beside it would split the fleet (GitHub #584).
    if (instance && instance.state === 'unresponsive') {
        throw new Error(
            `The apra-fleet HTTP server (pid ${instance.pid} at ${instance.url}) is alive but not answering /health.\n` +
                '  Refusing to start a second server on the same data dir.\n' +
                "  Run 'apra-fleet stop' and retry, or set APRA_FLEET_TRANSPORT=stdio to force a private stdio server.",
        );
    }

    // Step 3 -- the shared server is gone: start it the way 'apra-fleet start'
    // does and attach over HTTP.
    // A server the user stopped with 'apra-fleet stop' stays stopped: fail
    // with the actionable error instead of starting it (also on a mid-run
    // reconnect, which re-runs this resolution).
    const stopped = readStoppedByUser(getFleetDataDir(env));
    if (stopped) throw stoppedByUserError(stopped);
    const autoStart = deps.autoStartFleetServer || autoStartFleetServer;
    const started = await autoStart({ ...deps, env, checkRunningInstance: probe });
    return {
        mode: 'http',
        url: started.url,
        pid: started.pid,
        started: started.started !== false,
        reason: started.started === false
            ? `attached to HTTP singleton at ${started.url} (pid ${started.pid}), started by another client`
            : `the shared HTTP server was not running; started it and attached at ${started.url} (pid ${started.pid})`,
    };
}

/**
 * A ReconnectingHttpTransport for an http-mode resolution: on a refused
 * connection or a lost session it re-runs the resolution (re-probe; auto-start
 * a gone server unless APRA_FLEET_TRANSPORT=http) and reconnects.
 *
 * @param {{url: string}} connection an http-mode result of resolveFleetServerConnection
 * @param {object} [deps] same bag as resolveFleetServerConnection, plus `options`
 *   (transport options) and `createTransport` (tests).
 * @returns {ReconnectingHttpTransport}
 */
export function createFleetHttpTransport(connection, deps = {}) {
    const env = deps.env || process.env;
    // Every /mcp session needs the install's access secret (a FULL session as
    // much as a ?member= one); read from the data dir the server was resolved from.
    const authedOptions = withFleetAccessSecret(deps.options || {}, env);
    const forcedHttp = (env.APRA_FLEET_TRANSPORT || '').trim().toLowerCase() === 'http';
    // Reconnecting must stay on HTTP: never let the resolver pick stdio here.
    const relocateEnv = { ...env };
    delete relocateEnv.APRA_FLEET_SERVER_CMD;
    delete relocateEnv.APRA_FLEET_SERVER_BIN;
    if (!forcedHttp) delete relocateEnv.APRA_FLEET_TRANSPORT;
    return new ReconnectingHttpTransport(connection.url, {
        options: authedOptions,
        createTransport: deps.createTransport,
        relocate: async () => {
            const r = await resolveFleetServerConnection({ ...deps, env: relocateEnv });
            return r.url;
        },
    });
}

/**
 * Resolve + connect, returning a live MCP client bound to whichever transport the
 * ADR order selected.
 *
 * @param {object} [deps] same bag as resolveFleetServerConnection, plus `options`
 *                        forwarded to the transport.
 * @returns {Promise<{transport: object, mcpClient: McpClient, fleetApi: ApraFleet, mode: 'http'|'stdio'}>}
 */
export async function connectFleet(deps = {}) {
    const resolution = await resolveFleetServerConnection(deps);
    const options = deps.options || {};

    const transport = resolution.mode === 'http'
        ? createFleetHttpTransport(resolution, { ...deps, options })
        : new StdioTransport(resolution.command, resolution.args, options);

    await transport.start();

    const mcpClient = new McpClient(transport);

    if (resolution.mode === 'stdio') {
        await mcpClient.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'fleet-client', version: '1.0.0' },
        });
        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    }

    return { transport, mcpClient, fleetApi: new ApraFleet(mcpClient), mode: resolution.mode };
}

/** Header a `?member=` request carries the install's member access secret in
 *  (mirrors MEMBER_SECRET_HEADER in src/services/member-access-secret.ts). */
export const MEMBER_SECRET_HEADER = 'X-Apra-Fleet-Member-Secret';

/**
 * The member access secret of the install whose data dir `env` names
 * (<data dir>/member-access.key, owner-only), or null when there is none
 * (an install older than the secret, whose server does not check it).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function readMemberAccessSecret(env = process.env) {
    try {
        const v = fs.readFileSync(path.join(getFleetDataDir(env), 'member-access.key'), 'utf8').trim();
        return /^[0-9a-f]{64}$/.test(v) ? v : null;
    } catch {
        return null;
    }
}

/**
 * `options` with the install's access secret added as a request header (an
 * explicit header already in `options` wins). Every http connection to the
 * local server needs it -- the server refuses a /mcp session without a member
 * JWT or this secret with HTTP 401. A missing secret file leaves `options`
 * unchanged (the server then answers 401 with its own clear message).
 * @param {object} [options] StreamableHttpTransport options
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function withFleetAccessSecret(options = {}, env = process.env) {
    const secret = readMemberAccessSecret(env);
    if (!secret) return options;
    return { ...options, headers: { [MEMBER_SECRET_HEADER]: secret, ...(options.headers || {}) } };
}

/**
 * Resolve + connect a MEMBER session: the local HTTP singleton with
 * `?member=<uuid>` appended, so the server scopes the session's tools to the
 * member allowlist. A member session needs the HTTP singleton (the identity
 * rides on the URL); a stdio self-spawn cannot carry one, so it is refused.
 * An unregistered uuid is refused by the server with HTTP 403 at initialize;
 * the rejection carries `.status === 403` and `.code === 'HTTP_403'`.
 *
 * `deps.origin === 'engine'` adds `origin=engine` to the URL: the session is
 * the ENGINE acting as the member (memberCall, `apra-fleet call`), and the
 * server excludes its kb_/code_ calls from the member's session_stats counts.
 * Only those engine paths set it; any other origin value is refused.
 *
 * The server accepts a `?member=` session only with its install's member
 * access secret: it is read from the same data dir the server was resolved
 * from (readMemberAccessSecret) and sent in the MEMBER_SECRET_HEADER header
 * on every request. Without it the server answers HTTP 401.
 *
 * `deps.kbMaintainer === true` (requires `origin: 'engine'`) adds
 * `kb_maintainer=1`: the engine's kb_maintainer grant. The server then also
 * serves kb_promote, kb_resolve_contradiction and kb_reconcile_prefilter to
 * this member session (they mint CONFIRMED; no other member session sees
 * them), and accepts kb_import with an explicit `path` (refused with
 * E-KB-MAINTAINER-REQUIRED in a member session without the grant; kb_import
 * without `path` works in every member session), and lets kb_invalidate retire
 * CONFIRMED entries (without the grant they are left untouched and listed in
 * the response's `refused`). memberCall sets it only for
 * the member it chose as a repository's kb_maintainer.
 *
 * @param {string} memberId registered member uuid
 * @param {object} [deps] same bag as resolveFleetServerConnection, plus `options`
 *                        forwarded to the transport and optional
 *                        `origin: 'engine'`, and optional `kbMaintainer: true`.
 * @returns {Promise<{transport: object, mcpClient: McpClient, mode: 'http', url: string, close: () => Promise<void>}>}
 *          Always `await close()` when done: it DELETEs the server session so no
 *          McpServer or registry entry is leaked (`transport.stop()` does not).
 */
export async function connectFleetMember(memberId, deps = {}) {
    if (!memberId) throw new Error('connectFleetMember requires a member id.');
    if (deps.origin !== undefined && deps.origin !== 'engine') {
        throw new Error(`connectFleetMember: unsupported origin '${deps.origin}' (only 'engine' is accepted).`);
    }
    if (deps.kbMaintainer !== undefined && typeof deps.kbMaintainer !== 'boolean') {
        throw new Error('connectFleetMember: kbMaintainer must be a boolean.');
    }
    if (deps.kbMaintainer === true && deps.origin !== 'engine') {
        throw new Error("connectFleetMember: kbMaintainer requires origin 'engine' (the kb_maintainer grant is engine-only).");
    }
    const resolution = await resolveFleetServerConnection(deps);
    if (resolution.mode !== 'http') {
        throw new Error(
            'A member session requires the local apra-fleet HTTP server, but none was resolved ' +
                `(${resolution.reason}). Start it with 'apra-fleet start'.`,
        );
    }
    const url = new URL(resolution.url);
    url.searchParams.set('member', memberId);
    if (deps.origin === 'engine') url.searchParams.set('origin', 'engine');
    if (deps.kbMaintainer === true) url.searchParams.set('kb_maintainer', '1');
    const options = { ...(deps.options || {}) };
    const secret = readMemberAccessSecret(deps.env || process.env);
    if (secret) options.headers = { ...(options.headers || {}), [MEMBER_SECRET_HEADER]: secret };
    const transport = new StreamableHttpTransport(url.toString(), options);
    await transport.start();
    return {
        transport,
        mcpClient: new McpClient(transport),
        mode: 'http',
        url: url.toString(),
        /** Release the server-side member session (HTTP DELETE) and stop the transport. */
        close: () => transport.close(),
    };
}
