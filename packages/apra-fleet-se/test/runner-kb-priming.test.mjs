import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbPrimingClient,
    createKbWorkClient,
    vetKbWork,
    kbKnowledgeBlock,
    buildDoerPrompt,
    buildReviewerPrompt,
} from '../fleet-sprint/runner.js';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// apra-fleet-e28 / KB trust pipeline Phase 2: the fleet-sprint engine had no KB
// priming -- it lived only in the Claude workflow copy.
//
// The property that matters most here is NEGATIVE: this engine has no repo of
// its own, and a kb_* call operates on the CALLING SESSION's own KB. Priming
// through the orchestrator's own session would read whichever repo the fleet
// server sits in -- the apra-fleet-tm7 / apra-fleet-3zl repo-blindness defect.
// So every kb_* call runs AS the member (memberCall: a member-scoped session),
// carries no repo/scope argument, and a member that cannot be resolved to a
// member record is SKIPPED, never primed blind.

/**
 * The engine's two transports, backed by ONE fake: member_detail goes through
 * the orchestrator's callTool; every kb_* call goes through memberCall AS a
 * member. Each recorded call notes the member it ran as (null for callTool).
 */
function fleet(fake) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => { calls.push({ name, args, member: null }); return fake(name, args, null); },
        memberCall: async (member, name, args) => { calls.push({ name, args, member }); return fake(name, args, member); },
    };
}

/** member_detail's json answer for a member: its id, type and work folder. */
function detailFor(name, folder, extra = {}) {
    return { id: `id-${name}`, type: 'local', folder, ...extra };
}

function makeCallTool(folders, opts = {}) {
    return fleet(async (name, args) => {
        if (name === 'member_detail') {
            if (opts.throwOnDetail) throw new Error('transport exploded');
            const folder = folders[args.member_name];
            return folder === undefined ? {} : detailFor(args.member_name, folder);
        }
        if (name === 'kb_session_prime') {
            if (opts.throwOnPrime) throw new Error('kb unavailable');
            return { top_entries: [] };
        }
        return {};
    });
}

const SCOPE_FIELDS = ['repo', 'repo_path', 'repo_remote_url'];

function assertNoScopeArgs(call) {
    for (const field of SCOPE_FIELDS) {
        assert.equal(call.args[field], undefined, `${call.name} must not carry ${field} -- the member session is the scope`);
    }
}

describe('createKbPrimingClient (apra-fleet-e28)', () => {
    test('primes each member AS that member -- its own session, its own KB', async () => {
        const { calls, callTool, memberCall } = makeCallTool({ alpha: '/srv/alpha/repo', beta: '/srv/beta/repo' });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 2);
        const primes = calls.filter((c) => c.name === 'kb_session_prime');
        assert.deepEqual(primes.map((c) => c.member && c.member.id), ['id-alpha', 'id-beta']);
        assert.deepEqual(client.memberOf('alpha'), { id: 'id-alpha', name: 'alpha', type: 'local' });
        assert.equal(client.folderOf('alpha'), '/srv/alpha/repo');
    });

    test('NEVER primes through the orchestrator session, and never passes a scope argument', async () => {
        const { calls, callTool, memberCall } = makeCallTool({ alpha: '/srv/alpha/repo' });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        await client.primeAll();

        const kbCalls = calls.filter((c) => c.name.startsWith('kb_'));
        assert.ok(kbCalls.length > 0);
        for (const c of kbCalls) {
            assert.ok(c.member, `${c.name} through the orchestrator session would read the fleet server's own KB`);
            assertNoScopeArgs(c);
        }
    });

    test('skips a member that cannot be resolved rather than priming blind', async () => {
        const { calls, callTool, memberCall } = makeCallTool({ alpha: '/srv/alpha/repo' }); // beta has none
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.equal(result.skipped, 1);
        const primes = calls.filter((c) => c.name === 'kb_session_prime');
        assert.equal(primes.length, 1);
        assert.equal(primes[0].member.name, 'alpha');
        assert.equal(client.memberOf('beta'), null);
    });

    test('parses a member_detail result delivered as MCP content text', async () => {
        const { calls, callTool, memberCall } = fleet(async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify(detailFor(args.member_name, '/srv/wrapped/repo')) }] };
            }
            return {};
        });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.equal(calls.find((c) => c.name === 'kb_session_prime').member.id, 'id-alpha');
    });

    // apra-fleet-n78: member_detail's `format` defaults to 'compact'
    // (src/tools/member-detail.ts), and the compact renderer emits no id or
    // folder -- they are set only on the json path. So the client has to ask
    // for json explicitly, or it resolves nothing for every member and the KB
    // is never primed for anyone.
    test('asks member_detail for json -- compact carries no id or folder', async () => {
        const { calls, callTool, memberCall } = fleet(async (name, args) => {
            if (name === 'member_detail') {
                // Mirror the real tool: compact is prose, and has no id/folder in it.
                return args.format === 'json'
                    ? { content: [{ text: JSON.stringify(detailFor(args.member_name, '/srv/alpha/repo')) }] }
                    : { content: [{ text: 'alpha (local) | online | os=linux | cli=2.1.223' }] };
            }
            return {};
        });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(calls.find((c) => c.name === 'member_detail').args.format, 'json',
            'without format:json the compact text has no id and every member is skipped');
        assert.equal(result.primed, 1);
        assert.equal(result.skipped, 0);
        assert.equal(calls.find((c) => c.name === 'kb_session_prime').member.id, 'id-alpha');
    });

    test('is a no-op when callTool is absent (direct runSprintCycle/main test calls)', async () => {
        const { memberCall } = makeCallTool({});
        const client = createKbPrimingClient({ memberCall, members: ['alpha'], log: () => {} });
        const result = await client.primeAll();
        assert.deepEqual(result, { primed: 0, skipped: 1 });
    });

    test('is a no-op when memberCall is absent -- never falls back to the orchestrator session', async () => {
        const { calls, callTool } = makeCallTool({ alpha: '/srv/alpha/repo' });
        const client = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.deepEqual(result, { primed: 0, skipped: 1 });
        assert.equal(calls.filter((c) => c.name.startsWith('kb_')).length, 0);
    });

    test('is a no-op when there are no members', async () => {
        const { calls, callTool, memberCall } = makeCallTool({});
        const client = createKbPrimingClient({ callTool, memberCall, members: [], log: () => {} });

        const result = await client.primeAll();

        assert.deepEqual(result, { primed: 0, skipped: 0 });
        assert.deepEqual(calls, []);
    });

    test('a failing prime is non-fatal and does not stop later members', async () => {
        const { callTool, memberCall } = makeCallTool({ alpha: '/a', beta: '/b' }, { throwOnPrime: true });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 0);
        assert.equal(result.skipped, 2);
    });

    test('a failing member_detail is non-fatal', async () => {
        const { calls, callTool, memberCall } = makeCallTool({ alpha: '/a' }, { throwOnDetail: true });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.skipped, 1);
        assert.equal(calls.filter((c) => c.name === 'kb_session_prime').length, 0);
    });
});

// --- The READ half: priming must reach the agent, not just the database ---
//
// apra-fleet KB audit 2026-08-11: across six sprint batches, 77 entries were
// captured and 53 promoted, and not one was ever read back to inform work.
// Two independent causes, both fixed here:
//
//  1. Role subagents dispatched to a fleet member have the fleet MCP server
//     DISABLED (src/providers/claude.ts composePermissionConfig writes
//     mcpServers:{'apra-fleet':{disabled:true}}), so Step 0's
//     "call kb_session_prime" is dead prose on every member dispatch. This is
//     the SAME defect that made kb_promotions structurally empty -- and it has
//     the same fix: the engine reads, and hands the result to the role in its
//     prompt. Judgment belongs to the role, execution belongs here.
//  2. primeAll() discarded prime's return value entirely, so even a warm KB
//     reached nobody.

/** A primed KB entry, shared by the read-half and work-half suites below. */
const ENTRY = {
    id: 'abc123',
    title: 'resolveZoneBinding returns a discriminated union',
    summary: 'It does not collapse unknown-zone and unbound-ROI.',
    confidence: 'CONFIRMED',
    source_files: ['server/transit.service.ts'],
};

describe('KB priming reaches the agent (audit 2026-08-11)', () => {
    function primingCallTool(topEntries) {
        return fleet(async (name, args) => {
            if (name === 'member_detail') return detailFor(args.member_name, '/srv/alpha/repo');
            if (name === 'kb_session_prime') {
                return { content: [{ text: JSON.stringify({ top_entries: topEntries }) }] };
            }
            return {};
        });
    }

    test('primeAll retains the primed entries per member instead of discarding them', async () => {
        const { callTool, memberCall } = primingCallTool([ENTRY]);
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        await client.primeAll();

        assert.deepEqual(client.knowledgeOf('alpha').map((e) => e.id), ['abc123']);
    });

    test('knowledgeOf is [] for a member that was never primed', async () => {
        const { callTool, memberCall } = primingCallTool([ENTRY]);
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        await client.primeAll();

        assert.deepEqual(client.knowledgeOf('beta'), []);
    });

    test('an unparseable prime result degrades to no knowledge, never throws', async () => {
        const { callTool, memberCall } = fleet(async (name, args) => {
            if (name === 'member_detail') return detailFor(args.member_name, '/srv/alpha/repo');
            if (name === 'kb_session_prime') return { content: [{ text: 'not json' }] };
            return {};
        });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.deepEqual(client.knowledgeOf('alpha'), []);
    });

    // KB audit follow-up: the cold-seed in kb_session_prime is capped at 5
    // entries and reads the bible as a FILE, so bible knowledge never becomes
    // searchable rows. apra-fleet's own bible holds 17 CONFIRMED entries and a
    // sprint could reach at most 5 arbitrary ones, with FTS unable to rank
    // them. kb_import lands the whole bible in the warm KB first, which is what
    // gives the per-dispatch kb_query anything to match against.
    test('primeAll imports the bible before priming, so the whole bible is searchable', async () => {
        const { calls, callTool, memberCall } = primingCallTool([ENTRY]);
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        await client.primeAll();

        const names = calls.map((c) => c.name);
        assert.ok(names.includes('kb_import'), 'the bible must reach the warm KB, not just the cold-seed');
        assert.ok(
            names.indexOf('kb_import') < names.indexOf('kb_session_prime'),
            'importing AFTER priming would leave the very prime it was meant to feed cold',
        );
        // The member session imports its OWN folder's bible: no path, no scope.
        const imp = calls.find((c) => c.name === 'kb_import');
        assert.equal(imp.member.id, 'id-alpha');
        assert.equal(imp.args.path, undefined);
        assertNoScopeArgs(imp);
    });

    // KB audit 2026-08-12, found by a live sprint: kb_import's post-import
    // freshnessSweep re-judges the WHOLE KB against the member's worktree. At
    // sprint start that staled 16 of 17 CONFIRMED entries simply because the
    // repo had moved on since capture -- which degraded retrieval, made
    // kb_export attempt a 17 -> 9 truncation, and emptied the reviewer's
    // promotion candidates (kb_list filters stale=0), reintroducing
    // apra-fleet-0ef. The engine imports to WARM the KB, never to audit it.
    test('primeAll imports with skip_sweep -- warming the KB must not re-judge it', async () => {
        const { calls, callTool, memberCall } = primingCallTool([ENTRY]);
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        await client.primeAll();

        const imp = calls.find((c) => c.name === 'kb_import');
        assert.equal(imp.args.skip_sweep, true,
            'without skip_sweep the sprint-start import mass-stales the KB it is meant to warm');
    });

    test('a failing kb_import is non-fatal -- priming still runs', async () => {
        const { callTool, memberCall } = fleet(async (name, args) => {
            if (name === 'member_detail') return detailFor(args.member_name, '/srv/alpha/repo');
            if (name === 'kb_import') throw new Error('no bible here');
            if (name === 'kb_session_prime') return { content: [{ text: JSON.stringify({ top_entries: [ENTRY] }) }] };
            return {};
        });
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.deepEqual(client.knowledgeOf('alpha').map((e) => e.id), ['abc123']);
    });

    test('kbKnowledgeBlock is empty for no entries -- a cold KB adds nothing to the prompt', () => {
        assert.deepEqual(kbKnowledgeBlock([]), []);
        assert.deepEqual(kbKnowledgeBlock(undefined), []);
    });

    // Only CONFIRMED entries are injected (kb-inject-confirmed-only.test.mjs), so
    // the block states that rule instead of the old CONFIRMED/INFERRED ladder.
    test('kbKnowledgeBlock states the CONFIRMED-only rule and wraps the entries as untrusted', () => {
        const [block] = kbKnowledgeBlock([ENTRY, { ...ENTRY, id: 'def456', title: 'an inferred claim', confidence: 'INFERRED' }]);

        assert.match(block, /KNOWLEDGE BANK/);
        assert.match(block, /Only CONFIRMED entries are included/);
        assert.doesNotMatch(block, /INFERRED/);
        assert.ok(!block.includes('an inferred claim'), 'an INFERRED entry is not rendered');
        assert.ok(block.includes('resolveZoneBinding returns a discriminated union'));
        // The entries are agent-authored text from a prior sprint: they must
        // arrive labelled as data, exactly like the promotion-candidate block.
        assert.match(block, /BEGIN UNTRUSTED|untrusted/i);
    });

    test('the doer prompt carries the knowledge block', () => {
        const prompt = buildDoerPrompt({
            beadIds: ['x-1'],
            branch: 'feat/x',
            feedback: null,
            kbKnowledge: [ENTRY],
        });

        assert.match(prompt, /KNOWLEDGE BANK/);
        assert.ok(prompt.includes('resolveZoneBinding returns a discriminated union'));
    });

    test('the doer prompt is unchanged when there is no knowledge to inject', () => {
        const withNone = buildDoerPrompt({ beadIds: ['x-1'], branch: 'feat/x', feedback: null, kbKnowledge: [] });
        const legacy = buildDoerPrompt({ beadIds: ['x-1'], branch: 'feat/x', feedback: null });

        assert.equal(withNone, legacy);
        assert.doesNotMatch(withNone, /KNOWLEDGE BANK/);
    });

    test('the reviewer prompt carries the knowledge block alongside promotion candidates', () => {
        const prompt = buildReviewerPrompt({
            beadIds: ['x-1'],
            acceptanceCriteriaJson: '{}',
            baseBranch: 'main',
            branch: 'feat/x',
            kbKnowledge: [ENTRY],
            kbCandidates: [{ id: 'cand1', title: 'A candidate', summary: 's', source_files: ['a.ts'] }],
        });

        assert.match(prompt, /KNOWLEDGE BANK -- what this repo already knows/);
        assert.match(prompt, /KNOWLEDGE BANK -- promotion candidates/);
    });
});

// --- The execution half: the engine makes the calls, the role only decides ---

const GOOD_CAPTURE = {
    type: 'knowledge',
    title: 'getKbProviders is the only KB accessor',
    summary: 'Every kb_* tool routes through getKbProviders so the KB is repo-scoped.',
    content: 'getKbProviders(repo_path) resolves the per-repo sqlite store; every kb_* tool goes through it.',
    source_files: ['src/services/knowledge/kb-providers.ts'],
    symbols: ['getKbProviders'],
};
const GOOD_REASON = 'Verified against src/services/knowledge/kb-providers.ts: cache is keyed per slug.';

/** The member records kb work runs as (what createKbPrimingClient.memberOf returns). */
const ALPHA = Object.freeze({ id: 'id-alpha', name: 'alpha', type: 'local' });

function recorder() {
    const calls = [];
    return { calls, memberCall: async (member, name, args) => { calls.push({ name, args, member }); return {}; } };
}

// A tool call can RESOLVE with {isError:true} for a tool-level failure -- it
// does not throw. A recorder that only ever returns {} cannot see that, which is
// why the apra-fleet-23c phantom-success bug was invisible to these tests.
function errorRecorder(message) {
    const calls = [];
    return {
        calls,
        memberCall: async (member, name, args) => {
            calls.push({ name, args, member });
            return { isError: true, content: [{ type: 'text', text: message }] };
        },
    };
}

describe('createKbWorkClient (KB trust pipeline Phase 2, fleet-sprint half)', () => {
    test('a vetted capture becomes a real kb_capture call, run AS the member', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('doer', ALPHA, { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 1);
        const capture = calls.find((c) => c.name === 'kb_capture');
        assert.equal(capture.member, ALPHA);
        assert.equal(capture.args.repo_path, undefined, 'the member session is the scope');
        assert.equal(capture.args.title, GOOD_CAPTURE.title);
    });

    test('a reviewer promotion becomes a real kb_promote call', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('reviewer', ALPHA, {
            kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
        });

        assert.equal(out.promoted, 1);
        // apra-fleet-0ef: the promotion MUST run as the same member as the
        // capture. Run in any other session it resolves a different project's
        // KB and can only ever fail "Entry not found".
        const promote = calls.find((c) => c.name === 'kb_promote');
        assert.equal(promote.member, ALPHA);
        assert.deepEqual(promote.args, { id: 'abc123', reason: GOOD_REASON });
    });

    // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)), but
    // vetKbWork built its capture object from type/title/summary/source_files/symbols
    // only. Every kb_capture the sprint engine sent therefore failed zod validation
    // at the MCP boundary and persisted nothing, while the engine logged success.
    test('a capture carries content through -- kb_capture requires it', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('doer', ALPHA, { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 1);
        const capture = calls.find((c) => c.name === 'kb_capture');
        assert.equal(capture.args.content, GOOD_CAPTURE.content,
            'content is required by kbCaptureSchema; dropping it makes every capture a no-op');
    });

    test('a capture with no content is refused rather than sent to fail server-side', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });
        const { content, ...noContent } = GOOD_CAPTURE;

        const out = await client.apply('doer', ALPHA, { kb_captures: [noContent] });

        assert.equal(out.captured, 0);
        assert.equal(calls.filter((c) => c.name === 'kb_capture').length, 0);
        assert.equal(out.refused, 1);
    });

    // apra-fleet-23c, second half: an MCP error result resolves, so `captured++` ran
    // on calls that wrote nothing and the run reported "captured 3, promoted 0".
    test('an MCP isError result counts as a failure, not a capture', async () => {
        const logs = [];
        const { calls, memberCall } = errorRecorder('kb capture rejected: an entry must cite at least one source file');
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: (m) => logs.push(m) });

        const out = await client.apply('doer', ALPHA, { kb_captures: [GOOD_CAPTURE] });

        assert.equal(calls.length, 1, 'the call is still attempted');
        assert.equal(out.captured, 0, 'a tool-level error must not be counted as a successful capture');
        assert.equal(logs.length, 1, 'the rejection must be logged, not silently swallowed');
        assert.match(logs[0], /^\[kb-work\] kb_capture rejected for "getKbProviders is the only KB accessor" \(non-fatal\): kb capture rejected: an entry must cite at least one source file$/);
    });

    test('an MCP isError result on kb_promote is not counted as promoted', async () => {
        const { memberCall } = errorRecorder('no such entry');
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('reviewer', ALPHA, {
            kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
        });

        assert.equal(out.promoted, 0);
    });

    test('an unverifiable payload results in NO tool call', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('doer', ALPHA, {
            kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }],
        });

        assert.equal(out.captured, 0);
        assert.equal(calls.length, 0);
    });

    test('kb_promotions from a non-reviewer role results in NO promote call', async () => {
        for (const role of ['doer', 'planner', 'harvester']) {
            const { calls, memberCall } = recorder();
            const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

            const out = await client.apply(role, ALPHA, {
                kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
            });

            assert.equal(out.promoted, 0, `${role} must not promote`);
            assert.equal(calls.filter((c) => c.name === 'kb_promote').length, 0);
        }
    });

    test('without a resolved member nothing is captured -- never another session', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('doer', null, { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 0);
        assert.equal(calls.length, 0);
    });

    test('a failing kb_capture is non-fatal and later entries still run', async () => {
        let n = 0;
        const memberCall = async (member, name) => {
            if (name === 'kb_capture' && n++ === 0) throw new Error('rejected');
            return {};
        };
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.apply('doer', ALPHA, {
            kb_captures: [GOOD_CAPTURE, { ...GOOD_CAPTURE, title: 'A second durable claim' }],
        });

        assert.equal(out.captured, 1);
    });

    // KB audit 2026-08-11: of 17 checked repositories on the operator's machine,
    // exactly ONE had a .fleet/kb-canonical.json -- because nothing in the
    // sprint pipeline has ever called kb_export. A bible existed only where a
    // human ran the tool by hand, so promoted CONFIRMED knowledge stayed on the
    // machine that learned it and never reached a teammate or a fresh clone
    // (and the cold-seed in kb_session_prime had nothing to read).
    // KB audit follow-up: one hint-less prime per member at sprint start gave
    // every role the same handful of entries regardless of what it was working
    // on, and left kb_query unused by the engine entirely. This is the
    // per-dispatch, relevance-ranked read -- and the only path on which the
    // KB's refines/contradiction_of edges are ever traversed.
    test('relevantKnowledge queries the KB with the dispatch terms and expands the graph', async () => {
        const calls = [];
        const memberCall = async (member, name, args) => {
            calls.push({ name, args, member });
            return { content: [{ text: JSON.stringify({ l1_results: [ENTRY], related_claims: [] }) }] };
        };
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.relevantKnowledge(ALPHA, ['resolveZoneBinding', 'transit ingest']);

        assert.deepEqual(out.map((e) => e.id), ['abc123']);
        const q = calls.find((c) => c.name === 'kb_query');
        assert.equal(q.member, ALPHA);
        assert.equal(q.args.repo_path, undefined);
        assert.equal(q.args.expand_related, true, 'without this the edges stay unread');
        assert.match(q.args.query, /resolveZoneBinding/);
        assert.match(q.args.query, /transit ingest/);
    });

    test('relevantKnowledge appends related claims below the direct hits', async () => {
        const related = { id: 'zzz999', title: 'A newer framing of the above', summary: 'x', confidence: 'CONFIRMED' };
        const memberCall = async () => ({
            content: [{ text: JSON.stringify({ l1_results: [ENTRY], related_claims: [related] }) }],
        });
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const out = await client.relevantKnowledge(ALPHA, ['anything']);

        assert.deepEqual(out.map((e) => e.id), ['abc123', 'zzz999']);
        assert.equal(out[1].via, 'kb-graph', 'a related claim must be distinguishable from a direct hit');
    });

    test('relevantKnowledge without a member or terms makes NO call', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        assert.deepEqual(await client.relevantKnowledge(null, ['x']), []);
        assert.deepEqual(await client.relevantKnowledge(ALPHA, []), []);
        assert.equal(calls.length, 0);
    });

    test('a failing kb_query degrades to no knowledge, never throws', async () => {
        const logs = [];
        const client = createKbWorkClient({
            maintainers: selfMaintainer(ALPHA),
            memberCall: async () => { throw new Error('kb down'); },
            log: (m) => logs.push(m),
        });

        assert.deepEqual(await client.relevantKnowledge(ALPHA, ['x']), []);
        assert.equal(logs.length, 1, 'the failure must be logged, not silently swallowed');
        assert.match(logs[0], /^\[kb-work\] kb_query failed for alpha \(non-fatal\): kb down$/);
    });

    // apra-fleet-3swo.4.4 rework: this was the one uncovered cell of the
    // "throwing and rejecting memberCall for both kb_query and kb_capture"
    // criterion -- kb_capture's rejecting path is covered above ("an MCP
    // isError result counts as a failure, not a capture"), but relevantKnowledge
    // (kb_query) had only ever been exercised with a THROWING call, never a
    // RESOLVING-with-isError one. The call is still attempted and the dispatch
    // still completes with no knowledge, matching the non-fatal contract every
    // other kb_* site here already proves.
    test('a rejecting kb_query degrades to no knowledge, never throws', async () => {
        const { calls, memberCall } = errorRecorder('kb query rejected: cold store');
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        assert.deepEqual(await client.relevantKnowledge(ALPHA, ['x']), []);
        assert.equal(calls.length, 1, 'the call is still attempted');
    });

    // apra-fleet-3swo.16: kb_query is the one kb_* failure path that logged
    // nothing for an isError envelope -- parseResult() returns null for it, so
    // the code took the `if (!parsed) return [];` branch and never reached the
    // catch that every other kb_* site here uses to report a rejection. A cold
    // or misconfigured KB must degrade VISIBLY, matching the wording of the
    // kb_capture/kb_promote/kb_export rejected branches.
    test('a rejecting kb_query logs the rejection, non-fatal, matching every other kb_* site', async () => {
        const logs = [];
        const { memberCall } = errorRecorder('kb query rejected: cold store');
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: (m) => logs.push(m) });

        assert.deepEqual(await client.relevantKnowledge(ALPHA, ['x']), []);
        assert.equal(logs.length, 1, 'the rejection must be logged, not silently swallowed');
        assert.match(logs[0], /^\[kb-work\] kb_query rejected for alpha \(non-fatal\): kb query rejected: cold store$/);
    });

    test('exportBible writes the canonical bible AS the member it is given', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const ok = await client.exportBible(ALPHA);

        assert.equal(ok, true);
        const exportCall = calls.find((c) => c.name === 'kb_export');
        assert.equal(exportCall.member, ALPHA);
        assert.deepEqual(exportCall.args, {});
    });

    test('exportBible without a member makes NO call -- never another session', async () => {
        const { calls, memberCall } = recorder();
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        const ok = await client.exportBible(null);

        assert.equal(ok, false);
        assert.equal(calls.filter((c) => c.name === 'kb_export').length, 0);
    });

    test('a failing kb_export is non-fatal -- a sprint never fails over the bible', async () => {
        const { memberCall } = errorRecorder('export blew up');
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(ALPHA), log: () => {} });

        assert.equal(await client.exportBible(ALPHA), false);

        const throwing = createKbWorkClient({
            memberCall: async () => { throw new Error('transport exploded'); },
            log: () => {},
        });
        assert.equal(await throwing.exportBible(ALPHA), false);
    });

    test('vetKbWork here agrees with apra-pm lib/vet-kb-work.mjs on the reviewer-only rule', () => {
        assert.deepEqual(vetKbWork('doer', { kb_promotions: [{ id: 'x', reason: GOOD_REASON }] }).promotions, []);
        assert.equal(vetKbWork('reviewer', { kb_promotions: [{ id: 'x', reason: GOOD_REASON }] }).promotions.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Member KB scoping inside a sprint: the member session IS the scope.
//
// Every kb_* call this engine makes used to carry repo_path (and, for a remote
// member, repo_remote_url), because the fleet server could only guess which
// project KB a call meant from those arguments -- and for a remote member's
// path on another host it guessed 'default'. No kb_* tool takes a scope
// argument any more: a MEMBER session resolves that member's registered work
// folder (and, for a remote member, its own origin). So the engine's job is to
// run each kb_* call AS the right member, through memberCall, and to send no
// scope argument at all. These tests pin that for every kb_* site, for a local
// and a remote member alike.
// ---------------------------------------------------------------------------

const REMOTE_FOLDER = 'C:\\work\\widget';

describe('kb calls run AS the member -- no scope argument anywhere', () => {
    function sprintFleet(opts = {}) {
        return fleet(async (name, args) => {
            if (name === 'member_detail') {
                if (args.member_name === 'remote-1') {
                    return { content: [{ text: JSON.stringify(detailFor('remote-1', REMOTE_FOLDER, { type: 'remote' })) }] };
                }
                return { content: [{ text: JSON.stringify(detailFor(args.member_name, `/srv/${args.member_name}/repo`)) }] };
            }
            if (name === 'kb_session_prime') return { top_entries: [] };
            if (name === 'kb_list') return { results: opts.candidates ?? [] };
            if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: [], related_claims: [] }) }] };
            return {};
        });
    }

    test('a remote member is primed through its own member session, type and all', async () => {
        const { calls, callTool, memberCall } = sprintFleet();
        const client = createKbPrimingClient({ callTool, memberCall, members: ['remote-1'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.deepEqual(client.memberOf('remote-1'), { id: 'id-remote-1', name: 'remote-1', type: 'remote' });
        for (const c of calls.filter((c) => c.name.startsWith('kb_'))) {
            assert.deepEqual(c.member, { id: 'id-remote-1', name: 'remote-1', type: 'remote' });
            assertNoScopeArgs(c);
        }
    });

    test('two members are primed in two sessions -- one member never reads the other KB', async () => {
        const { calls, callTool, memberCall } = sprintFleet();
        const client = createKbPrimingClient({ callTool, memberCall, members: ['alpha', 'remote-1'], log: () => {} });

        await client.primeAll();

        const primes = calls.filter((c) => c.name === 'kb_session_prime');
        assert.deepEqual(primes.map((c) => c.member.id), ['id-alpha', 'id-remote-1']);
    });

    test('every work-client kb_* site runs as the member it is given, with no scope argument', async () => {
        const { calls, callTool, memberCall } = sprintFleet({ candidates: [] });
        const priming = createKbPrimingClient({ callTool, memberCall, members: ['remote-1'], log: () => {} });
        await priming.primeAll();
        const remote = priming.memberOf('remote-1');
        // The member is its repository's kb_maintainer, so the writes route
        // back to it -- through the maintainer queue, not the producer.
        const client = createKbWorkClient({ memberCall, maintainers: selfMaintainer(remote), log: () => {} });

        await client.promotionCandidates(remote);
        await client.relevantKnowledge(remote, ['resolveZoneBinding']);
        const out = await client.apply('reviewer', remote, {
            kb_captures: [GOOD_CAPTURE],
            kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
        });
        await client.exportBible(remote);

        assert.equal(out.captured, 1);
        assert.equal(out.promoted, 1);
        const workCalls = calls.filter((c) => ['kb_list', 'kb_query', 'kb_capture', 'kb_promote', 'kb_export'].includes(c.name));
        assert.deepEqual(workCalls.map((c) => c.name), ['kb_list', 'kb_query', 'kb_capture', 'kb_promote', 'kb_export']);
        for (const c of workCalls) {
            assert.equal(c.member, remote, `${c.name} must run as the member whose repo it is about`);
            assertNoScopeArgs(c);
        }
    });

    test('the explicit confidence lists survive the move: kb_list INFERRED, kb_query CONFIRMED', async () => {
        const { calls, memberCall } = sprintFleet({ candidates: [] });
        const client = createKbWorkClient({ memberCall, log: () => {} });

        await client.promotionCandidates(ALPHA);
        await client.relevantKnowledge(ALPHA, ['x']);

        assert.deepEqual(calls.find((c) => c.name === 'kb_list').args.confidence, ['INFERRED']);
        assert.deepEqual(calls.find((c) => c.name === 'kb_query').args.confidence, ['CONFIRMED']);
    });

    test('no memberCall injected means no kb work at all -- never the orchestrator session', async () => {
        const client = createKbWorkClient({ log: () => {} });

        assert.deepEqual(await client.promotionCandidates(ALPHA), []);
        assert.deepEqual(await client.relevantKnowledge(ALPHA, ['x']), []);
        assert.deepEqual(await client.apply('doer', ALPHA, { kb_captures: [GOOD_CAPTURE] }), { captured: 0, promoted: 0, discarded: 0, refused: 0 });
        assert.equal(await client.exportBible(ALPHA), false);
    });
});
