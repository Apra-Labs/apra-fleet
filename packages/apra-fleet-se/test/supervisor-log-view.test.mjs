import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createLogView,
    registerLogViewRoutes,
    resolveLogPath,
    tailLines,
} from '../src/supervisor/log-view.mjs';
import { isSafeSprintId } from '../src/supervisor/history-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { renderSprintSection } from '../src/supervisor/dashboard.mjs';

// apra-fleet-ou7.2 -- GET /sprints/:id/log serves the raw per-sprint
// stdout/stderr file the spawner tees a sprint child's output to
// (apra-fleet-ou7.1), for a live sprint AND for an ended one, with a clear
// 404 when no log was ever recorded, and no path-traversal surface via :id.

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function fakeLedger(map) {
    return { get: (id) => map[id] };
}

describe('log-view -- resolveLogPath (ledger first, history fallback)', () => {
    test('resolves from the ledger reservation when its logPath is set', () => {
        const ledger = fakeLedger({ 's1': { logPath: '/data/logs/s1.log' } });
        assert.strictEqual(resolveLogPath({ ledger, history: null }, 's1'), '/data/logs/s1.log');
    });

    test('falls back to the history log\'s most recent recorded logPath when the ledger has no live reservation', () => {
        const ledger = fakeLedger({});
        const history = { forSprint: () => [{ event: 'child-exited', logPath: null }, { event: 'child-exited', logPath: '/data/logs/s2.log' }] };
        assert.strictEqual(resolveLogPath({ ledger, history }, 's2'), '/data/logs/s2.log');
    });

    test('returns null when neither the ledger nor history has a recorded logPath (pre-apra-fleet-ou7.1 sprint)', () => {
        const ledger = fakeLedger({});
        const history = { forSprint: () => [{ event: 'aborted-by-restart', logPath: null }] };
        assert.strictEqual(resolveLogPath({ ledger, history }, 's3'), null);
    });

    test('the ledger reservation wins over a stale history entry when both exist', () => {
        const ledger = fakeLedger({ 's4': { logPath: '/data/logs/s4.log' } });
        const history = { forSprint: () => [{ logPath: '/data/logs/OLD-s4.log' }] };
        assert.strictEqual(resolveLogPath({ ledger, history }, 's4'), '/data/logs/s4.log');
    });
});

describe('log-view -- tailLines', () => {
    test('returns only the last N lines, in order', () => {
        assert.strictEqual(tailLines('a\nb\nc\nd', 2), 'c\nd');
    });

    test('returns the full text unchanged when N exceeds the line count', () => {
        assert.strictEqual(tailLines('a\nb', 10), 'a\nb');
    });

    test('a non-positive/non-integer N returns the text unchanged', () => {
        assert.strictEqual(tailLines('a\nb', 0), 'a\nb');
        assert.strictEqual(tailLines('a\nb', -1), 'a\nb');
        assert.strictEqual(tailLines('a\nb', NaN), 'a\nb');
    });

    test('a trailing newline is not counted as its own (empty) line', () => {
        assert.strictEqual(tailLines('a\nb\nc\n', 1), 'c\n');
        assert.strictEqual(tailLines('a\nb\nc\n', 2), 'b\nc\n');
    });
});

describe('log-view -- createLogView requires a ledger with get()', () => {
    test('throws without a ledger', () => {
        assert.throws(() => createLogView({}), TypeError);
    });
});

describe('log-view -- GET /sprints/:id/log (HTTP)', () => {
    let dir;
    let sup;
    let port;

    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-log-view-'));
        await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
        await fs.writeFile(path.join(dir, 'logs', 'live-1.log'), 'line one\nline two\nline three\n');
        await fs.writeFile(path.join(dir, 'logs', 'ended-1.log'), 'crashed sprint output\n');
        await fs.writeFile(path.join(dir, 'logs', 'released-1.log'), 'released sprint output\n');

        const ledger = fakeLedger({
            'live-1': { logPath: path.join(dir, 'logs', 'live-1.log') },
            'ended-1': { logPath: path.join(dir, 'logs', 'ended-1.log') }, // still-reserved, CRASHED/FINISHED
            'missing-file-1': { logPath: path.join(dir, 'logs', 'does-not-exist.log') },
        });
        const history = {
            forSprint: (id) => (id === 'released-1'
                ? [{ event: 'aborted-by-restart', logPath: path.join(dir, 'logs', 'released-1.log') }]
                : []),
        };

        const view = createLogView({ ledger, history });
        sup = createSupervisor({ port: 0 });
        registerLogViewRoutes(sup, view);
        await sup.start();
        port = sup.server.address().port;
    });

    after(async () => {
        await sup.stop('test');
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('serves the full log for a live sprint', async () => {
        const res = await getText(port, '/sprints/live-1/log');
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/plain'));
        assert.strictEqual(res.body, 'line one\nline two\nline three\n');
    });

    test('serves the log for an ended (CRASHED/FINISHED, still-reserved) sprint', async () => {
        const res = await getText(port, '/sprints/ended-1/log');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, 'crashed sprint output\n');
    });

    test('serves the log for a sprint whose reservation was released, via the history fallback', async () => {
        const res = await getText(port, '/sprints/released-1/log');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, 'released sprint output\n');
    });

    test('?tail=N returns only the last N lines', async () => {
        const res = await getText(port, '/sprints/live-1/log?tail=1');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, 'line three\n');
    });

    test('an unknown sprint id (no recorded logPath anywhere) answers 404 with a clear message', async () => {
        const res = await getText(port, '/sprints/never-existed/log');
        assert.strictEqual(res.status, 404);
        assert.ok(res.body.includes('never-existed'));
        assert.ok(res.body.toLowerCase().includes('no log recorded'));
    });

    test('a recorded logPath whose file is missing on disk answers 404 with a clear message (not a 500)', async () => {
        const res = await getText(port, '/sprints/missing-file-1/log');
        assert.strictEqual(res.status, 404);
        assert.ok(res.body.includes('missing-file-1'));
    });

    test('a path-traversal attempt on :id is rejected with 400 (isSafeSprintId reused, never reimplemented)', async () => {
        const res = await getText(port, '/sprints/' + encodeURIComponent('../../etc/passwd') + '/log');
        assert.strictEqual(res.status, 400);
    });

    test('the resolveLogPath lookup never builds a filesystem path from :id -- traversal segments in :id simply fail to match any reservation/history entry', () => {
        // Structural proof, independent of the HTTP-level isSafeSprintId guard
        // above: even an id shaped like a traversal payload is used ONLY as a
        // Map/array lookup key, never string-concatenated into a path.
        assert.strictEqual(isSafeSprintId('../../etc/passwd'), false);
        const ledger = fakeLedger({});
        const history = { forSprint: () => [] };
        assert.strictEqual(resolveLogPath({ ledger, history }, '../../etc/passwd'), null);
    });
});

describe('log-view -- dashboard row includes a "Raw log" link (apra-fleet-ou7.2 acceptance criterion)', () => {
    test('renderSprintSection includes a /sprints/:id/log link', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-xyz',
            branch: 'feat/x',
            goal: 'do the thing',
            status: 'running-healthy',
            issueRoots: ['apra-fleet-x'],
            beadCount: 3,
            members: [],
        });
        assert.ok(html.includes('/sprints/sprint-xyz/log'), 'dashboard row must link to the raw log');
        assert.ok(html.includes('Raw log'));
    });

    test('the link is present for a CRASHED row too (where the live SSE viewer is gone)', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-crashed',
            branch: null,
            goal: null,
            status: 'crashed',
            issueRoots: [],
            beadCount: null,
            members: [],
        });
        assert.ok(html.includes('/sprints/sprint-crashed/log'));
    });
});
