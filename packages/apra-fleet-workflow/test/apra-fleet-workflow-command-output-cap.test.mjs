import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import {
    capOutputText,
    capCommandActivityMeta,
    getFullOutput,
    _clearFullOutputStoreForTests
} from '../src/viewer/command-output-cap.mjs';

// Tests for apra-fleet-eft.27.4: capped command-activity stdout storage.
//
// Root cause (apra-fleet-eft.27, measured live): 130 command-activity events
// at ~1.3 MB each (164 MB of a 188 MB /state payload) each stored the FULL
// captured stdout of a repeated `bd list --all --limit 0 --json` directly
// into sprint state -- lean-state.mjs (eft.27.1) only trims GET /state's
// outgoing payload, it never stopped that full text from being stored (and
// therefore persisted to running/<sprintId>.json and sprint-logs/) in the
// first place. These tests cover: (1) the cap primitive itself, (2) that a
// `command` activity:end merged into live state.tree never exceeds the cap,
// (3) full output remains fetchable by activity id via GET
// /activities/:id/output, and (4) the behavior is command-agnostic (applies
// regardless of which command produced the output).

describe('apra-fleet-eft.27.4: capOutputText()', () => {
    test('text at or under headChars+tailChars passes through unchanged', () => {
        const text = 'short output';
        const result = capOutputText(text, { headChars: 2000, tailChars: 1000 });
        assert.equal(result.value, text);
        assert.equal(result.truncated, false);
        assert.equal(result.byteLength, Buffer.byteLength(text, 'utf8'));
    });

    test('text over the cap is capped to a head+tail excerpt, byteLength reflects the ORIGINAL text', () => {
        const head = 'H'.repeat(50);
        const middle = 'M'.repeat(10000);
        const tail = 'T'.repeat(50);
        const text = head + middle + tail;
        const result = capOutputText(text, { headChars: 50, tailChars: 50 });
        assert.equal(result.truncated, true);
        assert.ok(result.value.length < text.length, 'capped value must be shorter than the original');
        assert.ok(result.value.startsWith(head), 'capped value must start with the head excerpt');
        assert.ok(result.value.endsWith(tail), 'capped value must end with the tail excerpt');
        assert.equal(result.byteLength, Buffer.byteLength(text, 'utf8'), 'byteLength must be the ORIGINAL size, not the excerpt size');
    });
});

describe('apra-fleet-eft.27.4: capCommandActivityMeta()', () => {
    beforeEach(() => _clearFullOutputStoreForTests());

    test('non-command activities pass through unchanged (same reference)', () => {
        const meta = { id: 'a1', type: 'agent', output: 'X'.repeat(100000) };
        const result = capCommandActivityMeta(meta, { headChars: 10, tailChars: 10 });
        assert.strictEqual(result, meta, 'agent-type activities must never be capped by this module');
    });

    test('a command activity under the cap passes through unchanged', () => {
        const meta = { id: 'a2', type: 'command', output: 'small output', success: true };
        const result = capCommandActivityMeta(meta, { headChars: 2000, tailChars: 1000 });
        assert.strictEqual(result, meta);
        assert.equal(getFullOutput('a2'), null, 'nothing should be stashed when nothing was capped');
    });

    test('a command activity over the cap is capped without mutating the original meta object', () => {
        const bigOutput = 'X'.repeat(50000);
        const meta = { id: 'a3', type: 'command', output: bigOutput, success: true };
        const result = capCommandActivityMeta(meta, { headChars: 100, tailChars: 100 });

        assert.notStrictEqual(result, meta, 'a capped result must be a new object');
        assert.equal(meta.output, bigOutput, 'the ORIGINAL meta object must never be mutated (journal.mjs needs the full text)');

        assert.ok(result.output.length < bigOutput.length, 'stored output must be shorter than the original');
        assert.equal(result.outputTruncated, true);
        assert.equal(result.outputByteLength, Buffer.byteLength(bigOutput, 'utf8'));

        const full = getFullOutput('a3');
        assert.ok(full, 'the full original output must be retrievable by activity id');
        assert.equal(full.output, bigOutput);
    });

    test('is command-agnostic: any chatty command output is capped, not just bd list', () => {
        const chattyGitLog = 'commit-line\n'.repeat(20000);
        const meta = { id: 'a4', type: 'command', command: 'git log --all', output: chattyGitLog, success: true };
        const result = capCommandActivityMeta(meta, { headChars: 200, tailChars: 200 });
        assert.equal(result.outputTruncated, true);
        assert.ok(getFullOutput('a4').output.length === chattyGitLog.length);
    });

    test('caps a large `error` field too (a failing chatty command has no `output` field)', () => {
        const bigError = `[Command Failed] ${'E'.repeat(50000)}`;
        const meta = { id: 'a5', type: 'command', error: bigError, success: false };
        const result = capCommandActivityMeta(meta, { headChars: 100, tailChars: 100 });
        assert.equal(result.errorTruncated, true);
        assert.ok(result.error.length < bigError.length);
        assert.equal(getFullOutput('a5').error, bigError);
    });

    test('no single capped field exceeds roughly headChars+tailChars+marker overhead, regardless of original size', () => {
        const huge = 'Z'.repeat(5_000_000); // ~5 MB, larger than the eft.27 130x1.3MB events
        const meta = { id: 'a6', type: 'command', output: huge, success: true };
        const result = capCommandActivityMeta(meta, { headChars: 2000, tailChars: 1000 });
        // Generous ceiling: head + tail + a short marker line, nowhere near
        // the megabyte-scale original.
        assert.ok(result.output.length < 5000, `capped output must stay small (was ${result.output.length} chars)`);
    });
});

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

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
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

// createDashboardViewer() persists sprint state under process.cwd() -- run
// every test in this describe() block against a fresh temp cwd so nothing is
// written into the real repo checkout.
describe('apra-fleet-eft.27.4: live wiring through createDashboardViewer()', () => {
    let cwdOriginal;
    let cwdTemp;
    beforeEach(() => {
        cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-cmd-output-cap-test-cwd-'));
        cwdOriginal = process.cwd();
        process.chdir(cwdTemp);
    });
    afterEach(() => {
        process.chdir(cwdOriginal);
        fs.rmSync(cwdTemp, { recursive: true, force: true });
    });

    function createMockFleetApi(bigOutput) {
        return {
            async executePrompt() { return { content: [{ text: 'ok' }] }; },
            async executeCommand() { return { content: [{ text: bigOutput }], isError: false }; }
        };
    }

    test('a chatty command activity never stores its full output in state.tree, and the full text is fetchable via GET /activities/:id/output', async () => {
        const bigOutput = 'L'.repeat(200000); // ~200 KB, well over the default cap
        const wf = new FleetWorkflow(createMockFleetApi(bigOutput));
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap Test' });

        await withServer(server, async (port) => {
            let capturedActivityId = null;
            wf.on('activity:start', (meta) => { capturedActivityId = meta.id; });

            await wf.command('bd list --all --limit 0 --json', { member_name: 'fleet-dev' });

            await waitFor(() => capturedActivityId !== null);

            const { body: stateBody } = await httpGetFull(port, '/state');
            assert.ok(!stateBody.includes(bigOutput), 'GET /state must never carry the full captured command output');
            assert.ok(stateBody.length < bigOutput.length, '/state payload must stay far smaller than a single uncapped command dump');

            const { statusCode, body } = await httpGetFull(port, `/activities/${capturedActivityId}/output`);
            assert.equal(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.equal(parsed.output, bigOutput, 'the full original output must remain retrievable on demand by activity id');
        });
    });

    test('an unknown/never-capped activity id returns 404, not a crash', async () => {
        const wf = new FleetWorkflow(createMockFleetApi('small'));
        const server = createDashboardViewer(wf, { port: 0, name: 'Command Output Cap 404 Test' });

        await withServer(server, async (port) => {
            const { statusCode } = await httpGetFull(port, '/activities/does-not-exist/output');
            assert.equal(statusCode, 404);
        });
    });
});
