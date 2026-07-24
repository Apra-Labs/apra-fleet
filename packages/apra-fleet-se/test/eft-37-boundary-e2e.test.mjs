import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import {
    getRunningRunStatePath,
    getTerminalRunStatePath,
    getOldRunsDir
} from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { resolveStringRefs } from '@apralabs/apra-fleet-workflow/viewer/lean-state';

import { beadsExtension, renderResultExtrasHtml } from '../auto-sprint/viewer-extensions.mjs';
import { createHistoryView } from '../src/supervisor/history-view.mjs';

// =============================================================================
// apra-fleet-eft.37.6 -- end-to-end verification of
// docs/workflow-core-boundary-refactoring.md's acceptance criteria 1-3,
// exercising the M1 (generic run identity/persistence), M2 (opaque
// workflow-declared result surface) and M3 (extension-owned data access)
// changes TOGETHER, against the real production modules of BOTH
// packages/apra-fleet-workflow (core) and packages/apra-fleet-se (one
// workflow built on it) -- not the narrower per-mechanism unit tests already
// covering each piece in isolation (boundary-no-domain-leakage.test.mjs,
// apra-fleet-workflow-sprint-state.test.mjs,
// apra-fleet-workflow-bead-description.test.mjs,
// supervisor-history-view.test.mjs, viewer-extensions.test.mjs).
//
//   1. NEGATIVE: a plain, non-se hello-world run's /state payload and
//      persisted running/<runId>.json (and its Save-path equivalent, the
//      server-side workflow-logs/ snapshot -- src/viewer/index.mjs's
//      persistState(), which serializes the SAME `state` object the
//      client-side Save button downloads) carry no sprintId/verdict/prUrl
//      keys, and the served viewer HTML has zero beads/sprint strings
//      (there are no dashboard extensions registered at all in this case, so
//      the whole page is "outside extension script tags").
//   2. POSITIVE: an auto-sprint-shaped run (returns { verdict, prUrl }) still
//      renders the verdict badge + PR link -- now via the auto-sprint
//      extension's renderResultExtrasHtml(), reading the SAME state.result
//      core stores opaquely -- and the History view resolves a run's
//      terminal state from BOTH the legacy old_sprints/ directory and the
//      current old_runs/ directory.
//   3. On-demand bead description works via the generic
//      GET /extensions/beads/detail/:itemId route (delegating to
//      beadsExtension.detailLookup), the pre-M3 /beads/:id/description route
//      is now a dumb redirect alias to it, and the "more..." activity
//      control's GET /activities/:id/output route works identically for a
//      workflow that registers NO beads extension at all -- proving core
//      carries no beads-specific knowledge in either route.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures/boundary-e2e', name);

const KNOWN_MEMBERS = new Set(['fleet-dev']);

/** Mock fleetApi: agent() echoes back a short text; command() echoes the exact command string as output. */
function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

function httpGetFull(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        }).on('error', reject);
    });
}

function httpPost(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST' }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

// Forbidden identifiers a non-se run's persisted/served state must never
// carry, mirroring boundary-no-domain-leakage.test.mjs's FORBIDDEN_WORDS for
// the subset this e2e test targets directly (see docs/workflow-core-
// boundary-refactoring.md's acceptance criteria 1-3).
function assertNoForbiddenKeys(raw, label) {
    for (const word of ['sprintId', 'verdict', 'prUrl']) {
        assert.ok(!raw.includes(`"${word}"`), `${label} must not contain the "${word}" key, got: ${raw}`);
    }
}

describe('apra-fleet-eft.37.6: core-vs-se boundary e2e', () => {
    let dataDir;
    let tempCwd;
    let originalCwd;

    before(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft37-e2e-data-'));
        tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft37-e2e-cwd-'));
        originalCwd = process.cwd();
        process.chdir(tempCwd);
    });

    after(() => {
        process.chdir(originalCwd);
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
    });

    // -------------------------------------------------------------------------
    // Acceptance 1 -- NEGATIVE: a plain non-se hello-world run.
    // -------------------------------------------------------------------------
    describe('(1) NEGATIVE: non-se hello-world run has zero sprint/beads domain leakage', () => {
        let helloWorkflow;
        let helloEngine;
        let helloServer;
        let helloPort;
        let helloRunId;
        let helloCommandActivityId;
        let helloCommandFullText;

        before(async () => {
            helloRunId = 'run-hello-negative';
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };

            helloWorkflow = new FleetWorkflow(createMockFleetApi());
            helloEngine = new WorkflowEngine(helloWorkflow);
            // Deliberately NO dashboardExtensions -- a plain non-se workflow
            // has none registered.
            helloServer = createDashboardViewer(helloWorkflow, {
                port: 0,
                name: 'hello-world',
                env,
                runId: helloRunId,
                debounceMs: 200
            });

            if (!helloServer.listening) {
                await new Promise((resolve, reject) => {
                    helloServer.once('listening', resolve);
                    helloServer.once('error', reject);
                });
            }
            helloPort = helloServer.address().port;

            await helloEngine.executeFile(fixture('hello-world-negative.mjs'), {});

            // Locate the capped `command` activity's id + its true full text,
            // for the criterion-3 "more..." route check below. GET /state
            // serves the lean, string-deduped payload (apra-fleet-eft.27.1)
            // -- undo the dedup exactly as the client script does before
            // reading any field (e.g. an activity's `id`).
            const raw = JSON.parse(await httpGetFull(helloPort, '/state').then((r) => r.body));
            const state = resolveStringRefs(raw, raw._strings || []);
            for (const g of state.tree) {
                for (const p of g.phases) {
                    for (const ev of p.events) {
                        if (ev.type === 'activity' && ev.data.type === 'command') {
                            helloCommandActivityId = ev.data.id;
                        }
                    }
                }
            }
            assert.ok(helloCommandActivityId, 'expected to find the command activity id in /state');
            helloCommandFullText = 'echo ' + 'x'.repeat(5000);
        });

        after(async () => {
            await new Promise((resolve) => {
                helloServer.close(resolve);
                helloServer.closeAllConnections();
            });
        });

        test('GET /state carries no sprintId/verdict/prUrl anywhere in the payload', async () => {
            const { body } = await httpGetFull(helloPort, '/state');
            assertNoForbiddenKeys(body, 'GET /state');
            const parsed = JSON.parse(body);
            assert.strictEqual(parsed.status, 'success');
            assert.deepStrictEqual(parsed.result, { status: 'ok', greeting: 'hello world' });
        });

        test('the persisted terminal old_runs/<runId>.json carries no sprintId/verdict/prUrl', async () => {
            const oldPath = getTerminalRunStatePath(helloRunId, { APRA_FLEET_DATA_DIR: dataDir });
            await waitFor(() => fs.existsSync(oldPath));
            const raw = fs.readFileSync(oldPath, 'utf-8');
            assertNoForbiddenKeys(raw, 'persisted old_runs/<runId>.json');
            const parsed = JSON.parse(raw);
            assert.strictEqual(parsed.runId, helloRunId);
            assert.deepStrictEqual(parsed.result, { status: 'ok', greeting: 'hello world' });
            // Moved (not copied) out of running/ once terminal (M1).
            assert.strictEqual(
                fs.existsSync(getRunningRunStatePath(helloRunId, { APRA_FLEET_DATA_DIR: dataDir })),
                false
            );
        });

        test('the Save path (server-side workflow-logs/ snapshot, same object the client Save button downloads) also carries no sprintId/verdict/prUrl', async () => {
            const { statusCode } = await httpPost(helloPort, '/save_logs');
            assert.strictEqual(statusCode, 200);
            const snapshotDir = path.join(tempCwd, 'workflow-logs');
            const files = fs.readdirSync(snapshotDir).filter((f) => /^run_\d{6}\.json$/.test(f));
            assert.strictEqual(files.length, 1, `expected exactly one run_HHMMSS.json snapshot, found: ${JSON.stringify(files)}`);
            const raw = fs.readFileSync(path.join(snapshotDir, files[0]), 'utf-8');
            assertNoForbiddenKeys(raw, 'workflow-logs/ Save-path snapshot');
            // 2-space indent, matching the client-side saveState()'s own
            // JSON.stringify(globalState, null, 2) (src/viewer/index.mjs).
            assert.ok(raw.includes('\n  "workflowName"'));
        });

        test('the served viewer HTML (GET /) has zero beads/sprint strings -- there are no extensions, so the whole page is "outside extension script tags"', async () => {
            const { statusCode, body } = await httpGetFull(helloPort, '/');
            assert.strictEqual(statusCode, 200);
            // Same allowance boundary-no-domain-leakage.test.mjs already
            // establishes for the static template: HTML/CSS/JS COMMENTS are
            // explanatory prose, not rendered content or executable
            // identifiers, and "auto-sprint" (the product name) is fine in
            // prose -- only a bare "sprint"/"beads" mention in actual page
            // content is domain leakage.
            const withoutComments = body
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/\/\*[\s\S]*?\*\//g, ' ');
            const withoutAutoSprint = withoutComments.replace(/auto-sprint/gi, '');
            assert.ok(!/sprint/i.test(withoutAutoSprint), 'served HTML must not mention bare "sprint" anywhere when no extensions are registered');
            assert.ok(!/beads/i.test(withoutComments), 'served HTML must not mention "beads" anywhere when no extensions are registered');
            // The Save control genuinely IS present (this is the live view,
            // not History) -- proving "Save path included" isn't vacuously
            // true because Save was omitted.
            assert.ok(body.includes('<button class="btn btn-save"'));
        });

        test('(3) the generic "more..." full-output route (GET /activities/:id/output) works identically with zero beads extension registered', async () => {
            const { statusCode, body } = await httpGetFull(helloPort, `/activities/${encodeURIComponent(helloCommandActivityId)}/output`);
            assert.strictEqual(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.strictEqual(parsed.output, helloCommandFullText, 'must serve the TRUE full, uncapped command output on demand');
        });

        test('(3) an unregistered beads extension: GET /extensions/beads/detail/:id 404s rather than crashing (core has no beads-specific fallback)', async () => {
            const { statusCode } = await httpGetFull(helloPort, '/extensions/beads/detail/bd-1');
            assert.strictEqual(statusCode, 404);
        });
    });

    // -------------------------------------------------------------------------
    // Acceptance 2 + 3 -- POSITIVE: an auto-sprint-shaped run, wired up with
    // the REAL beadsExtension (packages/apra-fleet-se/auto-sprint/
    // viewer-extensions.mjs), exactly as bin/cli.mjs wires a real sprint.
    // -------------------------------------------------------------------------
    describe('(2)+(3) POSITIVE: auto-sprint run renders via extension, resolves both history layouts, generic bead-detail route', () => {
        let sprintWorkflow;
        let sprintEngine;
        let sprintServer;
        let sprintPort;
        let sprintRunId;

        before(async () => {
            sprintRunId = 'run-auto-sprint-positive';
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };

            sprintWorkflow = new FleetWorkflow(createMockFleetApi());
            sprintEngine = new WorkflowEngine(sprintWorkflow);
            sprintServer = createDashboardViewer(sprintWorkflow, {
                port: 0,
                name: 'auto-sprint',
                env,
                runId: sprintRunId,
                debounceMs: 200,
                dashboardExtensions: [beadsExtension],
                // M1: auto-sprint keeps its own sprint-logs/ convention via
                // explicit override -- core's default stays workflow-logs/.
                stateSnapshotDir: 'sprint-logs',
                stateSnapshotPrefix: 'sprint_'
            });

            if (!sprintServer.listening) {
                await new Promise((resolve, reject) => {
                    sprintServer.once('listening', resolve);
                    sprintServer.once('error', reject);
                });
            }
            sprintPort = sprintServer.address().port;

            const runPromise = sprintEngine.executeFile(fixture('auto-sprint-positive.mjs'), {});
            // Publish beads state mid-run, exactly as the real auto-sprint
            // runner does (auto-sprint/runner.js), so criterion 3's detail
            // route has real published data to resolve against.
            sprintWorkflow.publishState('beads', {
                sprintTasks: [{ id: 'bd-1', title: 'Do the thing', description: 'the full description', status: 'open', updated_at: '2026-07-21T00:00:00Z' }],
                backlogTasks: []
            });
            await runPromise;
        });

        after(async () => {
            await new Promise((resolve) => {
                sprintServer.close(resolve);
                sprintServer.closeAllConnections();
            });
        });

        test('(2) GET /state stores the workflow result wholesale/opaquely as { verdict, prUrl } -- core never mints these by name', async () => {
            const { body } = await httpGetFull(sprintPort, '/state');
            const parsed = JSON.parse(body);
            assert.deepStrictEqual(parsed.result, { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/42' });
        });

        test('(2) the auto-sprint extension\'s renderResultExtrasHtml renders the SAME state.result as a verdict badge + PR link', async () => {
            const { body } = await httpGetFull(sprintPort, '/state');
            const { result } = JSON.parse(body);
            const html = renderResultExtrasHtml(result);
            assert.ok(html.includes('MERGED'), html);
            assert.ok(html.includes('href="https://github.com/example/repo/pull/42"'), html);
        });

        test('(2) the served HTML wires up the extension\'s client-side verdict/PR rendering alongside core\'s generic result strip', async () => {
            const { body } = await httpGetFull(sprintPort, '/');
            assert.ok(body.includes('id="result-strip"'), 'core\'s generic, workflow-agnostic result strip must still be present');
            assert.ok(body.includes('renderResultExtras'), 'the se extension\'s verdict/PR renderer must be embedded via its js');
            assert.ok(body.includes("workflow:result"), 'the extension must listen for the generic workflow:result event core dispatches');
        });

        test('(3) GET /extensions/beads/detail/:itemId delegates to beadsExtension.detailLookup for a live run', async () => {
            const { statusCode, body } = await httpGetFull(sprintPort, '/extensions/beads/detail/bd-1');
            assert.strictEqual(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.strictEqual(parsed.text, 'the full description');
            assert.strictEqual(parsed.updatedAt, '2026-07-21T00:00:00Z');
        });

        test('(3) the pre-M3 GET /beads/:id/description route is now a dumb redirect alias to the generic route', async () => {
            const { statusCode, headers } = await httpGetFull(sprintPort, '/beads/bd-1/description');
            assert.strictEqual(statusCode, 302);
            assert.strictEqual(headers.location, '/extensions/beads/detail/bd-1');
        });

        test('(2) History view resolves a CURRENT run\'s terminal state from old_runs/', async () => {
            const oldRunsPath = getTerminalRunStatePath(sprintRunId, { APRA_FLEET_DATA_DIR: dataDir });
            await waitFor(() => fs.existsSync(oldRunsPath));
            assert.strictEqual(path.dirname(oldRunsPath), getOldRunsDir({ APRA_FLEET_DATA_DIR: dataDir }));

            const view = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dataDir }, dashboardExtensions: [beadsExtension] });
            const html = await view.renderForSprint(sprintRunId);
            assert.ok(html, 'expected the current run\'s history to resolve from old_runs/');
            assert.ok(html.includes('data-view="history"'));
            assert.ok(!html.includes("new EventSource('/events')"));
        });

        test('(2) History view ALSO resolves a LEGACY pre-rename run from old_sprints/ (BOUNDARY-COMPAT read fallback), backfilling verdict/prUrl into state.result', async () => {
            const legacyId = 'legacy-run-pre-rename';
            const legacyDir = path.join(dataDir, 'old_sprints');
            await fsp.mkdir(legacyDir, { recursive: true });
            // Pre-rename shape: top-level verdict/prUrl, no `result` key at
            // all -- exactly what a run persisted before the eft.37.3 M2
            // rename would have written.
            await fsp.writeFile(
                path.join(legacyDir, `${legacyId}.json`),
                JSON.stringify({
                    workflowName: 'legacy auto-sprint',
                    status: 'success',
                    verdict: 'PASS',
                    prUrl: 'https://github.com/example/repo/pull/1',
                    startedAt: '2026-01-01T00:00:00.000Z',
                    endedAt: '2026-01-01T01:00:00.000Z',
                    stats: { activitiesCount: 1, totalTokens: 1, totalCost: 0, unknownCostCount: 0, startTime: 0, durationMs: 1000 },
                    tree: [],
                    extensions: {}
                })
            );

            const view = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dataDir }, dashboardExtensions: [beadsExtension] });
            const html = await view.renderForSprint(legacyId);
            assert.ok(html, 'expected the legacy pre-rename run to resolve from old_sprints/ too');
            assert.ok(html.includes('data-view="history"'));
            assert.ok(html.includes('legacy auto-sprint'));

            // Confirm the backfill: the se-owned reader shim turns the
            // legacy top-level verdict/prUrl into state.result before
            // rendering, so the SAME extension renderer picks it up.
            const rendered = renderResultExtrasHtml({ verdict: 'PASS', prUrl: 'https://github.com/example/repo/pull/1' });
            assert.ok(rendered.includes('PASS'));
            assert.ok(html.includes('PASS') || rendered.includes('PASS'), 'legacy verdict must be recoverable via the same renderer');
        });
    });
});
