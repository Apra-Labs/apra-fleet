// The review-round KB bible commit, end to end against REAL git.
//
// helpers/git-repo-fixture.mjs stands up a bare "origin" carrying the sprint
// branch, the kb_maintainer's clone (the clone every command() runs real git
// in) and a peer clone standing in for another machine publishing to the same
// branch. The sprint's target base branch ('main') is published to origin at
// the seed commit; the maintainer's sprint branch then carries one commit of
// sprint work on top, so the base commit (merge-base) differs from HEAD.
//
// The engine side is the REAL createKbWorkClient wired the way runner.js
// wires it: gPull/gPush/abortRebase/bibleBase are the real createGitSync
// entry points over the real syncMemberBefore/syncMemberAfter. memberCall is
// a fake KB whose kb_bible_commit shells the same git operations the real
// handler performs (entry-level merge into .fleet/kb-canonical.json, v2
// envelope with the given provenance, a local pathspec-scoped commit, never a
// push).
//
// Every assertion is about REAL repository state on origin: the bible file at
// origin's sprint-branch tip, the tip SHA, merge commits -- never about a
// command string.
//
// FALSIFICATION: reverting the kb_maintainer half of runner.js
// computeBranchEnsureMembers makes scenario 9 fail -- the role-less
// maintainer is never put on the sprint branch, so the bible-commit branch
// guard refuses the commit and nothing reaches origin.
//
// FALSIFICATION: removing the retry path in kb.mjs commitRepo (the second
// bibleAttempt after a rejected G-push) makes scenario 3 fail -- the
// concurrent change's rebase conflicts on .fleet/kb-canonical.json, the
// ladder aborts it, and without the retry e1 never reaches origin.
//
// FALSIFICATION: reverting the committed:false publication check in kb.mjs
// bibleAttempt (back to "committed:false -> nothing to publish") makes
// scenarios 10 and 11 fail -- round 2 drops the ids (committed 0, pending 0)
// while origin's bible never receives the entries.
//
// HOST GATING mirrors git-sync-real-repo.test.mjs: a host without a usable
// git skips WITH the reason attached. Each test removes its temp repos.
//
// ASCII only.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import {
    syncMemberBefore,
    syncMemberAfter,
    syncMemberAfterOrdered,
    isNoMutationDispatchFailure,
    computeBranchEnsureMembers,
} from '../fleet-sprint/runner.js';
import { runEnsureSprintBranchPhase } from '../fleet-sprint/phases/ensure-sprint-branch.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { createGitRepoFixture, probeGitRepoFixtureSupport } from './helpers/git-repo-fixture.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

const support = probeGitRepoFixtureSupport();
if (!support.ok) {
    console.error(`[kb-bible-commit-real-git] DEGRADED -- real-git bible commit coverage did NOT run on this host: ${support.reason}`);
}

const BIBLE = '.fleet/kb-canonical.json';
const BASE_BRANCH = 'main';
const MAINT_NAME = 'maint';
const MAINT = { id: 'id-maint', name: MAINT_NAME, type: 'local' };
const REASON = 'verified against the merged code in this round';

/** A read-only git query straight against a repository directory (never through command()). */
function gitIn(dir, args) {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function entry(id) {
    return { id, type: 'knowledge', title: `entry ${id}`, summary: `summary of ${id}`, confidence: 'CONFIRMED' };
}

function serializeBible(entries, provenance) {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify({ version: 2, provenance: { ...provenance, entry_count: sorted.length }, entries: sorted }, null, 2) + '\n';
}

function readBible(text) {
    return text ? JSON.parse(text) : null;
}

/**
 * The fake maintainer KB. kb_promote confirms an INFERRED entry;
 * kb_bible_commit performs the real handler's git operations in the
 * maintainer clone through the fixture's real-git command().
 */
function createFakeKb(fixture, { afterBibleCommit } = {}) {
    const kb = new Map();
    const calls = [];
    const memberCall = async (member, tool, args) => {
        calls.push({ tool, member: member.name, args });
        if (tool === 'kb_promote') {
            if (!kb.has(args.id)) kb.set(args.id, { ...entry(args.id), confidence: 'INFERRED' });
            kb.get(args.id).confidence = 'CONFIRMED';
            return { id: args.id, confidence_after: 'CONFIRMED' };
        }
        if (tool === 'kb_bible_commit') {
            const file = path.join(fixture.clonePath, BIBLE);
            const existing = fs.existsSync(file) ? readBible(fs.readFileSync(file, 'utf8')).entries : [];
            const merged = [];
            const skipped = [];
            for (const id of args.ids) {
                const e = kb.get(id);
                if (e && e.confidence === 'CONFIRMED') merged.push(id); else skipped.push({ id, reason: 'not_confirmed_or_unknown' });
            }
            const byId = new Map(existing.map((e) => [e.id, e]));
            for (const id of merged) byId.set(id, { ...kb.get(id) });
            const entries = [...byId.values()];
            if (merged.length === 0) return { content: [{ text: JSON.stringify({ merged, skipped, entry_count: existing.length, committed: false }) }] };
            // As the real handler: an unchanged entry set is a no-op -- no
            // rewrite, no commit, committed:false (merged still lists the ids).
            const canon = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
            if (fs.existsSync(file) && canon(existing) === canon(entries)) {
                return { content: [{ text: JSON.stringify({ merged, skipped, entry_count: entries.length, committed: false }) }] };
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, serializeBible(entries, { commit: args.baseCommit, branch: args.baseBranch }), 'utf8');
            const add = await fixture.command(`git add -- ${BIBLE}`);
            if (!add.ok) throw new Error(`kb_bible_commit: git add failed: ${add.error}`);
            const commit = await fixture.command(`git commit -m kb-bible-commit -- ${BIBLE}`);
            if (!commit.ok) throw new Error(`kb_bible_commit: bible written but the local commit failed: ${commit.error}`);
            if (typeof afterBibleCommit === 'function') afterBibleCommit();
            return { content: [{ text: JSON.stringify({ merged, skipped, entry_count: entries.length, committed: true }) }] };
        }
        return {};
    };
    return { kb, calls, memberCall };
}

/** The engine side, wired the way runner.js wires it. */
function makeEngine(fixture, fakeKb) {
    const logs = [];
    const log = (m) => logs.push(m);
    const gitSync = createGitSync({
        brackets: createSyncBrackets(),
        command: fixture.command,
        log,
        branch: fixture.branch,
        baseBranch: BASE_BRANCH,
        args: {},
        agent: undefined,
        doltPushMutex: undefined,
        sprintId: 'sprint-kb-bible-commit',
        onAuthFailure: undefined,
        resolveMemberProvider: undefined,
        ensureVcsAuthFresh: async () => {},
        syncMemberBefore,
        syncMemberAfter,
        syncMemberAfterOrdered,
        isNoMutationDispatchFailure,
    });
    const kbWork = createKbWorkClient({
        memberCall: fakeKb.memberCall,
        maintainers: selfMaintainer(MAINT, [MAINT_NAME, 'reviewer-1']),
        gPull: (m, options) => gitSync.pullGitBefore(m, options),
        gPush: (m) => gitSync.pushBibleCommit(m),
        abortRebase: (m) => gitSync.abortRebase(m),
        bibleBase: (m) => gitSync.resolveBibleBase(m),
        canResetCheckout: (m, f) => gitSync.canResetBibleCheckout(m, f),
        checkedOutBranch: (m) => gitSync.checkedOutBranch(m),
        bibleUnpushed: (m, f) => gitSync.bibleUnpushed(m, f),
        unpushedOnlyBible: (m, f) => gitSync.unpushedOnlyBible(m, f),
        log,
    });
    return { kbWork, gitSync, logs };
}

/** A review round whose reviewer confirmed `ids`, through the real apply path. */
async function reviewRound(kbWork, ids) {
    await kbWork.apply('reviewer', 'reviewer-1', { kb_promotions: ids.map((id) => ({ id, reason: REASON })) });
    return kbWork.commitRound('review');
}

/** Install a pre-receive hook on origin that rejects every push while `flag` exists. */
function installRejectingHook(fixture) {
    const flag = path.join(fixture.root, 'reject-pushes');
    const hook = path.join(fixture.originDir, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -f "${flag.replace(/\\/g, '/')}" ]; then echo "push rejected by test hook" >&2; exit 1; fi\nexit 0\n`, 'utf8');
    fs.chmodSync(hook, 0o755);
    return {
        on: () => fs.writeFileSync(flag, 'x'),
        off: () => fs.rmSync(flag, { force: true }),
    };
}

describe('review-round bible commit against a real git origin', { skip: support.ok ? false : support.reason }, () => {
    let fixture;
    let baseSha;
    let priorInstantBackoff;

    before(() => {
        priorInstantBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
    });

    after(() => {
        if (priorInstantBackoff === undefined) delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        else process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantBackoff;
    });

    beforeEach(async () => {
        fixture = createGitRepoFixture({ member: MAINT_NAME, branch: 'feat/kb-sprint', prefix: 'kb-bible-commit-' });
        baseSha = fixture.seedSha;
        // The target base branch on origin, at the seed commit; the sprint
        // branch then moves one commit past it.
        fixture.peerPublishRef(baseSha, BASE_BRANCH);
        fixture.peerPublish('sprint-work');
        const fetch = await fixture.command(`git fetch origin ${BASE_BRANCH}`);
        assert.ok(fetch.ok, fetch.error);
        const pull = await fixture.command(`git pull --ff-only origin ${fixture.branch}`);
        assert.ok(pull.ok, pull.error);
    });

    afterEach(() => {
        const { root } = fixture;
        fixture.cleanup();
        assert.equal(fs.existsSync(root), false, 'the temp repos must be removed after the test');
        fixture = null;
    });

    test('1. after a review round with confirmations, the bible on the sprint branch at origin holds exactly those entries', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork } = makeEngine(fixture, fakeKb);

        const out = await reviewRound(kbWork, ['e1', 'e2']);

        assert.deepEqual(out, { committed: 2, pending: 0 });
        const bible = readBible(fixture.originFileAt(BIBLE));
        assert.ok(bible, 'the bible reached origin');
        assert.deepEqual(bible.entries.map((e) => e.id), ['e1', 'e2']);
        assert.equal(bible.provenance.entry_count, 2);
        assert.equal(fixture.originTip(), fixture.localTip(), 'the maintainer is in sync with origin');
        assert.equal(fixture.localStatus(), '');
    });

    test('2. a review round with no confirmations makes no bible commit: origin is unchanged', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork } = makeEngine(fixture, fakeKb);
        const tipBefore = fixture.originTip();

        const out = await reviewRound(kbWork, []);

        assert.deepEqual(out, { committed: 0, pending: 0 });
        assert.equal(fakeKb.calls.filter((c) => c.tool === 'kb_bible_commit').length, 0);
        assert.equal(fixture.originTip(), tipBefore);
        assert.equal(fixture.originFileAt(BIBLE), null);
    });

    test('3. a G-push rejected by a concurrent bible change ends with both changes on the branch and no manual merge', async () => {
        // Another clone publishes two entries of its own to the same file
        // between the maintainer's kb_bible_commit and its G-push, so the
        // push is rejected and the ladder's pull --rebase conflicts on the
        // bible.
        let peerChange = null;
        let injected = false;
        const fakeKb = createFakeKb(fixture, {
            afterBibleCommit: () => {
                if (!peerChange || injected) return;
                injected = true;
                fixture.peerPublishFile(BIBLE, peerChange.trimEnd(), 'peer-bible-change');
            },
        });
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        // Round 1 publishes a bible both clones share.
        await reviewRound(kbWork, ['e0']);
        const shared = readBible(fixture.originFileAt(BIBLE));
        peerChange = serializeBible([...shared.entries, entry('p1'), entry('p2')], { commit: baseSha, branch: BASE_BRANCH });

        const out = await reviewRound(kbWork, ['e1']);

        assert.ok(injected, 'the concurrent change was published between commit and push');
        assert.deepEqual(out, { committed: 1, pending: 0 });
        const bible = readBible(fixture.originFileAt(BIBLE));
        assert.deepEqual(bible.entries.map((e) => e.id), ['e0', 'e1', 'p1', 'p2'], 'both changes are on the branch');
        assert.equal(bible.provenance.entry_count, 4);
        assert.deepEqual(fixture.originMergeSubjects(), [], 'no merge commit: no manual merge');
        assert.ok(fixture.originSubjects().includes('peer-bible-change'));
        assert.equal(fixture.originTip(), fixture.localTip());
        assert.equal(fixture.localStatus(), '');
        assert.equal(fixture.localRebaseInProgress(), false);
        assert.ok(logs.some((l) => /retrying once/.test(l)), 'the retry path ran');
    });

    test('4. two consecutive push failures keep the confirmations queued with a WARN; the next successful round commits them', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const hook = installRejectingHook(fixture);
        const tipBefore = fixture.originTip();

        hook.on();
        const first = await reviewRound(kbWork, ['e1', 'e2']);

        assert.deepEqual(first, { committed: 0, pending: 2 });
        assert.equal(fixture.originTip(), tipBefore, 'nothing reached origin');
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1', 'e2'], 'no confirmation lost');
        assert.ok(logs.some((l) => /^\[kb-work\] WARN: bible commit [\s\S]* stay queued for the next round$/.test(l)), logs.join('\n'));
        assert.equal(fixture.localTip(), tipBefore, 'the maintainer is back on the remote tip, so its next G-pull fast-forwards');
        assert.equal(fixture.localStatus(), '');
        assert.equal(fakeKb.calls.filter((c) => c.tool === 'kb_bible_commit').length, 2, 'exactly one retry');

        hook.off();
        const second = await reviewRound(kbWork, ['e3']);

        assert.deepEqual(second, { committed: 3, pending: 0 });
        assert.deepEqual(readBible(fixture.originFileAt(BIBLE)).entries.map((e) => e.id), ['e1', 'e2', 'e3']);
        assert.deepEqual(kbWork.pendingConfirmations(), []);
    });

    for (const [label, reason] of [['a FAIL verdict', 'final review verdict FAIL'], ['an abort', 'sprint aborted: stall']]) {
        test(`5. after ${label}, no further bible commit is made`, async () => {
            const fakeKb = createFakeKb(fixture);
            const { kbWork } = makeEngine(fixture, fakeKb);
            await reviewRound(kbWork, ['e1']);
            const tipAfterRound = fixture.originTip();

            await kbWork.apply('reviewer', 'reviewer-1', { kb_promotions: [{ id: 'e2', reason: REASON }] });
            kbWork.seal(reason);
            const out = await kbWork.commitRound('harvest');

            assert.deepEqual(out, { committed: 0, pending: 1 });
            assert.equal(fixture.originTip(), tipAfterRound, 'origin unchanged');
            assert.equal(fixture.localTip(), tipAfterRound, 'no local bible commit either');
            assert.equal(fakeKb.calls.filter((c) => c.tool === 'kb_bible_commit').length, 1);
            assert.deepEqual(readBible(fixture.originFileAt(BIBLE)).entries.map((e) => e.id), ['e1']);
        });
    }

    test('6. provenance.branch is the sprint base branch and provenance.commit the base commit', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork } = makeEngine(fixture, fakeKb);
        const sprintTip = fixture.localTip();
        assert.notEqual(sprintTip, baseSha, 'precondition: the sprint branch has moved past its base');

        await reviewRound(kbWork, ['e1']);

        const bible = readBible(fixture.originFileAt(BIBLE));
        assert.equal(bible.provenance.branch, BASE_BRANCH);
        assert.notEqual(bible.provenance.branch, fixture.branch, 'never the sprint branch');
        assert.equal(bible.provenance.commit, baseSha);
        const call = fakeKb.calls.find((c) => c.tool === 'kb_bible_commit');
        assert.deepEqual(call.args, { ids: ['e1'], baseBranch: BASE_BRANCH, baseCommit: baseSha });
    });

    test('7. a twice-rejected G-push never resets away the maintainer\'s unpushed non-bible commit', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const hook = installRejectingHook(fixture);
        // The maintainer is also a doer whose own bracket G-push failed: it
        // holds an unpushed code commit.
        fs.writeFileSync(path.join(fixture.clonePath, 'doer-work.txt'), 'unpushed doer work\n', 'utf8');
        assert.ok((await fixture.command('git add -- doer-work.txt')).ok);
        const c = await fixture.command('git commit -m doer-unpushed-work');
        assert.ok(c.ok, c.error);
        const doerCommit = fixture.localTip();

        hook.on();
        const out = await reviewRound(kbWork, ['e1']);

        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.ok(fixture.isAncestor(doerCommit, 'HEAD'), 'the unpushed doer commit is still reachable from HEAD');
        assert.equal(fs.readFileSync(path.join(fixture.clonePath, 'doer-work.txt'), 'utf8'), 'unpushed doer work\n');
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1']);
        assert.ok(logs.some((l) => /^\[kb-work\] WARN: not pushing the bible commit from maintainer 'maint'.*doer-work\.txt.*stay queued/.test(l)), logs.join('\n'));
        assert.equal(fakeKb.calls.filter((c2) => c2.tool === 'kb_bible_commit').length, 1, 'no retry ran');
    });

    test('8. a twice-rejected G-push never resets away an uncommitted change to a tracked non-bible file', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const hook = installRejectingHook(fixture);
        fs.writeFileSync(path.join(fixture.clonePath, 'README.md'), 'edited by the doer, uncommitted\n', 'utf8');

        hook.on();
        const out = await reviewRound(kbWork, ['e1']);

        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.equal(fs.readFileSync(path.join(fixture.clonePath, 'README.md'), 'utf8'), 'edited by the doer, uncommitted\n');
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1']);
        assert.ok(logs.some((l) => /not resetting maintainer 'maint'.*unrelated local work was preserved/.test(l)), logs.join('\n'));
    });

    /** Commit unpushed doer work on the maintainer (it is usually also a doer); returns its sha. */
    async function commitDoerWork() {
        fs.writeFileSync(path.join(fixture.clonePath, 'doer-work.txt'), 'unpushed doer work\n', 'utf8');
        assert.ok((await fixture.command('git add -- doer-work.txt')).ok);
        const c = await fixture.command('git commit -m doer-unpushed-work');
        assert.ok(c.ok, c.error);
        return fixture.localTip();
    }

    test('10. a bible push never publishes an unpushed doer commit: it is skipped with a WARN and the ids stay queued, in every round, until the doer commit is published', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const doerCommit = await commitDoerWork();
        const tipBefore = fixture.originTip();

        const first = await reviewRound(kbWork, ['e1']);
        assert.deepEqual(first, { committed: 0, pending: 1 }, 'round 1: push skipped');
        assert.equal(fixture.originTip(), tipBefore, 'round 1 published nothing (not the doer commit either)');
        assert.equal(fixture.originFileAt('doer-work.txt'), null, 'the doer file never reached origin');
        assert.ok(logs.some((l) => /not pushing the bible commit from maintainer 'maint'.*doer-work\.txt/.test(l)), logs.join('\n'));

        // Round 2: kb_bible_commit commits nothing (the local commit holds the
        // bible); the earlier commit is still unpushed, and still guarded.
        const second = await kbWork.commitRound('review');
        assert.deepEqual(second, { committed: 0, pending: 1 });
        assert.equal(fixture.originTip(), tipBefore, 'round 2 published nothing');
        assert.ok(fixture.isAncestor(doerCommit, 'HEAD'), 'the doer commit was never reset away');
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1']);

        // The doer's own push publishes everything; the next round then finds
        // the bible on origin and releases the ids.
        const push = await fixture.command(`git push origin HEAD:refs/heads/${fixture.branch}`);
        assert.ok(push.ok, push.error);
        const third = await kbWork.commitRound('review');
        assert.deepEqual(third, { committed: 0, pending: 0 }, logs.join('\n'));
        assert.deepEqual(readBible(fixture.originFileAt(BIBLE)).entries.map((e) => e.id), ['e1']);
    });

    test('11. an unpushed bible commit left by a refused reset (uncommitted tracked change) is pushed by the next round although kb_bible_commit commits nothing', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const hook = installRejectingHook(fixture);
        fs.writeFileSync(path.join(fixture.clonePath, 'README.md'), 'edited by the doer, uncommitted\n', 'utf8');
        const tipBefore = fixture.originTip();

        hook.on();
        const first = await reviewRound(kbWork, ['e1']);
        assert.deepEqual(first, { committed: 0, pending: 1 });
        assert.equal(fixture.originTip(), tipBefore);

        hook.off();
        const second = await kbWork.commitRound('review');

        assert.deepEqual(second, { committed: 1, pending: 0 }, logs.join('\n'));
        assert.deepEqual(kbWork.pendingConfirmations(), []);
        const bible = readBible(fixture.originFileAt(BIBLE));
        assert.ok(bible, 'the bible reached origin');
        assert.deepEqual(bible.entries.map((e) => e.id), ['e1']);
        assert.equal(fixture.originTip(), fixture.localTip());
        assert.equal(fs.readFileSync(path.join(fixture.clonePath, 'README.md'), 'utf8'), 'edited by the doer, uncommitted\n', 'the uncommitted edit survives');
    });

    test('12. a push rejected in every round through the end keeps the ids pending, WARNs, and the sprint analysis names the repository and count', async () => {
        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const hook = installRejectingHook(fixture);
        await commitDoerWork();
        const tipBefore = fixture.originTip();

        hook.on();
        await reviewRound(kbWork, ['e1', 'e2']);
        const second = await kbWork.commitRound('final review');
        const third = await kbWork.commitRound('harvest');
        kbWork.warnPending();

        assert.deepEqual(second, { committed: 0, pending: 2 });
        assert.deepEqual(third, { committed: 0, pending: 2 });
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1', 'e2']);
        assert.equal(fixture.originTip(), tipBefore, 'nothing ever reached origin');
        assert.equal(logs.filter((l) => /^\[kb-work\] WARN: not pushing the bible commit from maintainer 'maint'.*stay queued/.test(l)).length, 3, 'each round WARNs and keeps the ids');
        assert.ok(logs.some((l) => /^\[kb-work\] WARN: 2 confirmation\(s\) for example\.com\/org\/repo are not in a pushed bible commit/.test(l)), logs.join('\n'));
        assert.ok(!logs.some((l) => /already in the bible -- nothing to push/.test(l)));

        const analysis = buildAnalysisText({
            targetIssues: ['scope-1'], branch: fixture.branch, baseBranch: BASE_BRANCH, cyclesRun: 1,
            closedCountHistory: [], highWaterClosedCount: 0, deployFailures: [], integFailures: [], rejectedNewTasks: [],
            finalVerdictResult: { verdict: 'PASS', notes: '' }, finalClosedCount: 0, finalOpenAtGoalCount: 0,
            kbBibleUnpublished: kbWork.unpublishedBible(),
        });
        assert.match(analysis, /## KB bible/);
        assert.match(analysis, /WARNING: bible not published/);
        assert.match(analysis, /- example\.com\/org\/repo: 2 unpublished confirmation\(s\)\./);
    });

    test('9. a role-less maintainer starting on another branch is put on the sprint branch at setup; the bible lands on the sprint branch and the other branch is untouched', async () => {
        // The maintainer clone starts on the base branch, carrying a local
        // commit origin does not have.
        const co = await fixture.command(`git checkout -b ${BASE_BRANCH} origin/${BASE_BRANCH}`);
        assert.ok(co.ok, co.error);
        fixture.memberCommit('base-local-work');
        const otherTip = fixture.localTip();
        const originBaseBefore = gitIn(fixture.originDir, ['rev-parse', `refs/heads/${BASE_BRANCH}`]);

        // Every dispatched role is held by other members; the maintainer holds
        // none. Only the maintainer's commands reach its clone -- the other
        // members are other machines.
        const roles = { doer: ['dev'], reviewer: ['rev'] };
        const getMembersForRole = (role) => roles[role] || ['dev'];
        const selector = selfMaintainer(MAINT, [MAINT_NAME, 'reviewer-1']);
        const branchEnsureMembers = computeBranchEnsureMembers(getMembersForRole, selector);
        const maintCommand = (cmd, opts = {}) => (opts.member_name === MAINT_NAME ? fixture.command(cmd, opts) : Promise.resolve({ ok: true, output: '', error: null }));
        const noop = () => {};
        await runEnsureSprintBranchPhase({
            command: maintCommand, log: noop, group: noop, phase: noop, endGroup: noop, publishState: noop,
            branchEnsureMembers,
            validated: { branch: fixture.branch, baseBranch: BASE_BRANCH, goal: 'P1/P2', maxCycles: 1 },
        });

        const fakeKb = createFakeKb(fixture);
        const { kbWork, logs } = makeEngine(fixture, fakeKb);
        const out = await reviewRound(kbWork, ['e1', 'e2']);

        assert.deepEqual(out, { committed: 2, pending: 0 }, logs.join('\n'));
        const bible = readBible(fixture.originFileAt(BIBLE));
        assert.ok(bible, 'the bible reached origin on the sprint branch');
        assert.deepEqual(bible.entries.map((e) => e.id), ['e1', 'e2']);
        assert.equal(gitIn(fixture.clonePath, ['rev-parse', '--abbrev-ref', 'HEAD']), fixture.branch, 'HEAD is the sprint branch');
        assert.equal(gitIn(fixture.clonePath, ['rev-parse', `refs/heads/${BASE_BRANCH}`]), otherTip, 'the other branch is untouched');
        assert.equal(gitIn(fixture.originDir, ['rev-parse', `refs/heads/${BASE_BRANCH}`]), originBaseBefore, "origin's base branch is untouched");
        assert.equal(fixture.originTip(), fixture.localTip(), 'the maintainer is in sync with origin');
    });
});
