import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildDoerPrompt } from '../auto-sprint/runner.js';

// apra-fleet-eft.65.3 -- pins apra-fleet-eft.65.2's fix: the composed Doer
// role prompt must carry an explicit fail-loud-not-route-around directive so
// a dispatched agent whose Edit/Write (or any git invocation) is
// permission-blocked STOPS and surfaces the block instead of improvising a
// workaround (e.g. a Bash heredoc). This is exactly the anti-pattern the
// eft.65 smoke-test doer exhibited (see RECOVERY.md's 2026-07-02 incident
// precedent) and that this repo's CLAUDE.md permission-block policy forbids.
//
// Calls the REAL, exported buildDoerPrompt() from runner.js (not a
// hand-rolled reimplementation of its format), so this test goes RED the
// moment the directive is dropped from the composed prompt and stays GREEN
// only while runner.js actually emits it.

describe('buildDoerPrompt: surface-dont-bypass permission-block directive', () => {
    const BASE_ARGS = {
        beadIds: ['apra-fleet-eft.65.3'],
        branch: 'auto-sprint/eft-service',
        feedback: null,
    };

    test('composed prompt contains the explicit fail-loud-not-route-around directive', () => {
        const prompt = buildDoerPrompt(BASE_ARGS);
        assert.ok(
            prompt.includes('PERMISSION BLOCKS MUST BE SURFACED, NOT ROUTED AROUND'),
            `expected composed Doer prompt to include the surface-don't-bypass directive header, got: ${prompt}`
        );
    });

    test('directive instructs STOP + status "BLOCKED", not a workaround', () => {
        const prompt = buildDoerPrompt(BASE_ARGS);
        assert.ok(prompt.includes('STOP'), 'directive must instruct the doer to STOP');
        assert.ok(
            prompt.includes('status "BLOCKED"'),
            'directive must instruct the doer to report status "BLOCKED"'
        );
    });

    test('directive explicitly forbids the Bash heredoc / wrapper / alternate-binary workaround class', () => {
        const prompt = buildDoerPrompt(BASE_ARGS);
        assert.ok(
            /do NOT substitute a Bash heredoc/.test(prompt),
            'directive must explicitly forbid substituting a Bash heredoc workaround'
        );
        assert.ok(prompt.includes('wrapper script'), 'directive must call out wrapper scripts');
        assert.ok(prompt.includes('alternate binary'), 'directive must call out alternate binaries');
    });

    test('directive applies even to a brand-new file (the exact eft.65 incident shape)', () => {
        const prompt = buildDoerPrompt(BASE_ARGS);
        assert.ok(
            prompt.includes('even for a brand-new file'),
            'directive must explicitly cover the brand-new-file case that triggered eft.65'
        );
    });

    test('directive is present regardless of feedback (present on both fresh dispatch and re-dispatch)', () => {
        const freshPrompt = buildDoerPrompt(BASE_ARGS);
        const feedbackPrompt = buildDoerPrompt({ ...BASE_ARGS, feedback: 'Fix the missing error handling.' });
        assert.ok(freshPrompt.includes('PERMISSION BLOCKS MUST BE SURFACED, NOT ROUTED AROUND'));
        assert.ok(feedbackPrompt.includes('PERMISSION BLOCKS MUST BE SURFACED, NOT ROUTED AROUND'));
    });

    test('directive text is consistent with this repo\'s own CLAUDE.md permission-block policy', () => {
        const prompt = buildDoerPrompt(BASE_ARGS);
        assert.ok(
            prompt.includes("This matches this repo's CLAUDE.md permission-block policy"),
            'directive must anchor itself to the CLAUDE.md policy it mirrors'
        );
    });
});
