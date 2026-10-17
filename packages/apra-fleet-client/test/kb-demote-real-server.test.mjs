// Verification task closing the client-and-docs lane (memory-contract/v1
// kb_demote epic): drives kbDemote through the REAL apra-fleet-client client
// (ApraFleet + McpClient + StdioTransport, via the package's own
// connectFleet()) against the REAL kb_demote tool on a REAL, freshly spawned
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

import { connectFleet } from '../src/client/server-resolution.mjs';
import { parseToolJson, KB_REMOVED_SCOPE_KEYS } from '../src/client/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

function initScratchRepoWithOriginRemote(dir) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'kb-demote-client-test@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'kb-demote-client-test'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-demote-client-test.git'], { cwd: dir });
}

/**
 * Spawns a real, private stdio apra-fleet server rooted at `repo` and returns
 * a connected {transport, mcpClient, fleetApi}. Forces stdio transport (never
 * the shared HTTP singleton, so concurrent test runs / a dev's own running
 * fleet server cannot interfere) and points dist/index.js's spawn env at a
 * scratch HOME/data dir.
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
    // Explicit, not auto-detected: resolveFleetServerCommand()'s own
    // dev-monorepo fallback resolves relative to server-resolution.mjs's
    // location (src/client/, three levels under packages/apra-fleet-client/)
    // and lands one directory short of the real repo-root dist/index.js from
    // THIS package's nesting depth -- the same reason auto-start-real-
    // server.test.mjs and tests/regression-command-surface.test.ts both name
    // DIST_INDEX explicitly rather than relying on auto-detection.
    const resolutionEnv = {
        ...spawnEnv,
        APRA_FLEET_TRANSPORT: 'stdio',
        APRA_FLEET_SERVER_CMD: `${process.execPath} ${DIST_INDEX} run --transport stdio`,
    };
    return connectFleet({ env: resolutionEnv, options: { cwd: repo, env: spawnEnv } });
}

describe(
    'kbDemote against the real kb_demote tool on a real apra-fleet server (no mock client, no stub tool)',
    { skip: !fs.existsSync(DIST_INDEX) && 'dist/index.js missing -- run npm run build first' },
    () => {
        test('kbDemote lowers a real CONFIRMED entry to INFERRED and the row reads back INFERRED', async (t) => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-client-kb-demote-'));
            const repo = path.join(tmp, 'repo');
            initScratchRepoWithOriginRemote(repo);
            fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'src', 'demote-client-basis.ts'), 'export const basis = 1;\n');

            const { transport, mcpClient, fleetApi } = await connectRealStdioFleet(repo, path.join(tmp, 'data'));
            t.after(() => transport.stop());
            t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ } });

            const captureResult = await mcpClient.callTool('kb_capture', {
                type: 'knowledge',
                title: 'Entry captured for the real apra-fleet-client kbDemote test',
                summary: 'Walked to CONFIRMED so the real client kbDemote call has a legal target.',
                content: 'Cites src/demote-client-basis.ts.',
                source_files: ['src/demote-client-basis.ts'],
            });
            const { id } = parseToolJson(captureResult);
            assert.ok(id, 'kb_capture did not return an id');

            await mcpClient.callTool('kb_promote', {
                id,
                reason: 'First promotion (UNVERIFIED -> INFERRED) for the real client kbDemote test.',
            });
            await mcpClient.callTool('kb_promote', {
                id,
                reason: 'Second promotion (INFERRED -> CONFIRMED) for the real client kbDemote test.',
            });

            // THE assertion this task exists for: kbDemote, through the real
            // ApraFleet client wrapper, against the real kb_demote tool.
            const demoteResult = await fleetApi.kbDemote({
                id,
                reason: 'Re-checked the cited basis for the real client kbDemote test; it holds in fewer cases than the promotion claimed.',
            });
            const parsed = parseToolJson(demoteResult);
            assert.deepStrictEqual(parsed, { id, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });

            // Read the row back through a SEPARATE tool call (kb_list), not
            // just trusting kbDemote's own response, to confirm the write
            // really landed.
            const listResult = await mcpClient.callTool('kb_list', { confidence: ['INFERRED'] });
            const { results } = parseToolJson(listResult);
            const row = results.find((e) => e.id === id);
            assert.ok(row, 'demoted entry not found reading back kb_list(confidence: [INFERRED])');
            assert.strictEqual(row.confidence, 'INFERRED');
        });

        test('kbBibleCommit forwards demoted_ids through to the real kb_bible_commit tool', async (t) => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-client-kb-demote-bible-'));
            const repo = path.join(tmp, 'repo');
            initScratchRepoWithOriginRemote(repo);
            fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'src', 'demote-client-bible-basis.ts'), 'export const basis = 1;\n');

            const { transport, mcpClient, fleetApi } = await connectRealStdioFleet(repo, path.join(tmp, 'data'));
            t.after(() => transport.stop());
            t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ } });

            const captureResult = await mcpClient.callTool('kb_capture', {
                type: 'knowledge',
                title: 'Entry captured for the real apra-fleet-client kbBibleCommit demoted_ids test',
                summary: 'Walked to CONFIRMED then demoted, so demoted_ids has a legal tombstone target.',
                content: 'Cites src/demote-client-bible-basis.ts.',
                source_files: ['src/demote-client-bible-basis.ts'],
            });
            const { id } = parseToolJson(captureResult);

            await mcpClient.callTool('kb_promote', { id, reason: 'First promotion for the real client kbBibleCommit demoted_ids test.' });
            await mcpClient.callTool('kb_promote', { id, reason: 'Second promotion for the real client kbBibleCommit demoted_ids test.' });
            await fleetApi.kbDemote({
                id,
                reason: 'Demoting before the kbBibleCommit demoted_ids forwarding assertion below.',
            });

            const commitResult = await fleetApi.kbBibleCommit({
                ids: [],
                demoted_ids: [id],
                baseBranch: 'main',
                baseCommit: '0123456789abcdef0123456789abcdef01234567',
            });
            const parsed = parseToolJson(commitResult);
            // The value reaching the tool: id was admitted and tombstoned, not
            // silently dropped by the client on the way to the wire.
            assert.deepStrictEqual(parsed.demoted, [id]);
        });

        test('kbDemote refuses a removed scope key client-side, before any request reaches the server', async (t) => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-client-kb-demote-refusal-'));
            const repo = path.join(tmp, 'repo');
            initScratchRepoWithOriginRemote(repo);

            const { transport, mcpClient, fleetApi } = await connectRealStdioFleet(repo, path.join(tmp, 'data'));
            t.after(() => transport.stop());
            t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ } });

            // Wrap the transport's send to prove no request is ever dispatched.
            let sent = 0;
            const originalSend = transport.send.bind(transport);
            transport.send = async (message) => {
                if (message?.method === 'tools/call') sent++;
                return originalSend(message);
            };

            for (const key of KB_REMOVED_SCOPE_KEYS) {
                await assert.rejects(
                    fleetApi.kbDemote({ id: 'whatever', reason: 'twenty-plus character reason text', [key]: '/elsewhere' }),
                    (err) => {
                        assert.equal(err.code, 'E-SCOPE-KEY-REMOVED');
                        return true;
                    },
                );
            }
            assert.strictEqual(sent, 0, 'kbDemote must refuse client-side before any tools/call request is sent');
        });
    },
);
