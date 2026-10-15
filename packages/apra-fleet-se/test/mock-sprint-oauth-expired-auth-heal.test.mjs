import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { isAuthDispatchError, isNonRetryableDispatchError } from '../fleet-sprint/errors.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// An expired-OAuth dispatch result ("Failed to authenticate: OAuth session
// expired and could not be refreshed") must be treated as an LLM auth failure:
// one provision_llm_auth heal + one retry, and on heal failure a loud error
// naming the member and the fix, never the generic server retry ladder.

const OAUTH_MSG = 'Failed to authenticate: OAuth session expired and could not be refreshed';

const authFailure = () => ({
    content: [{ text: OAUTH_MSG }],
    structuredContent: { isError: true, reason: 'auth' },
});

test('isAuthDispatchError / isNonRetryableDispatchError recognise the expired-OAuth text by message alone', () => {
    const err = new Error(OAUTH_MSG);
    assert.equal(isAuthDispatchError(err), true);
    assert.equal(isNonRetryableDispatchError(err), true);
});

test('mock sprint: expired-OAuth planner failure -> exactly one provision_llm_auth heal and one retry that succeeds', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('oauthexpiredhealok', async () => {
        let plannerCalls = 0;
        let healCalls = 0;
        const sc = await runDevelopLoopScenario('oauthexpiredhealok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: OAuth-expired heal success scenario work' }],
            maxCycles: 1,
            callTool: async (name) => {
                if (name === 'provision_llm_auth') {
                    healCalls += 1;
                    return { content: [{ text: '[OK] provisioned LLM credentials' }] };
                }
                return { content: [{ text: `mock ${name}` }] };
            },
            plannerHandler: async () => {
                plannerCalls += 1;
                if (plannerCalls === 1) return authFailure();
                return { content: [{ text: 'Planned the epic: tasks exist for implementation and e2e tests.' }] };
            },
        });
        assert.equal(healCalls, 1, `expected exactly one provision_llm_auth call, got ${healCalls}`);
                assert.equal(plannerCalls, 2, `expected exactly one retry after the heal, got ${plannerCalls} planner calls`);
        assert.ok(sc.logs.some((m) => m.includes('LLM auth self-heal succeeded')), 'heal success logged');
    });
});

test('mock sprint: expired-OAuth planner failure with a failed heal -> sprint fails naming member and fix, zero generic retries', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('oauthexpiredhealfail', async () => {
        let plannerCalls = 0;
        let healCalls = 0;
        const sc = await runDevelopLoopScenario('oauthexpiredhealfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: OAuth-expired heal failure scenario work' }],
            maxCycles: 1,
            callTool: async (name) => {
                if (name === 'provision_llm_auth') {
                    healCalls += 1;
                    return { isError: true, content: [{ text: '[FAIL] source login is dead' }] };
                }
                return { content: [{ text: `mock ${name}` }] };
            },
            plannerHandler: async () => {
                plannerCalls += 1;
                return authFailure();
            },
        });
        assert.ok(sc.error, 'expected the sprint to fail');
        assert.equal(healCalls, 1, `expected exactly one heal attempt, got ${healCalls}`);
        assert.equal(plannerCalls, 1, `expected zero generic retries (single planner dispatch), got ${plannerCalls}`);
        assert.ok(!sc.logs.some((m) => m.includes('before retry attempt') || m.includes('waiting')),
            `no retry waits expected, logs: ${JSON.stringify(sc.logs)}`);
        const text = `${sc.error.message}\n${sc.logs.join('\n')}`;
        assert.match(text, /local/, 'names the member');
        assert.match(text, /\/login/, 'names the fix');
        assert.match(text, /provision_llm_auth/, 'names the fix');
    });
});
