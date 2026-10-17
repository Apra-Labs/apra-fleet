import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHarvestPhase, HARVEST_STATUS_COMMAND } from '../fleet-sprint/phases/harvest.mjs';
import { WorkflowError } from '@apralabs/apra-fleet-workflow';
import { HarvestWriteViolationError } from '../fleet-sprint/errors.mjs';
import { isTypedAbortError } from '../fleet-sprint/abort.mjs';
import { isTerminalSprintFailure } from '../fleet-sprint/dispatch-failure.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// harvest_mode governs the HARVESTER's writes only. The engine's own KB bible
// commit (kbWork.commitRound('harvest')) moves HEAD and the remote branch tip
// in every mode, so it must run AFTER the no-write check -- otherwise the
// engine's own commit would be reported as a harvester write.
//
// The member's repository is modelled by a stub command() seam; the kbWork
// stub's commitRound advances both HEAD and the remote tip, exactly as a real
// bible commit + push would.
// =============================================================================

const BRANCH = 'feat/kb-order';
const BASE_SHA = 'a'.repeat(40);
const BIBLE_SHA = 'b'.repeat(40);
const ROGUE_SHA = 'c'.repeat(40);

function memberRepo({ remoteTip = BASE_SHA } = {}) {
    const state = { head: BASE_SHA, remoteTip, status: '' };
    const calls = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, member: opts && opts.member_name });
        if (cmd === 'git rev-parse HEAD') return { ok: true, output: `${state.head}\n` };
        if (cmd === HARVEST_STATUS_COMMAND) return { ok: true, output: state.status };
        if (cmd === `git ls-remote origin refs/heads/${BRANCH}`) {
            return { ok: true, output: state.remoteTip === null ? '' : `${state.remoteTip}\trefs/heads/${BRANCH}\n` };
        }
        if (cmd.startsWith('git reset --keep ')) { state.head = cmd.slice('git reset --keep '.length); return { ok: true, output: '' }; }
        return { ok: true, output: '' };
    };
    return { state, calls, command };
}

function baseArgs(extra) {
    return {
        phase: () => {},
        log: () => {},
        targetIssues: ['issue-1'],
        finalCycleLabel: '1',
        budget: {},
        closedCountHistory: [],
        highWaterClosedCount: 0,
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        integTestRunnerSpend: 0,
        integTestRunnerDispatchCount: 0,
        finalVerdictResult: { verdict: 'PASS' },
        finalClosedCount: 1,
        finalOpenAtGoalCount: 0,
        finalDeferredAtGoalIds: [],
        regressionResult: null,
        computeBranchSlug: (b) => b.replace(/[^A-Za-z0-9]+/g, '-'),
        buildAnalysisText: () => '# Sprint analysis\n',
        buildCostAnalysis: () => '',
        ...extra,
    };
}

test('pr-body-only: the engine KB bible commit (HEAD + remote tip move) after the harvester is not reported as a harvester write', async () => {
    const repo = memberRepo();
    const order = [];
    const { ctx } = createRecordingCtx({
        responses: [() => { order.push('harvester-dispatch'); return { status: 'OK', notes: 'harvested' }; }],
    });
    const kbWork = {
        commitRound: async (round) => {
            order.push(`commitRound:${round}`);
            // The engine's bible commit + G-push: HEAD and origin both advance.
            repo.state.head = BIBLE_SHA;
            repo.state.remoteTip = BIBLE_SHA;
        },
        warnPending: () => {},
    };
    const out = await runHarvestPhase(baseArgs({
        dispatchCtx: ctx,
        command: repo.command,
        kbWork,
        validated: { branch: BRANCH, baseBranch: 'main', harvestMode: 'pr-body-only' },
    }));
    assert.deepEqual(order, ['harvester-dispatch', 'commitRound:harvest'], 'the bible commit runs after the harvester dispatch');
    assert.equal(out.harvestWriteCheck.status, 'clean', `write check must be clean, got: ${JSON.stringify(out.harvestWriteCheck)}`);
    assert.ok(out.harvestWriteCheck.detail.includes(BASE_SHA), 'the clean check reports the pre-bible-commit HEAD');
    assert.ok(!repo.calls.some((c) => c.cmd.startsWith('git reset')), 'the engine never resets its own bible commit away');
});

test('pr-body-only: a remote branch the harvester CREATED (absent before, sha after) is a loud HARVEST_WRITE_VIOLATION', async () => {
    const repo = memberRepo({ remoteTip: null });
    const logs = [];
    const { ctx } = createRecordingCtx({
        responses: [() => { repo.state.remoteTip = ROGUE_SHA; return { status: 'OK', notes: 'harvested' }; }],
    });
    let commitRoundCalled = false;
    await assert.rejects(
        runHarvestPhase(baseArgs({
            log: (l) => logs.push(l),
            dispatchCtx: ctx,
            command: repo.command,
            kbWork: { commitRound: async () => { commitRoundCalled = true; } },
            validated: { branch: BRANCH, baseBranch: 'main', harvestMode: 'pr-body-only' },
        })),
        (err) => {
            assert.ok(err instanceof HarvestWriteViolationError, 'typed harvest violation');
            assert.ok(err instanceof WorkflowError, 'a WorkflowError, so the sprint ends with a terminal record');
            assert.equal(err.code, 'HARVEST_WRITE_VIOLATION');
            assert.equal(err.kind, 'remote-push');
            assert.equal(err.branch, BRANCH);
            assert.match(err.message, /did not exist before the harvester dispatch and now points at c{40}/);
            return true;
        },
    );
    assert.ok(logs.some((l) => l.startsWith('[Harvest Write Violation]') && l.includes('did not exist before')), 'loud violation log');
    assert.equal(commitRoundCalled, false, 'no bible commit after a harvester push violation');
});

test('HarvestWriteViolationError is a terminal WorkflowError but NOT a typed abort (finalizeAbort would push and publish the rogue write)', () => {
    const err = new HarvestWriteViolationError('x', { harvestMode: 'off', member: 'm', branch: BRANCH, kind: 'remote-push' });
    assert.ok(err instanceof WorkflowError);
    assert.equal(err.code, 'HARVEST_WRITE_VIOLATION');
    assert.equal(err.harvestMode, 'off');
    assert.equal(err.member, 'm');
    assert.equal(isTypedAbortError(err), false);
    assert.equal(isTerminalSprintFailure(err), true, 'the runner records a terminal state for it');
});
