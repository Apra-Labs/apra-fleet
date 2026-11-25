import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, MOCK_BRANCH_TIPS } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { splitLanesByTier, laneTier, formatLaneSplitLog } from '../fleet-sprint/worklists.mjs';

// =============================================================================
// Single-tier lanes (fleet-sprint/worklists.mjs splitLanesByTier, wired in
// phases/develop.mjs). Under balanced/economy a lane whose implementation
// beads declare different tiers is split into consecutive single-tier
// segments in lane order -- never regrouped by tier -- and the segments run
// strictly in order, one per Develop round; a [test] bead rides the tier of
// the implementation bead before it. quality dispatches a mixed lane exactly as
// before tier policies: the first bead's tier when streaks <= doers, the
// lane's maximum tier in a packed round.
//
// The premium cap is lifted (premiumCapPct 100) in the balanced scenarios so
// the cap gate never re-plans these deliberately premium-carrying plans.
// =============================================================================

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const closeAll = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await rc(`bd close ${id}`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
};
const NO_CAP = { premiumCapPct: 100 };

/**
 * One lane-carrying scenario. `lanes` maps a lane id to its beads in lane
 * order: [{ title, model }]. Returns the doer dispatches as
 * { ids (titles), model } plus the run's logs and title -> id map.
 */
async function laneScenario(tag, lanes, { tierPolicy, tierOverrides, members = ['local'], doerHandler = closeAll } = {}) {
    const titles = Object.values(lanes).flat().map((b) => b.title);
    const ids = {};
    const scenario = await runDevelopLoopScenario(tag, {
        members,
        taskSpecs: titles.map((title) => ({ title })),
        ...(tierPolicy ? { tierPolicy } : {}),
        ...(tierOverrides ? { tierOverrides } : {}),
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            for (const [lane, beads] of Object.entries(lanes)) {
                for (const [i, b] of beads.entries()) {
                    const id = tasks.find((t) => t.title === b.title).id;
                    ids[b.title] = id;
                    await rc(`bd update ${id} --set-metadata streak=${lane} --set-metadata streakOrder=${i + 1} --set-metadata model=${b.model}`, td);
                }
            }
        },
        doerHandler,
        reviewerHandler: approve,
    });
    assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
    const titleOf = new Map(Object.entries(ids).map(([t, id]) => [id, t]));
    const doers = scenario.dispatched
        .filter((d) => d.agent === 'doer')
        .map((d) => ({ titles: assignedIds(d.prompt).map((id) => titleOf.get(id)), model: d.model }));
    return { scenario, doers, ids };
}

const A = '[impl] split A cheap';
const B = '[impl] split B premium';
const C = '[test] split C covers B';
const MIXED_LANE = { 'lane-mixed': [{ title: A, model: 'cheap' }, { title: B, model: 'premium' }, { title: C, model: 'cheap' }] };

test('unit: a mixed lane splits into consecutive segments in lane order; only the head segment runs this round', () => {
    const bead = (id, model, title = `[impl] ${id}`) => ({ id, title, metadata: { model, streak: 'L' } });
    // A mid-lane premium bead: [A std, B prem, C std, T test] is the segments
    // [A] -> [B] -> [C, T], never regrouped by tier into [A, C, T] + [B].
    const lane = [bead('A', 'standard'), bead('B', 'premium'), bead('C', 'standard'), bead('T', 'cheap', '[test] T')];
    const { streaks, held, splits } = splitLanesByTier([lane]);
    assert.deepEqual(streaks.map((s) => s.map((b) => b.id)), [['A']], 'only the first segment runs this round');
    assert.deepEqual(held.map((s) => s.map((b) => b.id)), [['B', 'C', 'T']], 'the rest of the lane is held, in lane order');
    assert.deepEqual(splits, [{
        lane: 'L',
        segments: [{ tier: 'standard', ids: ['A'] }, { tier: 'premium', ids: ['B'] }, { tier: 'standard', ids: ['C', 'T'] }],
        heldIds: ['B', 'C', 'T'],
    }]);
    const line = formatLaneSplitLog(splits[0]);
    for (const part of ['tier.split', "lane 'L'", 'standard [A] -> premium [B] -> standard [C, T]', 'holds [B, C, T]', 'should have been single-tier']) {
        assert.ok(line.includes(part), line);
    }
    // Next round the held tail re-forms as the lane: its head is [B] alone.
    const next = splitLanesByTier([held[0]]);
    assert.deepEqual(next.streaks.map((s) => s.map((b) => b.id)), [['B']]);
    assert.deepEqual(next.held.map((s) => s.map((b) => b.id)), [['C', 'T']]);
    // The [test] bead rides the impl bead before it.
    const ride = splitLanesByTier([[bead('X', 'cheap'), bead('Y', 'premium'), bead('Z', 'cheap', '[test] Z')]]);
    assert.deepEqual(ride.splits[0].segments, [{ tier: 'cheap', ids: ['X'] }, { tier: 'premium', ids: ['Y', 'Z'] }]);
    assert.equal(laneTier(ride.held[0]), 'premium', 'the held segment runs at its impl tier, not the test bead tier');
    // A single-tier lane, and a lane whose only other tier is a riding test, are untouched.
    const single = [bead('P', 'cheap'), bead('Q', 'cheap')];
    const riding = [bead('I', 'standard'), bead('U', 'cheap', '[test] U')];
    const r = splitLanesByTier([single, riding]);
    assert.deepEqual(r.streaks, [single, riding]);
    assert.deepEqual(r.held, []);
    assert.deepEqual(r.splits, []);
    assert.equal(laneTier(riding), 'standard');
});

test('mock sprint (balanced): a lane {A cheap, B premium, C [test]} runs as two single-tier dispatches in order, cheap {A} then premium {B, C}, and logs the split', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes balanced split', async () => {
        const { scenario, doers, ids } = await laneScenario('tls-split', MIXED_LANE, { tierOverrides: NO_CAP });
        assert.deepEqual(doers, [
            { titles: [A], model: 'cheap' },
            { titles: [B, C], model: 'premium' },
        ]);
        const splitLogs = scenario.logs.filter((l) => l.includes('[tier-lanes]'));
        assert.equal(splitLogs.length, 1, `exactly one split line: ${JSON.stringify(splitLogs)}`);
        for (const part of ["lane 'lane-mixed'", ids[A], ids[B], ids[C], 'should have been single-tier']) {
            assert.ok(splitLogs[0].includes(part), `the split line names ${part}: ${splitLogs[0]}`);
        }
    });
});

test('mock sprint (balanced, 2 doers): a mid-lane premium bead keeps lane order -- {A std} then {B prem} then {C std, T}, one segment per round, never two at once', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes balanced mid-lane premium', async () => {
        const MA = '[impl] mid A standard';
        const MB = '[impl] mid B premium';
        const MC = '[impl] mid C standard';
        const MT = '[test] mid T covers C';
        const { scenario, doers } = await laneScenario('tls-midlane', {
            'lane-mid': [
                { title: MA, model: 'standard' }, { title: MB, model: 'premium' },
                { title: MC, model: 'standard' }, { title: MT, model: 'standard' },
            ],
        }, { tierOverrides: NO_CAP, members: ['m1', 'm2'] });
        assert.deepEqual(doers, [
            { titles: [MA], model: 'standard' },
            { titles: [MB], model: 'premium' },
            { titles: [MC, MT], model: 'standard' },
        ]);
        // One doer dispatch per Develop round: no segment ran beside another.
        const rounds = scenario.logs.filter((l) => /^Develop C1 R\d streak outcomes:/.test(l));
        assert.equal(rounds.length, 3, JSON.stringify(rounds));
        for (const line of rounds) assert.equal((line.match(/"beadIds"/g) || []).length, 1, line);
    });
});

test('mock sprint (balanced): an escalated bead redoes alone at premium; its standard successor waits for the next round', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes balanced escalation order', async () => {
        const EA = '[impl] esc-lane A standard';
        const EB = '[impl] esc-lane B standard';
        let calls = 0;
        const { scenario, doers, ids } = await laneScenario('tls-escalate', {
            'lane-esc': [{ title: EA, model: 'standard' }, { title: EB, model: 'standard' }],
        }, {
            members: ['m1', 'm2'],
            doerHandler: async (ctx) => {
                calls += 1;
                if (calls === 1) {
                    // Work committed, but A's verification failed: the doer stops the lane with A open.
                    MOCK_BRANCH_TIPS.set(ctx.opts.member_name || '(none)', 'c'.repeat(40));
                    return report({ status: 'VERIFY', closedIds: [], notes: 'tests still failing' });
                }
                return closeAll(ctx);
            },
        });
        MOCK_BRANCH_TIPS.clear();
        assert.deepEqual(doers, [
            { titles: [EA, EB], model: 'standard' },
            { titles: [EA], model: 'premium' },
            { titles: [EB], model: 'standard' },
        ]);
        assert.ok(scenario.logs.some((l) => l.includes(`[tier-escalation] bead ${ids[EA]} escalated standard -> premium`)));
        assert.ok(scenario.logs.some((l) => l.includes('[tier-lanes] tier.split') && l.includes(`holds [${ids[EB]}]`)));
    });
});

test('mock sprint (balanced): a [test] bead rides its impl lane -- {impl standard, [test] cheap} is one standard dispatch; a single-tier lane is one dispatch with no split log', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes balanced riding test', async () => {
        const I = '[impl] ride I standard';
        const T = '[test] ride T cheap';
        const X = '[impl] single X cheap';
        const Y = '[impl] single Y cheap';
        const { scenario, doers } = await laneScenario('tls-ride', {
            'lane-ride': [{ title: I, model: 'standard' }, { title: T, model: 'cheap' }],
            'lane-single': [{ title: X, model: 'cheap' }, { title: Y, model: 'cheap' }],
        }, { tierOverrides: NO_CAP });
        const sorted = doers.slice().sort((a, b) => a.titles[0].localeCompare(b.titles[0]));
        assert.deepEqual(sorted, [
            { titles: [I, T], model: 'standard' },
            { titles: [X, Y], model: 'cheap' },
        ]);
        assert.ok(!scenario.logs.some((l) => l.includes('[tier-lanes]')), 'no lane is split');
    });
});

test('mock sprint (balanced): tierOverrides.doerDefault prices a dispatch whose beads declare no tier', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes doer default', async () => {
        const U = '[impl] untiered U';
        const scenario = await runDevelopLoopScenario('tls-doer-default', {
            members: ['local'],
            taskSpecs: [{ title: U }],
            tierOverrides: { ...NO_CAP, doerDefault: 'cheap' },
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                await rc(`bd update ${tasks[0].id} --set-metadata streak=lane-u --set-metadata streakOrder=1`, td);
            },
            doerHandler: closeAll,
            reviewerHandler: approve,
        });
        assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
        const doers = scenario.dispatched.filter((d) => d.agent === 'doer');
        assert.deepEqual(doers.map((d) => d.model), ['cheap']);
    });
});

test('mock sprint (quality): the same mixed lane dispatches as before tier policies -- one dispatch at the first bead tier (streaks <= doers)', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes quality first bead', async () => {
        const { scenario, doers } = await laneScenario('tls-quality', MIXED_LANE, { tierPolicy: 'quality' });
        assert.deepEqual(doers, [{ titles: [A, B, C], model: 'cheap' }]);
        assert.ok(!scenario.logs.some((l) => l.includes('[tier-lanes]')), 'quality never splits');
    });
});

test('mock sprint (quality): in a packed round (more streaks than doers) the mixed lane dispatches at its max tier', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier lanes quality packed', async () => {
        const D = '[impl] packed D premium';
        const { doers } = await laneScenario('tls-quality-packed', {
            ...MIXED_LANE,
            'lane-other': [{ title: D, model: 'premium' }],
        }, { tierPolicy: 'quality' });
        const mixed = doers.find((d) => d.titles.includes(A));
        assert.deepEqual(mixed, { titles: [A, B, C], model: 'premium' });
    });
});
