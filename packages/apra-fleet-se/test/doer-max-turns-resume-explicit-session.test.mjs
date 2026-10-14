import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, turnExhaustionError } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// A doer's max-turns resume targets EXACTLY the failed doer session. On a member
// shared by several roles, `resume: true` would reattach the member's last
// SUCCESSFUL session, which can be a reviewer's or planner's. The failure
// envelopes below have the shape the server produces (reason plus the failed
// dispatch's sessionId).
// =============================================================================

const REVIEWER_SESSION = 'reviewer-session-R';
const DOER_SESSION = 'doer-session-D';
const DOER_SESSION_2 = 'doer-session-D2';

const sessionNotFound = (sessionId) => new AgentDispatchError(
    'session not found on member',
    { details: { reason: 'session_not_found', sessionId } },
);

/**
 * A `prepare` shaped like the doer's: the full streak prompt for a main or
 * fresh dispatch, a restated-scope continuation for a true resume.
 */
const doerOpts = () => ({
    ...ROLE_CALL_OPTS.doer,
    prompt: 'FULL DOER STREAK PROMPT',
    prepare: async ({ dispatch, freshSession }) => (dispatch.kind === 'max-turns-resume' && !freshSession
        ? { prompt: 'CONTINUE FROM WHERE YOU LEFT OFF', label: 'resume' }
        : { prompt: 'FULL DOER STREAK PROMPT', label: 'fresh-or-main', resumeArg: false }),
});

test('case 1: a member shared with a reviewer (last successful session R) resumes the doer session D, never true and never R', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [turnExhaustionError('max turns spent', DOER_SESSION)],
    });
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(rec.dispatches.length, 2);
    const resume = rec.dispatches[1].options.resume;
    assert.equal(resume, DOER_SESSION, 'the resume names the failed doer session by its explicit id');
    assert.notEqual(resume, true, 'resume: true would reattach the member last successful session');
    assert.notEqual(resume, REVIEWER_SESSION);
    assert.equal(rec.dispatches[1].prompt, 'CONTINUE FROM WHERE YOU LEFT OFF');
    // The main dispatch never resumes anything.
    assert.notEqual(rec.dispatches[0].options.resume, true);
    for (const d of rec.dispatches) assert.notEqual(d.options.resume, true, 'no dispatch passes resume: true');
});

test('case 2: an envelope without a sessionId starts a FRESH session with the full role prompt and logs it', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [turnExhaustionError('max turns spent', null)],
    });
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(rec.dispatches.length, 2);
    assert.equal(rec.dispatches[1].options.resume, false, 'no explicit id means no resume at all');
    assert.equal(rec.dispatches[1].prompt, 'FULL DOER STREAK PROMPT', 'a fresh session gets the FULL prompt, not a delta');
    assert.ok(
        rec.logs.some((m) => /FRESH session/.test(m) && /no session id/.test(m)),
        `expected a log line saying a fresh session was started and why, got: ${JSON.stringify(rec.logs)}`,
    );
});

test('case 3: session_not_found on the resume falls back to a fresh full-prompt session', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [turnExhaustionError('max turns spent', DOER_SESSION), sessionNotFound(DOER_SESSION)],
    });
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(rec.dispatches.length, 3, 'main + refused resume + fresh fallback');
    assert.equal(rec.dispatches[1].options.resume, DOER_SESSION);
    assert.equal(rec.dispatches[2].options.resume, false);
    assert.equal(rec.dispatches[2].prompt, 'FULL DOER STREAK PROMPT');
    assert.ok(rec.logs.some((m) => /FRESH session/.test(m) && /not found/.test(m)), `logs: ${JSON.stringify(rec.logs)}`);
});

test('case 4: a second exhaustion with a new id D2 moves the next resume to D2', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [
            turnExhaustionError('max turns spent', DOER_SESSION),
            turnExhaustionError('max turns spent again', DOER_SESSION_2),
        ],
    });
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(rec.dispatches.length, 3);
    assert.equal(rec.dispatches[1].options.resume, DOER_SESSION);
    assert.equal(rec.dispatches[2].options.resume, DOER_SESSION_2, 'the resume target follows the newest failed session');
    assert.deepEqual(
        rec.dispatches.slice(1).map((d) => d.options.max_turns),
        [1000, 2000],
        'the escalating turn budget is unchanged',
    );
});
