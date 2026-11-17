import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    isNonRetryableDispatchError,
    isAuthDispatchError,
    isInfraDispatchFailure,
} from '../fleet-sprint/errors.mjs';

// =============================================================================
// Unit coverage for the preflight_* branches errors.mjs added on top of the
// pre-existing 'auth' / 'workspace_not_trusted' dispatch-reason vocabulary
// (see execute-prompt.ts's preflightCheck() -> preflight_offline /
// preflight_auth_missing / preflight_auth_expired reason mapping).
//
// Each preflight_* code routes DIFFERENTLY across the three classifiers:
//   - preflight_offline:      infra failure only (retryable once connectivity
//                             recovers -- NOT an auth problem, so must not be
//                             classified as non-retryable/auth).
//   - preflight_auth_missing: non-retryable AND an auth failure -- but NOT an
//                             infra failure (the member IS reachable; it is
//                             the credential that is missing).
//   - preflight_auth_expired: same bucket as auth_missing.
// This table pins that 3x3 matrix explicitly so a future edit to any one
// classifier cannot silently misroute a preflight code into the wrong bucket.
// =============================================================================

const err = (reason) => ({ details: { reason } });

const ROWS = [
    { reason: 'preflight_offline', nonRetryable: false, auth: false, infra: true },
    { reason: 'preflight_auth_missing', nonRetryable: true, auth: true, infra: false },
    { reason: 'preflight_auth_expired', nonRetryable: true, auth: true, infra: false },
];

describe('errors.mjs -- preflight_* reason classification', () => {
    for (const row of ROWS) {
        test(`reason=${row.reason}: isNonRetryableDispatchError=${row.nonRetryable}, isAuthDispatchError=${row.auth}, isInfraDispatchFailure=${row.infra}`, () => {
            const e = err(row.reason);
            assert.equal(isNonRetryableDispatchError(e), row.nonRetryable, `isNonRetryableDispatchError mismatch for ${row.reason}`);
            assert.equal(isAuthDispatchError(e), row.auth, `isAuthDispatchError mismatch for ${row.reason}`);
            assert.equal(isInfraDispatchFailure(e), row.infra, `isInfraDispatchFailure mismatch for ${row.reason}`);
        });
    }

    test('a plain Error with a preflight-like message but no details.reason falls back to the message regex (no false positive)', () => {
        // Guards against a naive implementation that string-matches on
        // "preflight" in the message instead of requiring the structured
        // details.reason field.
        const plainError = new Error('Pre-dispatch check failed for "m1": Member is unreachable');
        assert.equal(isNonRetryableDispatchError(plainError), false);
        assert.equal(isAuthDispatchError(plainError), false);
        assert.equal(isInfraDispatchFailure(plainError), false);
    });

    test('an unrecognized reason string is not misclassified into any preflight bucket', () => {
        const e = err('some_other_reason');
        assert.equal(isNonRetryableDispatchError(e), false);
        assert.equal(isAuthDispatchError(e), false);
        assert.equal(isInfraDispatchFailure(e), false);
    });
});
