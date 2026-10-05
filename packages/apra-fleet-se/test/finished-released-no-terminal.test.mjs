// apra-fleet-i9ag.10.1.2 -- Finished Sprints rows synthesized for sprints
// released (aborted-by-restart / force-released / auto-released) with no
// terminal state file. Uses a temp data dir and a fake history collaborator.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { renderFinishedRunsHtml } from '../src/supervisor/dashboard.mjs';
import { createFinishedRunsIndex } from '../src/supervisor/history-view.mjs';
import { HISTORY_EVENTS } from '../src/supervisor/history.mjs';

const AT = '2026-09-28T01:02:03.000Z';

async function fixture(files = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i9ag10-1-'));
    await fs.mkdir(path.join(dataDir, 'old_runs'), { recursive: true });
    for (const [id, mtime] of Object.entries(files)) {
        const p = path.join(dataDir, 'old_runs', id + '.json');
        await fs.writeFile(p, JSON.stringify({
            workflowName: 'fleet-sprint', runId: id, status: 'success',
            result: { verdict: 'PASS', prUrl: null },
            startedAt: '2026-09-20T00:00:00.000Z', endedAt: '2026-09-20T02:00:00.000Z', extensions: {},
        }));
        const t = new Date(mtime);
        await fs.utimes(p, t, t);
    }
    return { dataDir, env: { APRA_FLEET_DATA_DIR: dataDir } };
}
const hist = (events) => ({ list: () => events });
const idx = (env, events, extra = {}) =>
    createFinishedRunsIndex({ env, history: events ? hist(events) : null, logger: { error() {} }, ...extra });

describe('released sprints with no terminal state', () => {
    for (const [event, status] of [
        [HISTORY_EVENTS.ABORTED_BY_RESTART, 'aborted-by-restart'],
        [HISTORY_EVENTS.FORCE_RELEASED, 'force-released'],
        [HISTORY_EVENTS.AUTO_RELEASED, 'auto-released'],
    ]) {
        test(`${event} synthesizes exactly one unknown-verdict row`, async () => {
            const { dataDir, env } = await fixture();
            try {
                const rows = await idx(env, [{ sprintId: 's1', event, at: AT, reason: 'because' }]).list();
                assert.strictEqual(rows.length, 1);
                assert.strictEqual(rows[0].verdict, null);
                assert.strictEqual(rows[0].hasTerminalState, false);
                assert.strictEqual(rows[0].endedAt, AT);
                assert.strictEqual(rows[0].status, status);
                assert.strictEqual(rows[0].reason, 'because');
            } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
        });
    }

    test('file-backed row wins over a release event', async () => {
        const { dataDir, env } = await fixture({ s1: '2026-09-20T02:00:00Z' });
        try {
            const rows = await idx(env, [{ sprintId: 's1', event: HISTORY_EVENTS.AUTO_RELEASED, at: AT }]).list();
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, 'finished');
            assert.strictEqual(rows[0].hasTerminalState, true);
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });

    test('file outside the limit window gets no synthesized duplicate', async () => {
        const { dataDir, env } = await fixture({ old: '2026-09-01T00:00:00Z', newer: '2026-09-20T00:00:00Z' });
        try {
            const rows = await idx(env, [
                { sprintId: 'old', event: HISTORY_EVENTS.FORCE_RELEASED, at: AT },
                { sprintId: 'newer', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS', at: AT },
            ], { limit: 1 }).list();
            assert.strictEqual(rows.filter((r) => r.sprintId === 'old').length, 0);
            assert.strictEqual(rows.length, 1);
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });

    test('CHILD_EXITED or FINISHED alone never synthesize a row', async () => {
        const { dataDir, env } = await fixture();
        try {
            const rows = await idx(env, [
                { sprintId: 'a', event: HISTORY_EVENTS.CHILD_EXITED, at: AT },
                { sprintId: 'b', event: HISTORY_EVENTS.FINISHED, at: AT },
            ]).list();
            assert.deepStrictEqual(rows, []);
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });

    test('LAUNCH_FAILED-only renders unchanged; LAUNCH_FAILED + release yields one launch-failed row', async () => {
        const { dataDir, env } = await fixture();
        try {
            const rows = await idx(env, [
                { sprintId: 'l', event: HISTORY_EVENTS.LAUNCH_FAILED, at: AT, reason: 'dead' },
                { sprintId: 'l', event: HISTORY_EVENTS.AUTO_RELEASED, at: AT },
            ]).list();
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, 'launch-failed');
            const html = renderFinishedRunsHtml(rows, '');
            assert.match(html, /launch-failed-badge/);
            assert.match(html, /launch-failed-reason/);
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });

    test('rendered synthesized card: unknown badge, Raw log only, no History/PR/data-sprint-id/progress', async () => {
        const { dataDir, env } = await fixture();
        try {
            const rows = await idx(env, [{ sprintId: 'abc', event: HISTORY_EVENTS.ABORTED_BY_RESTART, at: AT, reason: 'restart' }]).list();
            const html = renderFinishedRunsHtml(rows, '/ext/se');
            assert.match(html, /<span class="verdict-badge"[^>]*>unknown<\/span>/);
            assert.match(html, /<a class="raw-log-link" href="\/ext\/se\/sprints\/abc\/log"/);
            assert.ok(!html.includes('history-link'));
            assert.ok(!html.includes('pr-link'));
            assert.ok(!/\bdata-sprint-id=/.test(html));
            assert.ok(html.includes('data-finished-sprint-id="abc"'));
            assert.ok(!/\d+\s*\/\s*\d+\s*done/i.test(html));
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });

    test('no history collaborator: output equals file-only result', async () => {
        const { dataDir, env } = await fixture({ s1: '2026-09-20T02:00:00Z' });
        try {
            const rows = await idx(env, null).list();
            assert.deepStrictEqual(rows.map((r) => r.sprintId), ['s1']);
            assert.strictEqual(rows[0].status, 'finished');
        } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
    });
});
