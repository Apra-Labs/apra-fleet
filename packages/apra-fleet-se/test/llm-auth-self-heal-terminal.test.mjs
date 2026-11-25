import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createLlmAuthSelfHealCallback } from '../fleet-sprint/vcs-auth.mjs';
import { LlmAuthSelfHealFailedError, LLM_AUTH_SELF_HEAL_FAILED_CODE } from '../fleet-sprint/errors.mjs';
import { createRecordingCtx, authError, ROLE_CALL_OPTS } from './helpers/dispatch-role-harness.mjs';

// apra-fleet-3b8p.1: a provision_llm_auth that re-deploys credentials but
// whose post-deploy auth test FAILS (reason deployed_unverified) is a failed
// heal. The dispatch ladder must end at once with the typed error -- no
// "self-heal succeeded" line, no backoff wait, no second dispatch -- on a
// ladder with abortOnNonRetryable (planner) and on one without (reviewer).

const AUTH_LINE = 'Auth test: FAILED -- OAuth token revoked';

function provisionMock(result) {
    const calls = [];
    const callTool = async (name, args) => {
        calls.push({ name, args });
        return result;
    };
    return { calls, callTool };
}

const UNVERIFIED = {
    content: [{ text: `[OK] OAuth token provisioned on "member"\n  ${AUTH_LINE}\n` }],
    structuredContent: { ok: true, reason: 'deployed_unverified', verified: false },
};
const HEALED = {
    content: [{ text: '[OK] OAuth token provisioned on "member"\n  Auth test: OK\n' }],
    structuredContent: { ok: true, reason: 'ok', verified: true },
};

/** A recording ctx whose onLlmAuthFailure is the REAL callback over a mocked provision_llm_auth. */
function ctxWithRealHeal(responses, provisionResult) {
    const { ctx, rec } = createRecordingCtx({ responses });
    const provision = provisionMock(provisionResult);
    ctx.onLlmAuthFailure = createLlmAuthSelfHealCallback({ callTool: provision.callTool, log: ctx.log });
    return { ctx, rec, provision };
}

function assertTypedHealFailure(err, member) {
    assert.ok(err instanceof LlmAuthSelfHealFailedError, `expected LlmAuthSelfHealFailedError, got ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, LLM_AUTH_SELF_HEAL_FAILED_CODE);
    assert.equal(err.member, member);
    assert.equal(err.reason, 'deployed_unverified');
    assert.equal(err.healCause, AUTH_LINE);
    assert.match(err.remedy, /\/login on the source machine, then re-run provision_llm_auth/);
    assert.match(err.message, /OAuth token revoked/);
    assert.match(err.message, /\/login/);
    assert.match(err.message, /provision_llm_auth/);
    return true;
}

describe('LLM auth self-heal: a failed post-provision auth test is terminal', () => {
    test('abortOnNonRetryable ladder (planner): typed error after one dispatch and one provision call, no success log, no backoff', async () => {
        const { ctx, rec, provision } = ctxWithRealHeal([authError(), 'never reached'], UNVERIFIED);
        await assert.rejects(
            () => dispatchRole(ctx, 'planner', ROLE_CALL_OPTS.planner),
            (err) => assertTypedHealFailure(err, 'member:planner'),
        );
        assert.equal(rec.dispatches.length, 1, 'exactly one dispatch attempt');
        assert.equal(provision.calls.filter((c) => c.name === 'provision_llm_auth').length, 1, 'exactly one provision call');
        assert.ok(!rec.logs.some((m) => /self-heal succeeded/.test(m)), `no success log, logs: ${JSON.stringify(rec.logs)}`);
        assert.ok(!rec.logs.some((m) => /waiting [\d.]+s before retry attempt/.test(m)), `no backoff wait, logs: ${JSON.stringify(rec.logs)}`);
    });

    test('ladder WITHOUT abortOnNonRetryable (reviewer): typed error, no generic retry follows', async () => {
        const { ctx, rec, provision } = ctxWithRealHeal([authError(), 'never reached'], UNVERIFIED);
        await assert.rejects(
            () => dispatchRole(ctx, 'reviewer', ROLE_CALL_OPTS.reviewer),
            (err) => assertTypedHealFailure(err, rec.dispatches[0].member),
        );
        assert.equal(rec.dispatches.length, 1, 'no generic retry after a failed heal');
        assert.equal(provision.calls.filter((c) => c.name === 'provision_llm_auth').length, 1);
        assert.ok(!rec.logs.some((m) => /self-heal succeeded/.test(m)));
        assert.ok(!rec.logs.some((m) => /waiting [\d.]+s before retry attempt/.test(m)));
    });

    test('reason ok still heals: the planner retries once and succeeds', async () => {
        const { ctx, rec, provision } = ctxWithRealHeal([authError(), 'planned'], HEALED);
        const outcome = await dispatchRole(ctx, 'planner', ROLE_CALL_OPTS.planner);
        assert.equal(outcome.ok, true);
        assert.equal(outcome.value, 'planned');
        assert.equal(rec.dispatches.length, 2, 'one healed retry');
        assert.equal(provision.calls.length, 1);
        assert.ok(rec.logs.some((m) => /LLM auth self-heal succeeded -- retrying/.test(m)));
    });

    test('a bare boolean false from an injected callback is a failed heal too (typed error, no retry)', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [authError(), 'never reached'], healed: false });
        await assert.rejects(() => dispatchRole(ctx, 'reviewer', ROLE_CALL_OPTS.reviewer), LlmAuthSelfHealFailedError);
        assert.equal(rec.dispatches.length, 1);
    });
});
