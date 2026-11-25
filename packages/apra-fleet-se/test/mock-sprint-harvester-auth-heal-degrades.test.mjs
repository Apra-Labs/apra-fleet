import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, withStagedBodies, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { LLM_AUTH_SELF_HEAL_FAILED_CODE } from '../fleet-sprint/errors.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// A PASS sprint whose harvester member's LLM auth cannot be healed (the
// provision_llm_auth post-deploy auth test fails) must still publish its PR:
// the harvest report is informational, so the ladder logs the failed heal
// loudly, spends no further attempt and degrades to "no harvest report".

const AUTH_FAILURE = () => ({
    content: [{ text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
    structuredContent: { isError: true, reason: 'auth' },
});
const UNVERIFIED = {
    content: [{ text: '[OK] OAuth token provisioned on "local"\n  Auth test: FAILED -- OAuth token revoked\n' }],
    structuredContent: { ok: true, reason: 'deployed_unverified', verified: false },
};

test('mock sprint: a failed harvester auth heal still publishes the PR, without the harvest report, and logs loudly', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('harvesterauthhealfail', async () => {
        let heals = 0;
        let harvesterCalls = 0;
        const sc = await runDevelopLoopScenario('harvesterauthhealfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: harvester auth heal failure scenario work' }],
            maxCycles: 1,
            callToolFactory: (executeCommand) => {
                const base = defaultMockCallTool({ executeCommand });
                return async (name, toolArgs) => {
                    if (name === 'provision_llm_auth') { heals += 1; return UNVERIFIED; }
                    return base(name, toolArgs);
                };
            },
            harvesterHandler: async () => {
                harvesterCalls += 1;
                return AUTH_FAILURE();
            },
        });

        assert.equal(sc.error, null, `the sprint must not abort: ${sc.error && sc.error.message}`);
        assert.ok(sc.result && sc.result.status === 'success', `expected success, got ${JSON.stringify(sc.result)}`);
        assert.equal(harvesterCalls, 1, 'no further harvester attempt after a failed heal');
        assert.equal(heals, 1, 'exactly one provision_llm_auth call');
        assert.ok(sc.logs.some((m) => /LLM auth self-heal failed/.test(m) && /OAuth token revoked/.test(m)),
            `the failed heal must be logged loudly, logs: ${JSON.stringify(sc.logs)}`);
        assert.ok(!sc.logs.some((m) => m.includes('self-heal succeeded')), 'no success log');
        assert.ok(!sc.error || sc.error.code !== LLM_AUTH_SELF_HEAL_FAILED_CODE);
        assert.ok(
            withStagedBodies(sc.commandLog).some((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')),
            'the PR must still be published',
        );
    });
});
