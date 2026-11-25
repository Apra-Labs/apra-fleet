import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';
import { createDashboard, renderSprintSection, renderSprintStackHtml, buildStatePayload } from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { derivePrNotOpened } from '../src/supervisor/pr-not-opened.mjs';

// A sprint whose branch was pushed but whose PR was not opened shows
// "PR not opened: <reason>" next to its verdict on the dashboard row and in
// GET /api/sprints list rows. The verdict itself is never altered.
// ASCII only.

const SKIPPED_STATE = {
    result: {
        verdict: 'PASS', status: 'success-with-warnings',
        prSkipped: { reason: 'auth-failure', message: 'PR not opened: VCS auth failure' },
        warnings: ['PR not opened: VCS auth failure (reason: auth-failure)'],
    },
};
const OPENED_STATE = { result: { verdict: 'PASS', status: 'success' } };
const WARN_ONLY_STATE = {
    result: { verdict: 'PASS', status: 'success-with-warnings', warnings: ['PR not opened: x (reason: no-remote)'] },
};

function dashboardFor(entry, status, terminal) {
    return createDashboard({
        ledger: { list: () => [{ ...entry }] },
        watchdog: { classifySprint: async () => ({ status }) },
        expandScope: async () => new Set(), listAllBeads: async () => [], driftCheck: async () => null,
        hasTerminalState: () => terminal,
    });
}

async function listRows(terminalByRun, historyEvents = []) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pr-not-opened-'));
    try {
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        for (const id of Object.keys(terminalByRun)) await ledger.claim(id, { members: ['a'], issueRoots: [id], childPid: 42 });
        for (const e of historyEvents) await history.record(e);
        const controller = createSprintController({
            ledger, history, spawner: { spawnSprint: async () => ({}) }, listMembers: () => ({}), getBacklog: () => ({}),
            hasTerminalState: (id) => terminalByRun[id] ?? null,
        });
        return (await controller.listSprints()).sprints;
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

describe('derivePrNotOpened', () => {
    test('typed marker, warning fallback, and none', () => {
        assert.deepEqual(derivePrNotOpened({ prSkipped: { reason: 'auth-failure' } }), { reason: 'auth-failure' });
        assert.deepEqual(derivePrNotOpened({ resultStatus: 'success-with-warnings', warnings: ['PR not opened: x (reason: no-remote)'] }), { reason: 'no-remote' });
        assert.equal(derivePrNotOpened({ resultStatus: 'success', warnings: [] }), null);
    });
});

describe('dashboard: PR not opened', () => {
    test('row and detail (live-refresh payload) show the marker with the reason next to the verdict; verdict unchanged', async () => {
        const d = dashboardFor({ sprintId: 's1', members: [], issueRoots: [], childPid: 1 }, WATCHDOG_STATUS.FINISHED, SKIPPED_STATE);
        const views = await d.buildSprintViews();
        assert.equal(views.length, 1, 'a finished sprint with a skipped PR stays visible');
        assert.equal(views[0].verdict, 'PASS');
        assert.deepEqual(views[0].prNotOpened, { reason: 'auth-failure' });
        const html = renderSprintStackHtml(views);
        assert.match(html, /sprint-verdict[^>]*>PASS<\/span><span class="pr-not-opened"[^>]*>PR not opened: auth-failure</);
        // the same view travels through GET /state and renders identically
        const payload = buildStatePayload(views);
        assert.deepEqual(payload.sprints[0].prNotOpened, { reason: 'auth-failure' });
        assert.equal(renderSprintSection(payload.sprints[0]), renderSprintSection(views[0]));
    });

    test('success-with-warnings carrying only a PR-skip warning also shows the marker', async () => {
        const d = dashboardFor({ sprintId: 's2', members: [], issueRoots: [], childPid: 1 }, WATCHDOG_STATUS.FINISHED, WARN_ONLY_STATE);
        const [v] = await d.buildSprintViews();
        assert.match(renderSprintSection(v), /PR not opened: no-remote/);
    });

    test('a sprint whose PR opened shows no marker (and a finished one stays hidden)', async () => {
        const live = await dashboardFor({ sprintId: 's3', members: [], issueRoots: [], childPid: 1 }, WATCHDOG_STATUS.RUNNING_HEALTHY, null).buildSprintViews();
        assert.ok(!renderSprintSection(live[0]).includes('PR not opened'));
        const done = await dashboardFor({ sprintId: 's4', members: [], issueRoots: [], childPid: 1 }, WATCHDOG_STATUS.FINISHED, OPENED_STATE).buildSprintViews();
        assert.equal(done.length, 0);
        const lingering = await dashboardFor({ sprintId: 's5', members: [], issueRoots: [], childPid: 1 }, WATCHDOG_STATUS.RUNNING_HEALTHY, OPENED_STATE).buildSprintViews();
        assert.ok(!renderSprintSection(lingering[0]).includes('PR not opened'));
        assert.equal(lingering[0].prNotOpened, undefined);
    });

    test('a reason containing < and & is HTML-escaped', () => {
        const html = renderSprintSection({ sprintId: 's6', status: 'finished', prNotOpened: { reason: 'a<b>&c' }, issueRoots: [], members: [] });
        assert.ok(html.includes('PR not opened: a&lt;b&gt;&amp;c'), html);
        assert.ok(!html.includes('a<b>'), html);
    });
});

describe('GET /api/sprints list rows: PR not opened', () => {
    test('terminal row with a skipped PR carries verdict and prNotOpened { reason }', async () => {
        const rows = await listRows({ skipped: SKIPPED_STATE, opened: OPENED_STATE, running: null });
        const by = Object.fromEntries(rows.map((r) => [r.sprintId, r]));
        assert.equal(by.skipped.verdict, 'PASS');
        assert.deepEqual(by.skipped.prNotOpened, { reason: 'auth-failure' });
        assert.equal(by.opened.verdict, 'PASS');
        assert.equal('prNotOpened' in by.opened, false);
        assert.equal('verdict' in by.running, false);
        assert.equal('prNotOpened' in by.running, false);
        // existing fields are untouched
        assert.deepEqual(by.skipped.members, ['a']);
    });

    test('falls back to the FINISHED history event when no terminal state is on disk', async () => {
        const rows = await listRows({ h1: null }, [{
            sprintId: 'h1', event: 'finished', verdict: 'PASS', resultStatus: 'success-with-warnings',
            warnings: ['PR not opened: VCS auth failure (reason: auth-failure)'],
        }]);
        assert.equal(rows[0].verdict, 'PASS');
        assert.deepEqual(rows[0].prNotOpened, { reason: 'auth-failure' });
    });
});
