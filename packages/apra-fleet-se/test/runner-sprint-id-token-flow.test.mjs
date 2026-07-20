import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from './helpers/mock-sprint-harness.mjs';
import { createMemberReservationClient } from '../auto-sprint/runner.js';

const check = (cond, msg) => assert.ok(cond, msg);

// apra-fleet-eft.29.2 (regression for apra-fleet-eft.29): confirms the
// opaque sprint-identity token flows end to end, unified, through BOTH
// halves of the reservation/dispatch handshake that eft.29.1 fixed:
//
//   (a) runSprintCycle's `agent` wrapper (runner.js) stamps every real
//       dispatch call site with `sprint_id: sprintMutexId` -- this test
//       drives a FULL mock sprint (via the same runOnce() harness the
//       happy-path suite uses) and asserts every dispatched call actually
//       carries that token, end to end through FleetWorkflow's agent() ->
//       executePrompt payload (see AgentOptions.sprint_id in
//       apra-fleet-workflow/src/workflow/index.mjs and the mock
//       executePrompt's `dispatched.push(... sprintId: opts.sprint_id)` in
//       mock-sprint-harness.mjs).
//   (b) createMemberReservationClient (used by bin/cli.mjs to reserve
//       members BEFORE the sprint runs) sends that exact same token as
//       `sprint_id` on its `member_reservation` reserve call.
//
// Both (a) and (b) are driven from the SAME sprintMutexId/branch value in
// production (the sprint branch name); asserting they resolve to an
// identical string here is what closes the gap eft.29 exposed -- the
// token used to acquire a reservation and the token surfaced to
// execute_prompt's dispatch-time reservedBy check can never silently
// diverge.
test('sprint-identity token used for member_reservation matches the token stamped on every real dispatch (apra-fleet-eft.29.2)', async () => {
    const sprintToken = 'auto-sprint/mock-sprint'; // the branch runOnce() always passes as `branch`

    // (a) drive a full mock sprint end to end and inspect every dispatched
    // call's sprint_id. Reuses the 'run1' scenario tag (already has a
    // committed bd-replay fixture from the happy-path suite, see
    // test/fixtures/bd-recordings/apra-fleet-mock-sprint-run1.jsonl) rather
    // than introducing a new tag that would need its own recording -- this
    // test only inspects dispatched-call metadata (sprint_id), not bd
    // command sequencing, so sharing the fixture is safe and avoids an
    // unnecessary new recording file.
    const run = await runOnce('run1');
    check(run.result && run.result.status === 'success', `Mock sprint did not succeed: ${JSON.stringify(run.result)}`);
    check(run.dispatched.length > 0, 'Expected at least one dispatched call to inspect');
    const missingSprintId = run.dispatched.filter((d) => d.sprintId !== sprintToken);
    check(
        missingSprintId.length === 0,
        `Expected every dispatched call to carry sprint_id '${sprintToken}' (the runner's sprintMutexId), ` +
        `but found ${missingSprintId.length} that did not: ${JSON.stringify(missingSprintId.map((d) => ({ agent: d.agent, sprintId: d.sprintId })))}`
    );

    // (b) exercise createMemberReservationClient with the SAME token and
    // confirm it is what actually gets sent on the wire for `reserve`.
    const calls = [];
    const client = createMemberReservationClient({
        callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ text: '{}' }] }; },
        members: ['local'],
        sprintId: sprintToken,
    });
    await client.reserveAll();
    const reserveCall = calls.find((c) => c.name === 'member_reservation' && c.args.action === 'reserve');
    check(reserveCall !== undefined, `Expected a member_reservation reserve call, got: ${JSON.stringify(calls)}`);
    check(
        reserveCall.args.sprint_id === sprintToken,
        `Expected member_reservation reserve to send sprint_id '${sprintToken}', got '${reserveCall.args.sprint_id}'`
    );

    // The two halves must agree: the token dispatch calls were stamped with
    // (a) is identical to the token the reservation client sends (b).
    check(
        run.dispatched.every((d) => d.sprintId === reserveCall.args.sprint_id),
        'Dispatch-time sprint_id and member_reservation sprint_id diverged -- this is exactly the eft.29 regression.'
    );
});
