import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';

// =============================================================================
// The review-round bible commit (createKbWorkClient.commitRound), with fakes:
// every promotion the maintainer applied is a confirmation; after a review
// round the engine runs, on the maintainer, G-pull -> kb_bible_commit -> G-push,
// retries a rejected G-push exactly once, and keeps the ids queued (with a
// WARN) when the retry fails too. seal() stops every further commit.
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REPO = 'example.com/org/repo';
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

/**
 * A fake maintainer: records every event in order. `pushFailures` is how many
 * G-pushes fail before one succeeds.
 */
function harness({ pushFailures = 0, committed = true, unpushed = false } = {}) {
    const events = [];
    const logs = [];
    let pushesLeftToFail = pushFailures;
    const memberCall = async (member, tool, args) => {
        events.push({ ev: tool, member: member.name, args });
        if (tool === 'kb_bible_commit') {
            return { content: [{ text: JSON.stringify({ path: '.fleet/kb-canonical.json', merged: args.ids, skipped: [], entry_count: args.ids.length, committed }) }] };
        }
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async (m, opts = {}) => { events.push({ ev: opts.resetToRemoteTip ? 'G-pull(reset)' : 'G-pull', member: m }); },
        gPush: async (m) => {
            events.push({ ev: 'G-push', member: m });
            if (pushesLeftToFail > 0) {
                pushesLeftToFail--;
                throw new Error('! [rejected] (non-fast-forward)');
            }
        },
        abortRebase: async (m) => { events.push({ ev: 'rebase--abort', member: m }); return false; },
        bibleBase: async () => BASE,
        // The publication check after a committed:false: `unpushed` answers it
        // (false: origin holds the bible; true: a local bible commit is not
        // pushed; null: undecidable).
        bibleUnpushed: async (m, file) => {
            events.push({ ev: 'publication-check', member: m, file });
            return unpushed === null ? { unpushed: null, reason: 'git failed in the test' } : { unpushed };
        },
        log: (m) => logs.push(m),
    });
    return { client, events, logs };
}

async function confirm(client, ids) {
    await client.apply('reviewer', 'reviewer-1', { kb_promotions: ids.map((id) => ({ id, reason: REASON })) });
}

const gitAndBible = (events) => events.filter((e) => e.ev !== 'kb_promote').map((e) => e.ev);

describe('commitRound: the review-round bible commit on the kb_maintainer', () => {
    test('call order is G-pull, then kb_bible_commit, then G-push -- with the round ids and the base', async () => {
        const { client, events } = harness();
        await confirm(client, ['e1', 'e2']);

        const out = await client.commitRound('review C1');

        // The promotions' own batch G-pull comes first; the bible commit is the
        // three events after the last kb_promote.
        const afterPromotes = events.slice(events.map((e) => e.ev).lastIndexOf('kb_promote') + 1);
        assert.deepEqual(afterPromotes.map((e) => e.ev), ['G-pull', 'kb_bible_commit', 'G-push']);
        const call = afterPromotes[1];
        assert.equal(call.member, 'maint', 'kb_bible_commit runs in the maintainer session');
        assert.deepEqual(call.args, { ids: ['e1', 'e2'], baseBranch: 'main', baseCommit: BASE.baseCommit });
        assert.deepEqual(out, { committed: 2, pending: 0 });
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('a round with no confirmations makes no kb_bible_commit call and touches no git', async () => {
        const { client, events } = harness();
        // A capture-only round: no promotion, so no confirmation.
        await client.apply('reviewer', 'reviewer-1', { kb_captures: [] });

        const out = await client.commitRound();

        assert.deepEqual(events, []);
        assert.deepEqual(out, { committed: 0, pending: 0 });
    });

    test('a rejected G-push is retried exactly once: rebase --abort, G-pull onto the remote tip, kb_bible_commit with the same ids, G-push', async () => {
        const { client, events, logs } = harness({ pushFailures: 1 });
        await confirm(client, ['e1']);
        const before = events.length;

        const out = await client.commitRound();

        assert.deepEqual(events.slice(before).map((e) => e.ev), [
            'G-pull', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)', 'kb_bible_commit', 'G-push',
        ]);
        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.deepEqual(commits.map((c) => c.args.ids), [['e1'], ['e1']], 'the retry re-commits the same ids');
        assert.deepEqual(out, { committed: 1, pending: 0 });
        assert.ok(logs.some((l) => /retrying once/.test(l)));
        assert.ok(!logs.some((l) => /WARN/.test(l)), 'a successful retry is not a warning');
    });

    test('a second push failure keeps the ids queued with a WARN; the next successful round commits them', async () => {
        const { client, events, logs } = harness({ pushFailures: 2 });
        await confirm(client, ['e1', 'e2']);
        const before = events.length;

        const first = await client.commitRound('review C1');

        // Exactly one retry -- never a third push -- then the checkout is put
        // back on the remote tip so the maintainer's next G-pull fast-forwards.
        assert.deepEqual(events.slice(before).map((e) => e.ev), [
            'G-pull', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)',
        ]);
        assert.deepEqual(first, { committed: 0, pending: 2 });
        assert.deepEqual(client.pendingConfirmations(), ['e1', 'e2']);
        assert.ok(logs.some((l) => /^\[kb-work\] WARN: bible commit for .* failed at G-push .* 2 confirmation\(s\) stay queued for the next round$/.test(l)), logs.join('\n'));

        // Next round: a new confirmation joins the queued ones in one commit.
        await confirm(client, ['e3']);
        const mark = events.length;
        const second = await client.commitRound('review C2');

        const next = events.slice(mark).filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(next.length, 1);
        assert.deepEqual(next[0].args.ids, ['e1', 'e2', 'e3'], 'nothing queued is lost');
        assert.deepEqual(second, { committed: 3, pending: 0 });
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('nothing committed (entry set unchanged) means nothing pushed', async () => {
        const { client, events } = harness({ committed: false });
        await confirm(client, ['e1']);
        const before = events.length;

        await client.commitRound();

        assert.deepEqual(gitAndBible(events.slice(before)), ['G-pull', 'kb_bible_commit', 'publication-check']);
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('after seal() (a FAIL verdict or an abort) nothing further is committed and the queue is not flushed', async () => {
        const { client, events } = harness();
        await confirm(client, ['e1']);
        client.seal('final review verdict FAIL');
        const before = events.length;

        const out = await client.commitRound('harvest');

        assert.deepEqual(events.slice(before), [], 'no G-pull, no kb_bible_commit, no G-push');
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.deepEqual(client.pendingConfirmations(), ['e1']);
    });

    test('an unresolvable base keeps the ids queued and makes no kb_bible_commit call', async () => {
        const logs = [];
        const events = [];
        const client = createKbWorkClient({
            memberCall: async (m, tool) => { events.push(tool); return {}; },
            maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
            gPull: async () => {},
            gPush: async () => { events.push('G-push'); },
            bibleBase: async () => null,
            log: (m) => logs.push(m),
        });
        await confirm(client, ['e1']);

        const out = await client.commitRound();

        assert.ok(!events.includes('kb_bible_commit'));
        assert.ok(!events.includes('G-push'));
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.ok(logs.some((l) => /WARN: bible commit .* failed at base resolution/.test(l)));
    });
});

// =============================================================================
// The bible-commit branch guard. The engine side is the REAL createGitSync
// (over the real syncMemberBefore/syncMemberAfter) wired into
// createKbWorkClient the way runner.js wires it, driven by a fake command()
// that records every command and reports the maintainer's checked-out branch.
// When that branch is not the sprint branch, the maintainer gets no commit,
// push or reset --hard, a WARN names it and both branches, and every id stays
// queued.
// =============================================================================

const SPRINT_BRANCH = 'feat/kb-sprint';
const OTHER_BRANCH = 'hotfix/other-work';

function guardHarness({ branchAnswers, pushFailures = 0 }) {
    const commands = [];
    const logs = [];
    const log = (m) => logs.push(m);
    const answers = branchAnswers.slice();
    let pushesLeftToFail = pushFailures;
    const command = async (cmd, opts = {}) => {
        commands.push({ cmd, member: opts.member_name });
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
            const b = answers.length > 1 ? answers.shift() : answers[0];
            return { ok: true, output: `${b}\n`, error: null };
        }
        if (cmd.includes('bd config get sync.remote --json')) {
            return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: '' }), error: null };
        }
        if (/^git push\b/.test(cmd) && pushesLeftToFail > 0) {
            pushesLeftToFail--;
            return { ok: false, output: '', error: 'remote: refused by the test fixture' };
        }
        if (cmd.startsWith('git merge-base HEAD')) return { ok: true, output: 'b'.repeat(40), error: null };
        if (cmd.startsWith('git rev-list --count')) return { ok: true, output: '1', error: null };
        if (cmd.startsWith('git log -m --name-only')) return { ok: true, output: '.fleet/kb-canonical.json\n', error: null };
        return { ok: true, output: '', error: null };
    };
    const gitSync = createGitSync({
        brackets: createSyncBrackets(),
        command, log,
        branch: SPRINT_BRANCH,
        baseBranch: 'main',
        args: {},
        sprintId: 'sprint-kb-branch-guard',
        ensureVcsAuthFresh: async () => {},
        syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    });
    const toolCalls = [];
    const client = createKbWorkClient({
        memberCall: async (member, tool, args) => {
            toolCalls.push(tool);
            if (tool === 'kb_bible_commit') {
                commands.push({ cmd: '(kb_bible_commit: git commit)', member: member.name });
                return { content: [{ text: JSON.stringify({ merged: args.ids, skipped: [], committed: true }) }] };
            }
            return {};
        },
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: (m, options) => gitSync.pullGitBefore(m, options),
        gPush: (m) => gitSync.pushBibleCommit(m),
        abortRebase: (m) => gitSync.abortRebase(m),
        bibleBase: (m) => gitSync.resolveBibleBase(m),
        canResetCheckout: (m, f) => gitSync.canResetBibleCheckout(m, f),
        checkedOutBranch: (m) => gitSync.checkedOutBranch(m),
        log,
    });
    return { client, commands, logs, toolCalls };
}

/**
 * Every branch a git command names: `fetch origin <b>`, `origin/<b>`, `push
 * origin <b>`, `HEAD:<b>`. The one exception is the read-only provenance
 * lookup `git merge-base HEAD origin/<base>`, which names the sprint's base
 * branch by design and moves nothing.
 */
function branchesNamed(cmd) {
    if (cmd.startsWith('git merge-base HEAD origin/')) return [];
    const out = [];
    for (const m of cmd.matchAll(/\b(?:fetch|push)\s+(?:-\S+\s+)*origin\s+([^\s:]+)/g)) out.push(m[1]);
    for (const m of cmd.matchAll(/\borigin\/([^\s.]+(?:\.[^\s.]+)*)/g)) out.push(m[1]);
    for (const m of cmd.matchAll(/HEAD:(?:refs\/heads\/)?(\S+)/g)) out.push(m[1]);
    return out.filter((b) => b !== '--quiet');
}

describe('commitRound: the branch guard on the maintainer checkout', () => {
    test('a maintainer on another branch gets no commit, push or reset; a WARN names it and both branches; every id stays queued', async () => {
        const { client, commands, logs, toolCalls } = guardHarness({ branchAnswers: [OTHER_BRANCH] });
        await confirm(client, ['e1', 'e2']);
        const before = commands.length;

        const out = await client.commitRound('review C1');

        assert.deepEqual(out, { committed: 0, pending: 2 });
        assert.deepEqual(client.pendingConfirmations(), ['e1', 'e2']);
        assert.ok(!toolCalls.includes('kb_bible_commit'), 'no kb_bible_commit call');
        const round = commands.slice(before).map((c) => c.cmd);
        assert.deepEqual(round, ['git rev-parse --abbrev-ref HEAD'], `the guard is the only command of the round: ${JSON.stringify(round)}`);
        for (const { cmd } of commands) {
            assert.ok(!/\bgit (commit|push)\b|reset --hard|kb_bible_commit/.test(cmd), `no commit/push/reset: ${cmd}`);
            for (const b of branchesNamed(cmd)) assert.equal(b, SPRINT_BRANCH, `a git command named another branch: ${cmd}`);
        }
        const warn = logs.filter((l) => l.startsWith('[kb-work] WARN:') && l.includes("maintainer 'maint'"));
        assert.equal(warn.length, 1, logs.join('\n'));
        assert.ok(warn[0].includes(`'${OTHER_BRANCH}'`) && warn[0].includes(`'${SPRINT_BRANCH}'`), warn[0]);
        assert.match(warn[0], /2 confirmation\(s\) stay queued/);
    });

    test('a maintainer that leaves the sprint branch before the retry gets no reset --hard and no second commit', async () => {
        const { client, commands, logs } = guardHarness({ branchAnswers: [SPRINT_BRANCH, OTHER_BRANCH], pushFailures: 1 });
        await confirm(client, ['e1']);

        const out = await client.commitRound('review C1');

        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.ok(logs.some((l) => /retrying once/.test(l)), 'the first push failed and the retry path ran');
        assert.equal(commands.filter((c) => c.cmd === 'git rev-parse --abbrev-ref HEAD').length, 2, 'the branch is re-checked before the retry reset');
        assert.ok(!commands.some((c) => c.cmd.includes('reset --hard')), JSON.stringify(commands.map((c) => c.cmd)));
        assert.equal(commands.filter((c) => c.cmd.startsWith('(kb_bible_commit')).length, 1, 'only the first attempt committed');
        assert.equal(commands.filter((c) => /^git push\b/.test(c.cmd)).length, 1, 'only the first (failed) push');
        for (const { cmd } of commands) {
            for (const b of branchesNamed(cmd)) assert.equal(b, SPRINT_BRANCH, `a git command named another branch: ${cmd}`);
        }
        assert.ok(logs.some((l) => l.startsWith('[kb-work] WARN:') && l.includes(`'${OTHER_BRANCH}'`) && l.includes(`'${SPRINT_BRANCH}'`)), logs.join('\n'));
    });

    test('a maintainer on the sprint branch commits and pushes as before, after one branch read', async () => {
        const { client, commands } = guardHarness({ branchAnswers: [SPRINT_BRANCH] });
        await confirm(client, ['e1']);
        const before = commands.length;

        const out = await client.commitRound('review C1');

        assert.deepEqual(out, { committed: 1, pending: 0 });
        const round = commands.slice(before).map((c) => c.cmd);
        assert.equal(round[0], 'git rev-parse --abbrev-ref HEAD', JSON.stringify(round));
        assert.ok(round.some((c) => /^git push\b/.test(c)), JSON.stringify(round));
    });
});
