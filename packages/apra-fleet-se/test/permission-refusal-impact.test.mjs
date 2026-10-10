// A permission refusal is judged by its IMPACT on the reply
// (dispatch-role.mjs judgeRefusalByImpact): a permission_denied dispatch
// whose reply is COMPLETE (the server's explicit replyComplete) and satisfies
// the role's contract (dispatch schema via agent()'s parsedResponse, plus
// opts.validate when supplied) resolves the dispatch with that reply and a
// recorded warning naming the refused calls. Anything less goes to the heal
// path / MemberPermissionDeniedError exactly as before, and a classifier or
// deny-rule refusal (healable:false) keeps its own semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const LOOP = 'for r in a b; do bd graph $r; done';
const DENIAL = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: LOOP }],
    suggestedGrants: [],
    hint: `claude refused Bash "${LOOP}" for lack of a permission grant.`,
    signals: ['result_json'],
});
const APPROVED = Object.freeze({ verdict: 'APPROVED', notes: 'plan is fine' });

function refused(extra = {}, denial = DENIAL) {
    return new AgentDispatchError(
        '[Workflow Error] Agent dispatch failed (permission_denied): permission denied',
        { details: { reason: 'permission_denied', member: 'rev', permissionDenied: denial, sessionId: 'sess-1', ...extra } },
    );
}

function planReviewOpts(over = {}) {
    return { bindings: BINDINGS, ...ROLE_CALL_OPTS['plan-reviewer'], ...over };
}

function withHeal(ctx, result = { healed: false, step: 'no_progress', reason: 'no grant maps to it', grants: [], rejectedGrants: [] }) {
    const calls = [];
    ctx.onPermissionDenied = async (args) => { calls.push(args); return result; };
    return calls;
}

test('complete schema-valid reply: the dispatch resolves with it, a warning names the refused call, no heal', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [refused({ response: JSON.stringify(APPROVED), replyComplete: true, parsedResponse: APPROVED })],
        members: { 'plan-reviewer': 'rev' },
    });
    const heals = withHeal(ctx);
    const outcome = await dispatchRole(ctx, 'plan-reviewer', planReviewOpts());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.degraded, false);
    assert.deepEqual(outcome.value, APPROVED);
    assert.equal(heals.length, 0);
    assert.equal(rec.dispatches.length, 1);
    assert.deepEqual(outcome.permissionWarnings, [{ member: 'rev', role: 'plan-reviewer', actions: [`Bash "${LOOP}"`] }]);
    const warning = rec.logs.find((l) => /WARNING/.test(l));
    assert.ok(warning, rec.logs.join('\n'));
    assert.match(warning, /member 'rev'/);
    assert.ok(warning.includes(LOOP), warning);
});

test('schema-less role (planner): the complete reply text is the result', async () => {
    const { ctx, rec } = createRecordingCtx({
        responses: [refused({ response: 'Plan done: 7 beads, DAG verified.', replyComplete: true })],
        members: { planner: 'plan' },
    });
    const heals = withHeal(ctx);
    const outcome = await dispatchRole(ctx, 'planner', { bindings: BINDINGS, ...ROLE_CALL_OPTS.planner });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value, 'Plan done: 7 beads, DAG verified.');
    assert.equal(heals.length, 0);
    assert.equal(rec.dispatches.length, 1);
    assert.equal(outcome.permissionWarnings.length, 1);
});

for (const [name, extra] of [
    ['no response', {}],
    ['an incomplete reply (replyComplete false)', { response: JSON.stringify(APPROVED), replyComplete: false, parsedResponse: APPROVED }],
    ['a complete reply that fails the schema (no parsedResponse)', { response: '{"verdict":"MAYBE"}', replyComplete: true }],
]) {
    test(`${name}: still goes to the heal path and ends in MemberPermissionDeniedError`, async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [refused(extra)], members: { 'plan-reviewer': 'rev' } });
        const heals = withHeal(ctx);
        await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
            assert.ok(err instanceof MemberPermissionDeniedError, String(err));
            assert.equal(err.step, 'no_progress');
            return true;
        });
        assert.equal(heals.length, 1);
        assert.ok(!rec.logs.some((l) => /WARNING/.test(l)), rec.logs.join('\n'));
    });
}

test('a complete schema-valid reply that fails opts.validate goes to the heal path', async () => {
    const { ctx } = createRecordingCtx({
        responses: [refused({ response: JSON.stringify(APPROVED), replyComplete: true, parsedResponse: APPROVED })],
        members: { 'plan-reviewer': 'rev' },
    });
    const heals = withHeal(ctx);
    const validate = () => ({ ok: false, reason: 'semantically wrong', result: null });
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts({ validate })), MemberPermissionDeniedError);
    assert.equal(heals.length, 1);
});

test('a healable:false refusal keeps its semantics even with a complete reply attached', async () => {
    const { ctx } = createRecordingCtx({
        responses: [refused(
            { response: JSON.stringify(APPROVED), replyComplete: true, parsedResponse: APPROVED },
            { ...DENIAL, healable: false, permissionMode: 'auto' },
        )],
        members: { 'plan-reviewer': 'rev' },
    });
    const heals = withHeal(ctx, { healed: false, step: 'not_healable', reason: 'classifier refusal', grants: [], rejectedGrants: [] });
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError);
        assert.equal(err.step, 'not_healable');
        return true;
    });
    assert.equal(heals.length, 1);
});
