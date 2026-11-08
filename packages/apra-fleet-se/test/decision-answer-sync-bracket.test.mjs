// An answer recorded while the run is RUNNING is written and pushed only inside
// a beads sync bracket (after its pull), never by recordDecisionAnswer itself.
//
// Part 1 (unit): the real createDecisionWait with a seam that logs every pull,
// member command and push in one ordered sequence.
// Part 2 (mock sprint): the real runner; the answer is recorded while another
// bead is being worked, and the recorded command sequence shows the answer's
// bd writes between a bracketed pull and its push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { createDecisionWait, allPendingDecisions, answerPendingDecision } from '../fleet-sprint/decision-wait.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

function stateWith(id) {
    const decision = {
        decisionId: id, beadId: 'x-1', decisionBeadId: 'x-dec', question: 'Q?',
        options: [{ id: 'a', text: 'A' }], recommendation: 'a', raisedBy: 'doer', cycle: 1, round: 1, notification: {},
    };
    return {
        pendingDecisions: new Map([[id, decision]]),
        doctorBlockedIds: new Map([['x-1', { kind: 'needs-decision', blockedBy: 'x-1', reason: 'r', decisionId: id, cycle: 1, round: 1 }]]),
    };
}

test('unit: recordDecisionAnswer issues no command and no push; the bd writes and the single push happen inside the bracket, after its pull', async () => {
    const seq = [];
    const sprintState = stateWith('decision-bracket-unit');
    const wait = createDecisionWait({
        sprintState, requestPause: () => {}, requestResume: async () => {},
        command: async (cmd) => { seq.push(`cmd:${cmd.split(' ').slice(0, 3).join(' ')}`); return cmd.startsWith('node -e') ? '/tmp/s.txt' : ''; },
        member: 'm',
        pullBeads: async () => { seq.push('pull'); },
        pushBeads: async () => { seq.push('push'); },
    });
    await wait.recordDecisionAnswer('decision-bracket-unit', 'a');
    assert.deepEqual(seq, [], 'recording touched neither a member nor the beads remote');

    // What the runner does inside gitSync.withOpenSyncBracket().
    seq.push('bracket-open');
    seq.push('pull');
    await wait.applyRecordedAnswers();
    seq.push('bracket-close');

    const push = seq.indexOf('push');
    assert.ok(push > seq.indexOf('pull'), 'push is after the pull');
    assert.ok(push < seq.indexOf('bracket-close'), 'push is inside the bracket');
    assert.equal(seq.filter((s) => s === 'push').length, 1);
    const respond = seq.findIndex((s) => s.startsWith('cmd:bd human respond'));
    const note = seq.findIndex((s) => s.startsWith('cmd:bd note'));
    assert.ok(respond > seq.indexOf('pull') && note > respond && push > note, `writes sit between pull and push: ${JSON.stringify(seq)}`);
});

const resetSyncMemo = () => { invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); };
const assignedIds = (opts) => {
    const m = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
};
const approve = async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }] });
const DECIDE = 'Task: decide the cookie handling';
const OTHER = 'Task: unrelated work';
const OTHER2 = 'Task: follow-on work';

test('mock sprint: an answer recorded while another bead runs is written and pushed inside a sync bracket, and the released bead is then worked', async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision answer mid-run bracket', async () => {
        const seq = [];
        let recorded = false;
        let recordedAt = -1;
        let wf = null;
        // For each answer write (bd human respond / bd note): is a sync bracket
        // open at that instant? The runner's pause-guard is true only when no
        // bracket is open, so a closed guard == inside withOpenSyncBracket().
        const writeBracket = [];
        const scenario = await runDevelopLoopScenario('dbracket', {
            members: ['local'],
            taskSpecs: [DECIDE, OTHER, OTHER2].map((title) => ({ title })),
            maxCycles: 3,
            onWorkflow: async (workflow) => { wf = workflow; },
            onCommand: async ({ command }) => {
                const c = String(command);
                if (/bd human respond|bd note /.test(c) && wf && wf._pauseGuard) writeBracket.push({ c: c.slice(0, 40), inBracket: wf._pauseGuard() === false });
                if (/bd human respond|bd note |dolt (pull|push)|bd dolt (pull|push)|git push/.test(c)) seq.push(c.slice(0, 60));
                return undefined;
            },
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                await rc(`bd update ${id(DECIDE)} --set-metadata streak=lane-d --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER)} --set-metadata streak=lane-o --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER2)} --set-metadata streak=lane-p --set-metadata streakOrder=1`, td);
                // OTHER2 only becomes ready after OTHER, i.e. after the decision is pending.
                await rc(`bd dep add ${id(OTHER2)} ${id(OTHER)}`, td);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const decide = list.find((b) => b.title === DECIDE);
                if (decide && ids.includes(decide.id)) {
                    const shown = JSON.parse((await rc(`bd show ${decide.id} --json`, td)).stdout || '[]');
                    const notes = (Array.isArray(shown) ? shown[0] : shown).notes || '';
                    if (!notes.includes('OPERATOR DECISION')) {
                        return { content: [{ text: JSON.stringify({ status: 'NEEDS-DECISION', closedIds: [], notes: 'choose', decision: {
                            beadId: decide.id, question: 'Q?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], recommendation: 'a' } }) }] };
                    }
                } else {
                    if (!recorded) {
                        // Another bead is running and the run is not parked: record the answer now.
                        const pending = allPendingDecisions();
                        if (pending.length > 0) {
                            recorded = true;
                            recordedAt = seq.length;
                            await answerPendingDecision(pending[0].decisionId, 'a: go');
                        }
                    }
                    // Keep this bead open until the answer has been applied, so
                    // work stays runnable and the run reaches the top of the
                    // next cycle (where the runner applies recorded answers
                    // inside its sync bracket) instead of parking in the
                    // paused-wait path that only runs when nothing can.
                    if (recorded && !writeBracket.some((w) => w.c.includes('bd human respond'))) {
                        return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: [], notes: 'Not finished yet.' }) }] };
                    }
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        assert.equal(scenario.error, null, `run completes: ${scenario.error && scenario.error.message}`);
        assert.ok(recorded, 'the answer was recorded while the run was running');
        const respond = seq.findIndex((c, i) => i >= recordedAt && c.includes('bd human respond'));
        assert.ok(respond >= 0, `the answer was written after being recorded: ${JSON.stringify(seq)}`);
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        assert.equal(scenario.finalBeadsById.get(x).status, 'closed', 'the released bead was worked and closed');
        // Runner wiring: every answer write ran with a sync bracket open
        // (applyRecordedDecisionAnswers -> withOpenSyncBracket), not bare.
        assert.ok(writeBracket.some((w) => w.c.includes('bd human respond')), `a bd human respond ran: ${JSON.stringify(writeBracket)}`);
        assert.ok(writeBracket.every((w) => w.inBracket), `answer writes ran outside a sync bracket: ${JSON.stringify(writeBracket)}`);
    });
});
