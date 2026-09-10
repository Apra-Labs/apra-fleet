import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isSelfReservation,
    classifyActiveSprints,
    selectForeignSprints,
} from '../src/supervisor/sprint-identity.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';

// =============================================================================
// Self-vs-foreign classification of GET /api/sprints reservations
// (apra-fleet-5co8.37).
//
// The deploy runbook's active-sprints gate used to STOP on ANY non-empty
// `sprints` array. A sprint that dispatches its own deployer is ALWAYS in that
// ledger, so the gate fired on the deploying sprint's own reservation and no
// sprint could ever deploy its own work. These tests pin both directions of
// the comparison and that it is EXACT, never a substring/prefix match against
// issue-root text embedded in the sprintId.
// =============================================================================

// A realistic payload shape from api.mjs listSprints().
const ownReservation = {
    sprintId: 'apra-fleet-5co8-8f2c1d94-0f2a-4f4a-9a6f-31d0f6f3ab11',
    members: ['dev-1'],
    issueRoots: ['apra-fleet-5co8'],
    childPid: 4242,
    port: 8081,
};

const foreignReservation = {
    sprintId: 'apra-fleet-9zz1-1a2b3c4d-5e6f-4708-9192-abcdefabcdef',
    members: ['dev-2'],
    issueRoots: ['apra-fleet-9zz1'],
    childPid: 7777,
    port: 8082,
};

test('a reservation matching the dispatching sprint id is NOT foreign -- deploy proceeds', () => {
    const identity = { sprintId: ownReservation.sprintId };
    assert.equal(isSelfReservation(ownReservation, identity), true);

    const { self, foreign, shouldStop } = classifyActiveSprints([ownReservation], identity);
    assert.deepEqual(self, [ownReservation]);
    assert.deepEqual(foreign, []);
    assert.equal(shouldStop, false, 'a lone self-reservation must not stop the deploy');
});

test('a reservation with a different sprint id IS foreign -- deploy stops', () => {
    const identity = { sprintId: ownReservation.sprintId };
    assert.equal(isSelfReservation(foreignReservation, identity), false);

    const { self, foreign, shouldStop } = classifyActiveSprints(
        [ownReservation, foreignReservation],
        identity
    );
    assert.deepEqual(self, [ownReservation]);
    assert.deepEqual(foreign, [foreignReservation]);
    assert.equal(shouldStop, true, 'a genuinely foreign reservation must stop the deploy');
});

test('childPid alone identifies the caller when no sprintId is known', () => {
    const identity = { childPid: ownReservation.childPid };
    assert.equal(isSelfReservation(ownReservation, identity), true);
    assert.equal(isSelfReservation(foreignReservation, identity), false);
    assert.equal(classifyActiveSprints([ownReservation], identity).shouldStop, false);
});

test('the comparison is exact -- a shared issue-root prefix is NOT a match', () => {
    // Same issue root, different incarnation: a substring/prefix/issueRoots
    // comparison would wrongly call this the caller's own reservation and let
    // the deploy kill a live sibling sprint.
    const siblingOnSameRoot = {
        ...foreignReservation,
        sprintId: 'apra-fleet-5co8-cccccccc-dddd-4eee-8fff-000000000000',
        issueRoots: ['apra-fleet-5co8'],
    };
    const identity = { sprintId: ownReservation.sprintId, childPid: ownReservation.childPid };
    assert.equal(isSelfReservation(siblingOnSameRoot, identity), false);
    assert.deepEqual(selectForeignSprints([siblingOnSameRoot], identity), [siblingOnSameRoot]);

    // ... and a strict prefix of the caller's own id is not the caller either.
    const prefixOnly = { ...foreignReservation, sprintId: 'apra-fleet-5co8' };
    assert.equal(isSelfReservation(prefixOnly, identity), false);
});

test('with no self identity every reservation is foreign (old conservative gate)', () => {
    assert.equal(isSelfReservation(ownReservation, {}), false);
    assert.equal(classifyActiveSprints([ownReservation]).shouldStop, true);
});

test('an empty ledger never stops the deploy', () => {
    assert.equal(classifyActiveSprints([], { sprintId: ownReservation.sprintId }).shouldStop, false);
    assert.equal(classifyActiveSprints(undefined, { sprintId: ownReservation.sprintId }).shouldStop, false);
});

test('buildRunnerArgs forwards the launch run id to the runner as run_id', () => {
    const base = {
        targetIssues: ['apra-fleet-5co8'],
        members: ['dev-1'],
        branch: 'feat/x',
        baseBranch: 'main',
        goal: 'P1/P2',
        maxCycles: 5,
    };
    assert.equal(buildRunnerArgs({ ...base, runId: 'sprint-abc-123' }).run_id, 'sprint-abc-123');
    // Omitted (direct/standalone launch path) stays absent, not undefined-keyed.
    assert.equal(Object.prototype.hasOwnProperty.call(buildRunnerArgs(base), 'run_id'), false);
});

test("runner validateArgs accepts run_id and exposes it as validated.runId", async () => {
    const { validateArgs } = await import('../fleet-sprint/runner.js');
    const base = {
        target_issues: ['apra-fleet-5co8'],
        members: ['dev-1'],
        branch: 'feat/x',
        base_branch: 'main',
    };
    assert.equal(validateArgs({ ...base, run_id: 'sprint-abc-123' }).runId, 'sprint-abc-123');
    assert.equal(validateArgs(base).runId, undefined);
    assert.throws(() => validateArgs({ ...base, run_id: '' }), /Invalid run_id/);
});
