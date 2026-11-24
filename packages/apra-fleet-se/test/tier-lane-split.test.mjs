import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { splitLanesByTier, laneTier, formatLaneSplitLog } from '../fleet-sprint/worklists.mjs';

// =============================================================================
// Single-tier lanes (fleet-sprint/worklists.mjs splitLanesByTier, wired in
// phases/develop.mjs). Under balanced/economy a lane whose implementation
// beads declare different tiers is split into single-tier doer dispatches,
// in lane order, and logged once; a [test] bead rides the tier of the
// implementation bead before it. quality dispatches a mixed lane exactly as
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
async function laneScenario(tag, lanes, { tierPolicy, tierOverrides } = {}) {
    const titles = Object.values(lanes).flat().map((b) => b.title);
    const ids = {};
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
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
        doerHandler: closeAll,
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

test('unit: a mixed lane splits by impl tier in lane order; the [test] bead rides the impl bead before it', () => {
    const bead = (id, model, title = `[impl] ${id}`) => ({ id, title, metadata: { model, streak: 'L' } });
    const lane = [bead('A', 'cheap'), bead('B', 'premium'), bead('C', 'cheap', '[test] C')];
    const { streaks, splits } = splitLanesByTier([lane]);
    assert.deepEqual(streaks.map((s) => s.map((b) => b.id)), [['A'], ['B', 'C']]);
    assert.deepEqual(splits, [{ lane: 'L', tiers: [{ tier: 'cheap', ids: ['A'] }, { tier: 'premium', ids: ['B', 'C'] }] }]);
    assert.equal(laneTier(streaks[1]), 'premium', 'the sub-lane runs at its impl tier, not the test bead tier');
    const line = formatLaneSplitLog(splits[0]);
    for (const part of ["lane 'L'", 'cheap [A]', 'premium [B, C]', 'should have been single-tier']) assert.ok(line.includes(part), line);
    // A single-tier lane, and a lane whose only other tier is a riding test, are untouched.
    const single = [bead('X', 'cheap'), bead('Y', 'cheap')];
    const riding = [bead('I', 'standard'), bead('T', 'cheap', '[test] T')];
    const r = splitLanesByTier([single, riding]);
    assert.deepEqual(r.streaks, [single, riding]);
    assert.deepEqual(r.splits, []);
    assert.equal(laneTier(riding), 'standard');
});

test('mock sprint (balanced): a lane {A cheap, B premium, C [test]} runs as two single-tier dispatches, cheap {A} then premium {B, C}, and logs the split', async () => {
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
