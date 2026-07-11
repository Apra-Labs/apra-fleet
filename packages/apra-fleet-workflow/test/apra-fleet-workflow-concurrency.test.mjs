import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';

// Regression tests for apra-fleet-unw.9 (F11): per-run execution context, no
// shared mutable phase/args, UUID activity ids.
//
// Before this change:
//   - `WorkflowEngine.executeFile()` mutated a single shared
//     `this.wf.args` field per call, so two concurrent `executeFile()`
//     invocations against the SAME `FleetWorkflow` instance would corrupt
//     each other's `args`.
//   - `FleetWorkflow.phase()` mutated a single shared `this.currentPhase`
//     field, so `parallel()` branches that each called `phase()` with a
//     different value would leak their phase onto sibling branches (and
//     onto sibling runs) -- whichever branch called `phase()` last "won"
//     for every activity emitted afterwards, regardless of which branch
//     actually dispatched it.
//
// These tests exercise both bugs end-to-end via `WorkflowEngine.executeFile()`
// (not by poking `FleetWorkflow` internals directly), using fixture scripts
// under ./fixtures/, and assert against the `activity:start`/`activity:end`
// events a real dashboard viewer would consume.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

const KNOWN_MEMBERS = new Set(['fleet-dev']);

/**
 * A minimal mock fleetApi that echoes the prompt back in the response text
 * (so tests can confirm each run/branch got its own, uncorrupted prompt) and
 * introduces no artificial delay of its own -- the fixtures control timing
 * via their own `setTimeout` waits so interleaving is deterministic.
 */
function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('apra-fleet-unw.9: per-run execution context (F11)', () => {
    test('two concurrent executeFile() runs on one FleetWorkflow instance keep distinct args and phase attribution (no cross-run bleed)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const activityStarts = [];
        wf.on('activity:start', (meta) => activityStarts.push({ ...meta }));

        // Run A is the slower run: it sets its phase, then sleeps long
        // enough for Run B to start, set ITS OWN (different) phase, and
        // finish entirely, before Run A's agent() call actually reads the
        // "current" phase and dispatches. Under the old shared-instance-state
        // implementation, Run A's activity would incorrectly end up labeled
        // with Run B's phase (or Run B's args).
        const runA = engine.executeFile(fixture('test-concurrent-run.mjs'), { tag: 'A', delayMs: 40 });
        const runB = engine.executeFile(fixture('test-concurrent-run.mjs'), { tag: 'B', delayMs: 0 });

        const [resultA, resultB] = await Promise.all([runA, runB]);

        assert.strictEqual(resultA.tag, 'A');
        assert.strictEqual(resultA.result, 'echo: hello from A');
        assert.strictEqual(resultB.tag, 'B');
        assert.strictEqual(resultB.result, 'echo: hello from B');

        assert.strictEqual(activityStarts.length, 2, 'expected exactly one activity:start per run');

        const activityA = activityStarts.find((a) => a.label === 'A');
        const activityB = activityStarts.find((a) => a.label === 'B');
        assert.ok(activityA, 'expected an activity for run A');
        assert.ok(activityB, 'expected an activity for run B');

        // Core assertion: each run's activity carries ONLY its own phase --
        // Run A's slow agent() dispatch must still see 'Phase-A', not
        // 'Phase-B' left behind by the faster, already-finished Run B.
        assert.strictEqual(activityA.phase, 'Phase-A');
        assert.strictEqual(activityB.phase, 'Phase-B');

        // Every event carries a runId, and the two runs' events must be
        // distinguishable by it.
        assert.ok(activityA.runId, 'expected activity A to carry a runId');
        assert.ok(activityB.runId, 'expected activity B to carry a runId');
        assert.notStrictEqual(activityA.runId, activityB.runId);
    });

    test('parallel() branches that each call phase() with a distinct value do not cross-contaminate each other\'s activity phase labels', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const activityStarts = [];
        wf.on('activity:start', (meta) => activityStarts.push({ ...meta }));

        const result = await engine.executeFile(fixture('test-concurrent-parallel-phase.mjs'), {});
        assert.strictEqual(result.status, 'success');

        assert.strictEqual(activityStarts.length, 3, 'expected exactly one activity per parallel branch');

        const byLabel = Object.fromEntries(activityStarts.map((a) => [a.label, a]));
        assert.ok(byLabel.alpha && byLabel.beta && byLabel.gamma, 'expected activities for all three branches');

        // This is the exact F11 regression: branch 'alpha' is the slowest
        // (sleeps 40ms after calling phase('Phase-alpha')), so branches
        // 'beta' and 'gamma' both call phase() with THEIR OWN values and
        // fully dispatch before 'alpha' wakes up. Under the old shared
        // `currentPhase` field, 'alpha's activity would have been mislabeled
        // with 'Phase-gamma' (whichever branch's phase() ran last).
        assert.strictEqual(byLabel.alpha.phase, 'Phase-alpha');
        assert.strictEqual(byLabel.beta.phase, 'Phase-beta');
        assert.strictEqual(byLabel.gamma.phase, 'Phase-gamma');

        // All three branches belong to the SAME run, so they must all share
        // one runId.
        const runIds = new Set(activityStarts.map((a) => a.runId));
        assert.strictEqual(runIds.size, 1, `expected all branches to share one runId, got: ${[...runIds]}`);
        assert.ok([...runIds][0], 'expected a truthy runId');
    });
});

describe('apra-fleet-unw.9: UUID activity ids (no Math.random)', () => {
    test('agent()/command() activity ids are RFC-4122 UUIDs, not Math.random().toString(36) fragments', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());

        const ids = [];
        wf.on('activity:start', (meta) => ids.push(meta.id));

        await wf.agent('hello', { member_name: 'fleet-dev' });
        await wf.command('echo hi', { member_name: 'fleet-dev' });

        assert.strictEqual(ids.length, 2);
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const id of ids) {
            assert.match(id, uuidRe, `expected a UUID activity id, got: ${id}`);
        }
        assert.notStrictEqual(ids[0], ids[1]);
    });
});
