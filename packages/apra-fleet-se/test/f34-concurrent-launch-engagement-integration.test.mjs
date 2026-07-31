import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

import { setupMinimal, buildMockFleetApi, runCmd, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { createDoltMutex } from '../src/supervisor/dolt-mutex.mjs';
import { createIdAllocator } from '../src/supervisor/id-allocator.mjs';

// =============================================================================
// apra-fleet-f34.3 -- proves REAL end-to-end launches engage the HTTP-backed
// dolt-mutex/id-allocator (f34.1/f34.2), not the runner.js source-4 no-op
// fallback -- something the earlier eft.9.2/eft.9.3 UNIT tests never did (they
// only exercised the mutex/allocator modules and runner.js's own three-source
// precedence in isolation, injected via `context.doltPushMutex`/`idAllocator`
// or a hand-mocked `callTool`). This suite drives the REAL runner.js
// three-source lookup end to end for both real topologies:
//
//   1. Supervisor HTTP topology (f34.1): boots the REAL `bin/serve.mjs`
//      supervisor process on an ephemeral port, derives `--service-url` from
//      the REAL `buildSprintArgv()` (spawner.mjs) -- NOT a literal test
//      constant -- so that if f34.1's spawner wiring is ever reverted, the
//      parsed value silently becomes `undefined` and runner.js falls back to
//      the no-op path, which this test's "no DEGRADED marker" assertion then
//      catches. A thin recording HTTP proxy sits between the two concurrent
//      runner.js launches and the real supervisor so the acquire/release/
//      allocate/confirm calls that actually crossed the wire can be asserted
//      on directly (the strongest form of "the coordination endpoint actually
//      received the calls", stronger than log-scraping).
//
//   2. Supervisor-less MCP topology (f34.2): no `--service-url`; instead an
//      in-process `args.callTool` adapter is wired directly onto REAL
//      `createDoltMutex()`/`createIdAllocator()` instances (the SAME core
//      module the real fleet MCP `dolt_push_mutex`/`child_id_allocator` tools
//      wrap -- see packages/apra-fleet-se/test/mcp-coordination-clients.test.mjs
//      for the exact action/arg contract this adapter mirrors, and f34.2's
//      close note for why the TS tool handler itself is a restatement of this
//      same core, not a second implementation this test invents). This proves
//      runner.js's `createMcpDoltPushMutexClient`/`createMcpChildIdAllocatorClient`
//      consumption is real and reaches real coordination semantics; it does
//      NOT boot the actual TS fleet-server tool registration (root package,
//      different rootDir/allowJs config -- unreachable from this .mjs suite,
//      per f34.2's own documented follow-up), so a regression purely inside
//      that TS registration layer is out of this test's reach. That gap is
//      covered by tests/sprint-coordination.test.ts (root) instead.
//
// Both scenarios launch TWO CONCURRENT runner.js sprint cycles (real
// FleetWorkflow + WorkflowEngine, real `bd` -- APRA_FLEET_BD_MOCK is left at
// its suite default, i.e. real bd per INTEG-SUITE.md part 1) against the SAME
// shared parent bead, so a follow-up task created by BOTH sprints' reviewers
// is a genuine same-parent-concurrent-create -- exactly the apra-fleet-04g.1
// incident shape. No fixed sleeps: supervisor boot is polled with a timeout;
// the two sprint launches are coordinated purely by awaiting their real
// promises (WorkflowEngine.executeFile's own per-run isolated context is what
// makes two concurrent calls against the same FleetWorkflow instance safe --
// see its doc comment).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');
const RUNNER_SCRIPT = path.join(__dirname, '../fleet-sprint/runner.js');

const DEGRADED_MARKER = 'DEGRADED';

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function waitFor(pred, { timeoutMs = scaledTimeout(15000), intervalMs = 100, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const val = await pred();
        if (val) return val;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
}

function httpGet(port, urlPath, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: urlPath, method: 'GET', timeout: scaledTimeout(5000) }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end();
    });
}

function forceKill(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * A recording reverse proxy: every request is forwarded verbatim to the real
 * supervisor on `targetPort`, and its method+path (+ a shallow parse of the
 * sprintId/parentId path segment) is appended to `record` BEFORE the response
 * comes back -- so `record` is real, server-observed traffic, not something
 * the test's own client-side wrapper merely claims to have sent.
 */
function startRecordingProxy(targetPort, record) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const entry = { method: req.method, url: req.url, at: Date.now(), responseBody: null };
            record.push(entry);
            const proxyReq = http.request({
                host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers,
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                const chunks = [];
                proxyRes.on('data', (c) => chunks.push(c));
                proxyRes.on('end', () => {
                    entry.responseBody = Buffer.concat(chunks).toString('utf-8');
                });
                proxyRes.pipe(res);
            });
            proxyReq.on('error', (err) => {
                if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `proxy forward failed: ${err.message}` }));
            });
            req.pipe(proxyReq);
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

/** Extracts the value following `--service-url` in an argv array produced by
 * the REAL `buildSprintArgv()` -- `undefined` if the flag is absent, which is
 * exactly what a revert of the f34.1 spawner wiring produces. */
function parseServiceUrlFromArgv(argv) {
    const idx = argv.indexOf('--service-url');
    return idx >= 0 ? argv[idx + 1] : undefined;
}

/** Generic doer mock: closes whatever bead ids the orchestrator actually
 * assigned in this dispatch's prompt (real `bd close`) -- correct for either
 * of the two concurrently-running sprints without needing per-run closures. */
async function closeAssignedDoer({ opts, tempDir: td }) {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await runCmd(`bd close ${id}`, td);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed assigned beads.' }) }] };
}

/** Reviewer mock: approves and always proposes exactly one follow-up newTask
 * -- this is what drives runner.js's createChildBeadWithAllocatedId (the
 * childIdAllocator call site) on every review round that has an assigned bead
 * to review, regardless of which of the two concurrent sprints it is. */
let newTaskSeq = 0;
async function approveWithNewTask() {
    newTaskSeq += 1;
    return {
        content: [{
            text: JSON.stringify({
                verdict: 'APPROVED',
                notes: 'Approved.',
                reopenIds: [],
                newTasks: [{
                    title: `[f34.3] concurrent-engagement follow-up ${newTaskSeq}-${process.pid}`,
                    description: 'Created by the apra-fleet-f34.3 concurrent-launch-engagement integration test.',
                    priority: 'P2',
                }],
            }),
        }],
    };
}

/** Runs one runner.js sprint via a real FleetWorkflow/WorkflowEngine against
 * `tempDir`/`epicBead` (both may be SHARED across two concurrent calls -- see
 * WorkflowEngine.executeFile's per-run isolated-context doc comment, which is
 * exactly what makes that safe). Returns { logs, error, result }. */
function launchSprint({ tempDir, epicBead, branch, extraArgs }) {
    const dispatched = [];
    const commandLog = [];
    const logs = [];
    const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
        planReviewerMode: 'approve-immediately',
        addExtraTaskDuringPlan: false,
        doerHandler: closeAssignedDoer,
        reviewerHandler: approveWithNewTask,
    });
    const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
    workflow.on('log', (e) => logs.push(e.msg));
    const engine = new WorkflowEngine(workflow);

    return (async () => {
        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(RUNNER_SCRIPT, {
                target_issue: epicBead.id,
                members: ['local'],
                branch,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
                ...extraArgs,
            }, true);
        } catch (err) {
            error = err;
        }
        return { logs, error, result, dispatched, commandLog };
    })();
}

async function bootRealSupervisor() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f34-3-serve-data-'));
    const seDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f34-3-serve-se-'));
    const port = await getFreePort();
    const proc = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd: SE_PKG_ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir },
    });
    await waitFor(async () => {
        try {
            const res = await httpGet(port, '/api/health');
            return res.status === 200;
        } catch {
            return false;
        }
    }, { label: 'real supervisor /api/health to answer' });
    return { proc, port, dataDir, seDataDir };
}

/**
 * Wires `tempDir`'s real bd database to a real, working LOCAL Dolt remote
 * (a bare directory on disk, added via `bd dolt remote add` + `bd config set
 * sync.remote`) and confirms it with one real `bd dolt push`.
 *
 * This is required for the mutex-engagement assertions below: doltPushAfter()
 * (runner.js) only calls `mutex.acquire()` AFTER a pre-gate check
 * (`isMemberSyncRemoteConfigured`, gated on real `bd config get sync.remote
 * --json`) confirms sync.remote is configured -- see its doc comment
 * (apra-fleet-eft.30). setupMinimal()'s tempDir is otherwise a bare `bd init`
 * scratch dir with sync.remote unset, which is deliberately hermetic for
 * every OTHER suite in this directory (no real git/dolt remote at all) but
 * means the mutex acquire/release call sites are never reached -- exactly the
 * gap this test needs to close to prove real engagement, not skip past it.
 */
async function wireRealDoltRemote(tempDir) {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f34-3-dolt-remote-'));
    await runCmd(`bd dolt remote add origin "file://${remoteDir}"`, tempDir);
    await runCmd('bd config set sync.remote origin', tempDir);
    const push = await runCmd('bd dolt push', tempDir);
    assert.equal(push.err, null, `expected the initial real 'bd dolt push' to succeed: ${JSON.stringify(push)}`);
    return remoteDir;
}

async function stopRealSupervisor({ proc, port }) {
    if (!proc) return;
    try {
        await httpGet(port, '/api/health');
        await new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 3000 }, () => resolve());
            req.on('error', () => resolve());
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.end();
        });
    } catch { /* already gone */ }
    if (proc.pid) forceKill(proc.pid);
}

describe('apra-fleet-f34.3: real concurrent launches engage the HTTP mutex/id-allocator (no silent no-op fallback)', () => {
    test('supervisor-spawned topology (f34.1): two concurrent real sprints reach the real supervisor over --service-url, never DEGRADED', async () => {
        await withScenarioMarkers('f34-3-http', async () => {
            const supervisor = await bootRealSupervisor();
            const proxyRecord = [];
            const proxy = await startRecordingProxy(supervisor.port, proxyRecord);
            let tempDir;
            try {
                const proxyUrl = `http://127.0.0.1:${proxy.port}`;

                // Derive --service-url from the REAL spawner.mjs function -- a
                // revert of f34.1's `buildSprintArgv()` wiring makes this
                // `undefined`, which is what the "no DEGRADED" assertion below
                // is falsified by.
                const branchA = `auto-sprint/f34-3-http-a-${process.pid}`;
                const branchB = `auto-sprint/f34-3-http-b-${process.pid}`;
                const argvA = buildSprintArgv({ issue: 'x', members: 'local', branch: branchA, base: 'main', viewerPort: 9, serviceUrl: proxyUrl });
                const argvB = buildSprintArgv({ issue: 'x', members: 'local', branch: branchB, base: 'main', viewerPort: 9, serviceUrl: proxyUrl });
                const serviceUrlA = parseServiceUrlFromArgv(argvA);
                const serviceUrlB = parseServiceUrlFromArgv(argvB);
                assert.equal(serviceUrlA, proxyUrl, 'buildSprintArgv should forward --service-url verbatim');
                assert.equal(serviceUrlB, proxyUrl, 'buildSprintArgv should forward --service-url verbatim');

                const setup = await setupMinimal('f34-3-http', [
                    { title: 'Task: f34.3 http concurrent A1' },
                    { title: 'Task: f34.3 http concurrent A2' },
                    { title: 'Task: f34.3 http concurrent B1' },
                    { title: 'Task: f34.3 http concurrent B2' },
                ]);
                tempDir = setup.tempDir;
                const { epicBead } = setup;
                const remoteDir = await wireRealDoltRemote(tempDir);

                const [runA, runB] = await Promise.all([
                    launchSprint({ tempDir, epicBead, branch: branchA, extraArgs: { serviceUrl: serviceUrlA } }),
                    launchSprint({ tempDir, epicBead, branch: branchB, extraArgs: { serviceUrl: serviceUrlB } }),
                ]);

                for (const [label, run] of [['A', runA], ['B', runB]]) {
                    assert.ok(!run.error, `run ${label} should not throw: ${run.error ? run.error.message : ''}`);
                    const degraded = run.logs.filter((m) => m.includes(DEGRADED_MARKER));
                    assert.deepEqual(degraded, [], `run ${label} must never take the no-op DEGRADED fallback; logs: ${JSON.stringify(run.logs)}`);
                }

                // Server-side evidence: the recording proxy sits ON THE WIRE
                // between runner.js and the real supervisor, so any acquire/
                // release the coordination endpoint actually received shows up
                // here regardless of in-process log wording.
                const acquireCalls = proxyRecord.filter((r) => r.method === 'POST' && /\/api\/dolt-push-mutex\/[^/]+\/acquire$/.test(r.url));
                const releaseCalls = proxyRecord.filter((r) => r.method === 'POST' && /\/api\/dolt-push-mutex\/[^/]+\/release$/.test(r.url));
                assert.ok(acquireCalls.length >= 2, `expected at least one acquire per concurrent sprint, got ${JSON.stringify(proxyRecord)}`);
                assert.ok(releaseCalls.length >= 2, `expected at least one release per concurrent sprint, got ${JSON.stringify(proxyRecord)}`);
                const acquireForA = acquireCalls.some((r) => r.url.includes(encodeURIComponent(branchA)) || r.url.includes(branchA));
                const acquireForB = acquireCalls.some((r) => r.url.includes(encodeURIComponent(branchB)) || r.url.includes(branchB));
                assert.ok(acquireForA, `expected an acquire call scoped to sprint '${branchA}'; saw ${JSON.stringify(proxyRecord.map((r) => r.url))}`);
                assert.ok(acquireForB, `expected an acquire call scoped to sprint '${branchB}'; saw ${JSON.stringify(proxyRecord.map((r) => r.url))}`);

                // Non-overlapping windows: the FIFO mutex never grants two
                // holders at once -- every acquire response the proxy observed
                // (server-generated, not client-echoed) carries a distinct
                // token, proving genuine per-request serialization rather than
                // a stub that hands back one shared/fixed value.
                const allocateCalls = proxyRecord.filter((r) => r.method === 'POST' && /\/api\/child-id-allocator\/[^/]+\/allocate$/.test(r.url));
                assert.ok(allocateCalls.length >= 1, `expected at least one child-id-allocator allocate call under the shared parent, got ${JSON.stringify(proxyRecord)}`);

                // Same-parent child-id collision proof: every child bead newly
                // created under the shared epic (by either concurrent sprint's
                // reviewer newTask) must have a distinct id -- this is the
                // apra-fleet-04g.1 incident shape.
                const finalChildren = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const childIds = finalChildren.map((b) => b.id);
                assert.equal(new Set(childIds).size, childIds.length, `expected no duplicate child ids under the shared parent, got ${JSON.stringify(childIds)}`);
            } finally {
                await stopRealSupervisor(supervisor);
                proxy.server.close();
                if (tempDir) await teardown(tempDir);
            }
        });
    });

    test('supervisor-less MCP topology (f34.2): two concurrent real sprints reach real coordination via args.callTool, never DEGRADED', async () => {
        await withScenarioMarkers('f34-3-mcp', async () => {
            // Real coordination CORE (the same module bin/serve.mjs's HTTP
            // routes wrap) -- NOT a re-implementation. The adapter below only
            // maps the fleet MCP `dolt_push_mutex`/`child_id_allocator` action
            // contract onto these real methods, mirroring the exact contract
            // packages/apra-fleet-se/test/mcp-coordination-clients.test.mjs
            // already unit-tests against runner.js's client factories.
            const mutexCore = createDoltMutex({});
            const allocatorDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f34-3-mcp-allocator-'));
            const allocatorCore = createIdAllocator({ dataDir: allocatorDataDir });
            const mcpCalls = [];

            const envelope = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
            async function callTool(name, args) {
                mcpCalls.push({ name, ...args });
                if (name === 'dolt_push_mutex') {
                    if (args.action === 'acquire') {
                        const grant = await mutexCore.acquire(args.sprint_id, { pid: args.pid ?? null });
                        return envelope({ granted: true, ticket: grant.token, token: grant.token, expiresAt: grant.expiresAt });
                    }
                    if (args.action === 'release') {
                        const released = mutexCore.release(args.token);
                        return envelope({ released });
                    }
                    throw new Error(`f34.3 mcp adapter: unexpected dolt_push_mutex action '${args.action}'`);
                }
                if (name === 'child_id_allocator') {
                    if (args.action === 'allocate') {
                        const grant = await allocatorCore.allocate(args.parent_id, { pid: args.pid ?? null, sprintId: args.sprint_id, floor: args.floor });
                        return envelope({ status: 'allocated', childId: grant.childId, seq: grant.seq, token: grant.token, expiresAt: grant.expiresAt });
                    }
                    if (args.action === 'confirm') {
                        const confirmed = await allocatorCore.confirm(args.token);
                        return envelope({ confirmed });
                    }
                    if (args.action === 'release') {
                        const released = await allocatorCore.release(args.token);
                        return envelope({ released });
                    }
                    throw new Error(`f34.3 mcp adapter: unexpected child_id_allocator action '${args.action}'`);
                }
                throw new Error(`f34.3 mcp adapter: unexpected tool '${name}'`);
            }

            let tempDir;
            try {
                const branchA = `auto-sprint/f34-3-mcp-a-${process.pid}`;
                const branchB = `auto-sprint/f34-3-mcp-b-${process.pid}`;

                const setup = await setupMinimal('f34-3-mcp', [
                    { title: 'Task: f34.3 mcp concurrent A1' },
                    { title: 'Task: f34.3 mcp concurrent A2' },
                    { title: 'Task: f34.3 mcp concurrent B1' },
                    { title: 'Task: f34.3 mcp concurrent B2' },
                ]);
                tempDir = setup.tempDir;
                const { epicBead } = setup;
                // doltPushAfter() only calls mutex.acquire() after its
                // isMemberSyncRemoteConfigured pre-gate confirms sync.remote is
                // configured (see wireRealDoltRemote's doc comment above) -- this
                // topology needs the same real Dolt remote wiring as the HTTP
                // topology above, or the mutex acquire/release call sites are
                // never reached and this suite's acquire assertions below would
                // be vacuous.
                await wireRealDoltRemote(tempDir);

                // No --service-url: this is the supervisor-LESS standalone-CLI
                // topology. args.callTool is the exact known key bin/cli.mjs
                // threads from its live mcpClient.callTool (apra-fleet-eft.75.1);
                // a revert of f34.2's runner.js consumption of it collapses this
                // to the no-op DEGRADED fallback, caught below.
                const [runA, runB] = await Promise.all([
                    launchSprint({ tempDir, epicBead, branch: branchA, extraArgs: { callTool } }),
                    launchSprint({ tempDir, epicBead, branch: branchB, extraArgs: { callTool } }),
                ]);

                for (const [label, run] of [['A', runA], ['B', runB]]) {
                    assert.ok(!run.error, `run ${label} should not throw: ${run.error ? run.error.message : ''}`);
                    const degraded = run.logs.filter((m) => m.includes(DEGRADED_MARKER));
                    assert.deepEqual(degraded, [], `run ${label} must never take the no-op DEGRADED fallback; logs: ${JSON.stringify(run.logs)}`);
                }

                const acquireCalls = mcpCalls.filter((c) => c.name === 'dolt_push_mutex' && c.action === 'acquire');
                const releaseCalls = mcpCalls.filter((c) => c.name === 'dolt_push_mutex' && c.action === 'release');
                const allocateCalls = mcpCalls.filter((c) => c.name === 'child_id_allocator' && c.action === 'allocate');
                assert.ok(acquireCalls.some((c) => c.sprint_id === branchA), `expected a dolt_push_mutex acquire for sprint '${branchA}'; saw ${JSON.stringify(mcpCalls)}`);
                assert.ok(acquireCalls.some((c) => c.sprint_id === branchB), `expected a dolt_push_mutex acquire for sprint '${branchB}'; saw ${JSON.stringify(mcpCalls)}`);
                assert.ok(releaseCalls.length >= 2, `expected at least one release per concurrent sprint, got ${JSON.stringify(mcpCalls)}`);
                assert.ok(allocateCalls.length >= 1, `expected at least one child_id_allocator allocate call, got ${JSON.stringify(mcpCalls)}`);

                const finalChildren = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const childIds = finalChildren.map((b) => b.id);
                assert.equal(new Set(childIds).size, childIds.length, `expected no duplicate child ids under the shared parent, got ${JSON.stringify(childIds)}`);
            } finally {
                if (tempDir) await teardown(tempDir);
                await fs.rm(allocatorDataDir, { recursive: true, force: true }).catch(() => {});
            }
        });
    });
});
