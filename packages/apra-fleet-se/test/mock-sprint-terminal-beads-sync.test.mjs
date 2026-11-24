import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { recordDegradedSync, clearDegradedSyncRecords, DOLT_PUSH_RACE_MAX_RECONCILES } from '../fleet-sprint/dolt-sync.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

// =============================================================================
// End-to-end pin for the sprint-terminal beads check: the real engine
// (runner.js -> Publish PR -> DoltSync.flush -> gitSync.syncBeadsAfter ->
// doltPushAfter) over the mock fleet API.
//
// When the sprint branch is pushed in Publish PR (`git push -u origin ...`),
// onCommand records a pending degraded D-push for member 'local' -- the state
// an earlier non-fatal D-push leaves behind -- and from then on answers every
// `bd dolt push` per scenario:
//   - rejected non-fast-forward every time: the terminal retry runs once (one
//     bounded race loop), still fails, and the RUN RECORD carries the typed
//     beads-sync failure naming the member and the race kind;
//   - accepted: the retry lands and no failure is recorded.
// With nothing pending, Publish PR makes no extra beads push at all.
// =============================================================================

const NON_FAST_FORWARD = {
    content: [{ type: 'text', text: 'Exit code: 1\nerror: failed to push some refs to origin/main\nhint: Updates were rejected because the tip of your current branch is behind' }],
    structuredContent: { exitCode: 1, stdout: '', stderr: 'error: failed to push some refs to origin/main\nhint: Updates were rejected because the tip of your current branch is behind' },
};

const SYNC_REMOTE = 'git+https://example.invalid/org/beads.git';
const LS_REMOTE_RE = / ls-remote https:\/\/example\.invalid\/org\/beads\.git refs\/dolt\/data$/;

const exit0 = (stdout = '') => ({
    content: [{ type: 'text', text: `Exit code: 0\n${stdout}` }],
    structuredContent: { exitCode: 0, stdout, stderr: '' },
});

/**
 * onCommand over one shared beads remote with a configured sync.remote (so
 * D-pushes really run): an accepted push moves refs/dolt/data. It arms at the
 * Publish push; after that every `bd dolt push` is counted and answered by
 * `terminalPush` ('reject' or 'accept').
 */
function terminalBeadsRemote({ seedPending, terminalPush }) {
    const state = { armed: false, terminalPushes: 0, tip: 'a'.repeat(40), minted: 0 };
    const accept = () => {
        state.minted += 1;
        state.tip = String(state.minted).padStart(40, '0');
        return exit0('Push complete.\n');
    };
    const onCommand = ({ command }) => {
        if (/^bd config get sync\.remote/.test(command)) return exit0(JSON.stringify({ key: 'sync.remote', value: SYNC_REMOTE }));
        if (LS_REMOTE_RE.test(command)) return exit0(`${state.tip}\trefs/dolt/data\n`);
        if (command === 'bd dolt pull') return exit0('Pull complete.\n');
        if (command === 'bd vc status --json') return exit0(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
        if (command === 'bd diff remotes/origin/main main --json') return exit0(JSON.stringify([{ IssueID: 'mock-1', DiffType: 'modified' }]));
        if (/^git push -u origin/.test(command)) {
            state.armed = true;
            if (seedPending) {
                recordDegradedSync({ member: 'local', operation: 'push', kind: 'diverged', errorKind: 'remote-race', detail: 'seeded: an earlier D-push kept losing the race' });
            }
            return undefined;
        }
        if (command === 'bd dolt push') {
            if (!state.armed) return accept();
            state.terminalPushes += 1;
            return terminalPush === 'reject' ? NON_FAST_FORWARD : accept();
        }
        return undefined;
    };
    return { state, onCommand };
}

async function runScenario(tag, opts) {
    const remote = terminalBeadsRemote(opts);
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: `Task: ${tag} terminal beads sync scenario work` }],
        maxCycles: 1,
        onCommand: remote.onCommand,
    });
    return { scenario, remote };
}

const TIMEOUT = { timeout: scaledTimeout(180000, { concurrency: TEST_CONCURRENCY }) };

test('a D-push still failing at the terminal is recorded in the run record as a typed beads-sync failure after one retry', TIMEOUT, async () => {
    clearDegradedSyncRecords();
    try {
        await withScenarioMarkers('termbeadsfail', async () => {
            const { scenario, remote } = await runScenario('termbeadsfail', { seedPending: true, terminalPush: 'reject' });
            assert.equal(scenario.error, null, `sprint failed: ${scenario.error && scenario.error.message}`);
            assert.ok(remote.state.armed, 'the Publish push ran');
            assert.equal(remote.state.terminalPushes, 1 + DOLT_PUSH_RACE_MAX_RECONCILES, 'exactly one terminal retry (one bounded race loop)');
            const failure = scenario.result.beadsSyncFailure;
            assert.ok(failure, `run record lacks beadsSyncFailure: ${JSON.stringify(scenario.result)}`);
            assert.equal(failure.reason, 'beads-sync-failed');
            assert.deepEqual(failure.members.map((m) => [m.member, m.kind]), [['local', 'remote-race']]);
            assert.ok(scenario.result.warnings.some((w) => w.includes('beads-sync-failed') && w.includes("member 'local'")), JSON.stringify(scenario.result.warnings));
            assert.equal(scenario.logs.filter((l) => /retrying the beads push once before publishing/.test(l)).length, 1);
            assert.ok(scenario.logs.some((l) => l.startsWith('[Beads Sync FAILED]')), 'the failure is logged loudly');
        });
    } finally {
        clearDegradedSyncRecords();
    }
});

test('a D-push that lands on the terminal retry records no failure', TIMEOUT, async () => {
    clearDegradedSyncRecords();
    try {
        await withScenarioMarkers('termbeadsheal', async () => {
            const { scenario, remote } = await runScenario('termbeadsheal', { seedPending: true, terminalPush: 'accept' });
            assert.equal(scenario.error, null, `sprint failed: ${scenario.error && scenario.error.message}`);
            assert.equal(remote.state.terminalPushes, 1, 'one terminal retry push, which lands');
            assert.equal(scenario.result.beadsSyncFailure, undefined, JSON.stringify(scenario.result));
            assert.ok(!scenario.logs.some((l) => l.startsWith('[Beads Sync FAILED]')));
        });
    } finally {
        clearDegradedSyncRecords();
    }
});

test('with no pending degradation the terminal makes no extra beads push', TIMEOUT, async () => {
    clearDegradedSyncRecords();
    try {
        await withScenarioMarkers('termbeadsnone', async () => {
            const { scenario, remote } = await runScenario('termbeadsnone', { seedPending: false, terminalPush: 'reject' });
            assert.equal(scenario.error, null, `sprint failed: ${scenario.error && scenario.error.message}`);
            assert.ok(remote.state.armed, 'the Publish push ran');
            assert.equal(remote.state.terminalPushes, 0, 'no beads push after the Publish push');
            assert.equal(scenario.result.beadsSyncFailure, undefined);
        });
    } finally {
        clearDegradedSyncRecords();
    }
});
