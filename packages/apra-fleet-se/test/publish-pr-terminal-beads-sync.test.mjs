import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runPublishPrPhase, BEADS_SYNC_FAILED_REASON } from '../fleet-sprint/phases/publish-pr.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// Publish PR sprint-terminal beads check (phases/publish-pr.mjs
// checkTerminalBeadsSync).
//
// At the terminal the phase asks DoltSync.flush() (injected here as
// flushBeadsSync) whether any D-push this run degraded is still pending. If so
// it retries the beads push ONCE per pending member through
// gitSync.syncBeadsAfter, asks again, and reports anything still pending as a
// typed beads-sync failure -- in the phase result (runner.js folds it into the
// run record) and in the PR body -- without changing the verdict or stopping
// the PR. With nothing pending it makes no extra push.
//
// Hermetic: a fake GitHub behind vcs_credential_exec, stub gitSync. ASCII only.
// =============================================================================

function fakeGitHub() {
    const staged = createStagedFileRecorder();
    const state = { pr: null, calls: [] };
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' } });
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '', folder: TEST_MEMBER_FOLDER }) }] };
        if (name === 'send_files') return staged.record(toolArgs);
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') {
            const method = /^curl -sS -X (\w+)/.exec(toolArgs.command)[1];
            state.calls.push(method);
            if (method === 'POST') {
                const p = staged.json(toolArgs.command);
                state.pr = { number: 7, title: p.title, body: p.body };
                return respond(201, { number: 7, html_url: 'https://github.com/acme/widgets/pull/7' });
            }
            if (method === 'GET') return respond(200, []);
            throw new Error(`unexpected method ${method}`);
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
    : { ok: true, output: '', error: null });

const RACE_RECORD = { member: 'dev-1', operation: 'push', kind: 'diverged', errorKind: 'remote-race', detail: 'kept losing the race', pendingRetry: true };

/**
 * A stand-in for the module-level degraded-sync list: `pending` is what
 * flush() reports; `retryLands` decides whether the terminal retry clears it.
 */
function stubBeadsSync({ pending, retryLands }) {
    let records = pending.map((r) => ({ ...r }));
    const retries = [];
    const gitSync = {
        pushGitAfter: async () => {},
        syncBeadsAfter: async (member, opts) => {
            retries.push({ member, opts });
            if (retryLands) records = records.filter((r) => r.member !== member);
            return { ok: retryLands, degraded: !retryLands };
        },
    };
    const flushBeadsSync = () => ({ published: records.length === 0, degradations: records.map((r) => ({ ...r })) });
    return { gitSync, flushBeadsSync, retries };
}

async function publish({ verdict = 'PASS', beads }) {
    const gh = fakeGitHub();
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: remoteCommand,
        args: { callTool: gh.callTool, run_id: 'run-1' },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-1' },
        targetIssues: [],
        backlogMember: 'backlog',
        finalCycleLabel: '1',
        gitSync: beads.gitSync,
        getMemberForRole: () => 'dev-1',
        finalVerdictResult: { verdict, notes: 'ok' },
        flushBeadsSync: beads.flushBeadsSync,
    });
    return { result, logs, gh };
}

const EXPECTED_DETAIL = "- Beads sync failed: changes from member 'dev-1' (remote-race) did not reach the shared beads remote (reason: beads-sync-failed); the changes are safe in each member's local clone and were not published to the shared beads remote.";

describe('Publish PR terminal beads check', () => {
    test('a push still failing after the one terminal retry is reported in the result and the PR body, naming the member', async () => {
        const beads = stubBeadsSync({ pending: [RACE_RECORD], retryLands: false });
        const { result, logs, gh } = await publish({ beads });
        assert.equal(beads.retries.length, 1, 'the terminal retry ran exactly once');
        assert.deepEqual(beads.retries[0], { member: 'dev-1', opts: { pushBeads: true } });
        assert.equal(result.pushed, true, 'the PR path still ran');
        assert.deepEqual(result.beadsSyncFailure, {
            reason: BEADS_SYNC_FAILED_REASON,
            message: "Beads sync failed: changes from member 'dev-1' (remote-race) did not reach the shared beads remote",
            members: [{ member: 'dev-1', kind: 'remote-race', detail: 'kept losing the race' }],
        });
        assert.equal(BEADS_SYNC_FAILED_REASON, 'beads-sync-failed');
        assert.ok(gh.pr, 'the PR was still published');
        assert.ok(gh.pr.body.split('\n').includes(EXPECTED_DETAIL), `PR body lacks the generic beads-sync line:\n${gh.pr.body}`);
        assert.equal(gh.pr.title, 'fleet-sprint [PASS]: feat/x', 'the verdict is unchanged');
        assert.ok(logs.some((l) => l.startsWith('[Beads Sync FAILED]') && l.includes("member 'dev-1'")), logs.join('\n'));
    });

    test('a push that fails first and lands on the terminal retry records no failure', async () => {
        const beads = stubBeadsSync({ pending: [RACE_RECORD], retryLands: true });
        const { result, gh } = await publish({ beads });
        assert.equal(beads.retries.length, 1, 'the terminal retry ran exactly once');
        assert.equal(result.beadsSyncFailure, undefined);
        assert.deepEqual(result, { pushed: true });
        assert.ok(!gh.pr.body.includes('Beads sync failed'), gh.pr.body);
    });

    test('with no pending degradation no extra beads push is made', async () => {
        const beads = stubBeadsSync({ pending: [], retryLands: true });
        const { result } = await publish({ beads });
        assert.deepEqual(beads.retries, [], 'no terminal retry without a pending degradation');
        assert.deepEqual(result, { pushed: true });
    });

    test('a failed branch push still reports the pending beads failure (no PR to carry it)', async () => {
        const beads = stubBeadsSync({ pending: [RACE_RECORD], retryLands: false });
        beads.gitSync.pushGitAfter = async () => { throw new Error('remote unreachable'); };
        const { result } = await publish({ beads });
        assert.equal(result.pushed, false);
        assert.equal(beads.retries.length, 1);
        assert.equal(result.beadsSyncFailure.reason, 'beads-sync-failed');
    });
});
