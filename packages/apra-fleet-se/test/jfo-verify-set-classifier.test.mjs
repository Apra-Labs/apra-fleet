import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyVerifySet, buildPlannerPrompt, buildFinalVerdictPrompt, buildReviewerPrompt } from '../fleet-sprint/runner.js';
import { findUnreachableVerifyBlocks, verifyBlockFixCommands, selectReclaimCandidates, downstreamDependentIds } from '../fleet-sprint/beads-reachability.mjs';

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

// apra-fleet-jfo.3: hit live 2026-08-02 on apra-fleet-l7n's verify-only
// relaunch -- the Re-Review call site (runner.js ~8027) passed
// `beadIds: []` unconditionally, which buildReviewerPrompt renders as
// "Review the work just done for the following bead id(s): ." with nothing
// named. The reviewer correctly treats that as missing required input and
// refuses, which after one retry throws ReviewerContractViolationError and
// aborts the whole sprint -- the default path for any verify-only sprint
// whose Deploy fails on cycle 1 (openAtGoal reads 0, no review ran yet).
// These tests lock in the prompt-builder contract the fix relies on: a
// non-empty beadIds list (the call site now passes targetIssues) produces a
// well-formed, reviewable prompt.
//
// The empty-list case is now ALSO safe, from the other direction. jfo.3 fixed
// the call site; apra-fleet-s6d independently fixed the builder, so an empty
// beadIds list no longer renders the malformed "bead id(s): ." text at all --
// it gets its own coherent scope-wide framing ("No bead ids are named because
// no goal-priority beads remain open..."), which is a legitimate question for
// the Cycle Evaluation re-review to ask. The two fixes are defense in depth:
// the call site should never pass an empty list, and the builder no longer
// produces an incoherent prompt if something ever does. The assertion below
// therefore checks the malformed text is GONE, not that it reproduces.
describe('buildReviewerPrompt beadIds contract (regression for the Re-Review empty-beadIds bug)', () => {
    test('an empty beadIds array renders coherent scope-wide framing, never the malformed "bead id(s): ." prompt', () => {
        const prompt = buildReviewerPrompt({
            beadIds: [],
            acceptanceCriteriaJson: '[]',
            baseBranch: 'main',
            branch: 'sprint-branch',
            goal: 'P1/P2',
        });
        assert.doesNotMatch(prompt, /bead id\(s\): \./);
        assert.match(prompt, /No bead ids are named/);
    });

    test('passing the sprint\'s targetIssues as beadIds produces a well-formed, reviewable prompt', () => {
        const prompt = buildReviewerPrompt({
            beadIds: ['apra-fleet-6a7', 'apra-fleet-y8q'],
            acceptanceCriteriaJson: '[]',
            baseBranch: 'main',
            branch: 'sprint-branch',
            goal: 'P1/P2',
        });
        assert.match(prompt, /bead id\(s\): apra-fleet-6a7, apra-fleet-y8q\./);
        assert.doesNotMatch(prompt, /bead id\(s\): \./);
    });
});

// =============================================================================
// findUnreachableVerifyBlocks: a not-done bead whose ONLY unmet `blocks`
// dependencies are verify-routed beads can never become ready when no
// integ-test playbook exists (verify-routed beads close only through the
// integ phase), so the sprint deadlocks by construction. The helper finds
// exactly that shape, from the same verify set classifyVerifySet produces.
// =============================================================================
describe('findUnreachableVerifyBlocks', () => {
    // A task T blocked by two bugs whose children are all closed (both
    // verify-routed by classifyVerifySet), all under one epic.
    function verifyBlockedFixture() {
        return [
            bead('e', { issue_type: 'epic' }),
            bead('b1', { parent: 'e', issue_type: 'bug' }),
            bead('b1.1', { parent: 'b1', status: 'closed' }),
            bead('b2', { parent: 'e', issue_type: 'bug' }),
            bead('b2.1', { parent: 'b2', status: 'closed' }),
            bead('t', {
                parent: 'e',
                dependencies: [
                    { type: 'parent-child', depends_on_id: 'e' },
                    { type: 'blocks', depends_on_id: 'b1' },
                    { type: 'blocks', depends_on_id: 'b2' },
                ],
            }),
        ];
    }
    const notDone = (beads) => beads.filter((b) => b.status !== 'closed');

    test('a bead blocked only by verify-routed beads is reported with its blockers', () => {
        const beads = verifyBlockedFixture();
        const { verifyIds } = classifyVerifySet(beads, ['e']);
        assert.deepStrictEqual(verifyIds.slice().sort(), ['b1', 'b2']);
        assert.deepStrictEqual(findUnreachableVerifyBlocks(notDone(beads), verifyIds), [
            { id: 't', blockerIds: ['b1', 'b2'] },
        ]);
    });

    test('one non-verify unmet blocker means the bead is still reachable', () => {
        const beads = verifyBlockedFixture();
        beads.push(bead('x', { parent: 'e' }));
        beads.find((b) => b.id === 't').dependencies.push({ type: 'blocks', depends_on_id: 'x' });
        const { verifyIds } = classifyVerifySet(beads, ['e']);
        assert.deepStrictEqual(findUnreachableVerifyBlocks(notDone(beads), verifyIds), []);
    });

    test('closed blockers are met; a bead with no unmet blocker at all is not a hit', () => {
        const beads = [
            bead('t', { dependencies: [{ type: 'blocks', depends_on_id: 'done' }] }),
            bead('done', { status: 'closed' }),
        ];
        assert.deepStrictEqual(findUnreachableVerifyBlocks(notDone(beads), ['done']), []);
    });

    test('verify-routed and deferred beads are never themselves reported', () => {
        const beads = [
            bead('v1'),
            bead('v2', { dependencies: [{ type: 'blocks', depends_on_id: 'v1' }] }),
            bead('d', { status: 'deferred', dependencies: [{ type: 'blocks', depends_on_id: 'v1' }] }),
        ];
        assert.deepStrictEqual(findUnreachableVerifyBlocks(beads, ['v1', 'v2']), []);
    });

    test('non-blocks edges (related, parent-child) never make a bead unreachable', () => {
        const beads = [
            bead('v1'),
            bead('t', { dependencies: [{ type: 'related', depends_on_id: 'v1' }, { type: 'parent-child', depends_on_id: 'v1' }] }),
        ];
        assert.deepStrictEqual(findUnreachableVerifyBlocks(beads, ['v1']), []);
    });

    test('an explicit isUnmet predicate decides which blockers are still open', () => {
        // Cycle Evaluation passes only goal-priority beads, so a lower-priority
        // open blocker is not in the list; the predicate keeps it unmet.
        const beads = [bead('t', { dependencies: [{ type: 'blocks', depends_on_id: 'v1' }, { type: 'blocks', depends_on_id: 'lowpri' }] })];
        const closed = new Set();
        assert.deepStrictEqual(findUnreachableVerifyBlocks(beads, ['v1'], { isUnmet: (id) => !closed.has(id) }), []);
        closed.add('lowpri');
        assert.deepStrictEqual(findUnreachableVerifyBlocks(beads, ['v1'], { isUnmet: (id) => !closed.has(id) }), [
            { id: 't', blockerIds: ['v1'] },
        ]);
    });

    test('the fix commands name the exact bd dep edges to change', () => {
        assert.deepStrictEqual(verifyBlockFixCommands({ id: 't', blockerIds: ['b1', 'b2'] }), [
            'bd dep remove t b1',
            'bd dep add t b1 --type related',
            'bd dep remove t b2',
            'bd dep add t b2 --type related',
        ]);
    });
});

// =============================================================================
// selectReclaimCandidates: which in_progress beads the sprint may reset to
// open. A bead THIS run dispatched that is still in_progress once every
// dispatch has returned is an orphan and is always reclaimed; a claim that
// predates the sprint's launch is reclaimed only when the caller asks for the
// pre-launch rule and the bead has nothing left to wait on.
// =============================================================================
describe('selectReclaimCandidates', () => {
    const launch = Date.parse('2026-10-08T12:00:00Z');
    const before = '2026-10-08T11:00:00Z';
    const after = '2026-10-08T12:30:00Z';

    test('a dispatched bead left in_progress is an orphan regardless of started_at or blockers', () => {
        const beads = [
            bead('a', { status: 'in_progress', started_at: after }),
            bead('b', { status: 'in_progress', started_at: after, dependencies: [{ type: 'blocks', depends_on_id: 'c' }] }),
            bead('c'),
        ];
        const picked = selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(['a', 'b']), includePreLaunch: false });
        assert.deepStrictEqual(picked.map((p) => [p.bead.id, p.kind]), [['a', 'orphan'], ['b', 'orphan']]);
    });

    test('a bead in_progress since after launch that this run never dispatched is left alone', () => {
        const beads = [bead('a', { status: 'in_progress', started_at: after })];
        const picked = selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(), includePreLaunch: true });
        assert.deepStrictEqual(picked, []);
    });

    test('the pre-launch rule applies only when asked for', () => {
        const beads = [bead('s', { status: 'in_progress', started_at: before })];
        assert.deepStrictEqual(
            selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(), includePreLaunch: false }),
            []
        );
        const picked = selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(), includePreLaunch: true });
        assert.deepStrictEqual(picked.map((p) => [p.bead.id, p.kind]), [['s', 'pre-launch']]);
    });

    test('the pre-launch rule skips a bead with an unmet blocker and treats a missing started_at as pre-launch', () => {
        const beads = [
            bead('s1', { status: 'in_progress', started_at: before, dependencies: [{ type: 'blocks', depends_on_id: 'o' }] }),
            bead('s2', { status: 'in_progress' }),
            bead('o'),
        ];
        const picked = selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(), includePreLaunch: true });
        assert.deepStrictEqual(picked.map((p) => p.bead.id), ['s2']);
    });

    test('open, blocked and deferred beads are never candidates', () => {
        const beads = ['open', 'blocked', 'deferred'].map((status) => bead(status, { status, started_at: before }));
        const picked = selectReclaimCandidates({ notDoneBeads: beads, sprintLaunchTime: launch, dispatchedIds: new Set(['open', 'blocked', 'deferred']), includePreLaunch: true });
        assert.deepStrictEqual(picked, []);
    });

    test('downstreamDependentIds names the not-done beads waiting on a reclaimed bead', () => {
        const beads = [
            bead('s', { status: 'in_progress' }),
            bead('d1', { dependencies: [{ type: 'blocks', depends_on_id: 's' }] }),
            bead('d2', { dependencies: [{ type: 'related', depends_on_id: 's' }] }),
            bead('d3', { dependencies: [{ type: 'blocks', depends_on_id: 's' }] }),
        ];
        assert.deepStrictEqual(downstreamDependentIds(beads, 's'), ['d1', 'd3']);
    });
});
