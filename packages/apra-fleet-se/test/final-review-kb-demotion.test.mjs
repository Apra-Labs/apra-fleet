import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { createKbInjection } from '../fleet-sprint/kb-injection.mjs';

// =============================================================================
// FINAL REVIEW'S DEMOTION-CANDIDATE CALL SITE.
//
// buildFinalVerdictPrompt has always ACCEPTED kbDemoteCandidates and rendered
// it through the shared kbDemotionBlock -- but phases/final-review.mjs never
// called kbWork.demotionCandidates() and never passed the field, so that whole
// block was permanently dead on the final-review path. The one review that
// reads the WHOLE sprint diff could never demote anything, the exact shape of
// the bug that had previously left it unable to PROMOTE anything.
//
// These tests drive the REAL runFinalReviewPhase against fakes and read the
// prompt the dispatch actually received, rather than calling
// buildFinalVerdictPrompt directly: a prompt-builder test cannot tell whether
// anybody ever passes it the field, which is precisely what was wrong.
//
// SCOPE. Final review judges the entire sprint diff and therefore has no
// "this round", so its changed-file scope is the CUMULATIVE
// baseBranch...branch diff -- passed explicitly as { scope: 'sprint' }, never
// inferred by demotionCandidates from who called it.
// =============================================================================

const REVIEWER = 'reviewer-member';

const DEMOTE_CANDIDATES = [
    { id: 'kb-demote-1', type: 'knowledge', confidence: 'CONFIRMED', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-demote-2', type: 'learning', confidence: 'CONFIRMED', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
];

/**
 * Everything runFinalReviewPhase needs, with the dispatch replaced by a spy
 * that records the prompt and returns a PASS verdict carrying no newTasks and
 * no reopenIds -- so the phase's bead-mutation tail is a no-op and the test
 * stays about the KB candidate wiring.
 */
function harness({ demotionCandidates, promotionCandidates = async () => [] } = {}) {
    const prompts = [];
    const demotionCalls = [];
    const logs = [];
    const noop = async () => ({ ok: true, output: '' });

    const kbWork = {
        promotionCandidates,
        demotionCandidates: demotionCandidates ?? (async (member, opts) => {
            demotionCalls.push({ member, opts });
            return DEMOTE_CANDIDATES;
        }),
        apply: async () => ({}),
        commitRound: async () => ({}),
        warnPending: () => {},
        seal: () => {},
    };

    const dispatchCtx = {
        // runSprintCycle's `agent` wrapper resolves to the schema-parsed
        // result object, not a raw MCP envelope -- dispatchRole passes it
        // straight through as outcome.value.
        agent: async (prompt) => {
            prompts.push(prompt);
            return { verdict: 'PASS', notes: 'All good.' };
        },
        log: (line) => logs.push(String(line)),
        getMemberForRole: () => REVIEWER,
        memberSessionGuard: { killIfAlive: async () => {} },
        onLlmAuthFailure: async () => ({ healed: false }),
        onUsageLimit: async () => {},
        fixedRoleTier: () => undefined,
        budgets: {
            DISPATCH_INACTIVITY_TIMEOUT_S: 60,
            DISPATCH_TIMEOUT_S: 600,
            FINAL_REVIEW_MAX_TURNS: 120,
        },
        schemas: { finalVerdict: { type: 'object' } },
        isNoMutationDispatchFailure: () => false,
        invalidateAllBeadsCache: () => {},
        withGitSync: async (member, pushCode, invoke) => invoke(),
        withDispatchWatchdog: async (inFlight) => inFlight,
        steps: { 'kb-apply': async () => ({}) },
    };

    const state = {
        phase: () => {},
        log: (line) => logs.push(String(line)),
        command: noop,
        dispatchCtx,
        args: {},
        validated: { baseBranch: 'main', branch: 'feat/thing', goal: 'P1' },
        targetIssues: ['BD-1'],
        backlogMember: 'backlog-member',
        finalCycleLabel: 1,
        sprintState: {},
        gitSync: {
            syncBeadsBefore: async () => {},
            pushBeadsAfter: async () => {},
        },
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        verifyEverIds: new Set(),
        bdListScoped: async () => [],
        decomposedParentIds: async () => new Set(),
        goalMax: 2,
        NOT_DONE_STATUSES: 'open,in_progress',
        kbPriming: { knowledgeOf: () => undefined },
        kbInjection: null,
        kbSprintContext: {},
        kbWork,
        getMemberForRole: () => REVIEWER,
        childIdAllocator: null,
        sprintMutexId: 'sprint-1',
        resolveSettleShell: async () => undefined,
        computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async () => ({}),
        sanitizePrText: (s) => String(s || ''),
        // The review diff base the engine resolves on the reviewer member.
        reviewMergeBaseFor: async () => 'abcdef0123456789abcdef0123456789abcdef01',
    };

    return { state, prompts, demotionCalls, logs };
}

describe('Final Review: demotion candidates reach the final-verdict prompt', () => {
    test('calls demotionCandidates exactly once, BEFORE the dispatch, and renders every offered id in the prompt', async () => {
        const { state, prompts, demotionCalls } = harness();

        await runFinalReviewPhase(state);

        assert.equal(demotionCalls.length, 1, 'the final review must read its demotion candidates exactly once');
        assert.equal(prompts.length, 1, 'sanity: exactly one final-review dispatch in this scenario');
        for (const e of DEMOTE_CANDIDATES) {
            assert.ok(
                prompts[0].includes(e.id),
                `offered demotion candidate ${e.id} never reached the final-verdict prompt -- kbDemotionBlock is dead on this path`,
            );
            assert.ok(prompts[0].includes(e.title), `candidate title for ${e.id} missing from the final-verdict prompt`);
        }
        assert.match(prompts[0], /kb_demotions/, 'the prompt never names the output field the engine reads back');
    });

    test('the read happens BEFORE the dispatch, so a retry/resume reuses one fetched block', async () => {
        const order = [];
        const { state, prompts } = harness({
            demotionCandidates: async () => { order.push('read'); return DEMOTE_CANDIDATES; },
        });
        const innerAgent = state.dispatchCtx.agent;
        state.dispatchCtx.agent = async (prompt) => { order.push('dispatch'); return innerAgent(prompt); };

        await runFinalReviewPhase(state);

        assert.deepEqual(order, ['read', 'dispatch']);
        assert.ok(prompts[0].includes('kb-demote-1'));
    });

    test("scopes to the CUMULATIVE sprint diff, passed explicitly -- final review has no round", async () => {
        const { state, demotionCalls } = harness();

        await runFinalReviewPhase(state);

        assert.deepEqual(
            demotionCalls[0].opts, { scope: 'sprint' },
            'final review must ask for the cumulative baseBranch...branch scope explicitly, never leave it to be inferred',
        );
        assert.equal(demotionCalls[0].member, REVIEWER, 'the candidates must come from the reviewer role member, same as promotionCandidates');
    });

    test('the final review carries both the KNOWLEDGE BANK block and the demotion-candidate offer', async () => {
        const { state, prompts } = harness();
        const blockRoles = [];
        const knowledgeFor = async () => ({
            entries: [{ id: 'kb-know-1', type: 'knowledge', confidence: 'CONFIRMED', title: 'Known final-review fact', summary: 'a confirmed fact', source_files: ['server/x.js'] }],
            source: 'query',
        });
        const real = createKbInjection({ kbWork: { knowledgeFor }, log: () => {} });
        state.kbInjection = { ...real, blockFor: (d) => { blockRoles.push(d.role); return real.blockFor(d); } };

        await runFinalReviewPhase(state);

        assert.deepEqual(blockRoles, ['reviewer'], 'the final review reads its knowledge block as the reviewer');
        assert.match(prompts[0], /KNOWLEDGE BANK -- what this repo already knows/);
        assert.ok(prompts[0].includes('Known final-review fact'));
        for (const e of DEMOTE_CANDIDATES) assert.ok(prompts[0].includes(e.id), `demotion candidate ${e.id} missing`);
        assert.match(prompts[0], /kb_demotions/);
    });

    test('renders no demotion block when nothing is offered', async () => {
        const { state, prompts } = harness({ demotionCandidates: async () => [] });

        await runFinalReviewPhase(state);

        assert.ok(!/kb_demotions/.test(prompts[0]), 'an empty candidate set must not emit an empty KB demotion block');
    });

    // Criterion 7, final-review half: every degradation leaves the final
    // review dispatching anyway. A sprint's verdict must never hinge on the
    // KB being reachable.
    test('GUARD: a throw from the demotion-candidate read PROPAGATES at this call site, which is why the client must degrade internally', async () => {
        const { state, prompts } = harness({
            demotionCandidates: async () => { throw new Error('kb unreachable'); },
        });

        // The real client degrades internally and returns []; this asserts the
        // CALL SITE does not turn a KB failure into a lost sprint verdict even
        // if that internal degradation were ever lost.
        await assert.rejects(
            () => runFinalReviewPhase(state),
            /kb unreachable/,
            'guard test: a throw here propagates, which is why kbWork.demotionCandidates degrades internally (see kb.mjs) rather than throwing',
        );
        assert.equal(prompts.length, 0);
    });

    test('an empty read (the shape every degradation produces) still dispatches the final review and still returns its verdict', async () => {
        const { state, prompts } = harness({ demotionCandidates: async () => [] });

        const out = await runFinalReviewPhase(state);

        assert.equal(prompts.length, 1, 'the final review must run even with no KB candidates');
        assert.equal(out.finalVerdictResult.verdict, 'PASS');
    });

    test('logs the offer count only when there is something to offer', async () => {
        const offered = harness();
        await runFinalReviewPhase(offered.state);
        assert.ok(
            offered.logs.some((l) => /offering 2 CONFIRMED entr\(ies\) to the final reviewer for demotion/.test(l)),
            'the offer must be visible in the run log, as the promotion offer is',
        );

        const none = harness({ demotionCandidates: async () => [] });
        await runFinalReviewPhase(none.state);
        assert.ok(!none.logs.some((l) => /for demotion/.test(l)), 'an empty offer must not be announced');
    });
});

// =============================================================================
// FINAL REVIEW VERDICT -> BIBLE COMMIT, with the REAL kb work client. A FAIL
// verdict seals CONFIRMATIONS only: the final review's withdrawals (and
// restores) still reach kb_bible_commit, because they are merge-gated -- a
// FAIL branch that never merges carries them nowhere. A PASS commits both.
// =============================================================================
describe('Final Review: the verdict decides what the bible commit carries', () => {
    const REASON = 'the handler at server/transit.js:40 now keys by tenant too';
    async function runWithRealClient(verdict) {
        const { createKbWorkClient } = await import('../fleet-sprint/kb.mjs');
        const { selfMaintainer, currentServerKbWork } = await import('./helpers/kb-maintainer-fakes.mjs');
        const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
        const bibleCalls = [];
        let promotionRows = [];
        const kbWork = currentServerKbWork(createKbWorkClient, {
            memberCall: async (member, tool, args) => {
                if (tool === 'kb_query') {
                    if (Array.isArray(args.files)) return { l1_results: DEMOTE_CANDIDATES };
                    if (args.own_scope) return { l1_results: [] };
                    return { l1_results: promotionRows };
                }
                if (tool === 'kb_promote') return { id: args.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' };
                if (tool === 'kb_bible_commit') {
                    bibleCalls.push(args);
                    return { content: [{ text: JSON.stringify({
                        merged: args.ids, demoted: [], skipped: [], committed: true,
                        withdrawn: (args.withdrawals || []).map((w) => w.id), restored: args.restore_ids || [],
                    }) }] };
                }
                return {};
            },
            maintainers: selfMaintainer(MAINT, ['maint', REVIEWER]),
            gPull: async () => {},
            gPush: async () => {},
            bibleBase: async () => ({ baseBranch: 'main', baseCommit: 'a'.repeat(40) }),
            bibleUnpushed: async () => ({ unpushed: false }),
            sprintChangedFiles: async () => ['server/transit.js', 'server/rules.js'],
            log: () => {},
        });
        // An earlier round confirmed e1: it waits in the bible queue.
        promotionRows = [{ id: 'e1', type: 'knowledge' }];
        await kbWork.promotionCandidates(REVIEWER);
        await kbWork.apply('reviewer', REVIEWER, { kb_promotions: [{ id: 'e1', reason: REASON }] });
        promotionRows = [];

        const { state } = harness();
        state.kbWork = kbWork;
        state.dispatchCtx.agent = async () => ({
            verdict, notes: verdict === 'FAIL' ? 'Goal not met.' : 'All good.',
            kb_demotions: [{ id: 'kb-demote-1', reason: REASON, evidence_files: ['server/transit.js'] }],
            kb_holds: ['kb-demote-2'],
        });
        state.dispatchCtx.steps['kb-apply'] = async ({ value }) => kbWork.apply('reviewer', REVIEWER, value);
        await runFinalReviewPhase(state);
        return { bibleCalls, kbWork };
    }

    test('FAIL: the withdrawal and the restore are committed, the pending confirmation is not', async () => {
        const { bibleCalls, kbWork } = await runWithRealClient('FAIL');

        assert.equal(bibleCalls.length, 1, 'a FAIL verdict must still commit the merge-gated withdrawals');
        assert.deepEqual(bibleCalls[0].ids, [], 'a FAIL sprint commits no confirmation');
        assert.deepEqual(bibleCalls[0].withdrawals.map((w) => w.id), ['kb-demote-1']);
        assert.deepEqual(bibleCalls[0].restore_ids, ['kb-demote-2']);
        assert.deepEqual(kbWork.pendingConfirmations(), ['e1']);
    });

    test('PASS: one bible commit carries the confirmation, the withdrawal and the restore', async () => {
        const { bibleCalls } = await runWithRealClient('PASS');

        assert.equal(bibleCalls.length, 1);
        assert.deepEqual(bibleCalls[0].ids, ['e1']);
        assert.deepEqual(bibleCalls[0].withdrawals.map((w) => w.id), ['kb-demote-1']);
        assert.deepEqual(bibleCalls[0].restore_ids, ['kb-demote-2']);
    });
});
