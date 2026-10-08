import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole, resolveResumeArg } from '../fleet-sprint/dispatch-role.mjs';
import {
    BINDINGS,
    EXHAUSTED_SESSION_ID,
    ROLE_CALL_OPTS,
    createRecordingCtx,
    sessionNotFoundError,
    turnExhaustionError,
} from './helpers/dispatch-role-harness.mjs';
import { EXHAUSTED_SESSION_ID as EXEC_LADDER_SESSION_ID } from './helpers/execution-ladders.mjs';
import { EXHAUSTED_SESSION_ID as PLAN_LADDER_SESSION_ID } from './helpers/planning-ladders.mjs';

// =============================================================================
// A resume after turn exhaustion (and a usage-limit resume re-dispatch) must
// target EXACTLY the exhausted dispatch's own session, by explicit id.
//
// `resume: true` is resolved server-side to the member's single stored LAST
// session, which is shared across every role on that member: a doer that ran
// out of turns on a member that also hosts the reviewer was observed resuming
// the reviewer's session. So the engine sends `resume: "<sessionId>"` (the id
// reported on err.details.sessionId), never `true`, and never `session_id`
// alongside it (the client treats session_id as an alias of an explicit-id
// resume). When there is no id, or the server answers session_not_found, the
// engine starts a FRESH session carrying the FULL role prompt -- never the
// short resume nudge, which would be meaningless without the old context --
// and logs that it did so.
// =============================================================================

const RESUMING_ROLES = Object.keys(ROLE_POLICIES).filter((role) => {
    const p = ROLE_POLICIES[role];
    return p.kind === 'main' && p.secondary && p.secondary.kind === 'max-turns-resume';
});

function optsFor(role) {
    return { bindings: BINDINGS, ...ROLE_CALL_OPTS[role] };
}

describe('max-turns resume targets the exhausted session by explicit id', () => {
    test('the ladder fixtures pin the same exhausted-session literal as the harness', () => {
        assert.strictEqual(EXEC_LADDER_SESSION_ID, EXHAUSTED_SESSION_ID);
        assert.strictEqual(PLAN_LADDER_SESSION_ID, EXHAUSTED_SESSION_ID);
    });

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

    test("ladder: the member's last session belongs to ANOTHER role -- the doer resume still lands on the doer's own session", async () => {
        // A tiny stand-in for execute_prompt's session resolution: `true`
        // means "the member's stored last session", a string means exactly
        // that session. The shared member last ran the REVIEWER.
        const SHARED = 'member:shared-host';
        const server = { lastSession: { [SHARED]: 'sess-reviewer-on-shared' } };
        const landedOn = [];
        const resolveOnServer = (entry) => {
            const r = entry.options.resume;
            return r === true ? server.lastSession[entry.member] : (typeof r === 'string' ? r : null);
        };
        const { ctx, rec } = createRecordingCtx({
            responses: [
                (entry) => { landedOn.push(resolveOnServer(entry)); return turnExhaustionError('doer spent', 'sess-doer-own'); },
                (entry) => { landedOn.push(resolveOnServer(entry)); return 'DOER DONE'; },
            ],
        });
        const outcome = await dispatchRole(ctx, 'doer', {
            ...ROLE_CALL_OPTS.doer,
            bindings: ({ resumeAttempt }) => ({
                ...BINDINGS,
                doerMember: SHARED,
                'reviewerPool[0]': SHARED,
                maxTurns: 500 * (2 ** Math.max(resumeAttempt, 1)),
            }),
        });
        assert.strictEqual(outcome.ok, true);
        assert.strictEqual(rec.dispatches.length, 2);
        assert.strictEqual(rec.dispatches[1].member, SHARED);
        assert.notStrictEqual(rec.dispatches[1].options.resume, true, 'resume:true would land on the reviewer session');
        assert.strictEqual(landedOn[1], 'sess-doer-own', "the resume must land on the exhausted doer's own session, not the reviewer's");
    });

    test('a second exhaustion that reports a new id is resumed by that id; one that reports none keeps the previous id', async () => {
        const { ctx, rec } = createRecordingCtx({
            responses: [
                turnExhaustionError('spent 1', 'sess-a'),
                turnExhaustionError('spent 2', 'sess-b'),
                'DONE',
            ],
        });
        await dispatchRole(ctx, 'doer', ROLE_CALL_OPTS.doer);
        assert.deepStrictEqual(rec.dispatches.map((d) => d.options.resume), [false, 'sess-a', 'sess-b']);

        const second = createRecordingCtx({
            responses: [
                turnExhaustionError('spent 1', 'sess-a'),
                turnExhaustionError('spent 2', null),
                'DONE',
            ],
        });
        await dispatchRole(second.ctx, 'doer', ROLE_CALL_OPTS.doer);
        assert.deepStrictEqual(second.rec.dispatches.map((d) => d.options.resume), [false, 'sess-a', 'sess-a']);
    });

    test('no session id on the exhausted attempt: a FRESH session with the FULL prompt, logged', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [turnExhaustionError('spent', null), 'REVIEW OK'] });
        const outcome = await dispatchRole(ctx, 'final-review', ROLE_CALL_OPTS['final-review']);
        assert.strictEqual(outcome.ok, true);
        assert.strictEqual(rec.dispatches.length, 2);
        assert.strictEqual(rec.dispatches[1].options.resume, false, 'a fresh session, explicitly -- never true, never omitted');
        assert.strictEqual(rec.dispatches[1].prompt, ROLE_CALL_OPTS['final-review'].prompt, 'the FULL prompt, not the resume nudge');
        assert.ok(
            rec.logs.some((m) => m.includes('no session id') && m.includes('FRESH session')),
            `expected the fresh-session fallback to be logged, got: ${JSON.stringify(rec.logs)}`
        );
    });

    test('session_not_found on the resume: a FRESH session with the FULL prompt, logged', async () => {
        const { ctx, rec } = createRecordingCtx({
            responses: [turnExhaustionError('spent', 'sess-gone'), sessionNotFoundError('sess-gone'), 'DEPLOYED'],
        });
        const outcome = await dispatchRole(ctx, 'deployer', ROLE_CALL_OPTS.deployer);
        assert.strictEqual(outcome.ok, true);
        assert.strictEqual(outcome.value, 'DEPLOYED');
        assert.strictEqual(rec.dispatches.length, 3);
        assert.strictEqual(rec.dispatches[1].options.resume, 'sess-gone');
        assert.strictEqual(rec.dispatches[2].options.resume, false);
        assert.strictEqual(rec.dispatches[2].prompt, ROLE_CALL_OPTS.deployer.prompt);
        assert.ok(
            rec.logs.some((m) => m.includes('session_not_found') && m.includes('sess-gone') && m.includes('FRESH session')),
            `expected the session_not_found fallback to be logged, got: ${JSON.stringify(rec.logs)}`
        );
    });

    test("the fresh fallback tells the caller's prepare() so a role that builds its own resume prompt sends the full one", async () => {
        const seen = [];
        const { ctx, rec } = createRecordingCtx({ responses: [turnExhaustionError('spent', null), 'DONE'] });
        await dispatchRole(ctx, 'doer', {
            ...ROLE_CALL_OPTS.doer,
            prepare: async ({ dispatch, freshSession }) => {
                seen.push({ kind: dispatch.kind, freshSession: freshSession === true });
                return dispatch.kind === 'max-turns-resume' && freshSession !== true
                    ? { prompt: 'NUDGE' }
                    : { prompt: 'FULL DOER PROMPT' };
            },
        });
        assert.deepStrictEqual(seen, [
            { kind: 'main', freshSession: false },
            { kind: 'max-turns-resume', freshSession: true },
        ]);
        assert.strictEqual(rec.dispatches[1].prompt, 'FULL DOER PROMPT');
        assert.strictEqual(rec.dispatches[1].options.resume, false);
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
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}, 'sess-x'), 'sess-x');
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}, null), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}, undefined), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}, ''), false);
        assert.strictEqual(resolveResumeArg({ kind: 'same-session' }, {}), false);
    });
    test('the other kinds are unchanged', () => {
        assert.strictEqual(resolveResumeArg(null, {}), false);
        assert.strictEqual(resolveResumeArg({ kind: 'fresh-session' }, {}, 'sess-x'), false);
        assert.strictEqual(resolveResumeArg({ kind: 'worklist' }, { resumeArg: 'sess-w' }), 'sess-w');
        assert.strictEqual(resolveResumeArg({ kind: 'round-session', role: 'reviewer' }, {}), false);
    });
});
