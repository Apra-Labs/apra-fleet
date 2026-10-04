import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// my-beads-db-qy8.8: final-review.mjs:207-229 computes the sprint's changed
// files and offers kbWork.demotionCandidates() to the Final Review dispatch,
// threading kbDemotionCandidates into buildFinalVerdictPrompt -- but nothing
// drove that code PATH. kb-demotion-candidates.test.mjs covers the per-round
// reviewer half (buildReviewerPrompt) and final-review-kb-promotion.test.mjs
// covers the final-review PROMOTION path; this is the final-review DEMOTION
// path's missing suite, modelled on final-review-kb-promotion.test.mjs but
// driving the REAL runFinalReviewPhase (not buildFinalVerdictPrompt directly)
// so the git-diff computation and the kbWork.demotionCandidates() call site
// are actually exercised, the same way replan-findings-prompt.test.mjs drives
// runReplanPhase instead of calling buildPlannerPrompt by hand.

const DEMOTION_CANDIDATES = [
    { id: 'kb-d1', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-d2', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
];

const CHANGED_FILES_OUTPUT = 'server/transit.js\nserver/rules.js\n';
const CHANGED_FILES = ['server/transit.js', 'server/rules.js'];

const REPO_PATH = '/srv/warehouse/repo';

/**
 * Builds the full state object runFinalReviewPhase expects, with per-test
 * overrides. Every field not under test is a minimal inert fixture: no
 * newTasks/reopenIds in the verdict, so the child-bead-creation and
 * reopen machinery (computeChildFloor, createChildBeadWithAllocatedId,
 * sanitizePrText, gitSync.pushBeadsAfter) are never actually invoked --
 * they are still supplied (as throwing stubs) so a regression that DID
 * reach them would fail loudly rather than silently returning undefined.
 */
function buildState({ dispatchCtx, command, kbWork, logs = [] }) {
    const notReached = (label) => () => { throw new Error(`unexpected call: ${label}`); };
    return {
        phase: () => {},
        log: (msg) => { logs.push(msg); },
        command,
        dispatchCtx,
        args: {},
        validated: { baseBranch: 'main', branch: 'feat/x', goal: 'P1' },
        targetIssues: ['BD-1'],
        backlogMember: 'member:backlog',
        finalCycleLabel: 1,
        sprintState: { resolveSettleShell: async () => '' },
        gitSync: {
            syncBeadsBefore: async () => {},
            pushBeadsAfter: notReached('gitSync.pushBeadsAfter'),
        },
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        verifyEverIds: new Set(),
        bdListScoped: async () => [],
        decomposedParentIds: async () => new Set(),
        goalMax: 2,
        NOT_DONE_STATUSES: 'open,in_progress',
        kbPriming: { folderOf: () => REPO_PATH, knowledgeOf: () => [] },
        kbWork,
        getMemberForRole: (role) => `member:${role}`,
        childIdAllocator: notReached('childIdAllocator'),
        sprintMutexId: 'sprint-mutex-1',
        resolveSettleShell: async () => '',
        computeChildFloor: notReached('computeChildFloor'),
        createChildBeadWithAllocatedId: notReached('createChildBeadWithAllocatedId'),
        sanitizePrText: notReached('sanitizePrText'),
    };
}

/** A kbWork fixture whose demotionCandidates is a recording spy. */
function makeKbWork({ demotionResult = [], promotionResult = [] } = {}) {
    const demotionCalls = [];
    return {
        demotionCalls,
        kbWork: {
            promotionCandidates: async () => promotionResult,
            demotionCandidates: async (repoPath, changedFiles) => {
                demotionCalls.push({ repoPath, changedFiles });
                return demotionResult;
            },
            exportBible: async () => {},
        },
    };
}

/** A command() fixture whose git-diff response is driven per-test. */
function makeCommand(diffResponse) {
    return async (cmd, opts) => {
        if (/^git diff --name-only/.test(cmd)) {
            if (diffResponse instanceof Error) throw diffResponse;
            return diffResponse;
        }
        throw new Error(`unexpected command() call in this fixture: ${cmd} (${JSON.stringify(opts)})`);
    };
}

describe('Final Review demotion path: candidates reach the final verdict prompt', () => {
    test('git diff succeeds: changed files are parsed and threaded through kbWork.demotionCandidates into the prompt', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [{ verdict: 'PASS', notes: 'ok' }] });
        const { kbWork, demotionCalls } = makeKbWork({ demotionResult: DEMOTION_CANDIDATES });
        const command = makeCommand({ ok: true, output: CHANGED_FILES_OUTPUT });

        await runFinalReviewPhase(buildState({ dispatchCtx: ctx, command, kbWork }));

        assert.equal(rec.dispatches.length, 1, 'expected exactly one Final Review dispatch');
        assert.deepEqual(demotionCalls, [{ repoPath: REPO_PATH, changedFiles: CHANGED_FILES }]);

        const prompt = rec.dispatches[0].prompt;
        for (const c of DEMOTION_CANDIDATES) {
            assert.ok(prompt.includes(c.id), `candidate ${c.id} missing from the final verdict prompt`);
            assert.ok(prompt.includes(c.title), `candidate title for ${c.id} missing from the final verdict prompt`);
        }
        assert.match(prompt, /kb_demotions/, 'the prompt must name the structured-output field the orchestrator reads');
        assert.ok(prompt.includes('KNOWLEDGE BANK -- demotion candidates'), 'the final prompt must carry the demotion candidate block');
    });

    test('no candidates: the demotion block is entirely omitted', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [{ verdict: 'PASS', notes: 'ok' }] });
        const { kbWork } = makeKbWork({ demotionResult: [] });
        const command = makeCommand({ ok: true, output: CHANGED_FILES_OUTPUT });

        await runFinalReviewPhase(buildState({ dispatchCtx: ctx, command, kbWork }));

        const prompt = rec.dispatches[0].prompt;
        assert.ok(!/kb_demotions/.test(prompt), 'an empty candidate set must not render a kb_demotions block');
        assert.ok(!prompt.includes('KNOWLEDGE BANK -- demotion candidates'), 'an empty candidate set must not render the demotion heading');
    });

    test('a failing git diff (ok:false) degrades to an empty changed-files list and an empty candidate set, without failing the dispatch', async () => {
        const logs = [];
        const { ctx, rec } = createRecordingCtx({ responses: [{ verdict: 'PASS', notes: 'ok' }] });
        const { kbWork, demotionCalls } = makeKbWork({ demotionResult: [] });
        const command = makeCommand({ ok: false, output: '' });

        const result = await runFinalReviewPhase(buildState({ dispatchCtx: ctx, command, kbWork, logs }));

        assert.equal(rec.dispatches.length, 1, 'the dispatch must still happen despite the failing git diff');
        assert.equal(result.finalVerdictResult.verdict, 'PASS');
        assert.deepEqual(demotionCalls, [{ repoPath: REPO_PATH, changedFiles: [] }], 'a non-ok diff must degrade to an empty changed-files list, never throw into the dispatch');
        const prompt = rec.dispatches[0].prompt;
        assert.ok(!/kb_demotions/.test(prompt), 'no changed files means no candidates means no demotion block');
    });

    test('a throwing git diff degrades the same way, and logs the failure as non-fatal', async () => {
        const logs = [];
        const { ctx, rec } = createRecordingCtx({ responses: [{ verdict: 'PASS', notes: 'ok' }] });
        const { kbWork, demotionCalls } = makeKbWork({ demotionResult: [] });
        const command = makeCommand(new Error('git diff: network unreachable'));

        const result = await runFinalReviewPhase(buildState({ dispatchCtx: ctx, command, kbWork, logs }));

        assert.equal(rec.dispatches.length, 1, 'the dispatch must still happen despite the throwing git diff');
        assert.equal(result.finalVerdictResult.verdict, 'PASS');
        assert.deepEqual(demotionCalls, [{ repoPath: REPO_PATH, changedFiles: [] }], 'a throwing diff must degrade to an empty changed-files list, never escape the phase');
        assert.ok(
            logs.some((l) => l.includes('could not compute the sprint\'s changed files') && l.includes('non-fatal')),
            `expected a non-fatal log line for the failed git diff, got: ${JSON.stringify(logs)}`
        );
    });
});
