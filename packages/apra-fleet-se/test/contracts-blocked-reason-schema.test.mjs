import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-u1qw.1.2 -- schema-validation tests for the optional
// blockedReason field (apra-fleet-u1qw.1.1) on the deployer,
// integ-test-runner and regression-test-runner output schemas.
//
// Uses the same "wired" pattern as contracts-schema-loader.test.mjs's
// Group 2: point APRA_FLEET_SE_SCHEMAS_DIR at the real
// packages/apra-fleet-se/apra-pm/agents/schemas/ directory (the canonical
// source that apra-fleet-u1qw.1.1 edited) *before* importing
// contracts.mjs, so SCHEMAS.deployerReport/integReport/regressionReport
// are loaded from those files rather than contracts.mjs's own fallback
// literals (which deliberately do not carry blockedReason -- see
// FALLBACK_deployerReport et al.).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas');

describe('blockedReason on deploy/test role output schemas (wired against real apra-pm schemas)', () => {
    let wired;

    before(async () => {
        const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        process.env.APRA_FLEET_SE_SCHEMAS_DIR = SCHEMAS_DIR;
        wired = await import(`../fleet-sprint/contracts.mjs?blocked-reason-test=${Date.now()}`);
        if (previous === undefined) {
            delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        } else {
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
        }
    });

    const CASES = {
        deployerReport: {
            base: { deployed: false, notes: 'blocked: permission denied writing deploy.log' },
        },
        integReport: {
            base: {
                featuresClosed: 0,
                issuesCreated: 0,
                passed: false,
                bugsFiled: [],
                summary: 'blocked: permission denied running smoke test',
            },
        },
        regressionReport: {
            base: {
                passed: false,
                suitePassed: false,
                smokePassed: false,
                bugsFiled: [],
                summary: 'blocked: permission denied running regression suite',
            },
        },
    };

    for (const [name, { base }] of Object.entries(CASES)) {
        describe(name, () => {
            test('AC1: validates WITHOUT blockedReason (backward compatibility)', () => {
                const result = wired.validateVerdict(name, base);
                assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
                assert.strictEqual(result.errors, null);
                assert.ok(!('blockedReason' in base) || base.blockedReason === undefined);
            });

            test('AC2: validates WITH blockedReason=missing_permissions, and the parsed value is readable', () => {
                const withReason = { ...base, blockedReason: 'missing_permissions' };
                const result = wired.validateVerdict(name, withReason);
                assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
                assert.strictEqual(result.errors, null);
                // Caller-readability: the field survives untouched on the
                // object ajv validated -- this is what a runner.js dispatch
                // site would read to trigger the heal path.
                assert.strictEqual(withReason.blockedReason, 'missing_permissions');
            });

            test('AC3: rejects a non-string blockedReason', () => {
                const badType = { ...base, blockedReason: 42 };
                const result = wired.validateVerdict(name, badType);
                assert.strictEqual(result.valid, false);
                assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
            });

            test('AC3: rejects an unknown blockedReason enum value', () => {
                const badValue = { ...base, blockedReason: 'network_down' };
                const result = wired.validateVerdict(name, badValue);
                assert.strictEqual(result.valid, false);
                assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
            });
        });
    }
});
