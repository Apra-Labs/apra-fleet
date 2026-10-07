import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbWorkClient, vetKbWork, kbDemotionBlock, KB_MAX_DEMOTION_CANDIDATES, KB_MIN_PROMOTE_REASON,
} from '../fleet-sprint/kb.mjs';
import { createRoundChangedFiles, buildReviewerPrompt } from '../fleet-sprint/runner.js';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// my-beads-db-xqp.4.2 / my-beads-db-xqp.4.4: kbWork.demotionCandidates() --
// the CONFIRMED entries this reviewer may demote back to INFERRED, scoped to
// THIS review round's changed files -- plus the round-diff mechanism it
// depends on (createRoundChangedFiles), and the vetKbWork/kbDemotionBlock
// pieces landed by the sibling impl tasks (my-beads-db-xqp.4.1/4.3) that had
// no dedicated test coverage of their own until now (verified by grep: zero
// hits for kb_demotions/demotionCandidates/kbDemotionBlock anywhere under
// test/ before this file).

const REVIEWER = Object.freeze({ id: 'id-warehouse-reviewer', name: 'warehouse-reviewer', type: 'local' });
// Every KB write is routed to the repository's kb_maintainer, so the
// CONFIRMED candidates live in -- and are read from -- the maintainer's KB.
const MAINTAINER = Object.freeze({ id: 'id-warehouse-maint', name: 'warehouse-maint', type: 'remote' });
const withMaintainer = () => fakeMaintainerSelector({
    repoOf: { [REVIEWER.name]: 'example.com/warehouse', [MAINTAINER.name]: 'example.com/warehouse' },
    maintainerOf: { 'example.com/warehouse': MAINTAINER },
});

function makeCallTool(entries, opts = {}) {
    const calls = [];
    return {
        calls,
        memberCall: async (member, name, args) => {
            calls.push({ name, args, member });
            if (name === 'kb_query') {
                if (opts.throwOnList) throw new Error('kb unavailable');
                if (opts.rejectOnList) return { isError: true, content: [{ type: 'text', text: 'denied' }] };
                return { content: [{ type: 'text', text: JSON.stringify({ l1_results: entries }) }] };
            }
            return {};
        },
    };
}

const CONFIRMED_ENTRIES = [
    { id: 'kb-aaa', type: 'knowledge', confidence: 'CONFIRMED', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-bbb', type: 'learning', confidence: 'CONFIRMED', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
];

describe('createKbWorkClient.demotionCandidates (my-beads-db-xqp.4.2)', () => {
    test("asks the reviewer's repository maintainer for its own CONFIRMED entries touching this round's changed files", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => ['server/transit.js'],
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        const queryCall = calls.find((c) => c.name === 'kb_query');
        assert.ok(queryCall, 'kb_query was never called -- the reviewer gets no demotion candidates');
        assert.deepEqual(queryCall.args, {
            tag: `member:${MAINTAINER.id}`, confidence: ['CONFIRMED'], exclude_disputed: true, limit: KB_MAX_DEMOTION_CANDIDATES,
        });
        assert.equal(queryCall.member, MAINTAINER, 'the read must run in the maintainer session that holds the entries');
        // kb-aaa touches server/transit.js (this round's changed files);
        // kb-bbb touches server/rules.js, which this round never changed.
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa']);
    });

    test("excludes an entry whose source_files do not intersect this round's changed files", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['some/unrelated.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, [], 'an entry outside this round\'s diff must never be offered for demotion');
    });

    test('never offers a user-directive as a demotion candidate (kb_demote refuses them)', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-ddd', type: 'user-directive', confidence: 'CONFIRMED', title: 'pending directive', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.ok(!candidates.some((c) => c.id === 'kb-ddd'), 'a user-directive entry was offered for demotion');
    });

    test('caps at KB_MAX_DEMOTION_CANDIDATES -- a 21st matching entry is not offered', async () => {
        const many = Array.from({ length: 21 }, (_, i) => ({
            id: `kb-${i}`, type: 'knowledge', confidence: 'CONFIRMED', title: `entry ${i}`, summary: 'x', source_files: ['server/transit.js'],
        }));
        const { memberCall } = makeCallTool(many);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.equal(candidates.length, KB_MAX_DEMOTION_CANDIDATES, 'the cap was not applied');
        assert.ok(!candidates.some((c) => c.id === 'kb-20'), 'the 21st matching entry must not be offered');
    });

    test("no changed files this round yields [] without ever reading the KB", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        for (const changed of [[], null, undefined]) {
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => changed, log: () => {},
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        }
        assert.equal(calls.length, 0, 'nothing changed this round, so there is nothing to re-check -- kb_query must not even be called');
    });

    test('returns [] rather than reading the wrong KB when no maintainer is resolved', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const noSelection = createKbWorkClient({ memberCall, roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await noSelection.demotionCandidates(REVIEWER), []);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await client.demotionCandidates(null), []);
        assert.equal(calls.length, 0, 'a kb_* read with no maintainer would read some other KB');
    });

    test('no roundChangedFiles wired yields [] and never calls kb_query', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.length, 0);
    });

    test('a round diff that could not be computed degrades to [] and never throws into the review dispatch', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => { throw new Error('git unreachable'); },
            log: () => {},
        });

        await assert.doesNotReject(() => client.demotionCandidates(REVIEWER));
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a cold or broken kb_query yields [] and never throws', async () => {
        const { memberCall } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a kb_query tool-level rejection yields []', async () => {
        const { memberCall } = makeCallTool([], { rejectOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('inactive client (no memberCall) yields []', async () => {
        const client = createKbWorkClient({ roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('replaces, never accumulates: a failing read the round after a successful one still yields [] -- no fallback to the prior round\'s offers', async () => {
        let round = 0;
        const changedByRound = [['server/transit.js'], ['server/rules.js']];
        const client = createKbWorkClient({
            memberCall: async (member, name) => {
                if (name !== 'kb_query') return {};
                if (round === 0) return { content: [{ type: 'text', text: JSON.stringify({ l1_results: CONFIRMED_ENTRIES }) }] };
                throw new Error('kb unavailable this round');
            },
            maintainers: withMaintainer(),
            roundChangedFiles: async () => changedByRound[round],
            log: () => {},
        });

        const first = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(first.map((c) => c.id), ['kb-aaa'], 'round 1 should offer the entry touching this round\'s files');

        round = 1;
        const second = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(second, [], 'a failing round-2 read must not fall back to round 1\'s offered set');
    });

    test('a maintainer not on the sprint branch skips the round-diff read entirely and offers nothing', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        let roundChangedFilesCalls = 0;
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => { roundChangedFilesCalls += 1; return ['server/transit.js']; },
            checkedOutBranch: async () => ({ branch: 'main', sprintBranch: 'feat/thing' }),
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, []);
        assert.equal(roundChangedFilesCalls, 0, 'the round diff must never be computed on a maintainer checked out on the wrong branch');
    });
});

describe('createRoundChangedFiles (my-beads-db-xqp.4.2: the per-round diff, not the cumulative one)', () => {
    function fakeGit({ diffOutputs = {} } = {}) {
        const calls = [];
        let merged = false;
        const pullGitBefore = async (memberName) => {
            calls.push({ op: 'pull', memberName });
            merged = true;
        };
        const command = async (cmd, opts) => {
            calls.push({ op: 'command', cmd, opts, mergedAtCallTime: merged });
            if (cmd === 'git rev-parse HEAD') {
                return { ok: true, output: merged ? 'post-merge-sha' : 'pre-merge-sha' };
            }
            const key = Object.keys(diffOutputs).find((k) => cmd === `git diff --name-only ${k}`);
            if (key) return { ok: true, output: diffOutputs[key] };
            return { ok: true, output: '' };
        };
        return { calls, pullGitBefore, command, mergedFlag: () => merged };
    }

    test('fetches/fast-forward-merges BEFORE reading HEAD and diffing, and diffs from the base branch on the first round', async () => {
        const { calls, pullGitBefore, command } = fakeGit({
            diffOutputs: { 'origin/main...post-merge-sha': 'a.js\nb.js\n' },
        });
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const files = await roundChangedFiles('maint-1');

        assert.deepEqual(files, ['a.js', 'b.js']);
        const revParse = calls.find((c) => c.op === 'command' && c.cmd === 'git rev-parse HEAD');
        assert.equal(revParse.mergedAtCallTime, true, 'HEAD was read BEFORE the fetch/merge -- a stale pre-merge snapshot');
        const diff = calls.find((c) => c.op === 'command' && c.cmd.startsWith('git diff'));
        assert.equal(diff.cmd, 'git diff --name-only origin/main...post-merge-sha');
    });

    test('FALSIFICATION: computing the diff before the fetch/merge reads the stale pre-merge tree -- proving this test suite actually discriminates the order', async () => {
        // Same fakes as above, but this reverted variant reads HEAD and diffs
        // BEFORE calling pullGitBefore -- the superseded upstream attempt's
        // defect (my-beads-db-xqp.4.2's own description). It is written here,
        // inline, purely to prove the fakes above can tell the two orders
        // apart; the correct order is exercised by createRoundChangedFiles
        // itself in the test above and is never reverted in production code.
        async function revertedRoundChangedFiles({ command, pullGitBefore, baseBranch }) {
            const headRes = await command('git rev-parse HEAD', {});
            await pullGitBefore('maint-1');
            const diffRes = await command(`git diff --name-only origin/${baseBranch}...${headRes.output}`, {});
            return String(diffRes.output || '').split('\n').filter(Boolean);
        }
        const { command, pullGitBefore } = fakeGit({
            diffOutputs: {
                'origin/main...pre-merge-sha': 'stale-only.js\n',
                'origin/main...post-merge-sha': 'a.js\nb.js\n',
            },
        });

        const files = await revertedRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main' });

        assert.deepEqual(files, ['stale-only.js'], 'the reverted (pre-merge) order must read the stale tree');
        assert.notDeepEqual(files, ['a.js', 'b.js'], 'the reverted order must NOT match the correct post-merge result');
    });

    test("round 2 diffs from round 1's merged tip, not from the base branch again -- never the cumulative sprint diff", async () => {
        const shas = ['round1-sha', 'round2-sha'];
        let callIndex = 0;
        const calls = [];
        const pullGitBefore = async () => {};
        const command = async (cmd) => {
            calls.push(cmd);
            if (cmd === 'git rev-parse HEAD') {
                const sha = shas[callIndex];
                callIndex += 1;
                return { ok: true, output: sha };
            }
            // Round 1: origin/main...round1-sha. Round 2 (per-round): the
            // interesting case is round1-sha...round2-sha, which must differ
            // from what the CUMULATIVE diff (origin/main...round2-sha) would
            // have returned.
            if (cmd === 'git diff --name-only origin/main...round1-sha') return { ok: true, output: 'round1-file.js\n' };
            if (cmd === 'git diff --name-only round1-sha...round2-sha') return { ok: true, output: 'round2-only-file.js\n' };
            if (cmd === 'git diff --name-only origin/main...round2-sha') return { ok: true, output: 'round1-file.js\nround2-only-file.js\n' };
            return { ok: true, output: '' };
        };
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const round1Files = await roundChangedFiles('maint-1');
        const round2Files = await roundChangedFiles('maint-1');

        assert.deepEqual(round1Files, ['round1-file.js']);
        // The per-round diff for round 2 is round1-sha...round2-sha, which is
        // STRICTLY SMALLER than the cumulative origin/main...round2-sha diff
        // the engine's other (unrelated) diffFiles helper would have
        // returned for the same round -- proving this is genuinely the
        // per-round set, not the cumulative one.
        assert.deepEqual(round2Files, ['round2-only-file.js']);
        assert.notDeepEqual(round2Files, ['round1-file.js', 'round2-only-file.js']);
        assert.ok(calls.includes('git diff --name-only round1-sha...round2-sha'), 'round 2 must diff from round 1\'s tip');
        assert.ok(!calls.includes('git diff --name-only origin/main...round2-sha'), 'round 2 must never fall back to the cumulative base-branch diff');
    });

    test('a failed fetch/merge degrades to [] and does not advance the tracked round sha', async () => {
        let shouldFail = true;
        const pullGitBefore = async () => { if (shouldFail) throw new Error('unreachable'); };
        const diffCalls = [];
        const command = async (cmd) => {
            if (cmd === 'git rev-parse HEAD') return { ok: true, output: 'sha-1' };
            diffCalls.push(cmd);
            if (cmd === 'git diff --name-only origin/main...sha-1') return { ok: true, output: 'f.js\n' };
            return { ok: true, output: '' };
        };
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const failed = await roundChangedFiles('maint-1');
        assert.deepEqual(failed, [], 'a failed fetch/merge must degrade to [], never throw');

        shouldFail = false;
        const recovered = await roundChangedFiles('maint-1');
        assert.deepEqual(recovered, ['f.js'], 'the failed round must not have recorded a stale "previous round" sha');
        assert.ok(diffCalls.includes('git diff --name-only origin/main...sha-1'), 'the recovered round must still diff from the base branch, not a sha from the failed attempt');
    });

    test('a failed git command degrades to []', async () => {
        const pullGitBefore = async () => {};
        const command = async (cmd) => (cmd === 'git rev-parse HEAD' ? { ok: false } : { ok: true, output: 'x.js\n' });
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        assert.deepEqual(await roundChangedFiles('maint-1'), []);
    });
});

describe('vetKbWork: kb_demotions (my-beads-db-xqp.4.1/4.4)', () => {
    const REASON = 'checked the same cited test this review and it now fails';

    test('kb_demotions is reviewer-only: a non-reviewer role is refused wholesale and nothing is executed', () => {
        const result = vetKbWork('doer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON }] });
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.some((r) => r === 'doer: kb_demotions refused -- demotion is reviewer-only'));
    });

    test('a demotion with a missing id is refused; the rest of the list is still processed', () => {
        const result = vetKbWork('reviewer', { kb_demotions: [{ reason: REASON }, { id: 'kb-bbb', reason: REASON }] });
        assert.deepEqual(result.demotions.map((d) => d.id), ['kb-bbb']);
        assert.ok(result.refused.some((r) => r === 'reviewer: demotion missing id'));
    });

    test('a 19-character reason is refused; a 20-character reason is accepted', () => {
        const short = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(19) }] });
        assert.deepEqual(short.demotions, []);
        assert.ok(short.refused.some((r) => r === 'reviewer: demotion kb-aaa has no recorded evidence'));

        const exact = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(KB_MIN_PROMOTE_REASON) }] });
        assert.deepEqual(exact.demotions.map((d) => d.id), ['kb-aaa']);
    });

    test('evidence_files is carried through when present and omitted (not an empty array) when absent', () => {
        const withEvidence = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON, evidence_files: ['test/foo.test.ts'] }] });
        assert.deepEqual(withEvidence.demotions[0].evidence_files, ['test/foo.test.ts']);

        const withoutEvidence = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-bbb', reason: REASON }] });
        assert.ok(!('evidence_files' in withoutEvidence.demotions[0]), 'evidence_files must be omitted, not sent as []');
    });

    test('the pre-existing two-way promote/discard refusal messages are byte-identical to the pre-kb_demotions wording', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-shared', reason: REASON }],
            kb_discards: [{ id: 'kb-shared', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.discards, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-shared refused -- the same output also discards it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: discard kb-shared refused -- the same output also promotes it (discard reason: ${REASON})`));
    });

    test('three-way collision guard: an id in kb_promotions and kb_demotions is refused in both', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-x', reason: REASON }],
            kb_demotions: [{ id: 'kb-x', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-x refused -- the same output also demotes it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-x refused -- the same output also promotes it (demote reason: ${REASON})`));
    });

    test('three-way collision guard: an id in kb_discards and kb_demotions is refused in both', () => {
        const result = vetKbWork('reviewer', {
            kb_discards: [{ id: 'kb-y', reason: REASON }],
            kb_demotions: [{ id: 'kb-y', reason: REASON }],
        });
        assert.deepEqual(result.discards, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: discard kb-y refused -- the same output also demotes it (discard reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-y refused -- the same output also discards it (demote reason: ${REASON})`));
    });

    test('three-way collision guard: an id in ALL THREE lists is refused in every one of them', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-z', reason: REASON }],
            kb_discards: [{ id: 'kb-z', reason: REASON }],
            kb_demotions: [{ id: 'kb-z', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.discards, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-z refused -- the same output also discards and demotes it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: discard kb-z refused -- the same output also promotes and demotes it (discard reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-z refused -- the same output also promotes and discards it (demote reason: ${REASON})`));
    });

    test('an unrelated id in only one list is unaffected by the collision guard', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-shared', reason: REASON }, { id: 'kb-solo', reason: REASON }],
            kb_demotions: [{ id: 'kb-shared', reason: REASON }],
        });
        assert.deepEqual(result.promotions.map((p) => p.id), ['kb-solo']);
        assert.deepEqual(result.demotions, []);
    });
});

describe('kbDemotionBlock (my-beads-db-xqp.4.3/4.4)', () => {
    test('renders nothing for an empty or absent candidate list', () => {
        for (const kbCandidates of [[], undefined, null]) {
            assert.deepEqual(kbDemotionBlock(kbCandidates), []);
        }
    });

    test('renders the offered ids, titles and the kb_demotions output field', () => {
        const block = kbDemotionBlock(CONFIRMED_ENTRIES);
        assert.ok(block.length > 0);
        const text = block.join('\n');
        for (const e of CONFIRMED_ENTRIES) {
            assert.ok(text.includes(e.id), `candidate ${e.id} missing from the demotion block`);
            assert.ok(text.includes(e.title), `candidate title for ${e.id} missing`);
        }
        assert.match(text, /kb_demotions/, 'the block never names the output field the engine reads');
    });
});

describe('buildReviewerPrompt: demotion candidates (my-beads-db-xqp.4.2/4.4)', () => {
    const BASE = {
        beadIds: ['apra-fleet-aaa'],
        acceptanceCriteriaJson: '[]',
        baseBranch: 'main',
        branch: 'feat/thing',
        goal: 'P1',
    };

    test('carries each demotion candidate id into the prompt', () => {
        const prompt = buildReviewerPrompt({ ...BASE, kbDemoteCandidates: CONFIRMED_ENTRIES });

        for (const e of CONFIRMED_ENTRIES) {
            assert.ok(prompt.includes(e.id), `demotion candidate ${e.id} missing from the reviewer prompt`);
        }
        assert.match(prompt, /kb_demotions/, 'prompt never names the output field the engine reads');
    });

    test('omits the demotion block entirely when there are no candidates', () => {
        for (const kbDemoteCandidates of [[], undefined]) {
            const prompt = buildReviewerPrompt({ ...BASE, kbDemoteCandidates });
            assert.ok(!/kb_demotions/.test(prompt), `empty demotion candidate set still emitted a KB block (${JSON.stringify(kbDemoteCandidates)})`);
        }
    });
});
