import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimBeadsBatched } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-7h6n.7 (audit R6) -- claimBeadsBatched(): batches a streak's
// per-bead work-claiming into ONE `bd update <id...> --claim --json` call
// instead of one `bd update <id> --claim` call per bead.
//
// RESEARCH FINDING this relies on (verified against real `bd` 1.1.0 in a
// scratch sandbox DB, see claimBeadsBatched()'s own doc comment in
// runner.js for the full write-up):
//   - `bd update` accepts a variadic id list (`Usage: bd update [id...]`).
//   - `--claim --json` on a multi-id call returns a JSON array containing
//     ONLY the successfully-claimed issues; a failing id (unresolvable, or
//     already claimed by a DIFFERENT assignee) is silently dropped from
//     the array, its error going to stderr instead.
//   - This is NOT atomic (no all-or-nothing rollback across ids), and the
//     process exit code stays 0 even when some ids in the batch failed --
//     so the claimed/skipped split can ONLY be read off the JSON array,
//     never inferred from whether command() threw.
//
// This module mocks command() directly (the same shape verifyDoerStreak-
// Closed's tests in dolt-sync-brackets.test.mjs use: a raw JSON STRING
// return for a `--json` read) rather than re-deriving a real bd sandbox,
// since claimBeadsBatched()'s only real contract with `bd` is "parse the
// returned JSON array of successfully-claimed issues" -- the sandbox-level
// verification of THAT contract lives in this bead's commit message/report,
// not as a live-bd-spawning test here (this whole claim layer is dormant in
// production -- see runner.js's `assignee` doc comment).
// =============================================================================

const OK_JSON = (ids) => JSON.stringify(ids.map((id) => ({ id, status: 'in_progress', assignee: 'bella' })));

/** A tiny scripted command() mock, recording every call with its opts. */
function makeCommandMock(handler) {
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        return handler(cmd, opts);
    };
    return { command, calls };
}

test('claimBeadsBatched: one invocation claims multiple ids (the core batching proof)', async () => {
    const { command, calls } = makeCommandMock((cmd) => {
        assert.equal(cmd, 'bd update BD-1 BD-2 BD-3 --claim --json', 'every id must be in ONE bd update invocation, not one per id');
        return OK_JSON(['BD-1', 'BD-2', 'BD-3']);
    });

    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: ['BD-1', 'BD-2', 'BD-3'],
    });

    assert.deepEqual(claimedBeadIds, ['BD-1', 'BD-2', 'BD-3']);
    assert.deepEqual(skippedBeadIds, []);
    const claimCalls = calls.filter((c) => c.cmd.includes('bd update'));
    assert.equal(claimCalls.length, 1, 'exactly ONE bd update call for the whole streak, not one per bead');
    assert.equal(claimCalls[0].opts.member_name, 'orchestrator', 'the claim call carries an explicit member_name (3.2)');
});

test('claimBeadsBatched: a partial failure (some ids already claimed elsewhere / unresolvable) is read off the JSON array, not inferred from a throw', async () => {
    // Mirrors the real bd behavior verified in the sandbox: the call
    // resolves normally (command() never throws) even though BD-2 was
    // dropped from the returned array.
    const { command } = makeCommandMock(() => OK_JSON(['BD-1', 'BD-3']));

    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: ['BD-1', 'BD-2', 'BD-3'],
    });

    assert.deepEqual(claimedBeadIds, ['BD-1', 'BD-3']);
    assert.deepEqual(skippedBeadIds, ['BD-2'], 'an id missing from the returned array is reported skipped');
});

test('claimBeadsBatched: every id skipped when the returned array is empty (all already claimed elsewhere)', async () => {
    const { command } = makeCommandMock(() => '[]');
    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: ['BD-1', 'BD-2'],
    });
    assert.deepEqual(claimedBeadIds, []);
    assert.deepEqual(skippedBeadIds, ['BD-1', 'BD-2']);
});

test('claimBeadsBatched: a thrown command() (total call failure) degrades to "every id skipped", never throws', async () => {
    const command = async () => { throw new Error('member unreachable'); };
    const logs = [];
    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: ['BD-1', 'BD-2'], log: (m) => logs.push(m),
    });
    assert.deepEqual(claimedBeadIds, []);
    assert.deepEqual(skippedBeadIds, ['BD-1', 'BD-2']);
    assert.ok(logs.some((m) => /Batched claim failed/.test(m)), 'the failure must be logged, not silently swallowed');
});

test('claimBeadsBatched: an empty beadIds input is a no-op -- no command() call at all', async () => {
    const { command, calls } = makeCommandMock(() => { throw new Error('must never be called'); });
    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: [],
    });
    assert.deepEqual(claimedBeadIds, []);
    assert.deepEqual(skippedBeadIds, []);
    assert.equal(calls.length, 0, 'no bd command should be issued for an empty streak');
});

test('claimBeadsBatched: malformed/non-JSON output from bd is a fatal parse error, never silently swallowed', async () => {
    const command = async () => 'not valid json {{{';
    await assert.rejects(
        () => claimBeadsBatched({ command, orchestratorMember: 'orchestrator', beadIds: ['BD-1'] }),
        /bd JSON Parse Error/,
    );
});

test('claimBeadsBatched: a single id still works (batching is a superset of the old one-id-per-call shape)', async () => {
    const { command, calls } = makeCommandMock((cmd) => {
        assert.equal(cmd, 'bd update BD-1 --claim --json');
        return OK_JSON(['BD-1']);
    });
    const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
        command, orchestratorMember: 'orchestrator', beadIds: ['BD-1'],
    });
    assert.deepEqual(claimedBeadIds, ['BD-1']);
    assert.deepEqual(skippedBeadIds, []);
    assert.equal(calls.length, 1);
});
