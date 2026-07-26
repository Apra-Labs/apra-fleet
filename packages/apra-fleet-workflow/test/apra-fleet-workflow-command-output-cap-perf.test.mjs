import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { _clearFullOutputStoreForTests } from '../src/viewer/command-output-cap.mjs';

// Tests for apra-fleet-eft.27.5: mirrors the apra-fleet-eft.27.3 perf harness
// (packages/apra-fleet-se/test/viewer-perf-regression-e2e.test.mjs) but at the
// scale of the eft.27 MEASURED ROOT CAUSE -- a live 449-activity sprint whose
// 188 MB /state payload was dominated by 130 command-activity events at
// ~1.3 MB EACH (164 MB), every one the full captured stdout of a repeated
// `bd list --all --limit 0 --json` dump. apra-fleet-eft.27.4's own unit/live-
// wiring tests (apra-fleet-workflow-command-output-cap.test.mjs) cover the
// cap primitive and a SINGLE ~200 KB chatty activity; this file drives many
// large (>1 MB) command activities through a real createDashboardViewer()
// server -- closer to the actual incident shape -- and asserts all three
// apra-fleet-eft.27.5 acceptance criteria together:
//
//   1. no single command-activity event PERSISTED INTO SPRINT STATE (the
//      debounced running/<sprintId>.json writer's target -- the actual
//      artifact apra-fleet-eft.27's root-cause note identified as bloated,
//      not merely the already-summarized GET /state wire shape) exceeds the
//      configured head+tail cap;
//   2. the recurring GET /state poll payload stays under 1 MB regardless of
//      how many multi-MB command dumps were captured;
//   3. the on-demand GET /activities/:id/output endpoint returns the
//      complete, byte-for-byte original output for a sampled activity id.

const ACTIVITY_COUNT = 60; // mirrors the ~130-event scale of the measured incident
const CHATTY_OUTPUT_BYTES = 1_300_000; // matches the "~1.3 MB EACH" measured root cause
const HUGE_SINGLE_OUTPUT_BYTES = 6_000_000; // a single much-larger dump, well over 1 MB

function makeChattyBdListDump(id, sizeBytes) {
    // Not a real `bd list --all --json` dump, but the same shape that
    // matters here: one long string, far larger than the cap, distinct per
    // activity id (so a mix-up between activities is detectable).
    const marker = `BD-LIST-DUMP:${id}:`;
    return marker + 'D'.repeat(Math.max(0, sizeBytes - marker.length));
}

function httpGetFull(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('waitFor() timed out'));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

function createMockFleetApi() {
    return {
        async executePrompt() { return { content: [{ text: 'ok' }] }; },
        async executeCommand() { return { content: [{ text: 'ok' }], isError: false }; }
    };
}

// Drives ACTIVITY_COUNT finished `command` activities, each carrying a
// distinct multi-MB "bd list" style dump, straight through the real
// activity:end wiring in src/viewer/index.mjs (capCommandActivityMeta() ->
// state.tree -> debounced writer / GET /state), the same event shape
// FleetWorkflow.command() itself emits -- emitted directly (rather than via
// wf.command()) purely so the harness can control each dump's exact byte
// size and stay fast, the same shortcut apra-fleet-eft.27.3's
// seedLargeSprint() uses.
function seedChattySprint(wf) {
    const ids = [];
    for (let i = 0; i < ACTIVITY_COUNT; i++) {
        const id = `cmd-act-${i}`;
        ids.push(id);
        const meta = { id, type: 'command', command: 'bd list --all --limit 0 --json', label: `bd list (poll ${i})`, member: 'orchestrator' };
        wf.emit('activity:start', meta);
        wf.emit('activity:end', { ...meta, success: true, duration: 42, output: makeChattyBdListDump(id, CHATTY_OUTPUT_BYTES) });
    }
    return ids;
}

function walkActivities(state) {
    const out = [];
    for (const g of state.tree || []) {
        for (const p of g.phases || []) {
            for (const ev of p.events || []) {
                if (ev.type === 'activity') out.push(ev.data);
            }
        }
    }
    return out;
}

// createDashboardViewer() persists sprint state under process.cwd() (the
// terminal sprint-logs/ snapshot) -- run every test against a fresh temp cwd
// so nothing is written into the real repo checkout. The debounced writer's
// target is pointed at an explicit temp file per test (opts.debouncedStatePath)
// so the persisted "sprint state" artifact -- the actual thing
// apra-fleet-eft.27's root-cause note identified as bloated -- can be read
// back and inspected directly, independent of process.cwd().
let cwdOriginal, cwdTemp, runningStatePath;
beforeEach(() => {
    cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-cmd-output-cap-perf-test-cwd-'));
    cwdOriginal = process.cwd();
    process.chdir(cwdTemp);
    runningStatePath = path.join(cwdTemp, 'running-state.json');
    _clearFullOutputStoreForTests();
});
afterEach(() => {
    process.chdir(cwdOriginal);
    fs.rmSync(cwdTemp, { recursive: true, force: true });
});

describe('apra-fleet-eft.27.5: many multi-MB command activities, mirroring the eft.27 measured root cause at scale', () => {
    test('sanity: the raw fixture dumps really are far larger than any reasonable cap (not a vacuous test)', () => {
        const raw = makeChattyBdListDump('sanity', CHATTY_OUTPUT_BYTES);
        assert.ok(Buffer.byteLength(raw, 'utf8') > 1_000_000, 'fixture dump must itself be over 1 MB, or the assertions below prove nothing');
    });

    test('(1) no single command-activity event persisted into sprint state exceeds the configured cap', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, {
            port: 0,
            name: 'Command Output Cap Perf Test',
            debouncedStatePath: runningStatePath,
            debounceMs: 200
        });

        await withServer(server, async () => {
            const ids = seedChattySprint(wf);

            // Wait for the debounced writer to actually flush the persisted
            // running-state file -- this is the real artifact
            // apra-fleet-eft.27's root-cause note flagged as bloated
            // (running/<sprintId>.json), not merely GET /state's wire shape.
            await waitFor(() => fs.existsSync(runningStatePath));
            // The debounce window only fires once and coalesces the whole
            // synchronous seeding burst into it, but give a small grace
            // margin for the write itself to land on disk.
            await waitFor(() => {
                try {
                    const persisted = JSON.parse(fs.readFileSync(runningStatePath, 'utf8'));
                    return walkActivities(persisted).length === ACTIVITY_COUNT;
                } catch {
                    return false;
                }
            });

            const persisted = JSON.parse(fs.readFileSync(runningStatePath, 'utf8'));
            const activities = walkActivities(persisted);
            assert.equal(activities.length, ACTIVITY_COUNT);

            for (const act of activities) {
                assert.equal(act.type, 'command');
                assert.equal(act.outputTruncated, true, `activity ${act.id} must be marked truncated`);
                // Generous ceiling: default head (2000) + tail (1000) chars
                // plus a short marker line -- nowhere near the megabyte-scale
                // original, regardless of which of the ACTIVITY_COUNT dumps
                // it came from.
                assert.ok(act.output.length < 5000, `activity ${act.id} stored output must stay small (was ${act.output.length} chars)`);
                assert.equal(act.outputByteLength, CHATTY_OUTPUT_BYTES, `activity ${act.id} must report the ORIGINAL byte length, not the excerpt's`);
                assert.ok(!act.output.includes('D'.repeat(5000)), `activity ${act.id} must not carry a long run of the original filler text`);
            }

            // The persisted artifact as a whole must also stay far smaller
            // than the raw uncapped total would have been (ACTIVITY_COUNT *
            // CHATTY_OUTPUT_BYTES ~= 78 MB here) -- proving the cap applies
            // at the point of STORAGE, not just at the point GET /state
            // later trims the wire payload.
            const persistedBytes = fs.statSync(runningStatePath).size;
            const rawUncappedTotal = ACTIVITY_COUNT * CHATTY_OUTPUT_BYTES;
            assert.ok(
                persistedBytes < rawUncappedTotal / 10,
                `persisted running-state file was ${persistedBytes} bytes, expected well under 1/10th of the ${rawUncappedTotal}-byte raw uncapped total`
            );
        });
    });

    test('(2) the recurring GET /state poll payload stays under 1 MB regardless of how many multi-MB command dumps were captured', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap Perf Poll Test', debouncedStatePath: runningStatePath });

        await withServer(server, async (port) => {
            seedChattySprint(wf);

            const first = await httpGetFull(port, '/state');
            assert.equal(first.statusCode, 200);
            const firstBytes = Buffer.byteLength(first.body, 'utf8');
            assert.ok(firstBytes < 1024 * 1024, `expected GET /state payload under 1 MB, got ${firstBytes} bytes for ${ACTIVITY_COUNT} x ~${CHATTY_OUTPUT_BYTES}-byte command activities`);

            // A second poll (simulating the recurring ~250-400ms poll loop)
            // must hold the same bound.
            const second = await httpGetFull(port, '/state');
            const secondBytes = Buffer.byteLength(second.body, 'utf8');
            assert.ok(secondBytes < 1024 * 1024, `second poll was ${secondBytes} bytes, expected under 1 MB`);
        });
    });

    test('(2b) an even larger single dump (well over 1 MB) never leaks into the poll payload either', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap Perf Huge Single Test', debouncedStatePath: runningStatePath });

        await withServer(server, async (port) => {
            const hugeOutput = makeChattyBdListDump('huge-single', HUGE_SINGLE_OUTPUT_BYTES);
            const meta = { id: 'huge-single', type: 'command', command: 'bd list --all --limit 0 --json', label: 'bd list (huge)', member: 'orchestrator' };
            wf.emit('activity:start', meta);
            wf.emit('activity:end', { ...meta, success: true, duration: 42, output: hugeOutput });

            const { statusCode, body } = await httpGetFull(port, '/state');
            assert.equal(statusCode, 200);
            assert.ok(!body.includes(hugeOutput), 'GET /state must never carry the full huge dump');
            const bytes = Buffer.byteLength(body, 'utf8');
            assert.ok(bytes < 1024 * 1024, `expected GET /state payload under 1 MB even with a single ${HUGE_SINGLE_OUTPUT_BYTES}-byte command dump, got ${bytes} bytes`);
        });
    });

    test('(3) GET /activities/:id/output returns the complete, byte-for-byte original output for sampled activity ids', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap Perf On-Demand Test', debouncedStatePath: runningStatePath });

        await withServer(server, async (port) => {
            const ids = seedChattySprint(wf);

            // Sample the first, a middle, and the last activity id -- proves
            // per-activity full-output retrieval is correct across the whole
            // set, not just for whichever one happened to be captured last.
            const sampleIds = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
            for (const id of sampleIds) {
                const expected = makeChattyBdListDump(id, CHATTY_OUTPUT_BYTES);
                const { statusCode, body } = await httpGetFull(port, `/activities/${id}/output`);
                assert.equal(statusCode, 200, `expected 200 for /activities/${id}/output`);
                const parsed = JSON.parse(body);
                assert.equal(parsed.id, id);
                assert.equal(parsed.output.length, expected.length, `full output length mismatch for ${id}`);
                assert.equal(parsed.output, expected, `full original output must round-trip byte-for-byte for ${id}`);
            }
        });
    });

    test('an unknown activity id still 404s even amid a large capped sprint (no accidental fallback to some other activity\'s full output)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap Perf 404 Test', debouncedStatePath: runningStatePath });

        await withServer(server, async (port) => {
            seedChattySprint(wf);
            const { statusCode } = await httpGetFull(port, '/activities/does-not-exist/output');
            assert.equal(statusCode, 404);
        });
    });
});
