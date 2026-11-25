import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';
import { createBeadsPushedProbe } from '../src/supervisor/beads-pushed-check.mjs';
import { readUnpushedWith } from '../fleet-sprint/dolt-sync.mjs';

const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };

async function make(checkBeadsPushed) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bdpushed-'));
    const now = () => '2026-10-01T00:00:00.000Z';
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now });
    await history.start();
    const spawned = [];
    const spawner = { spawnSprint: async (o) => { spawned.push(o); return { pid: 4242, port: 9999, logPath: 'x.log' }; } };
    const controller = createSprintController({
        ledger, history, spawner, listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }), checkBeadsPushed,
    });
    return { controller, ledger, spawned, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('unpushed beads: launch is refused 409 with the push remedy; no spawn, no reservation', async () => {
    const t = await make(async () => ({ pending: true }));
    try {
        await assert.rejects(() => t.controller.launch({ ...LAUNCH }), (err) => {
            assert.equal(err.statusCode ?? err.status, 409);
            assert.match(err.message, /`bd dolt commit`, then `bd dolt push`/);
            assert.ok(!err.message.includes('&&'), 'the remedy must be shell-neutral');
            return true;
        });
        assert.equal(t.spawned.length, 0);
        assert.equal(t.ledger.list().length, 0);
    } finally { await t.cleanup(); }
});

test('nothing pending: launch proceeds with no warning', async () => {
    const t = await make(async () => ({ pending: false }));
    try {
        const res = await t.controller.launch({ ...LAUNCH });
        assert.equal(t.spawned.length, 1);
        assert.equal(res.beadsPushWarning, undefined);
    } finally { await t.cleanup(); }
});

test('inconclusive probe: launch proceeds and carries a warning naming why', async () => {
    const t = await make(async () => ({ pending: null, why: 'bd diff failed: no remote-tracking branch' }));
    try {
        const res = await t.controller.launch({ ...LAUNCH });
        assert.equal(t.spawned.length, 1);
        assert.match(res.beadsPushWarning, /no remote-tracking branch/);
        assert.ok(res.warnings.includes(res.beadsPushWarning));
    } finally { await t.cleanup(); }
});

test('a throwing probe is inconclusive, never a refusal', async () => {
    const t = await make(async () => { throw new Error('boom'); });
    try {
        const res = await t.controller.launch({ ...LAUNCH });
        assert.match(res.beadsPushWarning, /boom/);
    } finally { await t.cleanup(); }
});

test('probe runs bd vc status then bd diff in the given cwd', async () => {
    const calls = [];
    const execBd = async (args, opts) => {
        calls.push({ args, cwd: opts.cwd });
        return { stdout: args[0] === 'vc' ? '{"branch":"main"}' : '[{"IssueID":"x"}]' };
    };
    const out = await createBeadsPushedProbe({ cwd: '/some/dir', execBd })();
    assert.equal(out.pending, true);
    assert.deepEqual(calls.map((c) => c.args), [['vc', 'status', '--json'], ['diff', 'remotes/origin/main', 'main', '--json']]);
    assert.ok(calls.every((c) => c.cwd === '/some/dir'));
});
