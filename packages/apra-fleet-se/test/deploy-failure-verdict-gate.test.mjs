// Unit tests for the deploy-failure verdict gate helpers in
// fleet-sprint/phases/deploy.mjs (apra-fleet-b4g.102.1): a sprint whose LAST
// cycle's deploy failed can never end with a PASS verdict, and the reason
// names the cycle and the deployer's notes. The end-to-end behaviour through
// the real runner is pinned by mock-sprint-deploy-failure-verdict.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    latestDeployFailure,
    formatDeployFailureReason,
    applyDeployFailureVerdictGate,
    DEPLOY_RETRY_CYCLE_LIMIT,
} from '../fleet-sprint/phases/deploy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('latestDeployFailure', () => {
    test('no deploy.md -> null, whatever the failure history says', () => {
        assert.equal(latestDeployFailure({ hasDeploy: false, deployedThisCycle: false, cycle: 2, deployFailures: [{ cycle: 2, notes: 'x' }] }), null);
    });
    test('deploy succeeded this cycle -> null, even after an earlier failure', () => {
        assert.equal(latestDeployFailure({ hasDeploy: true, deployedThisCycle: true, cycle: 2, deployFailures: [{ cycle: 1, notes: 'boom' }] }), null);
    });
    test('deploy failed this cycle -> that cycle and its notes', () => {
        assert.deepEqual(
            latestDeployFailure({ hasDeploy: true, deployedThisCycle: false, cycle: 2, deployFailures: [{ cycle: 1, notes: 'old' }, { cycle: 2, notes: 'port in use' }] }),
            { cycle: 2, notes: 'port in use' },
        );
    });
    test('deploy failed with no recorded notes -> still a failure, with a placeholder', () => {
        const f = latestDeployFailure({ hasDeploy: true, deployedThisCycle: false, cycle: 3, deployFailures: [] });
        assert.equal(f.cycle, 3);
        assert.match(f.notes, /no notes/);
    });
});

describe('applyDeployFailureVerdictGate', () => {
    const failure = { cycle: 2, notes: 'smoke test timed out' };

    test('no failure -> verdict object returned unchanged (same reference)', () => {
        const v = { verdict: 'PASS', notes: 'fine' };
        assert.equal(applyDeployFailureVerdictGate(v, null), v);
    });
    test('LLM PASS is overridden to FAIL; the notes lead with the cycle and deployer notes', () => {
        const v = { verdict: 'PASS', notes: 'All good.', newTasks: [] };
        const out = applyDeployFailureVerdictGate(v, failure);
        assert.equal(out.verdict, 'FAIL');
        assert.match(out.notes, /^Deploy FAILED in the last cycle \(C2\)/);
        assert.match(out.notes, /smoke test timed out/);
        assert.match(out.notes, /overrode it to FAIL/);
        assert.match(out.notes, /All good\./);
        assert.deepEqual(out.newTasks, []);
        assert.equal(v.verdict, 'PASS', 'input verdict object must not be mutated');
    });
    test('LLM FAIL stays FAIL and still names the deploy failure, without claiming an override', () => {
        const out = applyDeployFailureVerdictGate({ verdict: 'FAIL', notes: 'tests red' }, failure);
        assert.equal(out.verdict, 'FAIL');
        assert.match(out.notes, /C2/);
        assert.doesNotMatch(out.notes, /overrode/);
        assert.match(out.notes, /tests red/);
    });
    test('reason text is ASCII-only and names the cycle', () => {
        const r = formatDeployFailureReason(failure);
        assert.match(r, /C2/);
        assert.ok(/^[\x00-\x7f]*$/.test(r));
    });
    test('retry limit is a small positive bound', () => {
        assert.ok(Number.isInteger(DEPLOY_RETRY_CYCLE_LIMIT) && DEPLOY_RETRY_CYCLE_LIMIT >= 2);
    });
});

describe('wiring (source pins)', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'fleet-sprint', 'runner.js'), 'utf8');
    const finalReview = fs.readFileSync(path.join(__dirname, '..', 'fleet-sprint', 'phases', 'final-review.mjs'), 'utf8');

    test('both satisfied exits (root-closed and goal-priority) sit behind the deploy-blocked check', () => {
        const gate = runner.indexOf('if ((rootsAllClosed || goalSatisfied) && lastDeployFailure)');
        const rootExit = runner.indexOf('if (rootsAllClosed) {');
        const goalExit = runner.indexOf('if (goalSatisfied) {');
        assert.ok(gate > 0 && rootExit > gate && goalExit > gate);
    });
    test('runner threads lastDeployFailure into Final Review, which applies the gate', () => {
        assert.match(runner, /lastDeployFailure,\s*\n\s*bdListScoped, decomposedParentIds/);
        assert.match(finalReview, /applyDeployFailureVerdictGate\(finalVerdictResult, lastDeployFailure\)/);
    });
});
