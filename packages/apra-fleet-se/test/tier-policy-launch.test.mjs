import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { holdTierPolicy, resolveTierPolicy } from '../fleet-sprint/tier-policy.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

// Launch path of tierPolicy / tierOverrides: POST /api/sprints -> spawner argv
// -> cli runner args -> sprint-args resolved policy, plus ledger and resume.

const NOW = () => '2026-10-01T00:00:00.000Z';
const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };
const BASE_ARGS = { target_issue: 'x-1', members: ['m1'], branch: 'sprint/a', base_branch: 'main' };

async function makeController(captured, dir, ledgerOverride) {
    const ledger = ledgerOverride ?? createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: NOW });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: NOW });
    await history.start();
    let nextPid = 7100;
    const spawner = createSpawner({
        basePort: 9400,
        isPortAvailable: async () => true,
        dataDir: 'unused-data-dir',
        fs: { mkdirSync() {}, openSync() { return 3; }, closeSync() {} },
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            return { pid, once() { return this; }, unref() {} };
        },
    });
    const controller = createSprintController({
        ledger, history, spawner,
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({ tasks: [] }),
    });
    return { controller, ledger };
}

async function withController(fn) {
    const captured = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tierpolicy-api-'));
    try {
        const ctx = await makeController(captured, dir);
        return await fn({ ...ctx, captured, dir });
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

const flag = (args, name) => args[args.indexOf(name) + 1];

describe('tier policy launch: sprint-args', () => {
    test('absent resolves balanced with cap 20', () => {
        const v = validateArgs(BASE_ARGS);
        assert.equal(v.tierPolicy.name, 'balanced');
        assert.equal(v.tierPolicy.premiumCapPct, 20);
    });
    test('economy, quality and overrides reach the resolved policy unchanged', () => {
        assert.equal(validateArgs({ ...BASE_ARGS, tier_policy: 'economy' }).tierPolicy.premiumCapPct, 10);
        const q = validateArgs({ ...BASE_ARGS, tier_policy: 'quality' }).tierPolicy;
        assert.equal(q.name, 'quality');
        assert.equal(q.premiumCapPct, null);
        const o = validateArgs({ ...BASE_ARGS, tier_policy: 'economy', tier_overrides: { premiumCapPct: 5 } });
        assert.equal(o.tierPolicy.name, 'economy');
        assert.equal(o.tierPolicy.premiumCapPct, 5);
        const js = validateArgs({ ...BASE_ARGS, tier_overrides: '{"premiumCapPct":7}' });
        assert.equal(js.tierPolicy.premiumCapPct, 7);
    });
    test('invalid preset or overrides throw naming the field', () => {
        assert.throws(() => validateArgs({ ...BASE_ARGS, tier_policy: 'fast' }), /tierPolicy/);
        assert.throws(() => validateArgs({ ...BASE_ARGS, tier_overrides: { premiumCapPct: 150 } }), /tierOverrides/);
        assert.throws(() => validateArgs({ ...BASE_ARGS, tier_overrides: '{nope' }), /tierOverrides/);
    });
});

describe('tier policy launch: cli.mjs and spawner argv', () => {
    const base = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };
    test('cli.mjs forwards both only when given', () => {
        const a = buildRunnerArgs({ ...base, tierPolicy: 'quality', tierOverrides: '{"premiumCapPct":5}' });
        assert.equal(a.tier_policy, 'quality');
        assert.equal(a.tier_overrides, '{"premiumCapPct":5}');
        const b = buildRunnerArgs({ ...base });
        assert.equal('tier_policy' in b, false);
        assert.equal('tier_overrides' in b, false);
    });
    test('buildSprintArgv emits --tier-policy and --tier-overrides only when set', () => {
        const b = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
        const argv = buildSprintArgv({ ...b, tierPolicy: 'economy', tierOverrides: '{"premiumCapPct":5}' });
        assert.equal(flag(argv, '--tier-policy'), 'economy');
        assert.equal(flag(argv, '--tier-overrides'), '{"premiumCapPct":5}');
        const bare = buildSprintArgv({ ...b });
        assert.equal(bare.includes('--tier-policy'), false);
        assert.equal(bare.includes('--tier-overrides'), false);
    });
});

describe('tier policy launch: supervisor POST /api/sprints', () => {
    test('no tierPolicy: the child gets --tier-policy balanced and no overrides flag', () => withController(async ({ controller, captured }) => {
        const res = await controller.launch({ ...LAUNCH });
        assert.equal(flag(captured[0].args, '--tier-policy'), 'balanced');
        assert.equal(captured[0].args.includes('--tier-overrides'), false);
        assert.equal(res.tierPolicy, 'balanced');
    }));

    test('economy plus object overrides reach the child argv end to end into sprint-args', () => withController(async ({ controller, captured }) => {
        await controller.launch({ ...LAUNCH, tierPolicy: 'economy', tierOverrides: { premiumCapPct: 5 } });
        const args = captured[0].args;
        assert.equal(flag(args, '--tier-policy'), 'economy');
        const v = validateArgs({ ...BASE_ARGS, tier_policy: flag(args, '--tier-policy'), tier_overrides: flag(args, '--tier-overrides') });
        assert.equal(v.tierPolicy.name, 'economy');
        assert.equal(v.tierPolicy.premiumCapPct, 5);
    }));

    test('per-role, doerDefault and doerCeiling overrides are accepted and reach the runner policy', () => withController(async ({ controller, captured }) => {
        const tierOverrides = { planner: 'standard', 'reviewer-round': 'premium', doerDefault: 'cheap', doerCeiling: 'standard' };
        await controller.launch({ ...LAUNCH, tierPolicy: 'balanced', tierOverrides });
        const v = validateArgs({ ...BASE_ARGS, tier_policy: 'balanced', tier_overrides: flag(captured[0].args, '--tier-overrides') });
        assert.equal(v.tierPolicy.roleTiers.planner, 'standard');
        assert.equal(v.tierPolicy.roleTiers['reviewer-round'], 'premium');
        assert.equal(v.tierPolicy.reviewerRound, 'fixed');
        assert.equal(v.tierPolicy.doerDefault, 'cheap');
        assert.equal(v.tierPolicy.doerCeiling, 'standard');
    }));

    test('overrides given as a JSON string are accepted', () => withController(async ({ controller, captured }) => {
        await controller.launch({ ...LAUNCH, tierPolicy: 'quality', tierOverrides: '{"premiumCapPct":9}' });
        assert.equal(flag(captured[0].args, '--tier-overrides'), '{"premiumCapPct":9}');
    }));

    for (const [label, body, field] of [
        ['preset fast', { tierPolicy: 'fast' }, 'tierPolicy'],
        ['cap 150', { tierOverrides: { premiumCapPct: 150 } }, 'tierOverrides'],
        ['unknown key', { tierOverrides: { bogus: 1 } }, 'tierOverrides'],
        ['bad role tier', { tierOverrides: { planner: 'opus' } }, 'tierOverrides'],
        ['bad doerCeiling', { tierOverrides: { doerCeiling: 'max' } }, 'tierOverrides'],
        ['bad JSON string', { tierOverrides: '{nope' }, 'tierOverrides'],
    ]) {
        test(`${label}: 400 naming ${field}, no child spawned`, () => withController(async ({ controller, captured }) => {
            await assert.rejects(controller.launch({ ...LAUNCH, ...body }), (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 400);
                assert.equal(err.field, field);
                return true;
            });
            assert.equal(captured.length, 0);
        }));
    }

    test('ledger and GET /api/sprints expose the launch policy', () => withController(async ({ controller, ledger }) => {
        await controller.launch({ ...LAUNCH, tierPolicy: 'quality', tierOverrides: { premiumCapPct: 5 } });
        const [r] = ledger.list();
        assert.equal(r.tierPolicy, 'quality');
        assert.deepEqual(r.tierOverrides, { premiumCapPct: 5 });
        const { sprints } = await controller.listSprints();
        assert.equal(sprints[0].tierPolicy, 'quality');
        assert.deepEqual(sprints[0].tierOverrides, { premiumCapPct: 5 });
    }));

    test('readopt: a restarted supervisor reloads the ledger policy; the default does not leak in', () => withController(async ({ controller, dir, captured }) => {
        await controller.launch({ ...LAUNCH, tierPolicy: 'quality' });
        const ledger2 = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: NOW });
        const { controller: c2 } = await makeController([], dir, ledger2);
        const { sprints } = await c2.listSprints();
        assert.equal(sprints.length, 1);
        assert.equal(sprints[0].tierPolicy, 'quality');
        // the live child's own command line is what it keeps; the restart spawned nothing.
        assert.equal(flag(captured[0].args, '--tier-policy'), 'quality');
        assert.equal(captured.length, 1);
    }));
});

describe('tier policy launch: runner resume', () => {
    test('a resume over the same run context keeps the held policy, not the current args', () => {
        const context = {};
        const first = holdTierPolicy(context, validateArgs({ ...BASE_ARGS, tier_policy: 'quality' }).tierPolicy);
        const resumed = holdTierPolicy(context, validateArgs(BASE_ARGS).tierPolicy);
        assert.equal(first.name, 'quality');
        assert.equal(resumed.name, 'quality');
        assert.equal(resumed, resolveTierPolicy('quality'));
    });
});
