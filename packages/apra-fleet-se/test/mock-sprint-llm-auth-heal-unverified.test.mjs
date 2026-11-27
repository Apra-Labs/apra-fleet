import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { LLM_AUTH_SELF_HEAL_FAILED_CODE } from '../fleet-sprint/errors.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// End to end through the real runner: a Planner dispatch fails with an LLM
// auth error, and the one self-heal (provision_llm_auth) re-deploys the
// credentials but its post-deploy auth test FAILS (reason deployed_unverified,
// "OAuth token revoked"). That heal did not heal, so the sprint must end at
// once with the typed cause -- never "self-heal succeeded -- retrying", never a
// backoff wait, never a second Planner dispatch.
//
// Backoff observation: the harness runs the ladder with its instant-backoff
// flag, so a requested wait shows up only as the ladder's own
// "waiting Ns before retry attempt" log line; zero such lines = zero waits.

const AUTH_FAILURE = () => ({
    content: [{ text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
    structuredContent: { isError: true, reason: 'auth' },
});

const UNVERIFIED = {
    content: [{ text: '[OK] OAuth token provisioned on "local"\n  Auth test: FAILED -- OAuth token revoked\n' }],
    structuredContent: { ok: true, reason: 'deployed_unverified', verified: false },
};
const HEALED = {
    content: [{ text: '[OK] OAuth token provisioned on "local"\n  Auth test: OK\n' }],
    structuredContent: { ok: true, reason: 'ok', verified: true },
};

function provisionCallTool(result, counter) {
    return async (name) => {
        if (name === 'provision_llm_auth') {
            counter.heals += 1;
            return result;
        }
        return { content: [{ text: `mock ${name}` }] };
    };
}

const waitLines = (logs) => logs.filter((m) => /waiting [\d.]+s before retry attempt/.test(m));

test('mock sprint: a failed post-provision auth test aborts the sprint at once with the typed cause', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('llmauthhealunverified', async () => {
        const counter = { heals: 0 };
        let plannerCalls = 0;
        const sc = await runDevelopLoopScenario('llmauthhealunverified', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: LLM auth heal unverified scenario work' }],
            maxCycles: 1,
            callTool: provisionCallTool(UNVERIFIED, counter),
            plannerHandler: async () => {
                plannerCalls += 1;
                return AUTH_FAILURE();
            },
        });

        assert.ok(sc.error, 'expected the sprint to abort with a surfaced error');
        assert.equal(counter.heals, 1, `expected exactly one provision_llm_auth call, got ${counter.heals}`);
        assert.equal(plannerCalls, 1, `expected no re-dispatch after the failed heal, got ${plannerCalls} Planner dispatches`);

        assert.ok(!sc.logs.some((m) => m.includes('self-heal succeeded')),
            `no 'self-heal succeeded' line expected, logs: ${JSON.stringify(sc.logs)}`);
        assert.deepEqual(waitLines(sc.logs), [], 'no backoff wait may be requested after the failed heal');

        // The thrown error carries the typed code, the cause and the remedy.
        assert.equal(sc.error.code, LLM_AUTH_SELF_HEAL_FAILED_CODE, `expected the typed code, got ${sc.error.code}: ${sc.error.message}`);
        assert.equal(sc.error.healCause, 'Auth test: FAILED -- OAuth token revoked');
        assert.match(sc.error.message, /OAuth token revoked/);
        assert.match(sc.error.message, /\/login on the source machine, then re-run provision_llm_auth/);

        // And the persisted terminal record says the same.
        const terminal = sc.states.filter((s) => s.namespace === 'terminal' && s.data);
        assert.ok(terminal.length > 0, `expected a terminal sprint-state record, states: ${JSON.stringify(sc.states)}`);
        assert.ok(
            terminal.some((s) => typeof s.data.message === 'string'
                && /OAuth token revoked/.test(s.data.message)
                && /\/login on the source machine, then re-run provision_llm_auth/.test(s.data.message)),
            `expected the terminal record to carry the cause and remedy, got: ${JSON.stringify(terminal)}`,
        );
    });
});

test('mock sprint: control -- a provision_llm_auth that verifies (reason ok) heals, retries once and the sprint continues', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('llmauthhealverified', async () => {
        const counter = { heals: 0 };
        let plannerCalls = 0;
        const sc = await runDevelopLoopScenario('llmauthhealverified', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: LLM auth heal verified scenario work' }],
            maxCycles: 1,
            callTool: provisionCallTool(HEALED, counter),
            plannerHandler: async () => {
                plannerCalls += 1;
                if (plannerCalls === 1) return AUTH_FAILURE();
                return { content: [{ text: 'Planned the epic: tasks exist for implementation and e2e tests.' }] };
            },
        });

        assert.equal(counter.heals, 1, `expected exactly one provision_llm_auth call, got ${counter.heals}`);
        assert.equal(plannerCalls, 2, `expected exactly one healed retry, got ${plannerCalls} Planner dispatches`);
        assert.ok(sc.logs.some((m) => m.includes('LLM auth self-heal succeeded -- retrying')), 'heal success logged');
        assert.ok(!sc.error || sc.error.code !== LLM_AUTH_SELF_HEAL_FAILED_CODE,
            `the healed sprint must not end on the heal-failure error, got: ${sc.error && sc.error.message}`);
        assert.ok(sc.logs.some((m) => m.includes('Phase: Develop') || m.includes('Develop C1')),
            'the sprint continued past planning into Develop');
    });
});
