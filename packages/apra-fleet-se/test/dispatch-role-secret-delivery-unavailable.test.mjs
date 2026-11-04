import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { isNonRetryableDispatchError, isAuthDispatchError } from '../fleet-sprint/errors.mjs';
import { ROLE_CALL_OPTS, createRecordingCtx, busyError } from './helpers/dispatch-role-harness.mjs';

// A member that cannot receive its stored credentials (relay member, SFTP
// disabled) fails the same way on every attempt: the dispatch must be tried
// once and the operator told how to fix it.

const secretDeliveryError = () => new AgentDispatchError(
    '[Workflow Error] Agent dispatch failed (secret_delivery_unavailable): stored credentials cannot be delivered',
    { details: { reason: 'secret_delivery_unavailable' } },
);

const ROLES = Object.keys(ROLE_CALL_OPTS).filter((r) => ROLE_POLICIES[r]);

describe('secret_delivery_unavailable classification', () => {
    test('is non-retryable', () => {
        assert.equal(isNonRetryableDispatchError(secretDeliveryError()), true);
    });

    test('is deliberately NOT an LLM-auth failure: provision_llm_auth self-heal cannot make the channel deliverable', () => {
        assert.equal(isAuthDispatchError(secretDeliveryError()), false);
    });

    test('a transient reason stays retryable (no over-classification)', () => {
        assert.equal(isNonRetryableDispatchError(busyError()), false);
    });
});

describe('dispatch retry loop and secret_delivery_unavailable', () => {
    test('every role in the harness is covered, including ladders that do not abortOnNonRetryable', () => {
        assert.ok(ROLES.length > 0, 'expected roles to be found');
        assert.ok(ROLES.includes('reviewer') && ROLES.includes('plan-reviewer'), 'non-aborting ladders must be covered');
    });

    for (const role of ROLES) {
        test(`${role}: dispatched exactly once, no self-heal, remedy surfaced`, async () => {
            const { ctx, rec } = createRecordingCtx({ responses: [secretDeliveryError()] });
            let thrown = null;
            try { await dispatchRole(ctx, role, ROLE_CALL_OPTS[role]); } catch (e) { thrown = e; }
            assert.equal(rec.dispatches.length, 1, `${role}: expected one attempt`);
            assert.equal(rec.authHeals.length, 0, 'not an auth failure: no provision_llm_auth self-heal');
            const surfaced = rec.logs.join('\n') + (thrown ? `\n${thrown.message}` : '');
            assert.match(surfaced, /SFTP/);
            assert.match(surfaced, /stored credentials/);
        });
    }

    test('a transient failure in the same harness is still retried', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [busyError(), 'DONE'] });
        await dispatchRole(ctx, 'doer', ROLE_CALL_OPTS.doer);
        assert.ok(rec.dispatches.length >= 2, `expected a retry, got ${rec.dispatches.length}`);
    });
});
