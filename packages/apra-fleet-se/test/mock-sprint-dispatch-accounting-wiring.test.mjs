import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import crypto from 'node:crypto';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { main } from '../fleet-sprint/runner.js';
import { createDispatchAccounting } from '../fleet-sprint/dispatch-accounting.mjs';
import { createKbPrimingClient } from '../fleet-sprint/kb.mjs';
import {
    setupMinimal, buildMockFleetApi, teardown, uniqueMockBranch, defaultMockCallTool, withScenarioMarkers,
} from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-b4g.46: runner.js's OWN wiring of the per-dispatch KB accounting
// seam, not dispatch-role.mjs's separate forDispatch() seed (already covered
// by test/dispatch-role-kb-accounting.test.mjs).
//
// Three call sites in fleet-sprint/runner.js are exercised here and had NO
// test coverage before this file:
//   - :1286 `const dispatchAccounting = context.dispatchAccounting ?? createDispatchAccounting(...)`
//     -- the injection seam itself.
//   - :1305 `accounting: dispatchAccounting` threaded into createKbWorkClient(...)
//     -- deleting this line leaves the Knowledge and Code Intelligence panel
//     permanently empty in every real sprint, with the whole suite still green.
//   - :1444 `dispatchAccounting.setPreflightRecords(memberPreflightRecords)`.
//
// `context.dispatchAccounting`, `context.memberPreflight` and
// `context.kbPriming` are all injection seams that only a DIRECT
// `main(context)` call (bypassing WorkflowEngine.executeFile(), which builds
// `context` itself from FleetWorkflow._bindPrimitives() + args + budget and
// has no path for extra keys) can exercise -- confirmed by reading
// engine.mjs/index.mjs in @apralabs/apra-fleet-workflow:
// `WorkflowEngine.executeFile()` never merges caller-supplied context fields,
// so in every REAL sprint (bin/cli.mjs and every existing
// mock-sprint-*.test.mjs scenario, which all go through
// engine.executeFile()) `context.dispatchAccounting` is undefined and this
// engine always falls back to a fresh createDispatchAccounting() -- these
// seams exist ONLY for a hand-built context like the one below.
//
// This test therefore reuses the SAME mock-sprint harness building blocks
// (setupMinimal/buildMockFleetApi/FleetWorkflow) as every other scenario in
// this suite, but drives `main()` directly through
// `FleetWorkflow.runWithContext()` (a public method) instead of through
// `WorkflowEngine.executeFile()`, so the extra `dispatchAccounting`/
// `memberPreflight`/`kbPriming` keys survive onto the context runner.js
// reads. `kbPriming` is also injected (rather than left to its own
// createKbPrimingClient() fallback) purely so this test's memberPreflight
// stub can prime it itself -- see the inline comment at its construction
// site below for why that is required for this scenario to be non-vacuous.
// =============================================================================

/** Wraps the REAL createDispatchAccounting() with call recorders, so this test
 * proves runner.js's wiring drives the genuine production object (not a
 * hand-rolled shape that could silently diverge from it) while still being
 * able to assert exactly which calls were made. */
function createSpiedDispatchAccounting() {
    const real = createDispatchAccounting({ log: () => {} });
    const forDispatchCalls = [];
    const recordKbCallCalls = [];
    const setPreflightRecordsCalls = [];
    return {
        ...real,
        forDispatch(info) {
            forDispatchCalls.push({ role: info && info.role, member: info && info.member });
            return real.forDispatch(info);
        },
        recordKbCall(record, toolName) {
            recordKbCallCalls.push({
                role: record && record.role,
                member: record && record.member,
                toolName,
            });
            return real.recordKbCall(record, toolName);
        },
        setPreflightRecords(records) {
            setPreflightRecordsCalls.push(records);
            return real.setPreflightRecords(records);
        },
        forDispatchCalls,
        recordKbCallCalls,
        setPreflightRecordsCalls,
    };
}

// apra-fleet-d6fq.2-style budget: this is a single-task, single-cycle
// develop-loop scenario -- comparable in shape to
// mock-sprint-kb-remote-scope.test.mjs's scenario, which measured 36s
// standalone. Directly confirmed for THIS file: `node scripts/run-tests.mjs
// record test/mock-sprint-dispatch-accounting-wiring.test.mjs` (which also
// runs the real suite once to produce the bd recording) completed in well
// under 30s standalone. scaledTimeout() keeps this unscaled at
// concurrency<=1 and multiplies it under the real 8-way suite.
test('mock sprint: runner.js wires a hand-injected dispatchAccounting into every doer/reviewer KB call and into setPreflightRecords', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('dispatch accounting runner wiring', async () => {
        const tag = 'dispatchacctwiring';
        const { tempDir, epicBead } = await setupMinimal(tag, [
            { title: 'Task: exercise the dispatchAccounting runner wiring' },
        ]);

        const dispatched = [];
        const commandLog = [];

        // Same isolation as runDevelopLoopScenario()/runOnce() in
        // mock-sprint-harness.mjs: an unscaled sprint-lock directory private
        // to this scenario, and instant retry backoff, restored in `finally`.
        const priorInstantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
        const priorSprintLockDir = process.env.APRA_FLEET_SPRINT_LOCK_DIR;
        const sprintLockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-mock-'));
        process.env.APRA_FLEET_SPRINT_LOCK_DIR = sprintLockDir;

        // The exact per-member records createMemberPreflight().runAll() would
        // return (member/repoPath/remoteUrl/mcpScope/kbEntryCount/checks/
        // warnings) -- setPreflightRecords() must receive THESE OBJECTS
        // unchanged (apra-fleet-b4g.33 AC5: no field renamed, dropped or
        // invented), so this stub stands in for memberPreflight without
        // needing a real callTool/kbPriming wired up.
        const FAKE_PREFLIGHT_RECORDS = [{
            member: 'local',
            repoPath: tempDir,
            remoteUrl: null,
            mcpScope: 'kb+code',
            kbEntryCount: 0,
            checks: { index: 'analyze-not-started', kb: 'ok', code: 'ok' },
            warnings: [],
        }];
        const memberPreflightStub = { runAll: async () => FAKE_PREFLIGHT_RECORDS };
        const spiedAccounting = createSpiedDispatchAccounting();

        let result = null;
        let error = null;
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, `[${tag}] `);

            // defaultMockCallTool()'s own member_detail response carries only
            // vcsProvider, never a folder (see its doc comment) -- without a
            // folder, kbPriming.folderOf('local') resolves to null and every
            // per-dispatch kbWork.relevantKnowledge() call short-circuits to
            // [] with NO kb_query call at all (kb.mjs's own `!repoPath`
            // guard), which would make this test vacuous. Layer a folder onto
            // member_detail and answer the KB tool calls kbWork.* makes,
            // exactly like runner-kb-priming.test.mjs's scopedCallTool /
            // mock-sprint-kb-remote-scope.test.mjs's callTool -- everything
            // else falls through to the same base mock every other scenario
            // in this suite uses.
            const baseCallTool = defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand });
            const callTool = async (name, toolArgs) => {
                if (name === 'member_detail') {
                    return { content: [{ text: JSON.stringify({ folder: tempDir, vcsProvider: 'github' }) }] };
                }
                if (name === 'kb_session_prime') return { top_entries: [] };
                if (name === 'kb_list') return { results: [] };
                if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: [], related_claims: [] }) }] };
                return baseCallTool(name, toolArgs);
            };

            const args = {
                target_issue: epicBead.id,
                members: ['local'],
                branch: uniqueMockBranch(tag),
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
                callTool,
            };

            // Production wiring: `createMemberPreflight().runAll()` calls
            // `kbPriming.primeAll()` itself (see runner.js's import comment
            // for createMemberPreflight -- "it calls primeAll() itself and
            // reads the per-member results back"), which is what resolves
            // `kbPriming.folderOf(member)` for every later kbWork.* call this
            // scenario needs to observe. The memberPreflightStub above
            // replaces createMemberPreflight() entirely (so we control
            // exactly what setPreflightRecords() receives for assertion (b)),
            // so it must still do this ONE real thing memberPreflight would
            // have done, or kbPriming is never primed and every
            // kbWork.relevantKnowledge() call short-circuits to [] with no
            // kb_query call -- making assertion (a) vacuous. `context.kbPriming`
            // is injected explicitly (rather than left to runner.js's own
            // `createKbPrimingClient(...)` fallback) so this same client
            // instance is the one both memberPreflightStub primes and
            // runner.js's real kbWork/kb-apply call sites read from.
            const kbPriming = createKbPrimingClient({ callTool, members: ['local'], log: () => {} });
            memberPreflightStub.runAll = async () => {
                await kbPriming.primeAll();
                return FAKE_PREFLIGHT_RECORDS;
            };

            // WorkflowEngine.executeFile() (used by every other scenario in
            // this suite and by bin/cli.mjs) builds its own context from
            // FleetWorkflow._bindPrimitives() + args + budget with no seam
            // for extra keys -- see the file header comment above. Calling
            // the PUBLIC runWithContext() directly, with a thin wrapper that
            // adds dispatchAccounting/memberPreflight onto the context
            // FleetWorkflow already built, is the only way to reach
            // runner.js's context.dispatchAccounting / context.memberPreflight
            // injection seams while still exercising the SAME real agent()/
            // command() primitives (and therefore the same mockFleetApi) any
            // other scenario here does.
            result = await workflow.runWithContext(
                args,
                (context) => main({
                    ...context,
                    dispatchAccounting: spiedAccounting,
                    memberPreflight: memberPreflightStub,
                    kbPriming,
                }),
                { runId: crypto.randomUUID(), journalEnabled: false },
            );
        } catch (err) {
            error = err;
        } finally {
            if (priorInstantRetryBackoff === undefined) {
                delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
            } else {
                process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantRetryBackoff;
            }
            if (priorSprintLockDir === undefined) {
                delete process.env.APRA_FLEET_SPRINT_LOCK_DIR;
            } else {
                process.env.APRA_FLEET_SPRINT_LOCK_DIR = priorSprintLockDir;
            }
            await fs.rm(sprintLockDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
        }

        try {
            assert.equal(error, null, `mock sprint did not complete: ${error && error.stack}`);
            assert.ok(result && result.status === 'success', `mock sprint did not succeed: ${JSON.stringify(result)}`);

            // (a) forDispatch/recordKbCall were actually invoked for BOTH the
            // doer and the reviewer dispatch -- via kb.mjs's own kb_query call
            // site (phases/develop.mjs's per-streak relevantKnowledge() for
            // the doer, runner.js's dispatchReview()'s relevantKnowledge() for
            // the reviewer), which only reaches accounting.forDispatch()/
            // recordKbCall() when createKbWorkClient() was actually built
            // with `accounting: dispatchAccounting` (the :1305 wiring this
            // bead exists to protect).
            const forDispatchRoles = spiedAccounting.forDispatchCalls.map((c) => c.role);
            assert.ok(
                forDispatchRoles.includes('doer'),
                `expected a forDispatch() call for role 'doer', got roles: ${JSON.stringify(forDispatchRoles)}`,
            );
            assert.ok(
                forDispatchRoles.includes('reviewer'),
                `expected a forDispatch() call for role 'reviewer', got roles: ${JSON.stringify(forDispatchRoles)}`,
            );
            assert.ok(
                spiedAccounting.recordKbCallCalls.some((c) => c.role === 'doer' && c.toolName === 'kb_query'),
                `expected a recordKbCall(kb_query) for the doer, got: ${JSON.stringify(spiedAccounting.recordKbCallCalls)}`,
            );
            assert.ok(
                spiedAccounting.recordKbCallCalls.some((c) => c.role === 'reviewer' && c.toolName === 'kb_query'),
                `expected a recordKbCall(kb_query) for the reviewer, got: ${JSON.stringify(spiedAccounting.recordKbCallCalls)}`,
            );
            // Confirm the real object underneath actually accumulated these
            // as genuine dispatch records (not just spy call logs that could
            // diverge from what the production object recorded).
            const doerRecord = spiedAccounting.dispatchRecordFor('doer', 'local');
            assert.ok(doerRecord, 'expected a real dispatch record for (doer, local)');
            assert.ok(doerRecord.kbCounts.kb_query > 0, 'expected the doer record to count at least one kb_query');
            const reviewerRecord = spiedAccounting.dispatchRecordFor('reviewer', 'local');
            assert.ok(reviewerRecord, 'expected a real dispatch record for (reviewer, local)');
            assert.ok(reviewerRecord.kbCounts.kb_query > 0, 'expected the reviewer record to count at least one kb_query');

            // (b) setPreflightRecords() received exactly the records
            // memberPreflight.runAll() returned -- the :1444 wiring.
            assert.equal(spiedAccounting.setPreflightRecordsCalls.length, 1,
                `expected setPreflightRecords() to be called exactly once, got ${spiedAccounting.setPreflightRecordsCalls.length}`);
            assert.deepEqual(spiedAccounting.setPreflightRecordsCalls[0], FAKE_PREFLIGHT_RECORDS);
            // And that the real object underneath actually retained them.
            assert.deepEqual(spiedAccounting.preflightRecords(), FAKE_PREFLIGHT_RECORDS);
        } finally {
            await teardown(tempDir);
        }
    });
});
