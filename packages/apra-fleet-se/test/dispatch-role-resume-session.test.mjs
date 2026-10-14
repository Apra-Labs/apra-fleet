import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole, resolveResumeArg } from '../fleet-sprint/dispatch-role.mjs';
import {
    BINDINGS,
    ROLE_CALL_OPTS,
    createRecordingCtx,
    infraError,
    sessionNotFoundError,
    turnExhaustionError,
} from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// Engine-level resume pins that complement doer-max-turns-resume-explicit-
// session.test.mjs (which covers the doer ladder cases): EVERY role with a
// max-turns resume ladder resumes the exhausted dispatch's own session by
// explicit id (`resume: "<sessionId>"`, never `true` -- the server resolves
// `true` to the member's last session, whichever role ran it -- and never
// `session_id` alongside it); the fresh-session fallback logs only the
// session that was actually lost; and a usage-limit resume re-dispatch also
// targets the failed session by id, falling back to a FRESH full-prompt
// session when the server reports session_not_found.
// =============================================================================

const RESUMING_ROLES = Object.keys(ROLE_POLICIES).filter((role) => {
    const p = ROLE_POLICIES[role];
    return p.kind === 'main' && p.secondary && p.secondary.kind === 'max-turns-resume';
});

function optsFor(role) {
    return { bindings: BINDINGS, ...ROLE_CALL_OPTS[role] };
}

describe('max-turns resume targets the exhausted session by explicit id', () => {
    test('every role with a max-turns resume ladder is covered', () => {
        assert.ok(RESUMING_ROLES.length >= 8, `expected the resuming roles to be found, got ${JSON.stringify(RESUMING_ROLES)}`);
        for (const role of ['planner', 'plan-reviewer', 'doer', 'reviewer', 'final-review', 'deployer', 'integ-test-runner']) {
            assert.ok(RESUMING_ROLES.includes(role), `${role} must be one of the audited resuming roles`);
        }
    });

    for (const role of RESUMING_ROLES) {
        test(`${role}: the resume sends resume="<exhausted session id>" -- never true, never session_id`, async () => {
            const { ctx, rec } = createRecordingCtx({ responses: [turnExhaustionError('spent', 'sess-role-own-1')] });
            await dispatchRole(ctx, role, optsFor(role));
            assert.ok(rec.dispatches.length >= 2, `${role}: expected a resume dispatch, got ${rec.dispatches.length}`);
            const resume = rec.dispatches[1].options;
            assert.strictEqual(resume.resume, 'sess-role-own-1', `${role}: the resume must name the exhausted session explicitly.`);
            assert.ok(!('session_id' in resume), `${role}: the resume must not also send session_id.`);
        });
    }

    test('a lost session is forgotten after a re-exhaustion: the next fallback log reports no session id, not the stale one', async () => {
        // exhaust(sess-a) -> resume sess-a -> session_not_found (fresh fallback
        // naming sess-a) -> the fresh run exhausts reporting NO id -> the next
        // fresh fallback must say there is no session id. Without the reset it
        // would still claim sess-a was not found, which is not what happened.
        const { ctx, rec } = createRecordingCtx({
            responses: [
                turnExhaustionError('spent 1', 'sess-a'),
                sessionNotFoundError('sess-a'),
                turnExhaustionError('spent 2', null),
                'DONE',
            ],
        });
        const outcome = await dispatchRole(ctx, 'doer', ROLE_CALL_OPTS.doer);
        assert.strictEqual(outcome.ok, true);
        assert.deepStrictEqual(rec.dispatches.map((d) => d.options.resume), [false, 'sess-a', false, false]);
        const fallbacks = rec.logs.filter((m) => m.includes('starting a FRESH session'));
        assert.strictEqual(fallbacks.length, 2, `expected two fresh-session fallbacks, got: ${JSON.stringify(rec.logs)}`);
        assert.ok(fallbacks[0].includes('session_not_found') && fallbacks[0].includes('sess-a'), fallbacks[0]);
        assert.ok(fallbacks[1].includes('no session id'), `second fallback must report no session id: ${fallbacks[1]}`);
        assert.ok(!fallbacks[1].includes('sess-a'), `second fallback must not name the stale lost session: ${fallbacks[1]}`);
    });
});

describe('the resume announcement never claims "resuming the same session" when there is no session to resume', () => {
    const SAME = 'resuming the same session';
    const FRESH = 'continuing in a FRESH session';
    const announcements = (logs, pattern) => logs.filter((m) => pattern.test(m));
    const runSettled = async (role, responses) => {
        const { ctx, rec } = createRecordingCtx({ responses });
        try {
            await dispatchRole(ctx, role, ROLE_CALL_OPTS[role]);
        } catch {
            // Only the log lines matter here.
        }
        return rec;
    };

    test('first exhaustion with no session id: the announcement says it continues in a FRESH session', async () => {
        const rec = await runSettled('doer', [turnExhaustionError('spent', null), 'DONE']);
        const lines = announcements(rec.logs, /exhausted its turn limit [(]max_turns=/);
        assert.strictEqual(lines.length, 1, JSON.stringify(rec.logs));
        assert.ok(lines[0].includes(FRESH), lines[0]);
        assert.ok(!rec.logs.some((m) => m.includes(SAME)), JSON.stringify(rec.logs));
    });

    test('infrastructure failure with no session id: the recovery announcement says FRESH session', async () => {
        const rec = await runSettled('integ-test-runner', [infraError('x', null), 'INTEG DONE']);
        const lines = announcements(rec.logs, /infrastructure dispatch failure/);
        assert.strictEqual(lines.length, 1, JSON.stringify(rec.logs));
        assert.ok(lines[0].includes(FRESH), lines[0]);
        assert.ok(!rec.logs.some((m) => m.includes(SAME)), JSON.stringify(rec.logs));
    });

    test('a re-exhaustion with no session id: the "again" announcement says FRESH, the first one still says same session', async () => {
        const rec = await runSettled('doer', [turnExhaustionError('spent 1', 'sess-a'), turnExhaustionError('spent 2', null), 'DONE']);
        const first = announcements(rec.logs, /exhausted its turn limit [(]max_turns=/);
        const again = announcements(rec.logs, /exhausted its turn limit again/);
        assert.strictEqual(first.length, 1, JSON.stringify(rec.logs));
        assert.ok(first[0].includes(SAME), `sess-a was resumable, so the first announcement is accurate: ${first[0]}`);
        assert.strictEqual(again.length, 1, JSON.stringify(rec.logs));
        assert.ok(again[0].includes(FRESH) && !again[0].includes(SAME), again[0]);
    });
});

describe('usage-limit resume re-dispatch targets the failed session by explicit id', () => {
    const usageLimitError = (sessionId) => new AgentDispatchError('hit your usage limit', {
        details: { reason: 'usage_limit', ...(sessionId ? { sessionId } : {}) },
    });

    test('resumes the failed attempt session by id, never true', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [usageLimitError('sess-limited-9'), { verdict: 'APPROVED', notes: 'ok' }] });
        ctx.onUsageLimit = async () => ({ resumed: true });
        await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });
        assert.strictEqual(rec.dispatches.length, 2);
        assert.strictEqual(rec.dispatches[1].options.resume, 'sess-limited-9');
        assert.ok(!('session_id' in rec.dispatches[1].options));
    });

    test('session_not_found on the usage-limit resume falls back to a FRESH session with the full prompt, logged', async () => {
        const { ctx, rec } = createRecordingCtx({
            responses: [usageLimitError('sess-limited-9'), sessionNotFoundError('sess-limited-9'), { verdict: 'APPROVED', notes: 'fresh' }],
        });
        ctx.onUsageLimit = async () => ({ resumed: true });
        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });
        assert.strictEqual(outcome.ok, true);
        assert.strictEqual(rec.dispatches.length, 3);
        assert.strictEqual(rec.dispatches[2].options.resume, false);
        assert.strictEqual(rec.dispatches[2].prompt, ROLE_CALL_OPTS.reviewer.prompt);
        assert.ok(rec.logs.some((m) => m.includes('session_not_found') && m.includes('FRESH session')), JSON.stringify(rec.logs));
    });
});

describe('resolveResumeArg never returns undefined and never returns true', () => {
    test('same-session resolves to the explicit id, or false without one', () => {
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, { resumeSessionId: 'sess-x' }), 'sess-x');
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, { resumeSessionId: null }), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, { resumeSessionId: undefined }), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, { resumeSessionId: '' }), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}), false);
    });
    test('the other kinds are unchanged', () => {
        assert.strictEqual(resolveResumeArg(null, {}), false);
        assert.strictEqual(resolveResumeArg({ kind: 'fresh-session' }, { resumeSessionId: 'sess-x' }), false);
        assert.strictEqual(resolveResumeArg({ kind: 'worklist' }, { resumeArg: 'sess-w' }), 'sess-w');
        assert.strictEqual(resolveResumeArg({ kind: 'round-session', role: 'reviewer' }, {}), false);
    });
});
