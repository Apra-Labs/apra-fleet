import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatchAccounting, KB_ACCOUNTING_TOOLS, CODE_CALLS_NOT_OBSERVABLE } from '../fleet-sprint/dispatch-accounting.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';
import {
    createRecordingCtx,
    driveEngineDispatch,
    ROLE_CALL_OPTS,
    schemaError,
} from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// apra-fleet-b4g.33 (review round 2 fix): dispatchRole() seeds a
// ZERO-initialized dispatch-accounting record for a role's real (persona,
// member) pair the instant it is dispatched -- BEFORE this fix, the only
// caller of dispatch-accounting.mjs#forDispatch() anywhere in the engine was
// kb.mjs's own accountCall(), so a role/member pair that made ZERO kb_* calls
// (every deployer/integ-test-runner dispatch; a planner/harvester round that
// returns no captures) got no record at all -- and apra-fleet-b4g.21's "a
// role that made ZERO kb calls is highlighted" panel feature could never
// fire in production, because the zero state it renders could never exist.
// These pins run the REAL dispatchRole() engine (not a hand-built fixture)
// against every migrated role and prove the seed lands under the exact key
// (policy.agentType, member) kb.mjs's own real call sites use, so a real
// kb_* call afterward accumulates into the SAME record rather than a second,
// never-rendered one.
// =============================================================================

describe('dispatchRole seeds a zero-initialized (persona, member) record at dispatch start', () => {
    test('a role with a wired kb-apply step (doer) that makes NO kb_* call still gets an explicit zero record, not an absent one', async () => {
        const accounting = createDispatchAccounting();
        const { dispatch } = await driveEngineDispatch('doer', 'main', { ctx: { dispatchAccounting: accounting } });
        assert.equal(dispatch.options.member_name, 'member:doer-3', 'sanity: the doer really dispatched to its bound member');

        const record = accounting.dispatchRecordFor('doer', 'member:doer-3');
        assert.ok(record, 'a record must exist for a genuinely-dispatched (doer, member) pair even with zero kb_* calls');
        for (const tool of KB_ACCOUNTING_TOOLS) {
            assert.equal(record.kbCounts[tool], 0, `${tool} must be an explicit 0, not an absent key`);
        }
        assert.equal(record.code.status, CODE_CALLS_NOT_OBSERVABLE);
    });

    test('a role with NO kb-apply wiring at all (deployer) -- which can never reach kb.mjs on its own -- still gets a real zero record', async () => {
        const accounting = createDispatchAccounting();
        assert.ok(!ROLE_POLICIES.deployer.postResult.includes('kb-apply'), 'sanity: deployer really has no kb-apply step wired');
        const { dispatch } = await driveEngineDispatch('deployer', 'main', { ctx: { dispatchAccounting: accounting } });

        const record = accounting.dispatchRecordFor('deployer', dispatch.options.member_name);
        assert.ok(record, 'deployer dispatches this sprint but is structurally incapable of ever calling kb.mjs -- the panel must still show a real zero, not an absence, for exactly this case');
        assert.deepEqual(record.kbCounts, { kb_list: 0, kb_query: 0, kb_capture: 0, kb_promote: 0, kb_export: 0 });
    });

    test('seeded BEFORE the dispatch runs -- a role whose sole attempt fails still leaves a record behind', async () => {
        const accounting = createDispatchAccounting();
        // harvester's retry.attempts is 1 and its degrade.classes is empty, so
        // one schema-repair-exhaustion failure ends the ladder with ok:false
        // and no resume -- what matters here is only that the dispatch never
        // succeeded, and the seed (planted before the attempt loop starts)
        // survives that failure regardless.
        const { ctx } = createRecordingCtx({ responses: [schemaError()], dispatchAccounting: accounting });
        const outcome = await dispatchRole(ctx, 'harvester', ROLE_CALL_OPTS.harvester);
        assert.equal(outcome.ok, false, 'sanity: this dispatch never produced a usable result');

        const record = accounting.dispatchRecordFor('harvester', 'member:harvester');
        assert.ok(record, 'the seed must land even though the attempt failed -- it is planted at dispatch START, not on success');
    });

    test('streak-assignment (agentType null -- no persona, no kb.mjs call site of its own) seeds nothing', async () => {
        const accounting = createDispatchAccounting();
        assert.equal(ROLE_POLICIES['streak-assignment'].agentType, null, 'sanity: this row really has no persona');
        await driveEngineDispatch('streak-assignment', 'main', { ctx: { dispatchAccounting: accounting } });
        assert.deepEqual(accounting.dispatchRecords(), [], 'a role with no persona must never fabricate a keyed record');
    });

    test('with no dispatchAccounting wired at all (every pre-existing pin in this suite), the engine is unaffected', async () => {
        const { outcome } = await driveEngineDispatch('doer', 'main');
        assert.equal(outcome.ok, true, 'dispatchRole must run exactly as before when the seam is not wired');
    });

    test('final-review shares its persona ("reviewer") with the per-round reviewer ladder, so both seed into the SAME record', async () => {
        const accounting = createDispatchAccounting();
        const member = 'member:reviewer';
        await driveEngineDispatch('final-review', 'main', { ctx: { dispatchAccounting: accounting } });
        const record = accounting.dispatchRecordFor('reviewer', member);
        assert.ok(record, 'final-review must seed under the "reviewer" persona key, not a "final-review" key of its own');
        assert.equal(accounting.dispatchRecords().length, 1, 'exactly one record for the shared (reviewer, member) pair');
    });

    test('the seed key matches EXACTLY what a real kb.mjs call for the same dispatch would use -- a later real kb_* call accumulates into the seeded record, never a second one', async () => {
        const accounting = createDispatchAccounting();
        const { dispatch } = await driveEngineDispatch('doer', 'main', { ctx: { dispatchAccounting: accounting } });
        const member = dispatch.options.member_name;

        // The seeded record already exists, all-zero.
        assert.deepEqual(accounting.dispatchRecordFor('doer', member).kbCounts,
            { kb_list: 0, kb_query: 0, kb_capture: 0, kb_promote: 0, kb_export: 0 });

        // A real kb.mjs call for the SAME (role, member) pair -- exactly as
        // develop.mjs's pre-dispatch relevantKnowledge() call threads it.
        const callTool = async () => ({ content: [{ text: JSON.stringify({ l1_results: [{ id: 'e1', title: 't' }] }) }] });
        const kbWork = createKbWorkClient({ callTool, accounting });
        await kbWork.relevantKnowledge('/repo', ['term'], { role: 'doer', member });

        assert.equal(accounting.dispatchRecords().length, 1, 'exactly one record -- the real call accumulated into the seeded one, not a second');
        assert.equal(accounting.dispatchRecordFor('doer', member).kbCounts.kb_query, 1);
    });

    test('every migrated role with a real persona seeds a record; streak-assignment is the sole exception', async () => {
        const rolesWithPersona = Object.keys(ROLE_POLICIES).filter((r) => ROLE_POLICIES[r].agentType && ROLE_CALL_OPTS[r]);
        assert.ok(rolesWithPersona.length >= 8, 'sanity: this covers most of the table');
        for (const role of rolesWithPersona) {
            const accounting = createDispatchAccounting();
            const { dispatch } = await driveEngineDispatch(role, 'main', { ctx: { dispatchAccounting: accounting } });
            const record = accounting.dispatchRecordFor(ROLE_POLICIES[role].agentType, dispatch.options.member_name);
            assert.ok(record, `role '${role}' (persona '${ROLE_POLICIES[role].agentType}') must seed a record on dispatch`);
        }
    });
});
