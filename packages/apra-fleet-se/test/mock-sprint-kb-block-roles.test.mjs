import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { kbKnowledgeBlock } from '../fleet-sprint/kb.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// The engine-built KNOWLEDGE BANK block goes ONLY to planner, plan-reviewer,
// doer and reviewer (per-round reviews and the final review). Deployer,
// integ-test-runner, regression-test-runner and harvester get no block AND
// trigger no KB read for one.
//
// Drives the REAL runner.js through a full mock sprint (plan, develop,
// review, deploy, integ, final review, regression, harvest) with a spy
// kbInjection: every blockFor() call is the engine's KB read for a block, so
// the recorded roles say exactly who read the KB, and the dispatched prompts
// say who got a block.
// =============================================================================

const BLOCK_HEADING = 'KNOWLEDGE BANK -- what this repo already knows';
const SENTINEL = 'Sentinel block-roles fact';

function spyKbInjection() {
    const roles = [];
    return {
        roles,
        shouldInject: () => true,
        async blockFor({ role }) {
            roles.push(role);
            return kbKnowledgeBlock(
                [{ id: 'kb-sentinel-1', type: 'knowledge', confidence: 'CONFIRMED', title: SENTINEL, summary: 'confirmed', source_files: ['src/x.mjs'] }],
                { source: 'query', reportEmpty: true },
            );
        },
    };
}

test('mock sprint: only planner, plan-reviewer, doer and reviewer read the KB and get the KNOWLEDGE BANK block', { timeout: scaledTimeout(300000) }, async () => {
    const spy = spyKbInjection();
    const r = await withScenarioMarkers('kb-block-roles', async () => runDevelopLoopScenario('kbblockroles', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: kb block roles scenario work' }],
        maxCycles: 1,
        withRunbooks: true,
        withRegressionPlaybook: true,
        kbInjection: spy,
    }));
    assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);

    const agents = r.dispatched.map((d) => d.agent);
    const excluded = ['deployer', 'integ-test-runner', 'regression-test-runner', 'harvester'];
    const included = ['planner', 'plan-reviewer', 'doer', 'reviewer'];
    // Non-vacuity: every role under test was really dispatched.
    for (const role of [...included, ...excluded]) {
        assert.ok(agents.includes(role), `${role} was never dispatched: ${JSON.stringify(agents)}`);
    }
    assert.ok(r.dispatched.some((d) => d.label === 'Final Review'), 'the final review was never dispatched');

    // (a) No KB read for a block and no block in the prompt for the excluded roles.
    for (const role of excluded) {
        assert.ok(!spy.roles.includes(role), `${role} must trigger no KB read; blockFor roles: ${JSON.stringify(spy.roles)}`);
        for (const d of r.dispatched.filter((x) => x.agent === role)) {
            assert.ok(!d.prompt.includes(BLOCK_HEADING), `${role} prompt must carry no KNOWLEDGE BANK block`);
            assert.ok(!d.prompt.includes(SENTINEL), `${role} prompt must carry no KB entries`);
        }
    }
    for (const role of spy.roles) assert.ok(included.includes(role), `unexpected KB read for ${role}`);

    // (b) The four block roles (and the final review, a reviewer dispatch) get the block.
    for (const role of included) {
        const first = r.dispatched.find((x) => x.agent === role && !x.resume);
        assert.ok(first.prompt.includes(BLOCK_HEADING) && first.prompt.includes(SENTINEL), `${role} prompt must carry the block`);
    }
    const finalReview = r.dispatched.find((d) => d.label === 'Final Review');
    assert.ok(finalReview.prompt.includes(BLOCK_HEADING) && finalReview.prompt.includes(SENTINEL), 'the final review must carry the block');
});
