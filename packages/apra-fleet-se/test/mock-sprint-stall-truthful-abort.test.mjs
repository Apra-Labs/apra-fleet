import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
// Namespace import on purpose: on a tree without the truthful-stall change
// the cases must fail on their assertions, not on a missing export at link time.
import * as setAside from '../fleet-sprint/set-aside.mjs';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// A stall abort is truthful about the work: with an at-goal bead deferred, a
// bead reopened by a reviewer and then closed again, and a last reviewer
// verdict of CHANGES_NEEDED, neither the StalledSprintError nor the
// [ABORTED] PR body may say the stall is "not in the work itself"; both name
// the deferred bead, the reopened-then-closed bead and the last verdict with
// its notes, and the PR body lists the beads closed this run. A stall with
// truly nothing open, deferred or reopened at goal and a non-CHANGES_NEEDED
// last verdict keeps the closing-out wording.
//
// The stall is driven by a real mock sprint (runner.js, real bd); the
// [ABORTED] PR is then raised by finalizeAbort with the sprint's own error,
// against a GitHub provider faked at the REST level (real builders, real
// staged request bodies).
//
// ASCII only.
// =============================================================================

const NOT_IN_WORK = 'not in the work itself';
const stallSettlementSummary = setAside.stallSettlementSummary || (() => ({ closingOut: true, suffix: '' }));
const REVIEW_NOTES = 'Defect reproduced: the widget cache returns a stale row after an update. Steps: update, then read.';

/** A fake GitHub holding no PR yet; records the created PR's body. */
function fakeGitHub() {
    const staged = createStagedFileRecorder();
    const state = { pr: null };
    const respond = (status, body) => ({
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${body === undefined ? '' : JSON.stringify(body)}\n${status}`, stderr: '' },
    });
    const exec = (cmd) => {
        const method = /^curl(?:\.exe)? -sS -X (\w+)/.exec(cmd)[1];
        const quoted = /'(https:\/\/[^']+)'\s*$/.exec(cmd);
        const url = quoted ? quoted[1] : cmd.trim().split(/\s+/).pop();
        if (method === 'POST' && /\/pulls$/.test(url)) {
            state.pr = { title: staged.json(cmd).title, body: staged.json(cmd).body };
            return respond(201, { number: 5, html_url: 'https://github.com/acme/widgets/pull/5' });
        }
        throw new Error(`fake github: unexpected ${method} ${url}`);
    };
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '', folder: TEST_MEMBER_FOLDER }) }] };
        if (name === 'send_files') return staged.record(toolArgs);
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'vcs_credential_exec') return exec(toolArgs.command);
        throw new Error(`unexpected tool ${name}`);
    };
    state.command = async (cmd, opts = {}) => {
        const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
        if (/^git rev-list --count\b/.test(cmd)) return out('3');
        if (/^git push\b/.test(cmd)) return out('To mock-remote');
        if (/^git remote get-url origin\b/.test(cmd)) return out('https://github.com/acme/widgets.git');
        return out('');
    };
    return state;
}

async function abortPrBody(error) {
    const gh = fakeGitHub();
    const logs = [];
    const result = await finalizeAbort({
        error, branch: 'feat/x', baseBranch: 'main', member: 'abort-pub', command: gh.command,
        log: (m) => logs.push(m), callTool: gh.callTool, runId: 'run-stall',
    });
    assert.equal(result.reason, 'aborted-pr-created', `${JSON.stringify(result)}\n${logs.join('\n')}`);
    return gh.pr.body;
}

/** The text of one `### <heading>` section of a PR body ('' when absent). */
function section(body, heading) {
    const start = body.indexOf(`### ${heading}\n\n`);
    if (start < 0) return '';
    const from = start + heading.length + 6;
    const next = body.indexOf('\n### ', from);
    return body.slice(from, next < 0 ? body.length : next);
}

test('stall with a deferred at-goal bead, a reopened-then-closed bead and a last CHANGES_NEEDED: the error and the ABORTED PR are truthful', async () => {
    await withScenarioMarkers('stalltruth (truthful stall abort)', async () => {
        let reopenedOnce = false;
        let followUps = 0;
        const run = await runDevelopLoopScenario('stalltruth', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Reopened once' }, { title: 'Task: Deferred by the planner' }],
            maxCycles: 8,
            beforeSprint: async ({ tempDir, tasks }) => {
                const deferred = tasks.find((t) => t.title === 'Task: Deferred by the planner');
                await runCmd(`bd update ${deferred.id} --status=deferred`, tempDir);
            },
            // Review: the first time the bead is seen closed it is reopened
            // over a reproduced defect; after the doer closes it again every
            // review still asks for changes, filing only below-goal follow-up
            // work -- nothing at goal is open, yet the work is not settled.
            reviewerHandler: async ({ tempDir, epicBead }) => {
                const closed = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --status=closed --json`, tempDir)).stdout || '[]');
                const target = closed.find((b) => b.title === 'Task: Reopened once');
                if (target && !reopenedOnce) {
                    reopenedOnce = true;
                    return { content: [{ text: JSON.stringify({ verdict: 'CHANGES_NEEDED', notes: REVIEW_NOTES, reopenIds: [target.id], newTasks: [] }) }] };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: REVIEW_NOTES,
                            reopenIds: [],
                            newTasks: [{ title: `Follow-up polish ${++followUps}`, description: 'Below-goal polish noticed during review.', priority: 'P3' }],
                        }),
                    }],
                };
            },
        });
        const err = run.error;
        assert.ok(err instanceof StalledSprintError, `expected a stall abort, got ${err ? `${err.constructor.name}: ${err.message}` : 'no error'}`);
        const reopenedId = run.tasks.find((t) => t.title === 'Task: Reopened once').id;
        const deferredId = run.tasks.find((t) => t.title === 'Task: Deferred by the planner').id;

        // Case 1: the error is truthful.
        assert.ok(!err.message.includes(NOT_IN_WORK), `the error must not claim the stall is not in the work: ${err.message}`);
        assert.ok(err.message.includes(deferredId), `the error names the deferred at-goal bead: ${err.message}`);
        assert.ok(err.message.includes(reopenedId), `the error names the reopened-then-closed bead: ${err.message}`);
        assert.ok(err.message.includes('CHANGES_NEEDED') && err.message.includes('Defect reproduced'), `the error carries the last verdict and its notes: ${err.message}`);
        assert.deepEqual(err.details.deferredAtGoal, [deferredId]);
        assert.deepEqual(err.details.reopenedThenClosed, [reopenedId]);
        assert.equal(err.details.lastReview.verdict, 'CHANGES_NEEDED');
        assert.equal(err.details.lastReview.notes, REVIEW_NOTES);

        // Case 1 + 2: the ABORTED PR body is truthful and lists the work.
        const body = await abortPrBody(err);
        assert.ok(!body.includes(NOT_IN_WORK), 'the ABORTED PR body must not claim the stall is not in the work');
        const stillOpen = section(body, 'Still open or deferred at goal');
        assert.ok(stillOpen.includes(`${deferredId}: deferred`), `deferred bead named:\n${stillOpen}`);
        assert.ok(stillOpen.includes(`${reopenedId}: closed again after a reviewer reopened it`), `reopened-then-closed bead named:\n${stillOpen}`);
        const lastReview = section(body, 'Last reviewer verdict');
        assert.ok(lastReview.includes('**CHANGES_NEEDED**') && lastReview.includes(REVIEW_NOTES), `last verdict and notes:\n${lastReview}`);
        const closedWork = section(body, 'Work closed this run');
        assert.ok(closedWork.includes(`- ${reopenedId}: Task: Reopened once`), `closed work listed with its title:\n${closedWork}`);
        assert.ok(body.indexOf('### Work closed this run') < body.indexOf('### Abort details'), 'the work sections come before the abort details');
    });
});

test('a stall with nothing open, deferred or reopened at goal and an APPROVED last review keeps the closing-out wording', () => {
    const quiet = stallSettlementSummary({ openAtGoalIds: [], goalMax: 2, deferredAtGoalIds: [], reopenedThenClosedIds: [], lastReview: { verdict: 'APPROVED', notes: 'ok', site: 'Re-Review', cycle: 3 } });
    assert.equal(quiet.closingOut, true);
    assert.ok(quiet.suffix.includes(NOT_IN_WORK), quiet.suffix);
    const none = stallSettlementSummary({ openAtGoalIds: [], goalMax: 2 });
    assert.equal(none.closingOut, true, 'no review at all and nothing at goal: closing out');
    for (const [what, extra] of [
        ['deferred', { deferredAtGoalIds: ['x-1'] }],
        ['reopened then closed', { reopenedThenClosedIds: ['x-2'] }],
        ['last CHANGES_NEEDED', { lastReview: { verdict: 'CHANGES_NEEDED', notes: 'n' } }],
    ]) {
        const r = stallSettlementSummary({ openAtGoalIds: [], goalMax: 2, ...extra });
        assert.equal(r.closingOut, false, what);
        assert.ok(!r.suffix.includes(NOT_IN_WORK), `${what}: ${r.suffix}`);
    }
});
