import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer, currentServerKbWork } from './helpers/kb-maintainer-fakes.mjs';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';

// An unreachable kb_maintainer (the command could not run on the member) must be
// named as unreachable, not as an "unreadable branch"; a genuinely unreadable
// branch and a wrong branch keep their own messages; ids stay queued in all three.

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const SPRINT = 'feat/kb-sprint';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const REASON = 'verified against the merged code in this round';

function gitSyncWith(command) {
    return createGitSync({
        brackets: createSyncBrackets(), command, log: () => {}, branch: SPRINT, baseBranch: 'main', args: {},
        sprintId: 'sprint-unreachable', ensureVcsAuthFresh: async () => {},
        syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    });
}

describe('gitSync.checkedOutBranch tells a failed command from an empty answer', () => {
    test('a failed command is unreachable with its error and host', async () => {
        const gs = gitSyncWith(async () => ({ ok: false, output: '', error: 'ssh: connect to host h1 port 22: timed out', host: 'h1' }));
        const r = await gs.checkedOutBranch('maint');
        assert.equal(r.branch, null);
        assert.equal(r.unreachable, true);
        assert.match(r.error, /timed out/);
        assert.equal(r.host, 'h1');
        assert.equal(r.sprintBranch, SPRINT);
    });
    test('a thrown command is unreachable too', async () => {
        const gs = gitSyncWith(async () => { throw new Error('member offline'); });
        const r = await gs.checkedOutBranch('maint');
        assert.deepEqual([r.branch, r.unreachable, r.error], [null, true, 'member offline']);
    });
    test('a command that ran with empty output is not unreachable', async () => {
        const gs = gitSyncWith(async () => ({ ok: true, output: '\n', error: null }));
        const r = await gs.checkedOutBranch('maint');
        assert.equal(r.branch, null);
        assert.equal(r.unreachable, false);
        assert.ok(r.error);
    });
    test('a branch answer is returned as before', async () => {
        const gs = gitSyncWith(async () => ({ ok: true, output: 'feat/x\n', error: null }));
        const r = await gs.checkedOutBranch('maint');
        assert.deepEqual([r.branch, r.unreachable, r.sprintBranch], ['feat/x', false, SPRINT]);
    });
});

function makeClient(answer) {
    const logs = [];
    const tools = [];
    const pulls = [];
    const row = { id: 'kb-w', type: 'knowledge', confidence: 'CONFIRMED', title: 't', summary: 's', source_files: ['a.js'] };
    const branchWithdrawals = Object.assign(async () => [row], { read: async () => ({ ok: true, rows: [row] }) });
    const client = currentServerKbWork(createKbWorkClient, {
        memberCall: async (member, tool, args) => {
            if (tool === 'kb_query') return { l1_results: [{ id: 'e1' }] };
            tools.push(tool);
            if (tool === 'kb_promote') return { id: args.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' };
            return {};
        },
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => { pulls.push('pull'); },
        gPush: async () => { pulls.push('push'); },
        bibleBase: async () => BASE,
        branchWithdrawals,
        checkedOutBranch: async () => (typeof answer === 'function' ? answer() : answer),
        log: (m) => logs.push(m),
    });
    return { client, logs, tools, pulls };
}

async function confirmE1(client, setOnSprint) {
    setOnSprint(true);
    await client.promotionCandidates('reviewer-1');
    await client.apply('reviewer', 'reviewer-1', { kb_promotions: [{ id: 'e1', reason: REASON }] });
    setOnSprint(false);
}

function scenario(answerOffSprint) {
    let onSprint = false;
    const h = makeClient(() => (onSprint ? { branch: SPRINT, sprintBranch: SPRINT } : answerOffSprint));
    return { ...h, setOnSprint: (v) => { onSprint = v; } };
}

describe('KB bible-commit guard and PR-body section: unreachable vs unreadable vs wrong branch', () => {
    test('unreachable maintainer: WARN names member, host and error, never "unreadable branch"; the id stays queued', async () => {
        const { client, logs, tools, setOnSprint } = scenario({ branch: null, sprintBranch: SPRINT, unreachable: true, error: 'connection reset', host: 'h1.example' });
        await confirmE1(client, setOnSprint);
        const before = tools.length;
        const out = await client.commitRound('review C1');
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.deepEqual(client.pendingConfirmations(), ['e1']);
        assert.ok(!tools.slice(before).includes('kb_bible_commit'));
        const warn = logs.filter((l) => l.includes("maintainer 'maint'") && l.includes('could not be reached'));
        assert.equal(warn.length, 1, logs.join('\n'));
        assert.ok(warn[0].includes('h1.example') && warn[0].includes('connection reset'), warn[0]);
        assert.match(warn[0], /1 confirmation\(s\) stay queued/);
        assert.ok(!logs.some((l) => /unreadable branch/.test(l)), logs.join('\n'));
    });

    test('unreachable maintainer: the PR-body section reports ok:false naming the cause, not an unreadable branch', async () => {
        const { client, logs } = makeClient({ branch: null, sprintBranch: SPRINT, unreachable: true, error: 'connection reset', host: 'h1.example' });
        const report = await client.kbChangesOnMerge();
        assert.equal(report.unreadable.length, 1);
        assert.equal(report.unreadable[0].member, 'maint');
        assert.ok(report.unreadable[0].error.includes('maint') && report.unreadable[0].error.includes('h1.example') && report.unreadable[0].error.includes('connection reset'), report.unreadable[0].error);
        assert.doesNotMatch(report.unreadable[0].error, /unreadable branch/);
        assert.ok(!logs.some((l) => /unreadable branch/.test(l)), logs.join('\n'));
    });

    test('a thrown checkedOutBranch is treated as unreachable in both sites', async () => {
        const { client, logs } = makeClient(() => { throw new Error('member offline'); });
        const report = await client.kbChangesOnMerge();
        assert.match(report.unreadable[0].error, /could not be reached \(member offline\)/);
        assert.ok(!logs.some((l) => /unreadable branch/.test(l)));
    });

    test('genuinely unreadable branch (command ran, no branch): keeps the unreadable-branch message; id stays queued', async () => {
        const { client, logs, setOnSprint } = scenario({ branch: null, sprintBranch: SPRINT, unreachable: false, error: 'the command ran but its output names no branch' });
        await confirmE1(client, setOnSprint);
        const out = await client.commitRound('review C1');
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.deepEqual(client.pendingConfirmations(), ['e1']);
        assert.ok(logs.some((l) => /has an unreadable branch .* checked out, not the sprint branch/.test(l) && !/could not be reached/.test(l)), logs.join('\n'));
        const { client: c2 } = makeClient({ branch: null, sprintBranch: SPRINT, unreachable: false });
        const report = await c2.kbChangesOnMerge();
        assert.match(report.unreadable[0].error, /an unreadable branch is checked out/);
    });

    test('wrong branch: the existing message is unchanged', async () => {
        const { client, logs, setOnSprint } = scenario({ branch: 'other', sprintBranch: SPRINT, unreachable: false });
        await confirmE1(client, setOnSprint);
        await client.commitRound('review C1');
        assert.ok(logs.some((l) => /WARN: maintainer 'maint' .* has 'other' checked out, not the sprint branch 'feat\/kb-sprint' .* 1 confirmation\(s\) stay queued for the next round/.test(l)), logs.join('\n'));
        assert.deepEqual(client.pendingConfirmations(), ['e1']);
    });
});
