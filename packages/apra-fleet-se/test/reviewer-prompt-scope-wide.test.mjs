import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerPrompt } from '../fleet-sprint/runner.js';

// apra-fleet-s6d: the Cycle Evaluation re-review dispatches with beadIds: []
// (runner.js, the `openAtGoal.length === 0 && !reviewedThisCycle` branch)
// because the whole POINT of that dispatch is "no goal-priority beads are
// open -- is the sprint actually done?". That is a scope-wide question, but
// it was forced through a prompt builder whose contract is per-bead:
//
//   `Review the work just done for the following bead id(s): ${beadIds.join(', ')}.`
//
// With an empty array that renders the literal dangling sentence
// "...for the following bead id(s): ." -- naming nothing -- and the SPRINT
// SCOPE block then told the reviewer to judge "ONLY against the named bead
// id(s) above", i.e. against an empty set. The reviewer answered honestly
// (CHANGES_NEEDED, nothing to reopen, nothing to create), which
// isReviewerContractViolation classified as a contract violation; the retry
// re-sent the IDENTICAL incoherent prompt, so the sprint aborted on
// ReviewerContractViolationError.
//
// These tests call the REAL exported buildReviewerPrompt so they go RED the
// moment the scope-wide framing is dropped.

const BASE_ARGS = {
    acceptanceCriteriaJson: '[{"id":"apra-fleet-s6d","title":"a bead"}]',
    baseBranch: 'main',
    branch: 'feat/thing',
    goal: 'P1',
};

describe('buildReviewerPrompt: scope-wide re-review (apra-fleet-s6d)', () => {
    test('empty beadIds never emits the dangling "bead id(s): ." sentence', () => {
        const prompt = buildReviewerPrompt({ ...BASE_ARGS, beadIds: [] });

        assert.ok(
            !/bead id\(s\):\s*\./.test(prompt),
            'prompt still renders the empty-join dangling sentence "bead id(s): ."\n' + prompt
        );
    });

    test('empty beadIds points the reviewer at the full sprint scope instead', () => {
        const prompt = buildReviewerPrompt({ ...BASE_ARGS, beadIds: [] });

        assert.match(
            prompt,
            /entire sprint scope|whole sprint scope|full sprint scope/i,
            'scope-wide re-review prompt does not tell the reviewer it is judging the whole scope'
        );
        // The scope data is already delivered as acceptanceCriteriaJson; the
        // prompt must direct the reviewer to it rather than to a bead list.
        assert.ok(
            prompt.includes(BASE_ARGS.acceptanceCriteriaJson),
            'scope JSON is not carried in the prompt'
        );
    });

    test('empty beadIds does not tell the reviewer to judge against named ids', () => {
        const prompt = buildReviewerPrompt({ ...BASE_ARGS, beadIds: [] });

        assert.ok(
            !/ONLY against the named bead id\(s\) above/.test(prompt),
            'SPRINT SCOPE block still references named bead ids that were never named'
        );
        // The goal-priority scoping itself must survive -- it is what keeps a
        // re-review from blocking on deliberately deferred sub-goal work.
        assert.match(prompt, /SPRINT SCOPE/, 'goal-priority scoping was lost for the scope-wide path');
        assert.match(prompt, /P1/, 'goal priority no longer stated');
    });

    test('non-empty beadIds keeps the existing per-bead framing (regression guard)', () => {
        const prompt = buildReviewerPrompt({ ...BASE_ARGS, beadIds: ['apra-fleet-aaa', 'apra-fleet-bbb'] });

        assert.match(prompt, /following bead id\(s\): apra-fleet-aaa, apra-fleet-bbb\./);
        assert.match(prompt, /ONLY against the named bead id\(s\) above/);
    });

    test('the never-mutate-beads contract survives on both paths', () => {
        for (const beadIds of [[], ['apra-fleet-aaa']]) {
            const prompt = buildReviewerPrompt({ ...BASE_ARGS, beadIds });
            assert.match(prompt, /Do NOT run any `bd` command yourself/, `lost for beadIds=${JSON.stringify(beadIds)}`);
        }
    });
});
