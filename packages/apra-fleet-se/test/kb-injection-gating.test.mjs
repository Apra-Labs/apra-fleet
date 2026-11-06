import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, kbKnowledgeBlock, KB_MAX_KNOWLEDGE_ENTRIES } from '../fleet-sprint/kb.mjs';
import { createKbInjection, withWrapperKbBlock } from '../fleet-sprint/kb-injection.mjs';
import fs from 'node:fs';
import { roleHints, cleanQueryTerms, isTrackerIdToken, isPriorityTierToken } from '../fleet-sprint/kb-hints.mjs';
import { kbQueryTerms } from '../fleet-sprint/kb.mjs';
import { createMemberInitProbe, createMemberVerifiedLookup } from '../fleet-sprint/member-init-probe.mjs';
import { buildDoerPrompt } from '../fleet-sprint/prompts.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// b4g.19 (per-role relevance hints + KNOWLEDGE BANK block shape) and b4g.18.3
// (engine-side injection gating on the per-member verified lookup).
// =============================================================================

const MAINT = Object.freeze({ id: 'id-maint', name: 'maint', type: 'local' });
const REPO = 'example.com/org/repo';
const entry = (id, title, confidence = 'CONFIRMED', extra = {}) => ({ id, title, summary: `${title} summary`, confidence, source_files: ['src/x.ts'], ...extra });

/** Selector: doer-1, rev-1, opencode-1, agy-1 and planner-1 all belong to REPO, whose maintainer is `maint`. */
const selector = () => fakeMaintainerSelector({
    repoOf: { maint: REPO, 'doer-1': REPO, 'rev-1': REPO, 'oc-1': REPO, 'agy-1': REPO, 'plan-1': REPO, 'dep-1': REPO, 'hv-1': REPO, 'it-1': REPO, 'rt-1': REPO, 'pr-1': REPO },
    maintainerOf: { [REPO]: MAINT },
});

/** A fake memberCall recording the target member of every kb_* call. */
function fakeKb({ query = [], related = [], prime = [] } = {}) {
    const calls = [];
    const memberCall = async (member, name, args) => {
        calls.push({ member: member.name, name, args });
        if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: query, related_claims: related }) }] };
        if (name === 'kb_session_prime') return { content: [{ text: JSON.stringify({ top_entries: prime }) }] };
        return {};
    };
    return { calls, memberCall };
}

function injection({ kb, verified = () => false, diffFiles, deployTargets } = {}) {
    const kbWork = createKbWorkClient({ memberCall: kb.memberCall, maintainers: selector(), log: () => {} });
    return createKbInjection({ kbWork, isMemberVerified: verified, diffFiles, deployTargets, log: () => {} });
}

describe('the KNOWLEDGE BANK block can be cited', () => {
    test('each entry in the real block text carries its id, and the block says to cite by id', async () => {
        const kb = fakeKb({ query: [entry('kb-one', 'First durable lesson'), entry('kb-two', 'Second durable lesson')] });
        const inj = injection({ kb });
        const { block, pushed } = await inj.blockWithInfoFor({ role: 'doer', member: 'doer-1', context: { beadTitles: [{ title: 'anything useful' }] } });
        assert.deepEqual(pushed.ids, ['kb-one', 'kb-two']);
        assert.match(block[0], /"id": "kb-one"/);
        assert.match(block[0], /"id": "kb-two"/);
        assert.match(block[0], /kb_used.*kb_wrong.*copy its `id` exactly/);
        // The id precedes the title it belongs to in the same entry.
        assert.ok(block[0].indexOf('"id": "kb-one"') < block[0].indexOf('First durable lesson'));
    });
});

describe('an injection failure never fails a dispatch', () => {
    const failures = [
        ['a throwing knowledgeFor', { knowledgeFor: async () => { throw new Error('boom'); } }],
        ['a knowledgeFor resolving undefined', { knowledgeFor: async () => undefined }],
    ];
    for (const [name, kbWork] of failures) {
        test(`${name}: no block, an empty push, one log line`, async () => {
            const logs = [];
            const inj = createKbInjection({ kbWork, log: (m) => logs.push(m) });

            assert.deepEqual(await inj.blockWithInfoFor({ role: 'deployer', member: 'dep-1' }), { block: [], pushed: { ids: [], bytes: 0 } });
            assert.deepEqual(await inj.blockFor({ role: 'doer', member: 'doer-1' }), []);
            assert.deepEqual(inj.pushedIn('any prompt', 'dep-1'), { ids: [], bytes: 0 });
            assert.equal(logs.filter((l) => l.includes('[kb-inject]') && l.includes('non-fatal')).length, 2, logs.join('\n'));

            const pushed = [];
            const out = await withWrapperKbBlock('THE PROMPT', {
                kbInjection: inj, agentType: 'deployer', member: 'dep-1', onPushed: (p) => pushed.push(p),
            });
            assert.equal(out, 'THE PROMPT');
            assert.deepEqual(pushed, [{ ids: [], bytes: 0 }]);
        });
    }

    test('a throwing roleHints input (a bad hint value) costs only the block', async () => {
        const logs = [];
        const kbWork = { knowledgeFor: async () => ({ entries: [], source: 'prime' }) };
        const inj = createKbInjection({ kbWork, log: (m) => logs.push(m) });
        const bad = { get goals() { throw new Error('bad hint'); } };
        const out = await inj.blockWithInfoFor({ role: 'planner', member: 'plan-1', context: bad });
        assert.deepEqual(out, { block: [], pushed: { ids: [], bytes: 0 } });
    });

    test('a block that fails after an earlier success does not leave the old push attributed', async () => {
        let fail = false;
        const kbWork = { knowledgeFor: async () => { if (fail) throw new Error('boom'); return { entries: [entry('kb-one', 'First durable lesson')], source: 'query' }; } };
        const inj = createKbInjection({ kbWork });
        const [first] = await inj.blockFor({ role: 'doer', member: 'doer-1' });
        assert.deepEqual(inj.pushedIn(`p\n${first}`, 'doer-1').ids, ['kb-one']);
        fail = true;
        assert.deepEqual(await inj.blockFor({ role: 'doer', member: 'doer-1' }), []);
        assert.deepEqual(inj.pushedIn(`p\n${first}`, 'doer-1'), { ids: [], bytes: 0 });
    });

    for (const [name, opts] of [
        ['a kbInjection whose blockWithInfoFor throws', { kbInjection: { blockWithInfoFor: async () => { throw new Error('boom'); } } }],
        ['a kbInjection whose blockFor throws', { kbInjection: { blockFor: async () => { throw new Error('boom'); } } }],
        ['a fallbackBlock that throws', { kbInjection: null, fallbackBlock: () => { throw new Error('boom'); } }],
    ]) {
        test(`withWrapperKbBlock with ${name}: the prompt goes out unchanged and the failure is logged`, async () => {
            const logs = [];
            const out = await withWrapperKbBlock('THE PROMPT', { ...opts, agentType: 'deployer', member: 'dep-1', log: (m) => logs.push(m) });
            assert.equal(out, 'THE PROMPT');
            assert.ok(logs.some((l) => l.includes('[kb-inject]') && l.includes('boom')), logs.join('\n'));
        });
    }
});

describe('per-role KB hints (b4g.19.1)', () => {
    const ctx = {
        goals: ['Ship resolveZoneBinding fix'],
        beadTitles: [{ title: 'Stop collapsing unknown_zone into unbound_roi' }],
        closedBeadTitles: [{ title: 'Closed: retry transit ingest' }],
        laneFiles: ['src/zones/binding.ts'],
        diffFiles: ['src/diff/changed.mjs'],
        deployTargets: ['deploy/staging.yml'],
        testFiles: ['test/zones.test.mjs'],
        beadIds: ['apra-fleet-b4g.19.1'],
    };
    const expectations = {
        planner: { terms: ['resolveZoneBinding', 'unknown_zone'], modules: [] },
        'plan-reviewer': { terms: ['resolveZoneBinding', 'unknown_zone'], modules: [] },
        doer: { terms: ['unknown_zone', 'binding'], modules: ['src/zones/binding.ts'] },
        reviewer: { terms: ['unknown_zone', 'changed'], modules: ['src/diff/changed.mjs'] },
        deployer: { terms: ['staging', 'zones.test'], modules: ['deploy/staging.yml', 'test/zones.test.mjs'] },
        'integ-test-runner': { terms: ['staging', 'zones.test'], modules: ['deploy/staging.yml', 'test/zones.test.mjs'] },
        'regression-test-runner': { terms: ['staging', 'zones.test'], modules: ['deploy/staging.yml', 'test/zones.test.mjs'] },
        harvester: { terms: ['changed', 'retry'], modules: ['src/diff/changed.mjs'] },
    };
    for (const [role, want] of Object.entries(expectations)) {
        test(`${role}: prime/query hints carry that role's sources`, async () => {
            const h = roleHints(role, ctx);
            for (const t of want.terms) assert.ok(h.terms.includes(t), `${role} terms ${JSON.stringify(h.terms)} must include ${t}`);
            assert.deepEqual(h.hintModules, want.modules);
            // ...and the query/prime call actually carries them.
            const kb = fakeKb({ query: [] , prime: [entry('p1', 'primed')] });
            const inj = injection({ kb });
            const memberFor = { planner: 'plan-1', 'plan-reviewer': 'pr-1', doer: 'doer-1', reviewer: 'rev-1', deployer: 'dep-1', 'integ-test-runner': 'it-1', 'regression-test-runner': 'rt-1', harvester: 'hv-1' }[role];
            await inj.blockFor({ role, member: memberFor, context: ctx });
            const qs = kb.calls.filter((c) => c.name === 'kb_query');
            assert.ok(qs.length > 0, `${role}: kb_query issued`);
            // doer / reviewer ask one situation-phrased query per bead and file
            // (kb-hints.mjs situations); the other roles one joined-terms query.
            const queryText = qs.map((c) => c.args.query).join(' | ');
            for (const t of want.terms) assert.ok(queryText.includes(t), `${role}: queries ${queryText} carry ${t}`);
            if (want.modules.length) {
                const p = kb.calls.find((c) => c.name === 'kb_session_prime');
                assert.ok(p, `${role}: the hint-ranked prime runs when the query finds nothing`);
                assert.deepEqual(p.args.hint_modules, want.modules);
            }
        });
    }

    test('hint_symbols come from identifier-looking tokens in titles and goals', () => {
        assert.deepEqual(roleHints('planner', ctx).hintSymbols.sort(), ['resolveZoneBinding', 'unknown_zone', 'unbound_roi'].sort());
    });

    test('stopwords and tracker-id tokens are never sent as query terms', async () => {
        const terms = cleanQueryTerms(['Fix the apra-fleet-b4g.19.1 bug in bd-12 and PROJ-123 of kb-maintainer with 19.3'], { knownIds: ['custom-id'] });
        assert.deepEqual(terms, ['Fix', 'bug', 'kb-maintainer']);
        assert.equal(isTrackerIdToken('apra-fleet-b4g.18.3'), true);
        assert.equal(isTrackerIdToken('kb-maintainer'), false);
        assert.deepEqual(kbQueryTerms([{ title: 'The fix for apra-fleet-b4g' }], ['apra-fleet-b4g']), ['fix']);

        const kb = fakeKb({ query: [entry('c1', 'hit')] });
        await injection({ kb }).blockFor({
            role: 'doer', member: 'doer-1',
            context: { beadTitles: [{ title: 'Fix the apra-fleet-b4g.19.1 parser and a custom-id' }], beadIds: ['custom-id'] },
        });
        const asked = kb.calls.filter((c) => c.name === 'kb_query').map((c) => c.args.query).join(' | ');
        assert.ok(!/b4g|custom-id/.test(asked), `no tracker id in ${asked}`);
        assert.ok(asked.includes('parser'), asked);
    });
});

describe('KNOWLEDGE BANK block shape (b4g.19.2)', () => {
    test('never contains INFERRED, UNVERIFIED or disputed entries', () => {
        const [block] = kbKnowledgeBlock([
            entry('a', 'good'), entry('b', 'inferredx', 'INFERRED'), entry('c', 'unverifiedx', 'UNVERIFIED'),
            entry('d', 'flaggedx', 'CONFIRMED', { flagged_for_review: true }), entry('e', 'contraryx', 'CONFIRMED', { contradiction_of: 'a' }),
        ], { source: 'query' });
        assert.ok(block.includes('"good"'));
        for (const m of ['inferredx', 'unverifiedx', 'flaggedx', 'contraryx']) assert.ok(!block.includes(m), m);
    });

    test('at most 8 entries are injected', async () => {
        const many = Array.from({ length: 30 }, (_, i) => entry(`m${i}`, `entry number ${i}`));
        const kb = fakeKb({ query: many });
        const [block] = await injection({ kb }).blockFor({ role: 'doer', member: 'doer-1', context: { beadTitles: [{ title: 'anything useful' }] } });
        assert.equal((block.match(/"title":/g) || []).length, KB_MAX_KNOWLEDGE_ENTRIES);
        assert.equal(KB_MAX_KNOWLEDGE_ENTRIES, 8);
    });

    test('no relevant match: no entries and an explicit statement, never an arbitrary set', async () => {
        const kb = fakeKb({ query: [], prime: [] });
        const [block] = await injection({ kb }).blockFor({ role: 'doer', member: 'doer-1', context: { beadTitles: [{ title: 'obscure topic' }], laneFiles: ['src/a.mjs'] } });
        assert.match(block, /KNOWLEDGE BANK/);
        assert.match(block, /Nothing relevant was found/);
        assert.ok(!block.includes('"title":'));
    });

    test('the block names its real source: query or prime', async () => {
        const viaQuery = await injection({ kb: fakeKb({ query: [entry('q1', 'from query')] }) })
            .blockFor({ role: 'doer', member: 'doer-1', context: { beadTitles: [{ title: 'topic words' }] } });
        assert.match(viaQuery[0], /kb_query --top_entries/);
        const viaPrime = await injection({ kb: fakeKb({ query: [], prime: [entry('p1', 'from prime')] }) })
            .blockFor({ role: 'doer', member: 'doer-1', context: { beadTitles: [{ title: 'topic words' }], laneFiles: ['src/a.mjs'] } });
        assert.match(viaPrime[0], /kb_session_prime --top_entries/);
        assert.ok(!viaPrime[0].includes('kb_query --top_entries'));
    });
});

describe('push to every member, verified or not (b4g.18.3, 6agk.3.1)', () => {
    const ctx = { beadTitles: [{ title: 'gating topic' }] };
    const records = [
        { member: 'doer-1', verified: true },
        { member: 'rev-1', verified: false },
    ];
    const lookup = createMemberVerifiedLookup(() => records);

    test('a verified member, an unverified member and one with no init record all get the block', async () => {
        const kb = fakeKb({ query: [entry('c1', 'known thing')] });
        const inj = injection({ kb, verified: lookup });
        assert.equal(inj.shouldInject('doer-1'), true);
        assert.equal(inj.shouldInject('rev-1'), true);
        assert.equal(inj.isVerified('doer-1'), true, 'the verified lookup is still readable (logging only)');
        const verified = await inj.blockFor({ role: 'doer', member: 'doer-1', context: ctx });
        assert.equal(verified.length, 1);
        assert.match(verified[0], /KNOWLEDGE BANK/);
        assert.ok(verified[0].includes('known thing'));
        const unverified = await inj.blockFor({ role: 'reviewer', member: 'rev-1', context: ctx });
        assert.match(unverified[0], /KNOWLEDGE BANK/);
        const noRecord = await inj.blockFor({ role: 'doer', member: 'agy-1', context: ctx });
        assert.match(noRecord[0], /KNOWLEDGE BANK/);
    });

    test('block content arrives via memberCall on the repository kb_maintainer, never the dispatched member', async () => {
        const kb = fakeKb({ query: [entry('c1', 'known thing')] });
        const inj = injection({ kb, verified: lookup });
        await inj.blockFor({ role: 'reviewer', member: 'rev-1', context: ctx });
        await inj.blockFor({ role: 'doer', member: 'doer-1', context: ctx });
        assert.ok(kb.calls.length > 0);
        for (const c of kb.calls) assert.equal(c.member, 'maint', `${c.name} must run on the kb_maintainer`);
    });

    test('a doer prompt carries the block exactly once for a verified and an unverified member', async () => {
        const kb = fakeKb({ query: [entry('c1', 'known thing')] });
        const inj = injection({ kb, verified: lookup });
        const verifiedPrompt = buildDoerPrompt({ beadIds: ['x-1'], branch: 'b', feedback: null, kbBlock: await inj.blockFor({ role: 'doer', member: 'doer-1', context: ctx }) });
        const unverifiedPrompt = buildDoerPrompt({ beadIds: ['x-1'], branch: 'b', feedback: null, kbBlock: await inj.blockFor({ role: 'doer', member: 'rev-1', context: ctx }) });
        for (const p of [verifiedPrompt, unverifiedPrompt]) {
            assert.equal(p.split('KNOWLEDGE BANK -- what this repo already knows').length - 1, 1, 'block header appears exactly once');
            assert.ok(p.includes('known thing'));
        }
    });

    // The REAL init probe decides verified-ness: opencode / agy are unverified
    // although their MEMBER session lists the kb tools.
    for (const [provider, reason] of [['opencode', 'no-per-tool-deny'], ['agy', 'no-per-project-mcp']]) {
        test(`${provider} member: its MEMBER session lists the kb tools yet the prompt still gets the block`, async () => {
            const name = provider === 'opencode' ? 'oc-1' : 'agy-1';
            const callTool = async (tool, args) => {
                if (tool !== 'member_detail') throw new Error(`unexpected ${tool}`);
                const body = { id: `uuid-${args.member_name}`, type: 'local', llmProvider: provider, folder: `/w/${args.member_name}` };
                if (args.refresh) body.fleetMcp = { state: 'available', checkedAt: 'x' };
                return { content: [{ text: JSON.stringify(body) }] };
            };
            const memberCall = async (_m, tool) => {
                if (tool === 'kb_stats') return { content: [{ text: JSON.stringify({ totals: { by_confidence: { CONFIRMED: 1 } } }) }] };
                return { content: [{ text: JSON.stringify({ outcome: 'unavailable' }) }] };
            };
            const listTools = async () => ({ tools: [{ name: 'kb_query' }, { name: 'kb_stats' }, { name: 'code_query' }] });
            const probe = createMemberInitProbe({ members: [name], callTool, memberCall, listTools, resolveTarget: async () => ({ os: 'linux', shell: 'bash' }), log: () => {} });
            const probed = await probe.probeAll();
            assert.equal(probed[0].kbTools, true);
            assert.equal(probed[0].reason, reason);
            const isVerified = createMemberVerifiedLookup(() => probed);
            assert.equal(isVerified(name), false);

            const kb = fakeKb({ query: [entry('c1', 'known thing')] });
            const [block] = await injection({ kb, verified: isVerified }).blockFor({ role: 'doer', member: name, context: ctx });
            assert.match(block, /KNOWLEDGE BANK/);
            assert.ok(block.includes('known thing'));
        });
    }

    test('revert check: the verified lookup never suppresses the block', async () => {
        // A gate that skips verified members (the pre-push rule) would make
        // verifiedBlock empty here.
        for (const verifiedFn of [lookup, () => true, () => false]) {
            const inj = injection({ kb: fakeKb({ query: [entry('c1', 'known thing')] }), verified: verifiedFn });
            assert.equal((await inj.blockFor({ role: 'doer', member: 'doer-1', context: ctx })).length, 1);
            assert.equal((await inj.blockFor({ role: 'doer', member: 'rev-1', context: ctx })).length, 1);
        }
    });
});

describe('engine-supplied hint sources and priority-tier goals (b4g.19.1)', () => {
    test('priority-tier goal tokens (P2, P1/P2/P3) are never query terms', () => {
        assert.ok(isPriorityTierToken('P1/P2/P3') && isPriorityTierToken('p2') && !isPriorityTierToken('P2p'));
        const h = roleHints('planner', { goals: ['P1/P2/P3'], beadTitles: ['Fix the parser'] });
        assert.deepEqual(h.terms, ['Fix', 'parser']);
    });

    test('deployer dispatch: deploy targets read by the engine reach kb_query and kb_session_prime', async () => {
        const kb = fakeKb({ query: [], prime: [entry('p1', 'primed')] });
        const seen = [];
        const inj = injection({ kb, deployTargets: async (m, role) => { seen.push([m, role]); return ['deploy/staging.yml']; } });
        await inj.blockFor({ role: 'deployer', member: 'dep-1', context: { beadTitles: ['Ship it'] } });
        assert.deepEqual(seen, [['dep-1', 'deployer']]);
        assert.ok(kb.calls.find((c) => c.name === 'kb_query').args.query.split(' ').includes('staging'));
        assert.deepEqual(kb.calls.find((c) => c.name === 'kb_session_prime').args.hint_modules, ['deploy/staging.yml']);
    });

    test('harvester dispatch: sprint closed bead titles and the engine diff files reach kb_query', async () => {
        const kb = fakeKb({ query: [entry('q1', 'hit')] });
        const inj = injection({ kb, diffFiles: async () => ['src/diff/changed.mjs'] });
        await inj.blockFor({ role: 'harvester', member: 'hv-1', context: { closedBeadTitles: ['Retry transit ingest'] } });
        const terms = kb.calls.find((c) => c.name === 'kb_query').args.query.split(' ');
        for (const t of ['changed', 'Retry', 'transit']) assert.ok(terms.includes(t), `${terms} carries ${t}`);
    });

    test('runner wires closedBeadTitles, deployTargets and the priority guard into the engine', () => {
        const src = fs.readFileSync(new URL('../fleet-sprint/runner.js', import.meta.url), 'utf8');
        assert.match(src, /kbSprintContext\.closedBeadTitles = sprintTasks\.filter\(\(t\) => t && t\.status === 'closed'/);
        assert.match(src, /createKbInjection\(\{[\s\S]*?deployTargets: async \(memberName, role\)/);
        assert.match(src, /!isPriorityTierToken\(validated\.goal\.trim\(\)\)/);
    });
});
