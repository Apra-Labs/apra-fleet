import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { validateVerdict, FALLBACK_SCHEMAS } from '../fleet-sprint/contracts.mjs';
import {
    validateDecisionRequest, formatDecisionRequest, recordPendingDecision, NEEDS_DECISION_KIND,
} from '../fleet-sprint/decisions.mjs';
import { collectSetAsideEntries, formatSetAsideItems } from '../fleet-sprint/set-aside.mjs';

// =============================================================================
// NEEDS-DECISION: a doer or reviewer asks an operator to choose. The bead is
// set aside at once (never re-dispatched in the run while the decision is
// pending), a dedicated decision bead labelled `human` carries the full
// question and every option verbatim, the work bead's notes gain the request
// (appended), and the set-aside report lists the bead with kind
// needs-decision and the untruncated question. Other ready beads keep
// dispatching.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

// Longer than the 300 characters the doer notes used to be capped at, so a
// truncation anywhere on the path fails these tests.
const QUESTION = 'The sign-out end-to-end test cannot pass locally: the local API emulator rejects ' +
    'version 2.0 payload cookies that carry attributes and answers the logout call with a 500, ' +
    'while the deployed gateway accepts them. The acceptance criteria require that test to pass ' +
    'locally, so either the emulator changes, it is patched, or the criterion is narrowed to the ' +
    'deployed sandbox only. Which should the next dispatch do?';
const OPTIONS = [
    { id: 'a', text: 'Upgrade the local emulator to the next major version, which accepts cookie attributes (touches the lockfile).' },
    { id: 'b', text: 'Patch the installed emulator with a postinstall patch file that strips the attribute check.' },
    { id: 'c', text: 'Run the sign-out test only against the deployed sandbox and mark it skipped locally.' },
];
const RECOMMENDATION = 'a, because it removes the mismatch instead of hiding it.';

const decisionFor = (beadId) => ({ beadId, question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION });

// --- contracts ---------------------------------------------------------------

test('contract: doer and reviewer outputs accept NEEDS-DECISION with question, >=2 options and recommendation', () => {
    const doer = { status: 'NEEDS-DECISION', closedIds: [], notes: 'needs a choice', decision: decisionFor('x-1') };
    const reviewer = { verdict: 'NEEDS-DECISION', notes: 'needs a choice', reopenIds: [], newTasks: [], decision: decisionFor('x-1') };
    assert.equal(validateVerdict('doerReport', doer).valid, true, JSON.stringify(validateVerdict('doerReport', doer).errors));
    assert.equal(validateVerdict('reviewerVerdict', reviewer).valid, true, JSON.stringify(validateVerdict('reviewerVerdict', reviewer).errors));
    // Existing outcomes are unchanged.
    assert.equal(validateVerdict('doerReport', { status: 'VERIFY', closedIds: ['a'], notes: 'ok' }).valid, true);
    assert.equal(validateVerdict('doerReport', { status: 'BLOCKED', closedIds: [], blockedIds: ['a'], notes: 'no' }).valid, true);
    assert.equal(validateVerdict('reviewerVerdict', { verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }).valid, true);
});

test('contract: a NEEDS-DECISION without options (or with one, or without a decision) is rejected -- vendored and fallback schemas alike', () => {
    const ajv = new Ajv({ strict: false });
    const fallbackDoer = ajv.compile(FALLBACK_SCHEMAS.doerReport);
    const fallbackReviewer = ajv.compile(FALLBACK_SCHEMAS.reviewerVerdict);
    const { options: _omit, ...noOptions } = decisionFor('x-1');
    const bad = [
        { decision: noOptions },
        { decision: { ...decisionFor('x-1'), options: [OPTIONS[0]] } },
        { decision: { ...decisionFor('x-1'), options: [{ id: 'a' }, { id: 'b', text: 'B' }] } },
        {},
    ];
    for (const extra of bad) {
        const doer = { status: 'NEEDS-DECISION', closedIds: [], notes: 'n', ...extra };
        const reviewer = { verdict: 'NEEDS-DECISION', notes: 'n', reopenIds: [], newTasks: [], ...extra };
        assert.equal(validateVerdict('doerReport', doer).valid, false, `doer must reject ${JSON.stringify(extra)}`);
        assert.equal(validateVerdict('reviewerVerdict', reviewer).valid, false, `reviewer must reject ${JSON.stringify(extra)}`);
        assert.equal(fallbackDoer(doer), false, `fallback doer must reject ${JSON.stringify(extra)}`);
        assert.equal(fallbackReviewer(reviewer), false, `fallback reviewer must reject ${JSON.stringify(extra)}`);
    }
});

// --- pure helpers ------------------------------------------------------------

test('unit: validateDecisionRequest normalizes a good request and refuses unusable ones', () => {
    const ok = validateDecisionRequest({ ...decisionFor(' x-1 '), question: `  ${QUESTION}  ` });
    assert.equal(ok.ok, true);
    assert.equal(ok.decision.beadId, 'x-1');
    assert.equal(ok.decision.question, QUESTION, 'the question is kept whole');
    assert.deepEqual(ok.decision.options, OPTIONS);
    assert.equal(validateDecisionRequest(null).ok, false);
    assert.equal(validateDecisionRequest({ ...decisionFor('x-1'), options: [OPTIONS[0]] }).ok, false);
    assert.equal(validateDecisionRequest({ ...decisionFor('x-1'), options: [OPTIONS[0], OPTIONS[0]] }).ok, false, 'duplicate option ids');
    assert.equal(validateDecisionRequest({ ...decisionFor('x 1; rm') }).ok, false, 'bead id must be a bead id');
    assert.equal(validateDecisionRequest({ ...decisionFor('x-1'), question: ' ' }).ok, false);
    assert.equal(validateDecisionRequest({ ...decisionFor('x-1'), recommendation: '' }).ok, false);
});

test('unit: formatDecisionRequest carries the question, every option and the recommendation verbatim', () => {
    const text = formatDecisionRequest(decisionFor('x-1'), { raisedBy: "doer on member 'm'", cycle: 2, round: 3, decisionBeadId: 'x-9' });
    check(text.includes(QUESTION), 'question verbatim');
    for (const o of OPTIONS) check(text.includes(`(${o.id}) ${o.text}`), `option ${o.id} verbatim`);
    check(text.includes(RECOMMENDATION), 'recommendation verbatim');
    check(text.includes('bd human respond x-9'), 'names how to answer');
    check(text.includes('C2 R3'), 'names where it was raised');
});

test('unit: recordPendingDecision files a human-labelled decision bead, appends a note, sets the bead and its blocks dependents aside, and never files twice', async () => {
    const commands = [];
    const command = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes('rmSync')) return '';
        if (cmd.startsWith('node -e')) return `/tmp/staged-${commands.length}.txt`;
        if (cmd.startsWith('bd create')) return 'x-dec\n';
        return '';
    };
    const sprintState = {};
    const scopeBeads = [
        { id: 'x-1', status: 'open', priority: 1, dependencies: [] },
        { id: 'x-2', status: 'open', dependencies: [{ depends_on_id: 'x-1', type: 'blocks' }] },
        { id: 'x-3', status: 'open', dependencies: [{ depends_on_id: 'x-1', type: 'parent-child' }] },
    ];
    const rec = await recordPendingDecision({
        sprintState, decision: decisionFor('x-1'), raisedBy: "doer on member 'm'",
        cycle: 1, round: 2, command, member: 'm', scopeBeads,
    });
    assert.equal(rec.decisionBeadId, 'x-dec');
    assert.equal(rec.question, QUESTION);
    assert.deepEqual(rec.options, OPTIONS);
    assert.deepEqual(rec.notification, {});
    assert.equal(sprintState.pendingDecisions.get(rec.decisionId), rec);

    const create = commands.find((c) => c.startsWith('bd create'));
    check(/ -l human /.test(create) && / -t decision /.test(create) && / -s deferred /.test(create), `decision bead flags: ${create}`);
    check(create.includes('--deps "discovered-from:x-1"') && !/--parent|blocks:/.test(create), `linked, not parented or blocking: ${create}`);
    check(/ -p 1 /.test(create), 'carries the work bead priority');
    check(commands.some((c) => c.startsWith('bd note x-1 --file')), 'appends (bd note), never replaces the notes');
    check(!commands.some((c) => /--notes\b/.test(c)), 'never bd update --notes');
    check(!commands.some((c) => /^bd (update|label) x-1\b.*human/.test(c)), 'the work bead is never labelled human');
    // The staged bodies are base64 in the node -e stage command: decode and
    // check the decision bead body carries everything verbatim.
    const removals = commands.filter((c) => c.includes('rmSync'));
    assert.equal(removals.length, 2, 'both staged bodies are removed after use');
    const staged = commands.filter((c) => c.startsWith('node -e') && !c.includes('rmSync')).map((c) => Buffer.from(c.match(/"([A-Za-z0-9+/=]+)"$/)[1], 'base64').toString('utf8'));
    for (const body of staged) {
        check(body.includes(QUESTION), 'staged body has the whole question');
        for (const o of OPTIONS) check(body.includes(o.text), 'staged body has every option');
    }

    const entries = collectSetAsideEntries(sprintState);
    assert.deepEqual(entries.map((e) => [e.id, e.kind]), [['x-1', NEEDS_DECISION_KIND], ['x-2', 'dependent']]);
    check(entries[0].reason.includes(QUESTION), 'set-aside reason carries the whole question');
    assert.equal(entries[0].decisionBeadId, 'x-dec');
    const items = formatSetAsideItems(entries);
    check(items[0].startsWith('x-1: [needs-decision] ') && items[0].includes(QUESTION), `report line: ${items[0]}`);

    const before = commands.length;
    const again = await recordPendingDecision({
        sprintState, decision: decisionFor('x-1'), raisedBy: 'reviewer', cycle: 1, round: 3, command, member: 'm', scopeBeads,
    });
    assert.equal(again, null, 'a second request on the same bead is not filed');
    assert.equal(commands.length, before, 'no bd call for the duplicate');
});

test('unit: a failed decision-bead create is non-fatal -- the bead is still set aside', async () => {
    const command = async (cmd) => {
        if (cmd.includes('rmSync')) return '';
        if (cmd.startsWith('node -e')) return '/tmp/staged.txt';
        if (cmd.startsWith('bd create')) throw new Error('bd create failed');
        return '';
    };
    const logs = [];
    const sprintState = {};
    const rec = await recordPendingDecision({
        sprintState, decision: decisionFor('x-1'), raisedBy: 'doer', cycle: 1, round: 1, command, member: 'm', log: (m) => logs.push(m),
    });
    assert.equal(rec.decisionBeadId, null);
    assert.equal(sprintState.doctorBlockedIds.get('x-1').kind, NEEDS_DECISION_KIND);
    check(logs.some((m) => m.includes('filing the decision bead FAILED')), 'the failure is logged');
});

// --- mock sprints ------------------------------------------------------------

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const doerDispatches = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer');
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const decisionRecord = (logs) => {
    const line = logs.find((m) => m.includes('NEEDS-DECISION set-aside'));
    return line ? JSON.parse(line.slice(line.indexOf('Request: ') + 'Request: '.length)) : null;
};

// Stops the run the moment it pauses awaiting a decision (the decision wait
// itself is covered by mock-sprint-decision-wait.test.mjs), recording the
// published 'decisions' state at that point.
const stopOnDecisionPause = (seen) => async (workflow) => {
    workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
    workflow.on('pause:requested', (e) => {
        if (e.source !== 'needs_decision' || seen.stopped) return;
        seen.stopped = true;
        workflow.requestStop('test: stop at the decision pause');
    });
};

const DECIDE = 'Task: needs an operator decision';
const DEPENDS = 'Task: depends on the decision bead';
const OTHER = 'Task: independent first';
const LATER = 'Task: independent second';

test('mock sprint: a doer NEEDS-DECISION sets the bead aside at once, files a human decision bead, and other beads keep dispatching', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer needs-decision set-aside', async () => {
        const seen = { states: [], stopped: false };
        const scenario = await runDevelopLoopScenario('ndec-doer', {
            onWorkflow: stopOnDecisionPause(seen),
            members: ['local'],
            taskSpecs: [DECIDE, DEPENDS, OTHER, LATER].map((title) => ({ title })),
            maxCycles: 2,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                await rc(`bd update ${id(DECIDE)} --set-metadata streak=lane-d --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(DEPENDS)} --set-metadata streak=lane-e --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER)} --set-metadata streak=lane-o --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(LATER)} --set-metadata streak=lane-l --set-metadata streakOrder=1`, td);
                // DEPENDS waits on DECIDE; LATER only becomes ready once OTHER closes.
                await rc(`bd dep add ${id(DEPENDS)} ${id(DECIDE)}`, td);
                await rc(`bd dep add ${id(LATER)} ${id(OTHER)}`, td);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const decide = list.find((b) => b.title === DECIDE);
                if (decide && ids.includes(decide.id)) {
                    return { content: [{ text: JSON.stringify({
                        status: 'NEEDS-DECISION', closedIds: [], notes: 'Stopped: an operator must choose.',
                        decision: decisionFor(decide.id),
                    }) }] };
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        const id = (title) => scenario.tasks.find((t) => t.title === title).id;
        const [x, dep, other, later] = [DECIDE, DEPENDS, OTHER, LATER].map(id);
        const doers = doerDispatches(scenario);
        const dispatchedFor = (beadId) => doers.filter((d) => assignedIds(d).includes(beadId));

        // (2) X is dispatched exactly once; other ready beads still dispatch,
        // in the same round and in a later one.
        assert.equal(dispatchedFor(x).length, 1, `the decision bead is dispatched once: ${JSON.stringify(doers.map(assignedIds))}`);
        assert.equal(dispatchedFor(dep).length, 0, 'its blocks dependent never dispatches');
        assert.equal(dispatchedFor(other).length, 1, 'an independent ready bead dispatches');
        assert.equal(dispatchedFor(later).length, 1, 'a bead that became ready in a later round dispatches');
        const firstRound = doers.indexOf(dispatchedFor(x)[0]);
        check(doers.indexOf(dispatchedFor(later)[0]) > firstRound, 'the later bead dispatched after the decision was raised');
        check(scenario.logs.some((m) => /Develop C1 R2\b/.test(m)), 'a later develop round ran');
        assert.equal(scenario.finalBeadsById.get(other).status, 'closed');
        assert.equal(scenario.finalBeadsById.get(later).status, 'closed');

        // (3) A decision bead labelled human holds the question and every
        // option verbatim; X stays open and is NOT labelled human.
        const rec = decisionRecord(scenario.logs);
        check(rec, 'the decision is recorded');
        assert.equal(rec.beadId, x);
        assert.equal(rec.question, QUESTION);
        assert.deepEqual(rec.options, OPTIONS);
        const decisionBead = scenario.finalBeadsById.get(rec.decisionBeadId);
        check(decisionBead, `the decision bead ${rec.decisionBeadId} exists`);
        check((decisionBead.labels || []).includes('human'), 'decision bead labelled human');
        check(decisionBead.description.includes(QUESTION), 'decision bead holds the whole question');
        for (const o of OPTIONS) check(decisionBead.description.includes(o.text), `decision bead holds option ${o.id}`);
        check(decisionBead.description.includes(RECOMMENDATION), 'decision bead holds the recommendation');
        check((decisionBead.dependencies || []).some((d) => d.depends_on_id === x && d.type === 'discovered-from'),
            `decision bead linked to the work bead: ${JSON.stringify(decisionBead.dependencies)}`);
        const work = scenario.finalBeadsById.get(x);
        assert.notEqual(work.status, 'closed', 'the work bead stays open');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');

        // (4) X's notes gain the full request (appended).
        check(typeof work.notes === 'string' && work.notes.includes(QUESTION), `work bead notes carry the question: ${work.notes}`);
        for (const o of OPTIONS) check(work.notes.includes(o.text), `work bead notes carry option ${o.id}`);
        check(work.notes.includes(`bd human respond ${rec.decisionBeadId}`), 'the note says how to answer');

        // (5) The set-aside report lists X with kind needs-decision and the
        // untruncated question: published with the decisions state when the
        // run pauses awaiting the decision (here stopped at that point).
        check(seen.stopped, 'the run paused awaiting the decision once only it (and its dependent) remained');
        check(scenario.error && scenario.error.name === 'CancelledError', `stopped at the pause, not stalled: ${scenario.error && scenario.error.name}`);
        const paused = seen.states.find((d) => d.state === 'paused-awaiting-decision');
        check(paused, 'the paused-awaiting-decision state was published');
        const entry = paused.setAside.find((e) => e.id === x);
        assert.equal(entry.kind, 'needs-decision');
        check(entry.reason.includes(QUESTION), `untruncated question in the set-aside entry: ${entry.reason}`);
        assert.equal(entry.decisionBeadId, rec.decisionBeadId);
        assert.equal(paused.setAside.find((e) => e.id === dep).kind, 'dependent');
        assert.equal(paused.pending[0].question, QUESTION, 'the published pending decision carries the whole question');
        check(!scenario.dispatched.some((d) => d.agent === 'doer' && d.prompt.includes(rec.decisionBeadId)), 'the decision bead is never dispatched as work');
    });
});

test('mock sprint: a reviewer NEEDS-DECISION reopens the closed bead, sets it aside and files the decision', async () => {
    resetSyncMemo();
    await withScenarioMarkers('reviewer needs-decision set-aside', async () => {
        let asked = false;
        const seen = { states: [], stopped: false };
        const scenario = await runDevelopLoopScenario('ndec-reviewer', {
            onWorkflow: stopOnDecisionPause(seen),
            members: ['local'],
            taskSpecs: [DECIDE, OTHER].map((title) => ({ title })),
            maxCycles: 2,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                await rc(`bd update ${id(DECIDE)} --set-metadata streak=lane-d --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER)} --set-metadata streak=lane-o --set-metadata streakOrder=1`, td);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                for (const x of ids) await rc(`bd close ${x}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const list = JSON.parse((await rc('bd list --all --json', td)).stdout || '[]');
                const decide = list.find((b) => b.title === DECIDE);
                if (!asked && decide && opts.prompt.includes(decide.id)) {
                    asked = true;
                    return { content: [{ text: JSON.stringify({
                        verdict: 'NEEDS-DECISION', notes: 'Two acceptable designs; an operator must pick.',
                        reopenIds: [], newTasks: [], decision: decisionFor(decide.id),
                    }) }] };
                }
                return approve();
            },
        });
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        check(asked, 'the reviewer saw the bead');
        const rec = decisionRecord(scenario.logs);
        check(rec && rec.beadId === x, 'the decision is recorded for the reviewed bead');
        check(rec.raisedBy.startsWith('reviewer'), `raised by the reviewer: ${rec.raisedBy}`);
        const work = scenario.finalBeadsById.get(x);
        assert.notEqual(work.status, 'closed', 'the bead was reopened');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');
        check(work.notes.includes(QUESTION), 'notes carry the request');
        const decisionBead = scenario.finalBeadsById.get(rec.decisionBeadId);
        check(decisionBead && (decisionBead.labels || []).includes('human'), 'decision bead labelled human');
        const doersOnX = doerDispatches(scenario).filter((d) => assignedIds(d).includes(x));
        assert.equal(doersOnX.length, 1, 'the reopened bead is not re-dispatched while the decision is pending');
        const paused = seen.states.find((d) => d.state === 'paused-awaiting-decision');
        check(paused && paused.setAside.some((e) => e.id === x && e.kind === 'needs-decision'), 'listed as needs-decision');
    });
});

// --- relaunch: reuse an open decision bead (fresh sprintState) ----------------

function relaunchCommand(listOutput, commands) {
    return async (cmd) => {
        commands.push(cmd);
        if (cmd.includes('rmSync')) return '';
        if (cmd.startsWith('node -e')) return '/tmp/staged.txt';
        if (cmd.startsWith('bd list')) {
            if (listOutput instanceof Error) throw listOutput;
            return listOutput;
        }
        if (cmd.startsWith('bd create')) return 'x-new\n';
        return '';
    };
}

const relaunch = (command) => recordPendingDecision({
    sprintState: {}, decision: decisionFor('x-1'), raisedBy: 'doer', cycle: 1, round: 1, command, member: 'm',
    scopeBeads: [{ id: 'x-1', status: 'open', dependencies: [] }],
});

test('unit: relaunch with an open decision bead for the work bead reuses it and files nothing', async () => {
    const commands = [];
    const open = JSON.stringify([
        { id: 'x-10dec', title: 'Decision needed for x-10', status: 'deferred' },
        { id: 'x-old', title: 'Decision needed for x-1', status: 'deferred' },
    ]);
    const rec = await relaunch(relaunchCommand(open, commands));
    assert.equal(rec.decisionBeadId, 'x-old');
    assert.ok(!commands.some((c) => c.startsWith('bd create')), `no bd create: ${commands.join(' | ')}`);
});

test('unit: relaunch with only a closed decision bead files exactly one new bead', async () => {
    const commands = [];
    const closed = JSON.stringify([{ id: 'x-old', title: 'Decision needed for x-1', status: 'closed' }]);
    const rec = await relaunch(relaunchCommand(closed, commands));
    assert.equal(rec.decisionBeadId, 'x-new');
    assert.equal(commands.filter((c) => c.startsWith('bd create')).length, 1);
});

test('unit: a failed decision-bead lookup still files (best-effort)', async () => {
    const commands = [];
    const rec = await relaunch(relaunchCommand(new Error('bd list failed'), commands));
    assert.equal(rec.decisionBeadId, 'x-new');
    assert.equal(commands.filter((c) => c.startsWith('bd create')).length, 1);
});
