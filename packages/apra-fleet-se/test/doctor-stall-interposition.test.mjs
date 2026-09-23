import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { finalizeAbort } from '../fleet-sprint/runner.js';
import { StalledSprintError, SprintDoctorAbortError } from '../fleet-sprint/errors.mjs';
import {
    runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, legacyCommandExecuteCommandAdapter,
} from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-iiny.4.3 -- replays the stall incident (design doc
// escalate-to-llm-design.md section 3.3, "Incident 1") end to end through the
// REAL mock-sprint harness, against the T3 cycle-stall interposition wired by
// apra-fleet-iiny.4.2 (one doctor consult before StalledSprintError, one
// doctored extra cycle, the original abort carrying the verdict on a second
// stall). Five cases, matching the bead's acceptance criteria:
//
//   1. a stalled sprint consults the doctor EXACTLY ONCE, is granted one
//      extra cycle, and then aborts -- a THIRD stalled cycle produces no
//      second consult (the T3 debounce + doctorStallExtraCycleUsed latch);
//   2. the abort record (StalledSprintError.details.doctorVerdict) and the
//      [ABORTED] PR body both carry the classification, evidence and
//      human-referral block;
//   3. an abort_sprint verdict terminates IMMEDIATELY via the doctor's own
//      typed abort (SprintDoctorAbortError) -- no extra cycle is ever
//      granted;
//   4. a consult that FAILS (a dispatch error, or a schema-invalid response
//      that survives the engine's own repair loop) reproduces EXACTLY the
//      pre-interposition stalled-sprint abort -- staleCycles===2, no
//      doctorVerdict anywhere on the error (strictly additive, design doc
//      section 2.3);
//   5. a doctored action that DOES restore progress (defer_bead, crediting
//      the stuck bead via the monotone stagnation-credit set) lets the
//      sprint continue past the stall and finish normally, with no error.
//
// Every scenario uses the SAME doer shape as mock-sprint-stall-
// oscillation.test.mjs's own undoctored "stalled" case (a doer that claims
// VERIFY/closedIds but never actually runs `bd close`) -- zero forward
// progress every cycle by construction, so staleCycles climbs 0->1->2 exactly
// like that file's own empirically-verified baseline (staleCycles===2 for the
// undoctored abort). The doctor consult dispatch itself is answered by this
// file's own `doctorHandler` (apra-fleet-iiny.4.3's addition to
// buildMockFleetApi/runDevelopLoopScenario, test/helpers/mock-sprint-
// harness.mjs) -- with none configured, a doctor dispatch falls through to
// the harness's "unhandled agentType" guard, which doctor-consult.mjs's own
// dispatch try/catch already treats as a failed consult (case 4's first
// sub-case, exercised for real rather than assumed).
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

// Same shape as mock-sprint-stall-oscillation.test.mjs's "Never actually
// closes" doer: claims done via a schema-valid VERIFY report, but never runs
// `bd close` -- the bead stays open forever and the closed-bead count in
// scope never advances, driving staleCycles up every cycle by construction.
const neverClosesDoer = async ({ opts }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Claims done, never actually closes.' }) }] };
};

/** A schema-valid sprint-doctor verdict, for the `doctorHandler` mocks below. */
function buildDoctorVerdict({ actionKind, beadIds = [], classification = 'ENVIRONMENT', confidence = 'medium', reason }) {
    return {
        classification,
        confidence,
        evidence: ['Bead made zero forward progress across consecutive cycles -- the classic T3 cycle-stagnation shape.'],
        matchedRegistryEntry: null,
        action: {
            kind: actionKind,
            ...(beadIds.length > 0 ? { beadIds } : {}),
            ...(reason ? { reason } : {}),
        },
        humanActionRequired: {
            summary: 'Stall-interposition test referral -- nothing environment-side accounts for the stall by itself.',
            suggestedCommands: ['inspect the stuck bead by hand'],
            relevantFiles: [],
            relevantBeadIds: beadIds,
            whyBeyondBounds: 'This is a scripted test verdict standing in for a real diagnosis.',
        },
        notes: 'mock doctor verdict (apra-fleet-iiny.4.3 stall-interposition coverage)',
    };
}

const doctorReply = (verdict) => ({ content: [{ text: JSON.stringify(verdict) }] });

// A deliberately schema-INVALID doctor response (missing every required
// field) -- returned on every call regardless of round, so the engine's own
// bounded schema-repair loop (design doc section 2.1, schemaRetries default
// 2) exhausts without ever producing a contract-valid verdict, exactly the
// "schema repair exhausted" branch doctor-consult.mjs's runConsult() logs.
const malformedDoctorReply = () => ({ content: [{ text: JSON.stringify({ notAVerdict: true }) }] });

// A genuine dispatch failure -- the same structuredContent shape this
// harness's own `infraFailingDoer` uses elsewhere to simulate an
// AgentDispatchError at a doer streak, here at the doctor consult call site
// instead. Lands in doctor-consult.mjs's `catch (err)` block around
// `await agent(...)`, logged as "consult failed (dispatch error)".
const failingDoctorReply = () => ({
    content: [{ text: 'dispatch failed' }],
    structuredContent: { isError: true, reason: 'dispatch_failed' },
});

// Minimal hermetic mock `command(cmd, opts)` for finalizeAbort()'s own
// git/PR call sites -- same shape/rationale as mock-sprint-abort-
// pr.test.mjs's buildMockCommand() and iiny-4-1-sprint-doctor-abort-
// error.test.mjs's own local duplicate (that file's doc comment explains the
// failSoft branching contract in full); duplicated locally here for the same
// reason neither of those helpers is exported for cross-file reuse.
function buildMockAbortCommand({ commitCount, prUrl = 'https://github.com/mock-org/mock-repo/pull/99' } = {}) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) {
            return ok('protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n');
        }
        if (/^curl -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            const body = JSON.stringify({ number: 501, html_url: prUrl });
            return ok(`${body}\n201`);
        }
        throw new Error(`buildMockAbortCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

function mockAbortCallTool(command) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return base(name, toolArgs);
    };
}

describe('apra-fleet-iiny.4.3: cases 1+2 -- one consult, one extra cycle, then abort carrying the verdict', () => {
    test('mock sprint: retry_same never fixes the stall -- exactly one doctor dispatch, one extra cycle, then StalledSprintError with the verdict attached', async () => {
        await withScenarioMarkers('interpose-one-consult', async () => {
            let beadId = null;
            const scenario = await runDevelopLoopScenario('interposeone', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (doctor T3 retry_same)' }],
                maxCycles: 6,
                beforeSprint: async ({ tasks }) => { beadId = tasks[0].id; },
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                doctorHandler: async () => doctorReply(buildDoctorVerdict({
                    actionKind: 'retry_same',
                    beadIds: [beadId],
                    reason: 'mitigation only -- try once more with a longer clock',
                })),
            });

            check(!!scenario.error, 'expected the sprint to still abort eventually (retry_same never actually fixes the stall)');
            check(
                scenario.error instanceof StalledSprintError,
                `expected a StalledSprintError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );
            check(
                !(scenario.error instanceof SprintDoctorAbortError),
                'retry_same must never raise the doctor typed-abort path -- only an applied abort_sprint action does'
            );

            // Requirement 1: exactly ONE doctor dispatch across the WHOLE
            // run -- T3's own debounce plus the doctorStallExtraCycleUsed
            // latch mean a third stalled cycle produces no second consult.
            const doctorDispatches = scenario.dispatched.filter((d) => d.agent === 'sprint-doctor');
            check(
                doctorDispatches.length === 1,
                `expected exactly ONE sprint-doctor dispatch for the whole sprint, got ${doctorDispatches.length}`
            );

            // The doctored extra cycle bought exactly one more stale cycle
            // than the undoctored baseline (staleCycles===2, per mock-
            // sprint-stall-oscillation.test.mjs's own "stalled" scenario --
            // the identical doer shape with no doctorHandler configured).
            check(
                scenario.error.staleCycles === 3,
                `expected staleCycles===3 (2 undoctored + exactly 1 doctored grant), got ${scenario.error.staleCycles}`
            );

            // Requirement 2 (abort record): the verdict's classification,
            // evidence and referral block survive onto the typed error.
            const dv = scenario.error.details && scenario.error.details.doctorVerdict;
            check(!!dv, `expected error.details.doctorVerdict to be present, got details: ${JSON.stringify(scenario.error.details)}`);
            check(dv.classification === 'ENVIRONMENT', `expected classification ENVIRONMENT, got: ${dv.classification}`);
            check(dv.actionKind === 'retry_same', `expected actionKind retry_same, got: ${dv.actionKind}`);
            check(dv.actionApplied === true, `expected the retry_same action to have applied, got: ${JSON.stringify(dv)}`);
            check(Array.isArray(dv.evidence) && dv.evidence.length > 0, `expected non-empty evidence on the error, got: ${JSON.stringify(dv.evidence)}`);
            check(
                dv.humanActionRequired && typeof dv.humanActionRequired.summary === 'string' && dv.humanActionRequired.summary.length > 0,
                `expected a human-referral summary on the error, got: ${JSON.stringify(dv.humanActionRequired)}`
            );
            check(
                scenario.error.message.includes('consulted once about this stall'),
                `expected the abort message to name the one consult, got: ${scenario.error.message}`
            );

            // Requirement 2 (PR body): finalizeAbort() is the SAME function
            // main()'s typed-abort catch calls -- exercised directly here
            // (same pattern as iiny-4-1-sprint-doctor-abort-error.test.mjs)
            // against the REAL error this mock sprint just produced, so this
            // proves the doctor diagnosis renders into the [ABORTED] PR body
            // for a genuine T3-interposition abort, not a hand-built fixture.
            const { command, log } = buildMockAbortCommand({ commitCount: 1, prUrl: 'https://github.com/mock-org/mock-repo/pull/501' });
            await finalizeAbort({
                error: scenario.error,
                branch: scenario.branch,
                baseBranch: 'main',
                member: 'local',
                command,
                callTool: mockAbortCallTool(command),
            });
            const prCmd = log.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
            check(!!prCmd, `expected a create-pull-request dispatch, command log: ${JSON.stringify(log)}`);
            check(prCmd.includes('Doctor diagnosis: ENVIRONMENT'), `expected the doctor diagnosis headline in the PR body, got: ${prCmd}`);
            check(prCmd.includes(dv.evidence[0]), `expected an evidence bullet in the PR body, got: ${prCmd}`);
            check(prCmd.includes('Human action required:'), `expected the human-referral block in the PR body, got: ${prCmd}`);
        });
    });
});

describe('apra-fleet-iiny.4.3: case 3 -- abort_sprint terminates immediately, no extra cycle', () => {
    test('mock sprint: an abort_sprint verdict raises the doctor typed-abort the SAME cycle T3 fires, with no doctored extra cycle', async () => {
        await withScenarioMarkers('interpose-immediate-abort', async () => {
            let beadId = null;
            const scenario = await runDevelopLoopScenario('interposeabort', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (doctor abort_sprint)' }],
                maxCycles: 6,
                beforeSprint: async ({ tasks }) => { beadId = tasks[0].id; },
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                doctorHandler: async () => doctorReply(buildDoctorVerdict({
                    actionKind: 'abort_sprint',
                    beadIds: [beadId],
                    reason: 'the member is unresponsive; nothing left to try',
                })),
            });

            check(!!scenario.error, 'expected the sprint to abort');
            check(
                scenario.error instanceof SprintDoctorAbortError,
                `expected a SprintDoctorAbortError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );
            check(
                scenario.error.verdict && scenario.error.verdict.action && scenario.error.verdict.action.kind === 'abort_sprint',
                `expected the error's own .verdict to carry the abort_sprint action, got: ${JSON.stringify(scenario.error.verdict)}`
            );

            // Exactly one doctor dispatch -- an abort is terminal by
            // definition, so no further evaluation ever gets a chance to
            // consult again.
            const doctorDispatches = scenario.dispatched.filter((d) => d.agent === 'sprint-doctor');
            check(doctorDispatches.length === 1, `expected exactly ONE sprint-doctor dispatch, got ${doctorDispatches.length}`);

            // No extra cycle was ever granted: the SAME staleCycles value
            // that first satisfied T3 (2, this doer shape's undoctored
            // baseline) is what's still on the error -- an extra granted
            // cycle would have let staleCycles climb to 3 first, as in the
            // retry_same case above.
            check(
                scenario.error.details && scenario.error.details.staleCycles === 2,
                `expected staleCycles===2 (the abort fired on T3's OWN triggering cycle, no extra cycle granted), got: ${JSON.stringify(scenario.error.details)}`
            );
        });
    });
});

describe('apra-fleet-iiny.4.3: case 4 -- a failed consult reproduces exactly the pre-interposition stalled abort', () => {
    test('mock sprint: a dispatch-error consult (no doctorHandler configured) falls back to the undoctored StalledSprintError byte-for-byte', async () => {
        await withScenarioMarkers('interpose-fail-nohandler', async () => {
            const scenario = await runDevelopLoopScenario('interposefailnh', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (no doctorHandler)' }],
                maxCycles: 5,
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                // No doctorHandler: a doctor dispatch falls through to the
                // harness's own "unhandled agentType" guard, which
                // doctor-consult.mjs's dispatch try/catch already treats as
                // a failed consult.
            });

            check(!!scenario.error, 'expected the sprint to abort');
            check(
                scenario.error instanceof StalledSprintError,
                `expected a StalledSprintError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );
            check(!(scenario.error instanceof SprintDoctorAbortError), 'a failed consult must never raise the doctor typed-abort path');
            // The pre-interposition value: no extra cycle was ever granted
            // because the consult itself failed.
            check(scenario.error.staleCycles === 2, `expected staleCycles===2 (pre-interposition value), got ${scenario.error.staleCycles}`);
            check(
                !scenario.error.message.includes('consulted once about this stall'),
                `expected the ORIGINAL (pre-doctor) abort message with no doctor-consult sentence, got: ${scenario.error.message}`
            );
            check(
                !(scenario.error.details && scenario.error.details.doctorVerdict),
                `expected NO doctorVerdict on a failed-consult abort, got: ${JSON.stringify(scenario.error.details)}`
            );
        });
    });

    test('mock sprint: a schema-invalid consult response (repair loop exhausted) ALSO falls back to the undoctored StalledSprintError', async () => {
        await withScenarioMarkers('interpose-fail-malformed', async () => {
            const scenario = await runDevelopLoopScenario('interposefailmf', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (malformed doctor verdict)' }],
                maxCycles: 5,
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                doctorHandler: async () => malformedDoctorReply(),
            });

            check(!!scenario.error, 'expected the sprint to abort');
            check(
                scenario.error instanceof StalledSprintError,
                `expected a StalledSprintError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );
            check(!(scenario.error instanceof SprintDoctorAbortError), 'a schema-invalid consult must never raise the doctor typed-abort path');
            check(scenario.error.staleCycles === 2, `expected staleCycles===2 (pre-interposition value), got ${scenario.error.staleCycles}`);
            check(
                !(scenario.error.details && scenario.error.details.doctorVerdict),
                `expected NO doctorVerdict on a schema-invalid-consult abort, got: ${JSON.stringify(scenario.error.details)}`
            );
            // A real dispatch DID happen (at least one, possibly several
            // through the engine's own bounded schema-repair loop) -- this
            // is the "schema-invalid after repair" sub-case, not merely an
            // unconfigured handler.
            const doctorDispatches = scenario.dispatched.filter((d) => d.agent === 'sprint-doctor');
            check(doctorDispatches.length >= 1, `expected at least one sprint-doctor dispatch attempt, got ${doctorDispatches.length}`);
        });
    });

    test('mock sprint: a genuine dispatch-error doctorHandler ALSO falls back to the undoctored StalledSprintError', async () => {
        await withScenarioMarkers('interpose-fail-dispatch', async () => {
            const scenario = await runDevelopLoopScenario('interposefaildp', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (dispatch-failing doctor)' }],
                maxCycles: 5,
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                doctorHandler: async () => failingDoctorReply(),
            });

            check(!!scenario.error, 'expected the sprint to abort');
            check(
                scenario.error instanceof StalledSprintError,
                `expected a StalledSprintError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );
            check(!(scenario.error instanceof SprintDoctorAbortError), 'a failed consult must never raise the doctor typed-abort path');
            check(scenario.error.staleCycles === 2, `expected staleCycles===2 (pre-interposition value), got ${scenario.error.staleCycles}`);
            check(
                !(scenario.error.details && scenario.error.details.doctorVerdict),
                `expected NO doctorVerdict on a dispatch-error-consult abort, got: ${JSON.stringify(scenario.error.details)}`
            );
        });
    });
});

describe('apra-fleet-iiny.4.3: case 5 -- a doctored action that restores progress lets the sprint continue and finish', () => {
    test('mock sprint: defer_bead credits the stuck bead, clears the stall, and the sprint finishes normally (no error)', async () => {
        await withScenarioMarkers('interpose-defer-recovers', async () => {
            let beadId = null;
            const scenario = await runDevelopLoopScenario('interposedefer', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: Never actually closes (doctor defer_bead recovery)' }],
                maxCycles: 6,
                beforeSprint: async ({ tasks }) => { beadId = tasks[0].id; },
                doerHandler: neverClosesDoer,
                reviewerHandler: approveReviewer,
                doctorHandler: async () => doctorReply(buildDoctorVerdict({
                    actionKind: 'defer_bead',
                    beadIds: [beadId],
                    reason: 'parking the stuck bead so the rest of the sprint can finish',
                })),
            });

            check(
                scenario.error === null,
                `expected the sprint to finish WITHOUT error once the stuck bead is deferred, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'n/a'}`
            );

            const doctorDispatches = scenario.dispatched.filter((d) => d.agent === 'sprint-doctor');
            check(doctorDispatches.length === 1, `expected exactly ONE sprint-doctor dispatch (the defer recovered the sprint on the very next evaluation), got ${doctorDispatches.length}`);

            const deferred = scenario.finalBeadsById.get(beadId);
            check(!!deferred, `expected the stuck bead to still be present in the final beads snapshot, got: ${JSON.stringify([...scenario.finalBeadsById.keys()])}`);
            check(deferred.status === 'deferred', `expected the stuck bead's final status to be 'deferred', got: ${JSON.stringify(deferred)}`);
        });
    });
});
