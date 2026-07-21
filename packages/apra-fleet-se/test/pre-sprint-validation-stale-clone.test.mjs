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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

// =============================================================================
// apra-fleet-eft.36: coverage for the RESIDUAL escape path apra-fleet-eft.34
// fixed, which eft.24.2's mock-sprint suite (mock-sprint-childless-target-
// scope.test.mjs) could never catch.
//
// Parent bug: apra-fleet-eft.24 ("Pre-sprint validation failed: No open/
// in-progress/blocked/deferred beads found for scope ... Nothing to do.").
// eft.24.1 seeded bdListScoped's scopeIds with a childless leaf target's own
// id; eft.24.2 covered that seed with mock-sprint coverage. The bug still
// recurred live because members in this always-on multi-sprint supervisor
// fleet are PERSISTENT across sprints, so the orchestrator member's local
// beads clone can be stale relative to the shared Dolt remote at the exact
// moment a NEW sprint is dispatched: a freshly bd-created childless canary
// target is genuinely invisible to fetchAllBeadsShared()'s
// `bd list --all --limit 0 --json` (issued against the orchestrator member)
// until that clone pulls it in. eft.24.1's scopeIds seed only matters if the
// target bead is actually PRESENT in the queried result to begin with -- on a
// stale clone it is not, regardless of scopeIds membership.
//
// eft.24.2's harness could never reproduce this: its single-clone
// record/replay setup has no dolt remote configured at all, so there is no
// orchestrator-clone-vs-shared-remote drift to simulate. This suite adds
// that drift directly at the executeCommand() intercept layer:
//   - `bd config get sync.remote --json` always reports a CONFIGURED remote,
//     so doltPullBefore()'s pre-gate does not skip the pull outright.
//   - `bd dolt pull` is mocked to a cheap, deterministic success (never
//     touches a real dolt remote) and flips a `doltPulled` latch.
//   - `bd dolt push` is likewise mocked to a cheap success (some role
//     dispatches will attempt one; never touches a real dolt remote).
//   - `bd list --all --limit 0 --json` -- fetchAllBeadsShared()'s query --
//     returns an EMPTY list (`[]`) for every call BEFORE the latch flips,
//     simulating the target being genuinely absent from a stale
//     orchestrator clone, then falls through to the real underlying `bd`
//     state (via the base mock's real bd-replay execution) once the D-pull
//     has fired.
//
// eft.34's fix is `await doltPullBefore(orchestratorMember, ...)` immediately
// before pre-sprint validation's first bd query (updateDashboard's
// bdListScoped('') call, then the `--ready`/notDoneBeads queries). With that
// D-pull in place, the very first `bd list --all` read pre-sprint validation
// performs happens AFTER the latch has flipped, so it observes the real
// (non-stale) bd state and validation does not hard-fail. Without it (the
// pre-fix behaviour), that first read races ahead of any pull and observes
// the empty stale snapshot, tripping "Pre-sprint validation failed: ...
// Nothing to do." -- confirmed by temporarily removing the D-pull call site
// and re-running this suite, which reproduces exactly that failure.
// =============================================================================

/**
 * Wraps buildMockFleetApi()'s executeCommand with the stale-clone-drift
 * intercepts described above. Everything else (executePrompt, and any
 * executeCommand call not explicitly intercepted) is delegated unchanged to
 * the base mock, so this only ever adds the drift simulation -- it does not
 * change any other dispatch/verdict behaviour the base mock already covers.
 */
function buildStaleCloneFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    let doltPulled = false;
    let staleAllListReads = 0;
    let freshAllListReads = 0;

    const executeCommand = async (opts) => {
        const cmd = opts.command;

        if (cmd === 'bd config get sync.remote --json') {
            commandLog.push(cmd);
            return mockCmdResult(0, JSON.stringify({ value: 'file:///fake-remote-eft36' }), '');
        }

        if (cmd === 'bd dolt pull') {
            commandLog.push(cmd);
            doltPulled = true;
            return mockCmdResult(0, 'up to date (mocked, apra-fleet-eft.36 stale-clone drift sim)', '');
        }

        if (cmd === 'bd dolt push') {
            commandLog.push(cmd);
            return mockCmdResult(0, 'up to date (mocked, apra-fleet-eft.36 stale-clone drift sim)', '');
        }

        // bdListScoped() issues TWO distinct `bd list ... --limit 0` queries
        // against the SAME orchestrator clone: fetchAllBeadsShared()'s
        // `bd list --all --limit 0 --json` (used to build scopeIds/childrenOf
        // AND as the direct result for a plain `bdListScoped('')` call), and
        // -- whenever `restArgs` is non-empty (e.g. `--ready --json` or
        // `--status=... --json`) -- a second `bd list <restArgs> --limit 0`
        // filter query, intersected with scopeIds afterward. In real life
        // BOTH commands hit the exact same underlying (possibly stale)
        // clone/database, so a faithful drift simulation must stale-ify
        // both, not just the `--all` one -- staleing only `--all` would
        // under-simulate the bug (the `--ready`/`--status` filter query
        // would still see the real, live bd state and mask the escape path
        // eft.34 fixed).
        if (/^bd list\b.*--limit 0\b/.test(cmd)) {
            if (!doltPulled) {
                staleAllListReads += 1;
                commandLog.push(cmd);
                // The orchestrator's OWN clone has not pulled yet: every bead
                // (including the sprint target itself) is genuinely invisible.
                return mockCmdResult(0, '[]', '');
            }
            freshAllListReads += 1;
        }

        return baseApi.executeCommand(opts);
    };

    return {
        executeCommand,
        executePrompt: baseApi.executePrompt,
        _staleCloneStats: () => ({ doltPulled, staleAllListReads, freshAllListReads }),
    };
}

test(
    'apra-fleet-eft.36: a childless leaf target invisible to a STALE orchestrator `bd list --all` clone is still ' +
    'recovered by the pre-sprint D-pull -- validation does not hard-fail and the cycle reaches Planning',
    async () => {
        await withScenarioMarkers('eft36-stale-a', async () => {
            // taskSpecs: [] -- ZERO children, i.e. eft.24's exact self-
            // provisioned-canary repro shape, now ALSO invisible to the
            // orchestrator's clone until the D-pull runs.
            //
            // NOTE: setupMinimal()'s tempDir basename becomes the bd/Dolt
            // database name (dashes -> underscores) and that identifier has
            // a 64-char cap -- keep this tag short (mirrors the existing
            // 'childless-a/b/c' tags in mock-sprint-childless-target-
            // scope.test.mjs) so `<tag>-<timestamp>-<pid>` never overflows it.
            const { tempDir, epicBead } = await setupMinimal('eft36-stale-a', []);
            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildStaleCloneFleetApi(tempDir, epicBead, dispatched, commandLog, {
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
                        branch: 'auto-sprint/mock-eft36-stale-a',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 1,
                    }, true);
                } catch (err) {
                    error = err;
                }

                assert.strictEqual(
                    error, null,
                    `expected the sprint NOT to abort with a pre-sprint validation hard-fail for a target that is ` +
                        `only STALE (not genuinely missing), got: ${error && error.message}`,
                );
                assert.ok(error === null || !/Pre-sprint validation failed/.test(error.message),
                    `must not be the 'Pre-sprint validation failed: ... Nothing to do' hard-fail this bug produces, got: ${error && error.message}`);
                assert.ok(result, 'expected a result object (no abort)');
                assert.strictEqual(
                    result.status, 'success',
                    `expected the sprint to complete successfully for a stale-then-fresh childless target, got: ${JSON.stringify(result)}`,
                );

                // The success assertions above are already the primary
                // tripwire: without apra-fleet-eft.34's D-pull call site,
                // `doltPulled` never flips true before the FIRST `bd list
                // --all` read (there is no other dolt-pull call anywhere
                // earlier in the cycle), so that first read hits the stale
                // (empty) mock and pre-sprint validation hard-fails with
                // 'Pre-sprint validation failed: ... Nothing to do' --
                // exactly the `error` this test asserts is null. These stats
                // add a second, more precise signal: with the fix in place,
                // the D-pull genuinely races AHEAD of every `bd list --all`
                // read (zero of them ever observe the stale snapshot), not
                // just "eventually, after some stale reads already leaked
                // through" -- a strictly weaker, still-buggy variant this
                // pins down too.
                const stats = mockFleetApi._staleCloneStats();
                assert.ok(stats.doltPulled, 'expected the orchestrator D-pull (`bd dolt pull`) to have actually fired before validation completed');
                assert.strictEqual(
                    stats.staleAllListReads, 0,
                    `expected the D-pull to precede EVERY \`bd list --all\` read (zero stale reads leaking through), got ${JSON.stringify(stats)}`,
                );
                assert.ok(
                    stats.freshAllListReads > 0,
                    `expected at least one fresh \`bd list --all\` read after the D-pull (proving the drift simulation was genuinely wired up), got ${JSON.stringify(stats)}`,
                );

                // Reached Planning: a real Planning-phase planner dispatch
                // (not the later streak-assignment reuse of the planner
                // member -- see mock-sprint-childless-target-scope.test.mjs
                // for the same distinguishing logic).
                const planningDispatches = dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
                assert.ok(
                    planningDispatches.length > 0,
                    `expected at least one real Planning-phase planner dispatch, proving the sprint advanced past 'Sprint Setup' into Planning despite the stale-clone drift. dispatched: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);

test(
    'apra-fleet-eft.36 regression guard: the SAME stale-clone drift against an already-decomposed target does not ' +
    'newly count the grouping node as ready, and the sprint still succeeds normally',
    async () => {
        await withScenarioMarkers('eft36-stale-b', async () => {
            // One child task -- the target itself is decomposed, unlike the
            // childless scenario above. eft.24.1's childless-only scopeIds
            // seed must stay inert here: the target's own id must NOT enter
            // scopeIds just because this new D-pull recovery path exists.
            // (Short tag -- see the char-limit note in the scenario above.)
            const { tempDir, epicBead, tasks } = await setupMinimal('eft36-stale-b', [
                { title: 'Task: only child of the decomposed target' },
            ]);
            const childId = tasks[0].id;
            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildStaleCloneFleetApi(tempDir, epicBead, dispatched, commandLog, {
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
                        branch: 'auto-sprint/mock-eft36-stale-b',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 1,
                    }, true);
                } catch (err) {
                    error = err;
                }

                assert.strictEqual(error, null, `expected the decomposed-target sprint to complete without aborting, got: ${error && error.message}`);
                assert.strictEqual(result.status, 'success', `expected the sprint to complete successfully, got: ${JSON.stringify(result)}`);

                const stats = mockFleetApi._staleCloneStats();
                assert.ok(stats.doltPulled, 'expected the orchestrator D-pull to have fired for the decomposed-target scenario too');
                assert.strictEqual(stats.staleAllListReads, 0, `expected zero stale \`bd list --all\` reads to leak through, got ${JSON.stringify(stats)}`);
                assert.ok(stats.freshAllListReads > 0, `expected the drift simulation to have been genuinely wired up, got ${JSON.stringify(stats)}`);

                // apra-fleet-xbu.C5 guard, unaffected by this D-pull recovery
                // path: the decomposed target must never appear in a
                // streak-assignment or doer dispatch alongside its own child.
                const streakDispatches = dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
                assert.ok(streakDispatches.length > 0, 'expected at least one streak-assignment dispatch');
                for (const d of streakDispatches) {
                    const idsMatch = d.prompt.match(/Ready bead ids:\s*(.+)/);
                    const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                    assert.ok(
                        !ids.includes(epicBead.id),
                        `expected the decomposed target ${epicBead.id} to stay excluded from the ready-dispatch set even after D-pull recovery, got ready ids: ${JSON.stringify(ids)}`,
                    );
                    assert.ok(ids.includes(childId), `expected the leaf child ${childId} to be present in the ready-dispatch set, got: ${JSON.stringify(ids)}`);
                }
            } finally {
                await teardown(tempDir);
            }
        });
    },
);
