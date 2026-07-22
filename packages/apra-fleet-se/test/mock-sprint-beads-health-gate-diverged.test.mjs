import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import {
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
// apra-fleet-eft.58.2: regression pin for eft.58 / impl eft.58.1 -- the
// pre-flight beads-health gate (preflightBeadsHealthGate(), see runner.js)
// must catch a diverged orchestrator beads DB BEFORE Sprint Setup's
// branch-ensure loop issues its first `git fetch`/`git checkout -B`, and
// BEFORE any PR command -- not after, which is what let a diverged clone
// (run 20) leave setup mutations half-done with only a raw dolt stack in
// stderr for an operator to find.
//
// dolt-sync-brackets.test.mjs already pins preflightBeadsHealthGate()'s
// UNIT behaviour (cause composition, fallbacks) against a scripted
// command() mock. This suite is the missing END-TO-END layer: a full
// engine.executeFile(runner.js, ...) run, driven through the SAME
// buildMockFleetApi() mock every other mock-sprint suite uses, with a
// `bd dolt pull` failure injected at the executeCommand() intercept layer
// (mirroring pre-sprint-validation-stale-clone.test.mjs's drift-simulation
// pattern) so the gate's real call site -- the very top of Sprint Setup,
// wired in by eft.58.1 -- is what actually fires, not a hand-invoked helper
// call.
// =============================================================================

/**
 * Wraps buildMockFleetApi()'s executeCommand so the FIRST `bd dolt pull`
 * this run issues (the pre-flight beads-health gate's own D-pull probe --
 * genuinely the first fleet dispatch of the run, per eft.58.1) fails with a
 * real Dolt merge-conflict error, exactly the "beads DB diverged from the
 * shared remote" shape described in the parent bug: an unmergeable conflict
 * touching the child_counters/dependencies/issues tables. `bd config get
 * sync.remote --json` is also intercepted to report a CONFIGURED remote, so
 * doltPullBefore()'s pre-gate does not short-circuit the pull as a benign
 * no-remote skip (this hermetic tempDir has no real dolt remote at all, so
 * without this override the gate's own D-pull would never even attempt to
 * run and this scenario could never fire). Everything else -- including any
 * LATER `bd dolt pull`/`bd dolt push` this run might otherwise have
 * issued -- delegates to the base mock unchanged; in practice no later
 * command is ever reached, since the gate throws before Sprint Setup's
 * branch-ensure loop issues its first git command.
 */
function buildDivergedGateFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    let doltPullAttempts = 0;

    const executeCommand = async (opts) => {
        const cmd = opts.command;

        if (cmd === 'bd config get sync.remote --json') {
            commandLog.push(cmd);
            return mockCmdResult(0, JSON.stringify({ value: 'file:///fake-remote-eft58-2' }), '');
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
    'apra-fleet-eft.58.2: a conflict-returning D-pull at the pre-flight beads-health gate aborts BEFORE any ' +
    'git branch/PR command, logs an actionable /beads DB diverged/ cause naming the remediation, and persists ' +
    'the same reason string to terminal run state',
    async () => {
        await withScenarioMarkers('beadshealthgatediverged', async () => {
            const { tempDir, epicBead } = await setupMinimal('healthgatediverged', [
                { title: 'Task: never reached -- gate aborts before Sprint Setup' },
            ]);
            const dispatched = [];
            const commandLog = [];
            const logs = [];
            const states = [];
            try {
                const mockFleetApi = buildDivergedGateFleetApi(tempDir, epicBead, dispatched, commandLog, {
                    planReviewerMode: 'approve-immediately',
                    addExtraTaskDuringPlan: false,
                });
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                workflow.on('log', (e) => logs.push(e.msg));
                workflow.on('state', (e) => states.push(e));
                const engine = new WorkflowEngine(workflow);

                let error = null;
                let result = null;
                try {
                    result = await engine.executeFile(scriptPath, {
                        target_issue: epicBead.id,
                        members: ['local'],
                        branch: 'auto-sprint/mock-healthgatediverged',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 1,
                    }, true);
                } catch (err) {
                    error = err;
                }

                // ---- 1. The sprint aborts (never reaches a success result) ----
                assert.ok(error, `expected the diverged D-pull to abort the sprint, got a result instead: ${JSON.stringify(result)}`);
                assert.ok(
                    error instanceof DoltDivergedError,
                    `expected a typed DoltDivergedError from the pre-flight gate, got: ${error && error.constructor && error.constructor.name}: ${error && error.message}`,
                );
                assert.match(
                    error.message, /beads DB diverged/,
                    `expected the thrown error's own message to match /beads DB diverged/, got: ${error && error.message}`,
                );

                // ---- 2. No ensure-branch / PR command ever ran ----
                // The gate is wired in strictly BEFORE Sprint Setup's
                // branch-ensure loop (eft.58.1) -- its first mutation is
                // `git checkout -B <branch>` off a freshly-fetched base/
                // sprint-branch ref. A diverged D-pull must abort before that
                // ever fires, and before any `gh pr create` (finalization/
                // abort-path PR raise).
                const ensureBranchCommands = commandLog.filter((c) => c.startsWith('git checkout -B'));
                assert.strictEqual(
                    ensureBranchCommands.length, 0,
                    `expected zero ensure-branch (\`git checkout -B\`) commands to have run, got: ${JSON.stringify(commandLog)}`,
                );
                const prCommands = commandLog.filter((c) => c.startsWith('gh pr create'));
                assert.strictEqual(
                    prCommands.length, 0,
                    `expected zero PR-raise commands to have run, got: ${JSON.stringify(commandLog)}`,
                );

                // The gate's own D-pull probe must have genuinely fired
                // exactly once (proving this scenario's injected failure was
                // actually reached, not skipped as a no-remote no-op).
                assert.strictEqual(
                    mockFleetApi._doltPullAttempts(), 1,
                    `expected exactly one \`bd dolt pull\` attempt (the gate's own probe, never retried on a divergence), got ${mockFleetApi._doltPullAttempts()}`,
                );

                // ---- 3. Main-log line names the remediation (log assertion, not stderr) ----
                // Proving this is present in the workflow's OWN 'log' event
                // stream -- what actually reaches the main sprint log an
                // operator reads -- not merely buried in the raw error stack/
                // stderr text, is the crux of this regression: the bug this
                // gate exists to fix left an operator staring at a raw dolt
                // stack dump with no actionable next step.
                const divergedLogLines = logs.filter((l) => /beads DB diverged/.test(l));
                assert.ok(
                    divergedLogLines.length > 0,
                    `expected a main-log line matching /beads DB diverged/, got logs: ${JSON.stringify(logs)}`,
                );
                assert.ok(
                    divergedLogLines.some((l) => /resolve or re-init from the shared remote, then relaunch/.test(l)),
                    `expected the /beads DB diverged/ main-log line to name the remediation, got: ${JSON.stringify(divergedLogLines)}`,
                );

                // ---- 4. Terminal run state persists the SAME reason string ----
                const terminalStates = states.filter((s) => s.namespace === 'terminal');
                assert.ok(
                    terminalStates.length > 0,
                    `expected at least one persisted 'terminal' run-state record, got states: ${JSON.stringify(states)}`,
                );
                const terminalMessage = terminalStates[terminalStates.length - 1].data && terminalStates[terminalStates.length - 1].data.message;
                assert.match(
                    String(terminalMessage), /beads DB diverged/,
                    `expected the persisted terminal state's message to carry the /beads DB diverged/ reason, got: ${JSON.stringify(terminalStates[terminalStates.length - 1])}`,
                );
                assert.strictEqual(
                    terminalMessage, error.message,
                    `expected the persisted terminal state's message to carry the EXACT SAME reason string as the thrown error's message`,
                );

                // ---- 5. No dispatches at all -- the gate is the very first fleet dispatch of the run ----
                assert.strictEqual(
                    dispatched.length, 0,
                    `expected zero agent dispatches (planner/doer/reviewer/etc.) -- the gate aborts before any of them, got: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);

// apra-fleet-eft.58.2 acceptance criterion "the happy path is unchanged
// (existing mock-sprint suites stay green)": deliberately NOT re-asserted as
// a fresh scenario here -- a full clean-D-pull happy-path run needs its own
// committed bd-recording fixture (record/replay layer, see
// helpers/bd-replay.mjs), and mock-sprint-happy-path.test.mjs already pins
// exactly this ("the pre-flight beads-health gate now runs BEFORE
// branch-ensure", see its own eft.58.1 comment block asserting the gate's
// `bd config get sync.remote --json` / `bd dolt pull` precede the first git
// command with the ordinary/no-remote happy path unaffected). This suite's
// own verification run (`npm test`) exercises that file in the same pass,
// which is the regression coverage this criterion asks for.
