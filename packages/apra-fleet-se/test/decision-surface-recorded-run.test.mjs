import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';
import { PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';
import { decisionsExtension, renderDecisionsBannerHtml } from '../fleet-sprint/viewer-extensions.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';

// =============================================================================
// The incident shape, end to end: a sprint with several beads where one doer
// reports NEEDS-DECISION with three options. The needs-decision bead is set
// aside (dispatched once) while the others complete; the operator is told by
// message and email exactly once; GET /api/sprints/:id and the sprint page show
// the decision in full; with nothing else ready the sprint pauses
// (paused-awaiting-decision, never StalledSprintError) and resumes, without a
// relaunch, on an answer from the dashboard route, or on `bd human respond`
// followed by an operator Resume.
// Notification failures (no channel, send error, thrown, timeout) are loud and
// visible but change nothing about the run.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const QUESTION = 'The sign-out end-to-end test cannot pass locally: the local API emulator rejects ' +
    'version 2.0 payload cookies that carry attributes and answers the logout call with a 500, ' +
    'while the deployed gateway accepts them. The acceptance criteria require that test to pass ' +
    'locally, so either the emulator changes, it is patched, or the criterion is narrowed to the ' +
    'deployed sandbox only. Which should the next dispatch do? <b>choose</b>';
const OPTIONS = [
    { id: 'a', text: 'Upgrade the local emulator to the next major version, which accepts cookie attributes (touches the lockfile).' },
    { id: 'b', text: 'Patch the installed emulator with a postinstall patch file that strips the attribute check.' },
    { id: 'c', text: 'Run the sign-out test only against the deployed sandbox and mark it skipped locally.' },
];
const RECOMMENDATION = 'a, because it removes the mismatch instead of hiding it.';

const DECIDE = 'Task: decide the cookie handling';
const OTHER_A = 'Task: unrelated work A';
const OTHER_B = 'Task: unrelated work B';

let priorPoll;
before(() => {
    priorPoll = process.env.APRA_FLEET_DECISION_POLL_MS;
    process.env.APRA_FLEET_DECISION_POLL_MS = '1500';
});
after(() => {
    if (priorPoll === undefined) delete process.env.APRA_FLEET_DECISION_POLL_MS;
    else process.env.APRA_FLEET_DECISION_POLL_MS = priorPoll;
});

const resetSyncMemo = () => { invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); };
const assignedIds = (opts) => {
    const m = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approve = async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] });

const OK = { content: [{ text: JSON.stringify({ ok: true }) }] };
const ERROR_JSON = { content: [{ text: JSON.stringify({ error: 'member not connected or no MCP session' }) }] };

/** A callTool whose send_message / send_email behaviour is switchable per channel. */
function fakeCallTool(modes, calls) {
    return (executeCommand) => {
        const base = defaultMockCallTool({ executeCommand });
        return async (name, args) => {
            if (name !== 'send_message' && name !== 'send_email') return base(name, args);
            const channel = name === 'send_message' ? 'message' : 'email';
            calls[channel].push(args);
            const mode = modes[channel];
            if (mode === 'ok') return OK;
            if (mode === 'error') return ERROR_JSON;
            if (mode === 'throw') throw new Error(`${channel} transport exploded`);
            return new Promise(() => {}); // 'hang'
        };
    };
}

async function incident(tag, { notify, modes = { message: 'ok', email: 'ok' }, answerVia, answer }) {
    const calls = { message: [], email: [] };
    const seen = {
        decideDispatches: 0, atPause: null, api: null, bannerHtml: null, pageHtml: null,
        resumed: 0, notesAtRedispatch: null, answerError: null, pauses: [], ANSWER: answer,
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-decision-surface-'));
    let viewer = null;
    try {
        const scenario = await runDevelopLoopScenario(tag, {
            members: ['local'],
            taskSpecs: [DECIDE, OTHER_A, OTHER_B].map((title) => ({ title })),
            maxCycles: 2,
            decisionNotify: notify,
            callToolFactory: fakeCallTool(modes, calls),
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                await rc(`bd update ${id(DECIDE)} --set-metadata streak=lane-d --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER_A)} --set-metadata streak=lane-a --set-metadata streakOrder=1`, td);
                await rc(`bd update ${id(OTHER_B)} --set-metadata streak=lane-b --set-metadata streakOrder=1`, td);
            },
            onWorkflow: async (workflow, ctx) => {
                viewer = createDashboardViewer(workflow, {
                    port: 0, runId: tag, name: tag, dashboardExtensions: [decisionsExtension],
                    debouncedStatePath: path.join(tmp, 'running.json'), debounceMs: 200, stateSnapshotDir: path.join(tmp, 'snaps'),
                });
                if (!viewer.listening) await new Promise((r, j) => { viewer.once('listening', r); viewer.once('error', j); });
                const port = viewer.address().port;
                const ledger = createLedger({ filePath: path.join(tmp, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
                await ledger.start();
                const history = createHistory({ filePath: path.join(tmp, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
                await history.start();
                await ledger.claim('s1', { members: ['local'], issueRoots: ['R'], childPid: 42 });
                const controller = createSprintController({
                    ledger, history,
                    spawner: createSpawner({ basePort: 9100, isPortAvailable: async () => true, dataDir: tmp, fs: { mkdirSync() {}, openSync() { return 1; }, closeSync() {} }, spawn: () => ({ pid: 1, on() {}, unref() {} }) }),
                    listMembers: () => ({}), getBacklog: () => ({}),
                    resolvePort: (pid) => (pid === 42 ? port : undefined),
                });
                workflow.on('resumed', () => { seen.resumed += 1; });
                workflow.on('pause:requested', (e) => {
                    seen.pauses.push(e);
                    if (e.source !== 'needs_decision' || seen.pauses.length > 1) return;
                    (async () => {
                        seen.api = await controller.getSprint('s1');
                        seen.bannerHtml = renderDecisionsBannerHtml({ state: seen.api.decisionState, pending: seen.api.pendingDecisions });
                        seen.pageHtml = await new Promise((resolve, reject) => {
                            http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
                                const chunks = [];
                                res.on('data', (c) => chunks.push(c));
                                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                            }).on('error', reject);
                        });
                        const list = JSON.parse((await ctx.runCmd('bd list --all --json', ctx.tempDir)).stdout || '[]');
                        seen.atPause = {
                            decideDispatches: seen.decideDispatches,
                            othersClosed: [OTHER_A, OTHER_B].every((t) => (list.find((b) => b.title === t) || {}).status === 'closed'),
                        };
                        const d = seen.api.pendingDecisions[0];
                        if (answerVia === 'route') {
                            await controller.answerDecision('s1', d.decisionId, { answer: seen.ANSWER });
                        } else {
                            await ctx.runCmd(`bd human respond ${d.decisionBeadId} -r "${seen.ANSWER}"`, ctx.tempDir);
                            // Answered outside the run: nothing polls the
                            // members while it is parked, so the operator
                            // resumes it (the dashboard Resume button).
                            await workflow.requestResume('operator Resume after bd human respond');
                        }
                    })().catch((err) => { seen.answerError = err; });
                });
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const decide = list.find((b) => b.title === DECIDE);
                if (decide && ids.includes(decide.id)) {
                    seen.decideDispatches += 1;
                    const shown = JSON.parse((await rc(`bd show ${decide.id} --json`, td)).stdout || '[]');
                    const notes = (Array.isArray(shown) ? shown[0] : shown).notes || '';
                    if (!notes.includes('OPERATOR DECISION')) {
                        return { content: [{ text: JSON.stringify({
                            status: 'NEEDS-DECISION', closedIds: [], notes: 'An operator must choose.',
                            decision: { beadId: decide.id, question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION },
                        }) }] };
                    }
                    seen.notesAtRedispatch = notes;
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        return { scenario, seen, calls };
    } finally {
        if (viewer) await new Promise((resolve) => viewer.close(resolve));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

const sequence = (scenario) => scenario.dispatched
    .filter((d) => d.agent === 'doer')
    .map((d) => assignedIds(d).map((id) => (scenario.tasks.find((t) => t.id === id) || {}).title).join('+'));

function assertSurfaced({ scenario, seen }, { answer }) {
    const x = scenario.tasks.find((t) => t.title === DECIDE).id;
    check(!seen.answerError, `surface/answer step failed: ${seen.answerError && seen.answerError.stack}`);
    // 1: dispatched once, the others complete.
    assert.equal(seen.atPause.decideDispatches, 1, 'the needs-decision bead was dispatched once before the pause');
    assert.equal(seen.atPause.othersClosed, true, 'the other beads completed while it was set aside');
    // 5: paused, not stalled.
    check(!scenario.error || scenario.error.code !== 'SPRINT_STALLED', `never stalled: ${scenario.error && scenario.error.message}`);
    assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
    assert.equal(seen.api.decisionState, PAUSED_AWAITING_DECISION);
    assert.equal(seen.api.runState, PAUSED_AWAITING_DECISION);
    // 2: API and dashboard show the decision in full.
    const d = seen.api.pendingDecisions[0];
    assert.equal(seen.api.pendingDecisions.length, 1);
    assert.equal(d.beadId, x);
    assert.equal(d.question, QUESTION);
    assert.deepEqual(d.options, OPTIONS);
    assert.equal(d.recommendation, RECOMMENDATION);
    check(seen.pageHtml.includes('renderDecisionsBannerHtml'), 'the sprint page carries the banner renderer');
    check(seen.bannerHtml.includes('&lt;b&gt;choose&lt;/b&gt;') && !seen.bannerHtml.includes('<b>choose</b>'), 'question HTML is escaped');
    for (const o of OPTIONS) check(seen.bannerHtml.includes(`data-decision-option="${o.id}"`), `option ${o.id} shown`);
    // 6: resumed without relaunch; re-dispatched once with the answer in its notes.
    check(seen.resumed >= 1, 'resumed');
    check(seen.notesAtRedispatch && seen.notesAtRedispatch.includes(answer), `the answer is in the notes at re-dispatch: ${seen.notesAtRedispatch}`);
    assert.equal(scenario.finalBeadsById.get(x).status, 'closed');
    assert.equal(scenario.finalBeadsById.get(d.decisionBeadId).status, 'closed');
    assert.equal(seen.decideDispatches, 2, 'exactly one re-dispatch, after the answer');
}

const NOTIFY = {
    message_member: 'orchestrator-1',
    email: { provider: 'sendgrid', from: 'sprint@example.com', to: 'ops@example.com' },
    dashboard_url: 'http://127.0.0.1:8787/sprints/s1/live',
};
const bodiesFull = (text) => text.includes(QUESTION) && OPTIONS.every((o) => text.includes(`(${o.id}) ${o.text}`)) && text.includes(RECOMMENDATION);

let baseline = null;

test('recorded run: both channels succeed -- each called once with the full body; the dashboard answer resumes the run', { timeout: 300_000 }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision surface: success + dashboard answer', async () => {
        const ANSWER = 'a: keep the attributes and upgrade the emulator';
        const run = await incident('dsurf-route', { notify: NOTIFY, answerVia: 'route', answer: ANSWER });
        assertSurfaced(run, { answer: ANSWER });
        assert.equal(run.calls.message.length, 1, 'message attempted exactly once');
        assert.equal(run.calls.email.length, 1, 'email attempted exactly once');
        check(bodiesFull(run.calls.message[0].content) && bodiesFull(run.calls.email[0].body), 'full question, options and recommendation in both bodies');
        check(run.calls.message[0].content.includes('bd human respond'), 'says how to answer');
        const n = run.seen.api.pendingDecisions[0].notification;
        assert.equal(n.message.status, 'sent');
        assert.equal(n.email.status, 'sent');
        check(!run.scenario.logs.some((l) => l.includes('NOTIFICATION FAILED')), 'no failure logged');
        baseline = sequence(run.scenario);
    });
});

test('recorded run: answering with bd human respond resumes the run with the answer in the notes', { timeout: 300_000 }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision surface: success + bd human respond', async () => {
        const ANSWER = 'b: patch the installed emulator';
        const run = await incident('dsurf-respond', { notify: NOTIFY, answerVia: 'respond', answer: ANSWER });
        assertSurfaced(run, { answer: ANSWER });
        assert.equal(run.calls.message.length, 1);
        assert.equal(run.calls.email.length, 1);
    });
});

// No decision_notify at all: the message channel defaults (resolved once at
// launch) to the operator's orchestrating session, and the unconfigured email
// channel is reported ONCE at launch -- recorded failed per decision without a
// repeated loud line.
test('recorded run: no decision_notify -> message to the default orchestrator session, email reported once at launch', { timeout: 300_000 }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision surface: no channel configured', async () => {
        const ANSWER = 'c: skip locally';
        const run = await incident('dsurf-nochan', { notify: undefined, modes: { message: 'ok', email: 'ok' }, answerVia: 'route', answer: ANSWER });
        assertSurfaced(run, { answer: ANSWER });
        assert.equal(run.calls.message.length, 1);
        assert.equal(run.calls.message[0].member_id, 'orchestrator');
        assert.equal(run.calls.email.length, 0);
        const n = run.seen.api.pendingDecisions[0].notification;
        assert.equal(n.message.status, 'sent');
        assert.equal(n.email.status, 'failed');
        check(n.email.reason.includes('no channel configured'), n.email.reason);
        assert.deepEqual(run.scenario.logs.filter((l) => l.startsWith('NOTIFICATION FAILED')), []);
        assert.equal(run.scenario.logs.filter((l) => l.startsWith('Decision notification: no email channel configured')).length, 1);
        assert.equal(run.scenario.logs.filter((l) => l.startsWith('Decision notification: no message target')).length, 0);
        check(run.seen.bannerHtml.includes('notification failed'), 'the dashboard shows the email notification failed');
        if (baseline) assert.deepEqual(sequence(run.scenario), baseline, 'identical dispatch order to the success case');
    });
});

const FAILURES = [
    { tag: 'dsurf-errors', name: 'send error and thrown exception', notify: NOTIFY, modes: { message: 'error', email: 'throw' }, reasons: ['member not connected', 'email transport exploded'], attempted: [1, 1] },
    { tag: 'dsurf-timeout', name: 'timeout', notify: { ...NOTIFY, timeout_s: 1 }, modes: { message: 'hang', email: 'hang' }, reasons: ['timed out', 'timed out'], attempted: [1, 1] },
];
for (const f of FAILURES) {
    test(`recorded run: notification failure "${f.name}" is loud and visible but changes nothing about the run`, { timeout: 300_000 }, async () => {
        resetSyncMemo();
        await withScenarioMarkers(`decision surface: ${f.name}`, async () => {
            const ANSWER = 'c: skip locally';
            const run = await incident(f.tag, { notify: f.notify, modes: f.modes, answerVia: 'route', answer: ANSWER });
            assertSurfaced(run, { answer: ANSWER });
            assert.equal(run.calls.message.length, f.attempted[0]);
            assert.equal(run.calls.email.length, f.attempted[1]);
            const n = run.seen.api.pendingDecisions[0].notification;
            assert.equal(n.message.status, 'failed');
            assert.equal(n.email.status, 'failed');
            check(n.message.reason.includes(f.reasons[0]), n.message.reason);
            check(n.email.reason.includes(f.reasons[1]), n.email.reason);
            const loud = run.scenario.logs.filter((l) => l.startsWith('NOTIFICATION FAILED'));
            assert.equal(loud.length, 2, `one loud line per channel: ${JSON.stringify(loud)}`);
            check(run.seen.bannerHtml.includes('notification failed'), 'the dashboard shows notification failed');
            if (baseline) assert.deepEqual(sequence(run.scenario), baseline, 'identical dispatch order to the success case');
        });
    });
}
