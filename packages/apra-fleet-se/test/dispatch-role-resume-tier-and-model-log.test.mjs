import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { policyFor } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { BINDINGS, ROLE_CALL_OPTS, createRecordingCtx, turnExhaustionError } from './helpers/dispatch-role-harness.mjs';

// Every resume/re-dispatch continues on the tier its main dispatch was priced
// at (a missing model would run on the server default), and every settled
// dispatch logs requested tier + actual model id (or 'unknown').

const doerOptsAt = (tier) => ({ ...ROLE_CALL_OPTS.doer, bindings: { ...BINDINGS, doerModel: tier } });
const CLEAN = Object.freeze({ status: 'VERIFY', closedIds: ['b-1'], notes: 'done' });
const usageLimitError = (sessionId) => new AgentDispatchError('hit your usage limit', {
    details: { reason: 'usage_limit', ...(sessionId ? { sessionId } : {}) },
});

describe('resume keeps the original tier', () => {
    for (const tier of ['premium', 'standard', 'cheap']) {
        test(`doer at ${tier}: max_turns resume dispatches at ${tier}`, async () => {
            const { ctx, rec } = createRecordingCtx({ responses: [turnExhaustionError('spent', 'sess-t-1'), CLEAN] });
            await dispatchRole(ctx, 'doer', doerOptsAt(tier));
            assert.ok(rec.dispatches.length >= 2);
            assert.equal(rec.dispatches[0].options.model, tier);
            assert.equal(rec.dispatches[1].options.model, tier, 'the resume must carry the main dispatch tier');
        });
    }

    test('doer: usage-limit resume variant (session id) and onUsageLimit both carry the original tier', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [usageLimitError('sess-ul-1'), CLEAN] });
        const seen = [];
        ctx.onUsageLimit = async (info) => { seen.push(info); return { resumed: true }; };
        await dispatchRole(ctx, 'doer', doerOptsAt('cheap'));
        assert.equal(rec.dispatches[1].options.resume, 'sess-ul-1');
        assert.equal(rec.dispatches[1].options.model, 'cheap');
        assert.equal(seen[0].tier, 'cheap');
    });

    test('doer: usage-limit fresh variant (no session id) carries the original tier', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [usageLimitError(null), CLEAN] });
        ctx.onUsageLimit = async () => ({ resumed: true });
        await dispatchRole(ctx, 'doer', doerOptsAt('premium'));
        assert.equal(rec.dispatches[1].options.resume, false);
        assert.equal(rec.dispatches[1].options.model, 'premium');
    });

    test('doer: unmappable-refusal resume carries the original tier', async () => {
        assert.equal(policyFor('doer').retry.unmappableRefusalResume, true);
        const refusal = new AgentDispatchError('permission denied', {
            details: {
                reason: 'permission_denied', member: 'dev', sessionId: 'sess-refused',
                permissionDenied: {
                    actions: ['Bash'], denials: [{ action: 'Bash', target: 'a && b', suggestedGrants: [] }],
                    suggestedGrants: [], hint: 'refused', signals: ['result_json'],
                },
            },
        });
        const { ctx, rec } = createRecordingCtx({ responses: [refusal, CLEAN] });
        ctx.onPermissionDenied = async () => ({ healed: false, step: 'no_progress', composeRole: 'doer', grants: [], rejectedGrants: [], reason: 'none' });
        await dispatchRole(ctx, 'doer', doerOptsAt('cheap'));
        assert.equal(rec.dispatches[1].options.resume, 'sess-refused');
        assert.equal(rec.dispatches[1].options.model, 'cheap');
    });
});

describe('every settled dispatch logs its model id', () => {
    const modelLines = (logs) => logs.filter((m) => m.includes('actual model'));

    test('a result that reports a model id logs that id and the requested tier', async () => {
        const { ctx, rec } = createRecordingCtx({
            responses: [async (entry) => { entry.options.onModelId('claude-opus-test-1'); return CLEAN; }],
        });
        await dispatchRole(ctx, 'doer', doerOptsAt('premium'));
        const lines = modelLines(rec.logs);
        assert.equal(lines.length, 1, JSON.stringify(rec.logs));
        assert.ok(lines[0].includes('claude-opus-test-1') && lines[0].includes('requested tier premium'), lines[0]);
    });

    test('a result with no model id logs the literal unknown', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [CLEAN] });
        await dispatchRole(ctx, 'doer', doerOptsAt('standard'));
        const lines = modelLines(rec.logs);
        assert.equal(lines.length, 1, JSON.stringify(rec.logs));
        assert.ok(lines[0].includes('actual model unknown'), lines[0]);
    });

    test('a failed dispatch logs the model id from the error details, and each resume logs its own line', async () => {
        const exhausted = turnExhaustionError('spent', 'sess-m-1');
        exhausted.details.model = 'claude-sonnet-test-2';
        const { ctx, rec } = createRecordingCtx({ responses: [exhausted, CLEAN] });
        await dispatchRole(ctx, 'doer', doerOptsAt('standard'));
        const lines = modelLines(rec.logs);
        assert.equal(lines.length, 2, JSON.stringify(rec.logs));
        assert.ok(lines[0].includes('claude-sonnet-test-2'), lines[0]);
        assert.ok(lines[1].includes('actual model unknown'), lines[1]);
    });
});
