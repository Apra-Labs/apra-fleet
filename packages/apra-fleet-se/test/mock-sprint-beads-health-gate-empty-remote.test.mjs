import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import {
    setup,
    setupMinimal,
    buildMockFleetApi,
    mockCmdResult,
    teardown,
    withScenarioMarkers,
} from './helpers/mock-sprint-harness.mjs';
import { DoltDivergedError } from '../auto-sprint/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

// =============================================================================
// apra-fleet-eft.63.2: regression pin for eft.63 / impl eft.63.1 -- the
// preflight beads-health gate (preflightBeadsHealthGate -> doltPullBefore,
// see runner.js) must treat a `bd dolt pull` against a Dolt remote with ZERO
// branches ever pushed (Dolt's own "Error 1105: fetch failed: no branches
// found in remote origin" -- e.g. the smoke-test playbook's `## Reset`
// fast-path re-deriving sync.remote from a bare git-only mirror Dolt has
// never pushed to) as a benign no-op success, NOT identically to a genuine
// merge-conflict divergence -- so the sprint proceeds past Sprint Setup into
// Planning instead of aborting before Planner dispatch ever runs (the eft.63
// bug: observed live as "Sprint failed: DoltSyncError: ... no branches found
// in remote origin"). A genuine divergence/conflict D-pull failure must
// still abort the sprint before Planning, unchanged.
//
// mock-sprint-beads-health-gate-diverged.test.mjs (eft.58.2) already pins the
// gate's DIVERGENCE behaviour end to end. This suite adds the missing
// EMPTY-REMOTE positive case (the no-op success reaching Planning) plus its
// own self-contained divergence negative control, both driven through a full
// engine.executeFile(runner.js, ...) run over the SAME buildMockFleetApi()
// mock every other mock-sprint suite uses, with `bd dolt pull` (and its `bd
// config get sync.remote --json` pre-gate) intercepted at the
// executeCommand() layer -- mirroring eft.58.2's injection pattern -- so the
// gate's REAL call site at the very top of Sprint Setup is what actually
// fires, not a hand-invoked helper call.
// =============================================================================

/**
 * Wraps buildMockFleetApi()'s executeCommand so every `bd dolt pull` this
 * run issues fails with the exact "Error 1105: fetch failed: no branches
 * found in remote origin" signature: a sync.remote that IS configured but
 * has genuinely never had anything pushed into it -- distinct from BOTH
 * no-remote (nothing configured at all, the pre-eft.63 skip) and a real
 * divergence/conflict. `bd config get sync.remote --json` is also
 * intercepted to report a CONFIGURED remote, so doltPullBefore()'s own
 * pre-gate does not short-circuit to the no-remote skip before ever
 * attempting the pull -- this hermetic tempDir has no real dolt remote at
 * all, so without this override the empty-remote D-pull path this scenario
 * exists to exercise could never actually fire. EVERY `bd dolt pull` this
 * run issues gets this same fixture (not just the gate's own first probe),
 * since it is a benign no-op every time -- the whole run should complete
 * exactly as if no dolt remote issue existed at all.
 */
function buildEmptyRemoteGateFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    let doltPullAttempts = 0;

    const executeCommand = async (opts) => {
        const cmd = opts.command;

        if (cmd === 'bd config get sync.remote --json') {
            commandLog.push(cmd);
            return mockCmdResult(0, JSON.stringify({ value: 'file:///fake-remote-eft63-2' }), '');
        }

        if (cmd === 'bd dolt pull') {
            commandLog.push(cmd);
            doltPullAttempts += 1;
            return {
                isError: true,
                content: [{
                    text: 'Exit code: 1\n[stderr]\nError 1105: fetch failed: no branches found in remote origin',
                }],
                structuredContent: { exitCode: 1, stdout: '', stderr: 'Error 1105: fetch failed: no branches found in remote origin' },
            };
        }

        return baseApi.executeCommand(opts);
    };

    return {
        executeCommand,
        executePrompt: baseApi.executePrompt,
        _doltPullAttempts: () => doltPullAttempts,
    };
}

test(
    'apra-fleet-eft.63.2: preflight D-pull against an empty never-pushed Dolt remote (Error 1105 "no branches found") ' +
    'is a no-op success and the sprint reaches Planning and completes',
    async () => {
        await withScenarioMarkers('emptyremotegate', async () => {
            const { tempDir, epicBead } = await setup('emptyremotegate');
            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildEmptyRemoteGateFleetApi(tempDir, epicBead, dispatched, commandLog, {
                    planReviewerMode: 'reject-then-approve',
                });
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                const engine = new WorkflowEngine(workflow);

                const result = await engine.executeFile(scriptPath, {
                    target_issue: epicBead.id,
                    members: ['local'],
                    branch: 'auto-sprint/mock-emptyremotegate',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 5,
                }, true);

                // ---- 1. The sprint reaches Planning (and beyond: completes) ----
                assert.ok(
                    result && result.status === 'success',
                    `expected the sprint to complete successfully despite the empty-remote D-pull fixture, got: ${JSON.stringify(result)}`,
                );
                assert.ok(
                    dispatched.some((d) => d.agent === 'planner'),
                    `expected at least one 'planner' dispatch (the sprint reached Planning), got dispatched agents: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );

                // ---- 2. The empty-remote fixture's `bd dolt pull` genuinely fired ----
                // (proving this scenario's injected failure was actually reached via
                // the gate's real call site, not skipped/bypassed by the mock).
                assert.ok(
                    mockFleetApi._doltPullAttempts() > 0,
                    'expected the empty-remote `bd dolt pull` fixture to have fired at least once',
                );

                // ---- 3. Setup was never aborted: branch-ensure still ran ----
                const ensureBranchCommands = commandLog.filter((c) => c.startsWith('git checkout -B'));
                assert.ok(
                    ensureBranchCommands.length > 0,
                    `expected at least one ensure-branch (\`git checkout -B\`) command to have run, got: ${JSON.stringify(commandLog)}`,
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);

/**
 * Wraps buildMockFleetApi()'s executeCommand so the FIRST `bd dolt pull`
 * this run issues fails with a genuine Dolt merge-conflict signature -- a
 * real divergence, distinct from the empty-remote no-op fixture above.
 * Same `bd config get sync.remote --json` override, for the same reason.
 */
function buildDivergedGateFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    let doltPullAttempts = 0;

    const executeCommand = async (opts) => {
        const cmd = opts.command;

        if (cmd === 'bd config get sync.remote --json') {
            commandLog.push(cmd);
            return mockCmdResult(0, JSON.stringify({ value: 'file:///fake-remote-eft63-2-neg' }), '');
        }

        if (cmd === 'bd dolt pull') {
            commandLog.push(cmd);
            doltPullAttempts += 1;
            return {
                isError: true,
                content: [{
                    text: 'Exit code: 1\n[stderr]\nerror: unmergeable conflict pulling from remote: ' +
                        'conflict in table `child_counters`, conflict in table `dependencies`, ' +
                        'conflict in table `issues` -- resolve manually',
                }],
                structuredContent: { exitCode: 1, stdout: '', stderr: 'conflict in tables child_counters, dependencies, issues' },
            };
        }

        return baseApi.executeCommand(opts);
    };

    return {
        executeCommand,
        executePrompt: baseApi.executePrompt,
        _doltPullAttempts: () => doltPullAttempts,
    };
}

test(
    'apra-fleet-eft.63.2 NEGATIVE CASE: a genuine divergence/conflict D-pull failure still aborts the sprint ' +
    'BEFORE Planning (not swallowed by the new empty-remote no-op)',
    async () => {
        await withScenarioMarkers('emptyremotegateneg', async () => {
            const { tempDir, epicBead } = await setupMinimal('emptyremotegateneg', [
                { title: 'Task: never reached -- gate aborts before Planning' },
            ]);
            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildDivergedGateFleetApi(tempDir, epicBead, dispatched, commandLog, {
                    planReviewerMode: 'approve-immediately',
                    addExtraTaskDuringPlan: false,
                });
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                const engine = new WorkflowEngine(workflow);

                let error = null;
                let result = null;
                try {
                    result = await engine.executeFile(scriptPath, {
                        target_issue: epicBead.id,
                        members: ['local'],
                        branch: 'auto-sprint/mock-emptyremotegateneg',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 1,
                    }, true);
                } catch (err) {
                    error = err;
                }

                // ---- 1. The sprint still aborts (never reaches a success result) ----
                assert.ok(error, `expected the diverged D-pull to abort the sprint, got a result instead: ${JSON.stringify(result)}`);
                assert.ok(
                    error instanceof DoltDivergedError,
                    `expected a typed DoltDivergedError from the pre-flight gate, got: ${error && error.constructor && error.constructor.name}: ${error && error.message}`,
                );
                // DoltDivergedError carries code DOLT_DIVERGED (the sibling
                // DoltSyncError/DOLT_SYNC_FAILED covers transient-exhausted/
                // unrecognized D-pull failures -- see dolt-sync-brackets.test.mjs);
                // either way this is the same abort-the-sprint-before-Planning
                // family the empty-remote fixture above must NOT fall into.
                assert.strictEqual(
                    error.code, 'DOLT_DIVERGED',
                    `expected the abort error's code to be DOLT_DIVERGED, got: ${error && error.code}`,
                );

                // ---- 2. Planning was never reached ----
                assert.strictEqual(
                    dispatched.filter((d) => d.agent === 'planner').length, 0,
                    `expected zero 'planner' dispatches -- Planning was never reached, got dispatched agents: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );

                // ---- 3. The gate's own D-pull probe genuinely fired exactly once ----
                assert.strictEqual(
                    mockFleetApi._doltPullAttempts(), 1,
                    `expected exactly one \`bd dolt pull\` attempt (the gate's own probe, never retried on a divergence), got ${mockFleetApi._doltPullAttempts()}`,
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);
