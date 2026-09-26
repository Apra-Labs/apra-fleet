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
 *      - 'http'                        -> probe only; NEVER falls back to stdio.
 *      - unset                         -> http is the product default: probe, then fall back.
 *   2. HTTP singleton probe -- checkRunningInstance(): ~/.apra-fleet/data/server.json
 *      {pid, url}, pid-alive check + GET <url with /mcp -> /health> (2s timeout),
 *      self-healing (deletes a stale server.json). On success: attach over
 *      StreamableHttpTransport, spawn nothing.
 *   3. stdio self-spawn fallback -- the existing four command tiers
 *      (APRA_FLEET_SERVER_CMD, APRA_FLEET_SERVER_BIN, bundled sibling index.js,
 *      dev-monorepo dist/index.js), fed to StdioTransport.
 *
 * Scope guard (ADR): the launcher/auto-sprint client and the MCP server are ALWAYS
 * separate processes. This module decides only the transport, never merges them.
 *
 * Every branch is unit-testable: all filesystem/env/network access goes through the
 * injectable `deps` bag.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioTransport, StreamableHttpTransport } from './transport.mjs';
import { McpClient } from './client.mjs';
import { ApraFleet } from './api.mjs';

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
 * @returns {Promise<boolean>}
 */
function checkHealthEndpoint(url) {
    const healthUrl = url.replace(/\/mcp$/, '/health');
    return new Promise((resolve) => {
        const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/**
 * The HTTP-singleton probe. Same semantics as src/services/singleton.ts's
 * checkRunningInstance() (pid + /health + self-heal), so the launcher's probe and
 * the server's own startup-dedup can never disagree.
 *
 * @param {{ env?: Record<string, string|undefined>, readFile?: (p: string) => string,
 *           unlink?: (p: string) => void, pidAlive?: (pid: number) => boolean,
 *           health?: (url: string) => Promise<boolean> }} [deps]
 * @returns {Promise<{running: true, url: string, pid: number} | {running: false}>}
 */
export async function checkRunningInstance(deps = {}) {
    const env = deps.env || process.env;
    const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const unlink = deps.unlink || ((p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } });
    const pidAlive = deps.pidAlive || isPidAlive;
    const health = deps.health || checkHealthEndpoint;

    const serverInfoPath = getServerInfoPath(env);

    let info;
    try {
        info = JSON.parse(readFile(serverInfoPath));
    } catch {
        return { running: false };
    }

    if (!info || !info.pid || !info.url) return { running: false };

    if (!pidAlive(info.pid)) {
        unlink(serverInfoPath);
        return { running: false };
    }

    if (!(await health(info.url))) {
        unlink(serverInfoPath);
        return { running: false };
    }

    return { running: true, url: info.url, pid: info.pid };
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
 * The ADR's resolution order, as a pure descriptor (nothing is spawned or connected).
 *
 * @param {{ env?: Record<string, string|undefined>, dirname?: string,
 *           exists?: (candidate: string) => boolean,
 *           checkRunningInstance?: (deps?: object) => Promise<object> }} [deps]
 * @returns {Promise<{mode: 'http', url: string, pid: number, reason: string}
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
                'APRA_FLEET_TRANSPORT to allow the stdio self-spawn fallback.',
        );
    }

    // Step 3 -- stdio self-spawn fallback.
    const cmd = resolveFleetServerCommand(deps);
    return {
        mode: 'stdio',
        ...cmd,
        reason: `no healthy fleet singleton found; self-spawning stdio server via ${cmd.command} ${cmd.args.join(' ')}`,
    };
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
        ? new StreamableHttpTransport(resolution.url, options)
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
