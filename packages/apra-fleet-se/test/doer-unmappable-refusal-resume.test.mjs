// A doer dispatch refused ONLY tool calls that map to no permission grant
// (e.g. a chained or backgrounded shell command) is resumed ONCE in the same
// session (retry.unmappableRefusalResume on the doer row), with a notice that
// names the refused call(s) and says no grant can ever allow them. The refused
// reply is never used; a clean reply from the resume is the ladder's result. A
// second such refusal fails with the existing unmappable remedy text, and a
// refusal that maps to a grant still goes through the progressive heal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole, unmappableRefusalResumeNotice } from '../fleet-sprint/dispatch-role.mjs';
import { MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { policyFor } from '../fleet-sprint/role-policies.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const CHAINED = 'npm test > /tmp/t.log 2>&1 &';
const REFUSED_SESSION = 'doer-session-refused';

const UNMAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
    suggestedGrants: [],
    hint: `claude refused Bash "${CHAINED}".`,
    signals: ['result_json'],
});
const MAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: 'bd show root-1' }],
    suggestedGrants: ['Bash(bd:*)'],
    hint: 'claude refused Bash "bd show root-1" for lack of a permission grant.',
    signals: ['result_json'],
});

const refused = (denial, sessionId = REFUSED_SESSION) => new AgentDispatchError(
    '[Workflow Error] Agent dispatch failed (permission_denied): [FAIL] execute_prompt on "dev": permission denied',
    { details: { reason: 'permission_denied', member: 'dev', permissionDenied: denial, ...(sessionId ? { sessionId } : {}) } },
);

const CLEAN = Object.freeze({ status: 'VERIFY', closedIds: ['bead-1'], notes: 'Finished with plain commands.' });

const doerOpts = () => ({
    ...ROLE_CALL_OPTS.doer,
    prompt: 'FULL DOER STREAK PROMPT',
    prepare: async ({ dispatch, freshSession, refusalNotice }) => {
        if (refusalNotice) return { prompt: `${refusalNotice}\n\nSCOPE RESTATED`, label: 'resume after refused calls' };
        return dispatch.kind === 'max-turns-resume' && !freshSession
            ? { prompt: 'CONTINUE FROM WHERE YOU LEFT OFF', label: 'resume' }
            : { prompt: 'FULL DOER STREAK PROMPT', label: 'main', resumeArg: false };
    },
});

const noProgressHeal = (ctx) => {
    const calls = [];
    ctx.onPermissionDenied = async (args) => {
        calls.push(args);
        return { healed: false, step: 'no_progress', composeRole: 'doer', grants: [], rejectedGrants: [], reason: 'no grant maps to the refused call' };
    };
    return calls;
};

test('policy: only the doer row resumes after an unmappable refusal', () => {
    assert.equal(policyFor('doer').retry.unmappableRefusalResume, true);
    for (const role of ['planner', 'plan-reviewer', 'reviewer', 'harvester']) {
        assert.equal(policyFor(role).retry.unmappableRefusalResume, false, role);
    }
});

test('notice: names every refused call and says no grant can ever allow them', () => {
    const text = unmappableRefusalResumeNotice([`Bash "${CHAINED}"`, 'Bash "a && b"']);
    assert.ok(text.includes(`Bash "${CHAINED}"`) && text.includes('Bash "a && b"'), text);
    assert.match(text, /no permission grant\s+can ever allow them/);
    assert.match(text, /separate, plain command/);
    assert.doesNotMatch(text, /compose_permissions/);
});

test('an unmappable-only refusal is resumed once in the same session; the clean resumed reply is the result', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), CLEAN] });
    const heals = noProgressHeal(ctx);
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.deepEqual(out.value, CLEAN, 'the resumed reply, never the refused one, is the result');
    assert.equal(out.resumesIssued, 1);
    assert.equal(rec.dispatches.length, 2, 'main dispatch + exactly one resume');
    assert.equal(rec.dispatches[1].options.resume, REFUSED_SESSION, 'the resume targets the refused session by its explicit id');
    const prompt = rec.dispatches[1].prompt;
    assert.ok(prompt.includes(`Bash "${CHAINED}"`), `the resume prompt names the refused call: ${prompt}`);
    assert.match(prompt, /no permission grant\s+can ever allow them/);
    assert.ok(prompt.includes('SCOPE RESTATED'));
    assert.equal(heals.length, 1);
    assert.ok(rec.logs.some((l) => /its reply is NOT used; resuming session 'doer-session-refused' once/.test(l)), JSON.stringify(rec.logs));
});

test('the notice is delivered even when the caller prepare() does not place it', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), CLEAN] });
    noProgressHeal(ctx);
    const opts = { ...doerOpts(), prepare: async () => ({ prompt: 'CALLER PROMPT', resumeArg: false }) };
    const out = await dispatchRole(ctx, 'doer', opts);
    assert.equal(out.ok, true);
    assert.ok(rec.dispatches[1].prompt.startsWith(unmappableRefusalResumeNotice([`Bash "${CHAINED}"`])), rec.dispatches[1].prompt);
    assert.ok(rec.dispatches[1].prompt.endsWith('CALLER PROMPT'));
});

test('a resume refused again fails with the unmappable remedy text, no compose_permissions or rerun advice', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), refused(UNMAPPABLE, 'doer-session-2'), CLEAN] });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'doer', doerOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.match(err.message, /no permission grant can allow/);
        assert.doesNotMatch(err.message, /compose_permissions/);
        assert.doesNotMatch(err.message, /rerun|re-run/i);
        assert.equal(err.details.unmappable, true);
        return true;
    });
    assert.equal(rec.dispatches.length, 2, 'exactly one resume, never a second');
});

test('an unmappable refusal with no session id to resume fails at once with the unmappable text', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE, null), CLEAN] });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'doer', doerOpts()), (err) => (
        err instanceof MemberPermissionDeniedError && err.details.unmappable === true
    ));
    assert.equal(rec.dispatches.length, 1);
    assert.ok(rec.logs.some((l) => /cannot resume after the unmappable refusal -- the refused dispatch reported no session id/.test(l)), JSON.stringify(rec.logs));
});

test('a grant-mappable refusal is never resumed: the progressive heal re-runs the main dispatch', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(MAPPABLE), CLEAN] });
    const heals = [];
    ctx.onPermissionDenied = async (args) => {
        heals.push(args);
        return { healed: true, grants: ['Bash(bd:*)'] };
    };
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(out.resumesIssued, 0);
    assert.equal(heals.length, 1);
    assert.equal(rec.dispatches.length, 2);
    assert.equal(rec.dispatches[1].prompt, 'FULL DOER STREAK PROMPT', 'the healed re-run is the main dispatch, not a resume');
    assert.notEqual(rec.dispatches[1].options.resume, REFUSED_SESSION);
});

test('a non-doer role (plan-reviewer) still fails at once on an unmappable refusal', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), { verdict: 'APPROVED', notes: 'ok' }], members: { 'plan-reviewer': 'dev' } });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', { bindings: BINDINGS, ...ROLE_CALL_OPTS['plan-reviewer'] }), MemberPermissionDeniedError);
    assert.equal(rec.dispatches.length, 1);
});
