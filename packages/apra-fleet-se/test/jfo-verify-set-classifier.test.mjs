import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyVerifySet, buildPlannerPrompt, buildFinalVerdictPrompt } from '../fleet-sprint/runner.js';

// Unit tests for apra-fleet-jfo's classifyVerifySet(): the phase-routing
// initial slice that classifies "all children closed" beads into the
// `verify` route instead of administratively closing them (rejected design)
// or leaving them silently stuck (tonight's actual bug on apra-fleet-l7n and
// apra-fleet-2sn).

function bead(id, overrides = {}) {
    return {
        id,
        status: 'open',
        parent: null,
        dependencies: [],
        issue_type: 'task',
        ...overrides,
    };
}

describe('classifyVerifySet', () => {
    test('a childless parent is never eligible (leaf, routes plan)', () => {
        const beads = [bead('p1')];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, []);
    });

    test('partial closure never qualifies', () => {
        const beads = [
            bead('p1'),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
            bead('p1.2', { parent: 'p1', status: 'open' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, []);
    });

    test('all children closed -> parent qualifies, any issue_type', () => {
        for (const issue_type of ['bug', 'feature', 'task', 'epic']) {
            const beads = [
                bead('p1', { issue_type }),
                bead('p1.1', { parent: 'p1', status: 'closed' }),
                bead('p1.2', { parent: 'p1', status: 'closed' }),
            ];
            const { verifyIds } = classifyVerifySet(beads, ['p1']);
            assert.deepStrictEqual(verifyIds, ['p1'], `issue_type=${issue_type} should qualify`);
        }
    });

    test('an already-closed parent is not re-classified', () => {
        const beads = [
            bead('p1', { status: 'closed' }),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, []);
    });

    test('an unmet blocks dependency excludes the parent (inv-4)', () => {
        const beads = [
            bead('p1', { dependencies: [{ type: 'blocks', depends_on_id: 'blocker' }] }),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
            bead('blocker', { status: 'open' }),
        ];
        const { verifyIds, ineligible } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, []);
        assert.strictEqual(ineligible.length, 1);
        assert.strictEqual(ineligible[0].id, 'p1');
    });

    test('a closed blocker no longer excludes the parent', () => {
        const beads = [
            bead('p1', { dependencies: [{ type: 'blocks', depends_on_id: 'blocker' }] }),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
            bead('blocker', { status: 'closed' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, ['p1']);
    });

    test(
        'checks children against the FULL bead list, not scope-filtered -- ' +
        'fixes the premature-closure bug in the old pendingClosureBugs derivation',
        () => {
            // p1 is the sprint's own target; p1.2 is a child that happens to sit
            // OUTSIDE the BFS scope reachable from targetIssues (simulated here by
            // simply not being discoverable via parent chain from the target --
            // but still present in allBeads and still a real child of p1). A
            // scope-filtered check would miss it; the classifier must not.
            const beads = [
                bead('p1'),
                bead('p1.1', { parent: 'p1', status: 'closed' }),
                bead('p1.2', { parent: 'p1', status: 'open' }), // still open, must block
            ];
            const { verifyIds } = classifyVerifySet(beads, ['p1']);
            assert.deepStrictEqual(verifyIds, []);
        }
    );

    test('a target bead itself, all-children-closed, is admitted (pure-verify sprint case)', () => {
        const beads = [
            bead('p1'),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, ['p1']);
    });

    test('nested parents cascade one level at a time', () => {
        const beads = [
            bead('grandparent'),
            bead('parent', { parent: 'grandparent', status: 'closed' }), // not yet -- simulate mid-cascade
            bead('child', { parent: 'parent', status: 'closed' }),
        ];
        // grandparent's only child ('parent') is closed -> grandparent qualifies
        // this round; 'parent' itself is already closed so it is not re-classified.
        const { verifyIds } = classifyVerifySet(beads, ['grandparent']);
        assert.deepStrictEqual(verifyIds, ['grandparent']);
    });

    test('an in_progress parent with all children closed still qualifies', () => {
        const beads = [
            bead('p1', { status: 'in_progress' }),
            bead('p1.1', { parent: 'p1', status: 'closed' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['p1']);
        assert.deepStrictEqual(verifyIds, ['p1']);
    });

    test('multiple independent parents in scope are all classified', () => {
        const beads = [
            bead('root'),
            bead('bugA', { parent: 'root' }),
            bead('bugA.1', { parent: 'bugA', status: 'closed' }),
            bead('bugB', { parent: 'root' }),
            bead('bugB.1', { parent: 'bugB', status: 'open' }),
        ];
        const { verifyIds } = classifyVerifySet(beads, ['root']);
        assert.deepStrictEqual(verifyIds, ['bugA']);
    });
});

describe('buildPlannerPrompt verify-route exclusion clause', () => {
    test('names verify-excluded ids when present', () => {
        const prompt = buildPlannerPrompt({
            isDeltaCycle: false,
            targetIssues: ['root'],
            goal: 'P1/P2',
            requirementsFile: undefined,
            requirementsContent: null,
            feedback: null,
            verifyExcluded: ['bugA', 'bugB'],
        });
        assert.match(prompt, /VERIFY-ROUTE EXCLUSION/);
        assert.match(prompt, /bugA, bugB/);
        assert.match(prompt, /Do NOT create tasks for them/);
    });

    test('omits the clause entirely when the verify set is empty', () => {
        const prompt = buildPlannerPrompt({
            isDeltaCycle: false,
            targetIssues: ['root'],
            goal: 'P1/P2',
            requirementsFile: undefined,
            requirementsContent: null,
            feedback: null,
            verifyExcluded: [],
        });
        assert.doesNotMatch(prompt, /VERIFY-ROUTE EXCLUSION/);
    });
});

// apra-fleet-jfo.2: the structural gap identified after 2g2's redeploy --
// verify-routed beads (parents with children) are excluded from
// `openAtGoal`/`finalOpenAtGoal` no matter their status, so a Deploy
// failure that skips IntegTest could let a sprint finalize as "done" with
// verify targets never actually re-verified. buildFinalVerdictPrompt's
// `unclosedVerifyIds` param is the Final Review's half of the fix: it must
// surface any still-open verify-routed bead as explicit evidence and
// instruct the reviewer not to rubber-stamp PASS on the (misleadingly
// zero) openAtGoalCount alone.
describe('buildFinalVerdictPrompt unclosed-verify-beads evidence', () => {
    const baseArgs = {
        targetIssues: ['root'],
        branch: 'sprint-branch',
        baseBranch: 'main',
        goal: 'P1/P2',
        cyclesRun: 5,
        closedCount: 3,
        openAtGoalCount: 0,
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
    };

    test('names still-open verify-routed beads and warns against rubber-stamping PASS', () => {
        const prompt = buildFinalVerdictPrompt({
            ...baseArgs,
            unclosedVerifyIds: ['parentA', 'parentB'],
        });
        assert.match(prompt, /STILL OPEN/);
        assert.match(prompt, /parentA, parentB/);
        assert.match(prompt, /do not treat 0 open-at-goal as/);
    });

    test('omits the evidence block entirely when no verify-routed bead is unclosed', () => {
        const prompt = buildFinalVerdictPrompt({
            ...baseArgs,
            unclosedVerifyIds: [],
        });
        assert.doesNotMatch(prompt, /STILL OPEN/);
    });

    test('defaults unclosedVerifyIds to empty when the param is omitted (backward compatible)', () => {
        const prompt = buildFinalVerdictPrompt({ ...baseArgs });
        assert.doesNotMatch(prompt, /STILL OPEN/);
    });
});
