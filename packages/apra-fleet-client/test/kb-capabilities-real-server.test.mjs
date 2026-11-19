// Drives kbCapabilities through the REAL apra-fleet-client client
// (ApraFleet + McpClient + StdioTransport, wired the way the package's own
// connectFleet() wires them for stdio) against the REAL kb_capabilities tool on a REAL, freshly spawned
// apra-fleet server instance (dist/index.js) -- no mock MCP client, no stub
// tool, same shape as tests/regression-command-surface.test.ts's real-server
// stdio handshake test and test/auto-start-real-server.test.mjs's real-server
// spawn, but through this package's own client wrapper rather than the raw
// MCP SDK.
//
// Fully sandboxed: a fresh scratch git repo (with an origin remote, so the
// server's FULL-session self-resolution accepts it as a KB identity) is the
// spawned server's cwd, and HOME/USERPROFILE/APRA_FLEET_DATA_DIR are all
// redirected into a temp dir -- nothing here touches the real host KB.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { StdioTransport } from '../src/client/transport.mjs';
import { McpClient } from '../src/client/client.mjs';
import { ApraFleet, parseToolJson } from '../src/client/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

function initScratchRepoWithOriginRemote(dir) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'kb-capabilities-client-test@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'kb-capabilities-client-test'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-capabilities-client-test.git'], { cwd: dir });
}

/**
 * Spawns a real, private stdio apra-fleet server rooted at `repo` and returns
 * a connected {transport, mcpClient, fleetApi}. Forces stdio transport (never
 * the shared HTTP singleton, so concurrent test runs / a dev's own running
 * fleet server cannot interfere) and points dist/index.js's spawn env at a
 * scratch HOME/data dir.
 *
 * The server command is passed as {command, args}, never as an
 * APRA_FLEET_SERVER_CMD string: that string is split on spaces, which breaks
 * when node lives under a path with a space (C:\Program Files on Windows).
 * The handshake below is the one connectFleet() performs for stdio.
 */
async function connectRealStdioFleet(repo, dataDir) {
    const home = path.join(dataDir, '..', 'home');
    fs.mkdirSync(home, { recursive: true });
    const spawnEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APRA_FLEET_DATA_DIR: dataDir,
    };
    const transport = new StdioTransport(process.execPath, [DIST_INDEX, 'run', '--transport', 'stdio'], { cwd: repo, env: spawnEnv });
    await transport.start();
    const mcpClient = new McpClient(transport);
    await mcpClient.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fleet-client', version: '1.0.0' },
    });
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return { transport, mcpClient, fleetApi: new ApraFleet(mcpClient) };
}

describe(
    'kbCapabilities against the real kb_capabilities tool on a real apra-fleet server (no mock client, no stub tool)',
    { skip: !fs.existsSync(DIST_INDEX) && 'dist/index.js missing -- run npm run build first' },
    () => {
        test('kbCapabilities returns contract, routes and branch_aware for the local SQLite KB', async (t) => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-client-kb-capabilities-'));
            const repo = path.join(tmp, 'repo');
            initScratchRepoWithOriginRemote(repo);

            const { transport, fleetApi } = await connectRealStdioFleet(repo, path.join(tmp, 'data'));
            t.after(() => transport.stop());
            t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ } });

            const parsed = parseToolJson(await fleetApi.kbCapabilities());
            assert.strictEqual(typeof parsed.contract, 'string');
            assert.ok(Array.isArray(parsed.routes) && parsed.routes.length > 0, 'routes must be a non-empty array');
            assert.ok(parsed.routes.every((r) => typeof r === 'string'));
            assert.strictEqual(typeof parsed.branch_aware, 'boolean');
        });
    },
);
