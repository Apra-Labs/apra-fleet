import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { SPRINT_ANALYSIS_STATE_NAMESPACE } from '../fleet-sprint/phases/harvest.mjs';

// A mock sprint reaching Harvest publishes the engine's analysis text in the
// 'sprint-analysis' run-state namespace (the viewer keeps every published
// namespace in the terminal run state) and never commits the analysis file.

test('mock sprint: Harvest publishes the engine analysis text under sprint-analysis and never stages it', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('analysispersist', async () => {
        const harvesterPrompts = [];
        const sc = await runDevelopLoopScenario('analysispersist', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: analysis persistence scenario work' }],
            maxCycles: 1,
            harvesterHandler: async ({ opts }) => {
                harvesterPrompts.push(opts.prompt);
                return { content: [{ text: JSON.stringify({ status: 'OK', notes: 'ok' }) }] };
            },
        });
        assert.equal(sc.error, null, `no abort: ${sc.error && sc.error.message}`);
        assert.equal(harvesterPrompts.length, 1, 'harvester dispatched once');

        const events = sc.states.filter((e) => e.namespace === SPRINT_ANALYSIS_STATE_NAMESPACE);
        assert.equal(events.length, 1, 'exactly one sprint-analysis publish');
        const { text, generatedAt } = events[0].data;
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 0, 'analysis text is non-empty');
        assert.ok(!Number.isNaN(Date.parse(generatedAt)), 'generatedAt is an ISO timestamp');
        assert.ok(harvesterPrompts[0].includes(text), 'persisted text is exactly the text handed to the harvester');

        // Never committed: the engine issues no git add/commit naming the analysis file.
        const staged = sc.commandLog.filter((c) => /git\s+(add|commit)/.test(c) && /sprint-analysis/.test(c));
        assert.deepEqual(staged, [], 'no git add/commit of the analysis file');
    });
});
