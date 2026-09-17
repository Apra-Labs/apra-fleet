import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
// bd record/replay-aware runCmd -- same (cmd, cwd) signature, and in real
// mode (APRA_FLEET_BD_MOCK=0) byte-for-byte the local exec() copy this
// replaced; see test/helpers/bd-replay.mjs for the APRA_FLEET_BD_MOCK
// contract.
import { runCmd } from './helpers/bd-replay.mjs';
import { extractVerifyIds } from './helpers/verify-clause.mjs';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
// apra-fleet-j918.7.8: the determinism test resets dolt-sync's process-
// lifetime sync.remote/tip memoization (apra-fleet-akuv) before its own
// independent second run -- see that test for why.
import { invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-unw2.17 (N16) -- 3-bead golden variant protecting the
// apra-fleet-unw.19 ordering fixes (runner.js's `.sort((a, b) =>
// a.title.localeCompare(b.title) || a.id.localeCompare(b.id))` calls that
// feed the streak-assignment prompt's "Ready bead ids:" line and the
// reviewer prompt's "...following bead id(s):" line).
//
// test/golden-transcript.test.mjs's committed scenario is deliberately
// single-bead (see its own header comment), so every one of those sorts is
// a no-op there -- reverting any of them still passes that suite in full.
// This file closes that gap with a 3-INDEPENDENT-bead scenario (three
// sibling tasks under one epic, no dependencies between them), so all
// three are ready in the SAME cycle and runner.js's Develop loop dispatches
// one doer streak per bead via `parallel()` -- genuine, correct concurrency
// whose completion order is real child-process/microtask scheduling, not
// anything this mock or runner.js controls.
//
// Rather than snapshotting the FULL ordered dispatch transcript (as
// golden-transcript.test.mjs does for its single-bead scenario), this test
// snapshots ONLY the two order-sensitive artifacts apra-fleet-unw.19 fixed:
//
//   1. The streak-assignment prompt text (its "Ready bead ids: ..." line
//      is built from the title/id-sorted `currentReady` list --
//      runner.js:~1422).
//   2. The reviewer prompt's bead-id list (built from the title/id-sorted
//      `assignedBeadIds` list -- runner.js:~1589-1593).
//
// Both are deterministic (title is static, per-run-stable text) regardless
// of which of the three parallel doer streaks physically finishes first.
// Asserting on the FULL dispatch order across the three streaks would
// reintroduce exactly the genuine parallel-completion race
// golden-transcript.test.mjs's single-bead design note explains avoiding --
// this file must never do that (no dispatch-log ordering assertions here,
// only assertions on the two fields above).
//
// Update path (deliberately NOT automatic, same gate as
// golden-transcript.test.mjs): run
//   UPDATE_GOLDEN=1 node --test test/golden-transcript-3bead.test.mjs
// to regenerate test/fixtures/golden-transcript/mock-sprint-3bead.jsonl. A
// normal `npm test` run NEVER writes the golden file.
// =============================================================================

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'golden-transcript');
const GOLDEN_PATH = path.join(GOLDEN_DIR, 'mock-sprint-3bead.jsonl');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

// apra-fleet-ot2z.14: runner.js's main() acquires the machine-local sprint
// pidfile mutex (fleet-sprint/sprint-lock.mjs) keyed on (branch, members)
// against the OS-tmpdir-wide default lock directory unless
// APRA_FLEET_SPRINT_LOCK_DIR is set. This file's `branch: 'auto-sprint/
// mock-sprint-3bead'` is a fixed literal shared by every test below, so
// without isolation it could spuriously collide with an unrelated REAL
// fleet-sprint concurrently running on the same host under
// `--test-concurrency=8`. Node's test runner spawns one process per test
// file, so setting this once at module scope (a fresh throwaway dir for
// this file's whole process lifetime) safely isolates every test here
// without affecting other files.
process.env.APRA_FLEET_SPRINT_LOCK_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-golden-3bead-'));

// apra-fleet-7ll: replicate the real execute_command MCP tool's response
// shape (src/tools/execute-command.ts) -- "Exit code: N\n<output>" display
// text PLUS a structuredContent.stdout/stderr/exitCode machine-readable
// channel -- so this mock exercises the same contract FleetWorkflow.command()
// actually receives in production, instead of a cleaner-than-reality stand-in
// that silently masked the "Exit code: N\n" prefix bug for this suite's
// whole lifetime.
function mockCmdResult(code, stdout, stderr) {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    const output = parts.join('\n') || '(no output)';
    return {
        content: [{ text: `Exit code: ${code}\n${output}` }],
        structuredContent: { exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' },
    };
}

// apra-fleet-1cb.1: classifies a runCmd() `err` (Node's child_process exec()
// callback error) as a genuine spawn/transport failure (the process never
// ran) as opposed to the process running and exiting nonzero, which is
// normal data -- see the matching comment in
// test/helpers/mock-sprint-harness.mjs and src/tools/execute-command.ts,
// which never sets isError for a nonzero shell exit code.
function isSpawnFailure(err) {
    return err.code === undefined || err.code === 'ENOENT';
}

// apra-fleet-1cb.2: direct regression assertion for the isError/nonzero-exit
// contract above -- protects against mockCmdResult()/isSpawnFailure()
// silently drifting back to conflating "shell exited nonzero" with "MCP
// dispatch failed" (the bug apra-fleet-1cb.1 fixed here). Exercises the two
// functions directly rather than a full mock sprint, so it stays fast and
// pinpoints the exact function at fault on a regression.
test('mockCmdResult/isSpawnFailure: nonzero exit is non-error data, spawn failure is isError:true', () => {
    // A nonzero shell exit (e.g. a `bd` command failing on bad input) is
    // normal data, matching src/tools/execute-command.ts -- never isError.
    const nonzeroExit = mockCmdResult(1, '', 'bead already closed');
    assert.strictEqual(nonzeroExit.isError, undefined);
    assert.strictEqual(nonzeroExit.structuredContent.exitCode, 1);
    assert.match(nonzeroExit.content[0].text, /^Exit code: 1/);

    // A genuine spawn/transport failure (process never ran) IS isError:true
    // in the command() dispatch logic below -- isSpawnFailure() is what
    // distinguishes that case from an ordinary nonzero exit code.
    assert.strictEqual(isSpawnFailure({ code: undefined }), true);
    assert.strictEqual(isSpawnFailure({ code: 'ENOENT' }), true);
    assert.strictEqual(isSpawnFailure({ code: 1 }), false);
    assert.strictEqual(isSpawnFailure({ code: 127 }), false);
});

// Titles chosen so alphabetical (title) order DIFFERS from creation order
// (and from `bd list --ready`'s undocumented, created_at-derived default
// order -- see the apra-fleet-unw.19 comment in runner.js): creating
// Zzz-then-Aaa-then-Mmm means a raw/unsorted or reversed-creation-order
// listing would NOT match the alphabetical "Aaa, Mmm, Zzz" order the
// title-sort fix guarantees. This is what makes the scenario actually
// exercise the sort rather than passing vacuously.
const TASK_TITLES = [
    'Task: Zzz finalize retry backoff for register_member calls',
    'Task: Aaa implement listMembers pagination in client.js',
    'Task: Mmm add ensureMember idempotency check',
];

// apra-fleet-wclh.1: setup() drives several sequential `bd` calls whose
// results feed straight into the NEXT call (e.g. `bd list --json`'s output
// decides `epicBead`, then `epicBead.id` is used to parent every task). Under
// real bd (APRA_FLEET_BD_MOCK=0) any one of those calls can fail for a
// reason that has nothing to do with this scenario's logic (a transient
// spawn/resource failure, an unexpected bd exit) -- `runCmd()` never rejects,
// it resolves `{ err, stdout, stderr }` and leaves the caller to notice.
// Before this fix, setup() never checked `err` on any of its calls, so a
// failed `bd list --json` silently produced `stdout: ''` -> `epicList: []` ->
// `epicBead: undefined`, and the very next line's `epicBead.id` threw a bare
// `TypeError: Cannot read properties of undefined (reading 'id')` with a
// stack trace pointing at the dereference, not the actual failed command --
// exactly the crash apra-fleet-wclh reported (reproduced by forcing `bd
// list --json` to fail: identical message, identical ~4-5s elapsed, all
// scenario-running subtests failing the same way). Guarding every call here
// turns that opaque TypeError into a diagnostic naming the actual failed `bd`
// command, its exit/stderr, and -- for the epic lookup specifically -- what
// `bd list --json` actually returned.
function assertCmdOk(res, description) {
    if (res.err) {
        throw new Error(
            `golden-transcript-3bead.test.mjs setup(): ${description} failed unexpectedly.\n` +
            `exit: ${typeof res.err.code === 'number' ? res.err.code : '(spawn failure -- process never ran)'}\n` +
            `stdout: ${res.stdout || '(empty)'}\n` +
            `stderr: ${res.stderr || '(empty)'}\n` +
            `${res.err.message || ''}`
        );
    }
    return res;
}

// apra-fleet-wclh.2: `runCmdFn` is an injection seam (defaulting to the real
// `runCmd` above) so this guard's own test suite below can drive setup()
// with a simulated failing/malformed `bd` response and pin the exact
// dereference apra-fleet-wclh.1 fixed, without requiring a contended real-bd
// run to exercise the failure path. Every production call site omits it and
// is unaffected.
async function setup(tempDirSuffix, runCmdFn = runCmd) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-golden-3bead-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    assertCmdOk(await runCmdFn('bd init', tempDir), '`bd init`');

    assertCmdOk(
        await runCmdFn('bd create -t epic "Epic: Fleet Member Management APIs (3-bead)" -d "Three independent, sibling tasks -- no dependency between them -- so all three are ready in the same Develop cycle and dispatch as concurrent doer streaks."', tempDir),
        '`bd create -t epic ...` (epic creation)'
    );

    const epicListRes = assertCmdOk(await runCmdFn('bd list --json', tempDir), '`bd list --json` (epic lookup)');
    const epicList = JSON.parse(epicListRes.stdout || '[]');
    const epicBead = epicList.find((b) => b.title.startsWith('Epic:'));
    if (!epicBead) {
        throw new Error(
            'golden-transcript-3bead.test.mjs setup(): `bd list --json` did not return the just-created epic bead ' +
            `(expected a title starting with 'Epic:'). Got ${epicList.length} bead(s): ` +
            `${JSON.stringify(epicList.map((b) => b.title))}.`
        );
    }

    const taskIds = [];
    for (const title of TASK_TITLES) {
        const createRes = assertCmdOk(
            await runCmdFn(`bd create "${title}" -d "Independent sibling task." --silent`, tempDir),
            `\`bd create "${title}"\``
        );
        const id = createRes.stdout.trim();
        assertCmdOk(
            await runCmdFn(`bd update ${id} --parent ${epicBead.id}`, tempDir),
            `\`bd update ${id} --parent ${epicBead.id}\``
        );
        taskIds.push(id);
    }

    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');

    return { tempDir, epicBead, taskIds };
}

// apra-fleet-wclh.2: regression pin for apra-fleet-wclh.1's fix, unit-level
// (no real-bd sprint run required -- see criterion 3). Drives setup() and
// assertCmdOk() directly with an injected fake `runCmdFn` reproducing the
// exact input shape that used to crash: a `bd list --json` that fails (or
// returns a list with no epic bead), which pre-fix flowed straight into
// `epicBead.id` and threw a bare `TypeError: Cannot read properties of
// undefined (reading 'id')`. Every case below asserts on the SPECIFIC
// diagnostic text the fix now produces, not merely that some error was
// thrown -- a test that only checks "it threw" would still pass against a
// reverted fix (the bare TypeError also throws), so that would not meet
// criterion 2's "pin the specific handled shape" requirement.
function fakeCmdResult(err, stdout = '', stderr = '') {
    return { err, stdout, stderr };
}

function makeFailingErr(code, message) {
    return Object.assign(new Error(message), { code });
}

// setup() unconditionally fs.mkdir(tempDir)s before issuing any bd call, so
// even a case that throws mid-setup leaves an empty tempDir behind. Swept up
// by suffix after each such test so this guard's own suite leaves nothing
// outside its sandbox (acceptance criterion 5).
async function cleanupGoldenTempDirs(suffix) {
    const tmp = os.tmpdir();
    const prefix = `apra-fleet-golden-3bead-${suffix}-`;
    let entries;
    try {
        entries = await fs.readdir(tmp);
    } catch {
        return;
    }
    await Promise.all(
        entries
            .filter((name) => name.startsWith(prefix))
            .map((name) => fs.rm(path.join(tmp, name), { recursive: true, force: true })),
    );
}

test('assertCmdOk: a failed bd call throws naming the description, exit code, and stdout/stderr', () => {
    assert.throws(
        () => assertCmdOk(fakeCmdResult(makeFailingErr(1, 'Command failed: bd list --json'), '', 'unknown flag: --FORCE-REPRO-FAILURE'), '`bd list --json` (epic lookup)'),
        (err) => {
            assert.match(err.message, /`bd list --json` \(epic lookup\) failed unexpectedly/);
            assert.match(err.message, /exit: 1/);
            assert.match(err.message, /unknown flag: --FORCE-REPRO-FAILURE/);
            return true;
        },
    );
});

test('assertCmdOk: a successful bd call returns the result unchanged', () => {
    const ok = fakeCmdResult(null, 'apra-fleet-abcd\n', '');
    assert.strictEqual(assertCmdOk(ok, 'label'), ok);
});

test('golden 3-bead setup(): a failing `bd list --json` (the exact wclh input shape) throws the assertCmdOk diagnostic, never the bare undefined-id TypeError', async () => {
    const seenCmds = [];
    const fakeRunCmd = async (cmd, cwd) => {
        seenCmds.push(cmd);
        if (cmd === 'bd init') return fakeCmdResult(null, '', '');
        if (cmd.startsWith('bd create -t epic')) return fakeCmdResult(null, '', '');
        if (cmd === 'bd list --json') {
            // Byte-for-byte the forced repro apra-fleet-wclh.1's own close
            // notes captured: a nonzero exit with an "unknown flag" stderr.
            return fakeCmdResult(makeFailingErr(1, 'Command failed: bd list --json'), '', 'unknown flag: --FORCE-REPRO-FAILURE');
        }
        throw new Error(`unexpected command reached after the epic lookup failed: ${JSON.stringify(cmd)}`);
    };
    try {
        await assert.rejects(
            () => setup('wclh2g-listfail', fakeRunCmd),
            (err) => {
                assert.match(err.message, /`bd list --json` \(epic lookup\) failed unexpectedly/);
                assert.doesNotMatch(err.message, /Cannot read properties of undefined/);
                return true;
            },
        );
        assert.deepStrictEqual(seenCmds, ['bd init', 'bd create -t epic "Epic: Fleet Member Management APIs (3-bead)" -d "Three independent, sibling tasks -- no dependency between them -- so all three are ready in the same Develop cycle and dispatch as concurrent doer streaks."', 'bd list --json'], 'setup() must stop at the failed epic lookup and never reach a task create/update');
    } finally {
        await cleanupGoldenTempDirs('wclh2g-listfail');
    }
});

test('golden 3-bead setup(): `bd list --json` succeeding with no epic bead in it throws the epic-not-found diagnostic, never the bare undefined-id TypeError', async () => {
    const fakeRunCmd = async (cmd) => {
        if (cmd === 'bd init') return fakeCmdResult(null, '', '');
        if (cmd.startsWith('bd create -t epic')) return fakeCmdResult(null, '', '');
        // Succeeds, but the epic never made it into the list -- the second
        // half of the pre-fix hazard (an empty/mismatched list is not itself
        // a `runCmd` error, so assertCmdOk alone cannot catch it).
        if (cmd === 'bd list --json') return fakeCmdResult(null, '[]', '');
        throw new Error(`unexpected command: ${JSON.stringify(cmd)}`);
    };
    try {
        await assert.rejects(
            () => setup('wclh2g-noepic', fakeRunCmd),
            (err) => {
                assert.match(err.message, /did not return the just-created epic bead/);
                assert.doesNotMatch(err.message, /Cannot read properties of undefined/);
                return true;
            },
        );
    } finally {
        await cleanupGoldenTempDirs('wclh2g-noepic');
    }
});

test('golden 3-bead setup(): the full happy path (init + epic + 3 tasks + parent links) still succeeds end to end', async () => {
    const epicId = 'apra-fleet-epic1';
    const taskIds = ['apra-fleet-t1', 'apra-fleet-t2', 'apra-fleet-t3'];
    let taskIndex = 0;
    const fakeRunCmd = async (cmd) => {
        if (cmd === 'bd init') return fakeCmdResult(null, '', '');
        if (cmd.startsWith('bd create -t epic')) return fakeCmdResult(null, '', '');
        if (cmd === 'bd list --json') return fakeCmdResult(null, JSON.stringify([{ id: epicId, title: 'Epic: Fleet Member Management APIs (3-bead)' }]), '');
        if (cmd.startsWith('bd create "Task:')) {
            const id = taskIds[taskIndex];
            taskIndex += 1;
            return fakeCmdResult(null, `${id}\n`, '');
        }
        if (cmd.startsWith(`bd update `)) return fakeCmdResult(null, '', '');
        throw new Error(`unexpected command: ${JSON.stringify(cmd)}`);
    };
    let result;
    try {
        result = await setup('wclh2g-happy', fakeRunCmd);
        assert.strictEqual(result.epicBead.id, epicId);
        assert.deepStrictEqual(result.taskIds, taskIds);
    } finally {
        if (result) await fs.rm(result.tempDir, { recursive: true, force: true });
    }
});

async function teardown(tempDir) {
    if (!tempDir) return;
    let retries = 8;
    while (retries > 0) {
        try {
            // Windows can hold file handles open briefly after child
            // processes (bd CLI) exit; retry on EBUSY -- see
            // test/advanced-mock-runner-test.mjs's identical helper.
            await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
            return;
        } catch (e) {
            if (e.code === 'EBUSY' && retries > 1) {
                retries--;
                await new Promise((r) => setTimeout(r, 400));
            } else {
                console.error('Could not fully clean up temp dir:', tempDir, e.message);
                return;
            }
        }
    }
}

/**
 * Builds a deterministic mock FleetApi for the 3-bead scenario. Unlike
 * golden-transcript.test.mjs's single-bead mock, the plan-reviewer approves
 * immediately (round 1) and the (non-final) reviewer approves immediately
 * with no reopens -- this scenario is not exercising the reject/reopen
 * paths (those are already covered by golden-transcript.test.mjs and
 * advanced-mock-runner-test.mjs); it exists ONLY to exercise three
 * genuinely-parallel doer streaks landing in one Develop round, so the
 * title/id-sorted streak-assignment and reviewer bead-id-list prompts are
 * built from all three ready beads at once.
 */
function build3BeadFleetApi(tempDir, epicBead, dispatchLog) {
    return {
        executeCommand: async (opts) => {
            dispatchLog.push({ kind: 'command', member: opts.member_name || null, command: opts.command });

            // git/gh commands are intercepted rather than run for real:
            // tempDir is a bare `bd init` scratch dir, not a git repo with
            // an 'origin' remote -- see the identical comment in
            // test/golden-transcript.test.mjs / advanced-mock-runner-test.mjs.
            // apra-fleet-eft.64.1: answer `git remote get-url origin`
            // (now resolved+classified by the Publish PR step before it
            // decides whether to attempt `gh pr create`) with a hosted
            // GitHub URL, BEFORE the generic git/gh success stub below --
            // otherwise the generic stub's non-URL text misclassifies as a
            // non-hosted remote and this golden scenario silently diverts
            // onto the skip-PR/direct-close path instead of the `gh pr
            // create` path this fixture was recorded against.
            if (/^git remote get-url origin\b/.test(opts.command)) {
                return mockCmdResult(0, 'https://github.com/mock-org/mock-repo.git', '');
            }

            if (/^(git|gh)\s/.test(opts.command)) {
                return mockCmdResult(0, 'ok (mocked -- no real git remote in this mock sprint)', '');
            }

            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                // apra-fleet-1cb.1: only a genuine spawn failure is an MCP-level
                // isError -- a nonzero-exit bd/node invocation is normal data
                // with the real exit code, matching execute-command.ts.
                if (isSpawnFailure(err)) {
                    return { isError: true, content: [{ text: stderr || err.message }] };
                }
                const exitCode = typeof err.code === 'number' ? err.code : 1;
                return mockCmdResult(exitCode, stdout, stderr);
            }
            return mockCmdResult(0, stdout, stderr);
        },

        executePrompt: async (opts) => {
            const isFinalReview = opts.agent === 'reviewer' && opts.prompt.startsWith('Final review for sprint scope issue id(s):');
            // Not gated on opts.agent === 'planner': runner.js no longer sets
            // agentType on this dispatch (see the streakAssignment schema
            // comment in contracts.mjs) -- detect it by prompt content instead.
            const isStreakAssignment = opts.prompt.includes('Ready bead ids:');

            dispatchLog.push({
                kind: 'prompt',
                agentType: opts.agent,
                label: isFinalReview ? 'Final Review' : (isStreakAssignment ? 'Streak Assignment' : null),
                member: opts.member_name || null,
                prompt: opts.prompt,
            });

            // --- plan phase: planner ---
            if (opts.agent === 'planner' && !isStreakAssignment) {
                return {
                    content: [{
                        text: 'Analyzed the Fleet Member API epic. Confirmed the three independent implementation tasks are well-formed and ready to develop.'
                    }]
                };
            }

            // --- plan phase: plan-reviewer (approve immediately -- see header note) ---
            if (opts.agent === 'plan-reviewer') {
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Three independent tasks, well scoped. Approved.',
                            taskAssignments: [],
                        })
                    }]
                };
            }

            // --- develop phase: streak grouping (still agentType 'planner') ---
            if (isStreakAssignment) {
                const idsMatch = opts.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                // One-bead-per-streak -- each of the three independent beads
                // is its own streak, so all three dispatch concurrently via
                // runner.js's `parallel()`.
                return { content: [{ text: JSON.stringify({ streaks: ids.map((id) => [id]) }) }] };
            }

            // --- develop phase: doer (close every assigned bead) ---
            if (opts.agent === 'doer') {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, tempDir);
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'VERIFY',
                            closedIds: ids,
                            notes: 'Implemented the requested fleet client method(s). Closed the assigned bead(s).'
                        })
                    }]
                };
            }

            // --- review phase: reviewer (approve immediately -- see header note) ---
            if (opts.agent === 'reviewer' && !isFinalReview) {
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'All three implementations look correct. Approved.',
                            reopenIds: [],
                            newTasks: [],
                        })
                    }]
                };
            }

            // --- final review (evidence-based) ---
            if (isFinalReview) {
                const openMatch = opts.prompt.match(/(\d+) bead\(s\) still open at or above goal priority/);
                const openCount = openMatch ? Number(openMatch[1]) : 0;
                const hasDeployFailure = opts.prompt.includes('Deploy phase FAILED');
                const hasIntegFailure = opts.prompt.includes('Integration tests FAILED');
                if (openCount > 0 || hasDeployFailure || hasIntegFailure) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'FAIL',
                                notes: `Evidence-based FAIL: ${openCount} open goal-priority bead(s), deployFailure=${hasDeployFailure}, integFailure=${hasIntegFailure}.`,
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'PASS',
                            notes: 'All goal-priority beads closed, last review APPROVED, deploy/integ phases succeeded.',
                        })
                    }]
                };
            }

            // --- deploy phase ---
            if (opts.agent === 'deployer') {
                return {
                    content: [{
                        text: JSON.stringify({
                            deployed: true,
                            notes: 'Successfully ran `npm publish` and published @apralabs/apra-fleet-client to the local registry.',
                        })
                    }]
                };
            }

            // --- integ test phase ---
            if (opts.agent === 'integ-test-runner') {
                // apra-fleet-66u.4: same fix as the identical handler in
                // golden-transcript.test.mjs -- close every verify-routed
                // bead id the prompt names (the epic bead, once all three
                // sibling tasks close), mirroring the real integ-test-runner
                // agent's documented contract and the `doer` handler's own
                // "Assigned bead ids" extraction/close above. See the
                // apra-fleet-66u.4 bd comment for the full diagnosis.
                //
                // apra-fleet-spp.5: extraction now delegates to the shared
                // extractVerifyIds() helper (test/helpers/verify-clause.mjs)
                // -- see the identical fix/comment in golden-transcript.test.mjs.
                const verifyIds = extractVerifyIds(opts.prompt);
                for (const id of verifyIds) {
                    await runCmd(`bd close ${id}`, tempDir);
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: 3,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: 'All vitest e2e specs passed successfully.',
                        })
                    }]
                };
            }

            // --- harvest phase ---
            if (opts.agent === 'harvester') {
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'OK',
                            notes: 'Harvested API usage patterns to memory. Updated context docs.',
                        })
                    }]
                };
            }

            throw new Error(`golden-transcript-3bead.test.mjs: unhandled agentType '${opts.agent}'`);
        }
    };
}

/**
 * Same id-normalization approach as golden-transcript.test.mjs: bd assigns
 * each bead an id derived from the (random, per-tempdir) scratch-directory
 * name it was created in, so raw ids are volatile and must never appear in
 * a committed snapshot. Titles are static, sprint-authored text and so ARE
 * deterministic -- map each real (volatile) id to a stable placeholder
 * derived from its bead's title instead.
 */
function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

function buildIdNormalizationMap(beads) {
    const sorted = [...beads].sort((a, b) => a.title.localeCompare(b.title));
    const usedSlugs = new Map();
    const map = new Map();
    for (const b of sorted) {
        let slug = slugify(b.title);
        const count = (usedSlugs.get(slug) || 0) + 1;
        usedSlugs.set(slug, count);
        if (count > 1) slug = `${slug}-${count}`;
        map.set(b.id, `<BEAD:${slug}>`);
    }
    return map;
}

function normalizeText(text, idMap, tempDir) {
    if (typeof text !== 'string') return text;
    let out = text;
    const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
    for (const id of ids) {
        out = out.split(id).join(idMap.get(id));
    }
    if (tempDir) {
        out = out.split(tempDir).join('<TMPDIR>');
        out = out.split(tempDir.replace(/\\/g, '/')).join('<TMPDIR>');
    }
    return out;
}

/**
 * Extracts JUST the reviewer prompt's bead-id-list line ("Review the work
 * just done for the following bead id(s): <list>.") -- NOT the full
 * reviewer prompt (which also embeds `bd show --json` output whose field
 * ORDER within each bead object is not what apra-fleet-unw.19 fixed, and is
 * out of scope for this order-sensitive-artifacts-only snapshot).
 * @param {string} prompt
 * @returns {string|null}
 */
function extractReviewerBeadIdList(prompt) {
    const match = prompt.match(/Review the work just done for the following bead id\(s\): ([^.]+)\./);
    return match ? match[1] : null;
}

// apra-fleet-j918.7.8: memoizes the ONE 'golden-3bead-main' run so the
// snapshot test and the determinism test's "run1" share it instead of each
// paying for their own byte-identically-configured full sprint run -- see
// golden-transcript.test.mjs's identical-purpose goldenMainRun() for the
// full rationale (promise memoization, why the determinism test's run2 stays
// genuinely independent, and the falsification record).
let golden3BeadMainRunPromise = null;
function golden3BeadMainRun() {
    if (!golden3BeadMainRunPromise) golden3BeadMainRunPromise = run3BeadScenario('golden-3bead-main');
    return golden3BeadMainRunPromise;
}

/**
 * Runs one full deterministic 3-bead mock sprint and returns ONLY the two
 * order-sensitive artifacts this golden variant protects -- never the full
 * dispatch transcript (see header comment for why).
 * @param {string} tag - unique per-call scratch-dir suffix
 * @returns {Promise<{ artifacts: object[], result: object }>}
 */
async function run3BeadScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatchLog = [];
    try {
        const fleetApi = build3BeadFleetApi(tempDir, epicBead, dispatchLog);
        const workflow = new FleetWorkflow(fleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

        const result = await engine.executeFile(scriptPath, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: 'auto-sprint/mock-sprint-3bead',
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
        }, true);

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const idMap = buildIdNormalizationMap(finalBeadsRaw);

        // Deliberately NOT the full dispatchLog: only the two order-
        // sensitive artifacts apra-fleet-unw.19 fixed. `seq` is the ORIGINAL
        // dispatch-log index (kept for a readable diff), but this array
        // itself is a FILTERED, order-preserving-within-kind projection --
        // never an assertion on interleaving with the (genuinely racy)
        // parallel doer-streak dispatches.
        const artifacts = [];
        dispatchLog.forEach((entry, index) => {
            if (entry.kind !== 'prompt') return;
            if (entry.label === 'Streak Assignment') {
                artifacts.push({
                    seq: index,
                    kind: 'streakAssignmentPrompt',
                    prompt: normalizeText(entry.prompt, idMap, tempDir),
                });
            } else if (entry.agentType === 'reviewer' && entry.label !== 'Final Review') {
                artifacts.push({
                    seq: index,
                    kind: 'reviewerBeadIdList',
                    beadIds: normalizeText(extractReviewerBeadIdList(entry.prompt), idMap, tempDir),
                });
            }
        });

        // apra-fleet-66u.5: the FULL normalized dispatch log, kept separate
        // from `artifacts` above (which is deliberately the order-sensitive-
        // only projection this file's committed GOLDEN_PATH snapshot pins --
        // see header comment). This full log is never compared against a
        // committed snapshot; it exists only so a test can inspect
        // non-order-sensitive dispatch content (e.g. the integ-test-runner's
        // verification-closure clause) without widening the snapshot's scope.
        const dispatchLogNormalized = dispatchLog.map((entry, index) => {
            const normalized = { seq: index, kind: entry.kind, member: entry.member };
            if (entry.kind === 'command') {
                normalized.command = normalizeText(entry.command, idMap, tempDir);
            } else {
                normalized.agentType = entry.agentType;
                normalized.label = entry.label;
                normalized.prompt = normalizeText(entry.prompt, idMap, tempDir);
            }
            return normalized;
        });

        return { artifacts, result, dispatchLog: dispatchLogNormalized };
    } finally {
        await teardown(tempDir);
    }
}

function artifactsToJsonl(artifacts) {
    return artifacts.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function diffFirstDivergence(goldenJsonl, actualJsonl) {
    const goldenLines = goldenJsonl.split('\n');
    const actualLines = actualJsonl.split('\n');
    const maxLen = Math.max(goldenLines.length, actualLines.length);

    for (let i = 0; i < maxLen; i++) {
        const g = goldenLines[i];
        const a = actualLines[i];
        if (g === a) continue;

        const lines = [
            `First divergence at JSONL line ${i + 1}:`,
            '',
        ];

        if (g === undefined) {
            lines.push('  GOLDEN: <no line -- actual has MORE artifacts than golden>');
            lines.push(`  ACTUAL: ${a}`);
            return lines.join('\n');
        }
        if (a === undefined) {
            lines.push(`  GOLDEN: ${g}`);
            lines.push('  ACTUAL: <no line -- actual has FEWER artifacts than golden>');
            return lines.join('\n');
        }

        let gObj = null;
        let aObj = null;
        try { gObj = JSON.parse(g); } catch { /* leave null */ }
        try { aObj = JSON.parse(a); } catch { /* leave null */ }

        if (gObj && aObj) {
            const keys = new Set([...Object.keys(gObj), ...Object.keys(aObj)]);
            for (const key of keys) {
                const gVal = gObj[key];
                const aVal = aObj[key];
                if (JSON.stringify(gVal) !== JSON.stringify(aVal)) {
                    lines.push(`  field '${key}' differs:`);
                    lines.push(`    GOLDEN: ${JSON.stringify(gVal)}`);
                    lines.push(`    ACTUAL: ${JSON.stringify(aVal)}`);
                }
            }
        } else {
            lines.push(`  GOLDEN: ${g}`);
            lines.push(`  ACTUAL: ${a}`);
        }

        return lines.join('\n');
    }

    return null;
}

test('golden transcript (3-bead): streak-assignment prompt + reviewer bead-id list match the committed snapshot', async (t) => {
    const { artifacts, result } = await golden3BeadMainRun();
    const actualJsonl = artifactsToJsonl(artifacts);

    assert.strictEqual(result.status, 'success', `3-bead scenario did not succeed: ${JSON.stringify(result)}`);
    // Exactly one streak-assignment dispatch (single develop round -- see
    // header note) covering all three beads, and exactly one (non-final)
    // reviewer dispatch covering all three beads.
    assert.strictEqual(
        artifacts.filter((a) => a.kind === 'streakAssignmentPrompt').length, 1,
        `Expected exactly 1 streak-assignment prompt, got: ${JSON.stringify(artifacts)}`
    );
    assert.strictEqual(
        artifacts.filter((a) => a.kind === 'reviewerBeadIdList').length, 1,
        `Expected exactly 1 reviewer bead-id-list dispatch, got: ${JSON.stringify(artifacts)}`
    );

    if (UPDATE_GOLDEN) {
        await fs.mkdir(GOLDEN_DIR, { recursive: true });
        await fs.writeFile(GOLDEN_PATH, actualJsonl, 'utf-8');
        t.diagnostic(`UPDATE_GOLDEN=1: wrote ${artifacts.length} artifact(s) to ${GOLDEN_PATH}`);
        return;
    }

    assert.ok(
        fsSync.existsSync(GOLDEN_PATH),
        `Golden file does not exist: ${GOLDEN_PATH}. Run with UPDATE_GOLDEN=1 to generate it.`
    );
    const goldenJsonl = await fs.readFile(GOLDEN_PATH, 'utf-8');

    if (goldenJsonl === actualJsonl) {
        return;
    }

    const diff = diffFirstDivergence(goldenJsonl, actualJsonl);
    assert.fail(
        'Order-sensitive artifacts diverged from the committed golden snapshot ' +
        `(${GOLDEN_PATH}).\n\n${diff}\n\n` +
        'If this divergence is an INTENTIONAL prompt change, regenerate the golden ' +
        'file (review the diff before committing it):\n' +
        '  UPDATE_GOLDEN=1 node --test test/golden-transcript-3bead.test.mjs'
    );
});

// =============================================================================
// apra-fleet-66u.5: pins the apra-fleet-66u.4 fix (build3BeadFleetApi's
// integ-test-runner handler above now issues `bd close` for every
// verify-routed bead named in its dispatch prompt) on THIS file's 3-bead
// mock-sprint/golden-transcript path -- see the identical-purpose test in
// golden-transcript.test.mjs for the full false-stall regression writeup.
// Here the epic becomes a childful verify-routed target once all THREE
// sibling tasks close (rather than one, as in the single-bead file), so
// this also exercises the fix under the file's genuine parallel-streak
// shape.
//
// MUTATION CHECK (apra-fleet-w7ee.2, PERFORMED against real bd on THIS
// file -- previously an unverified claim inherited from the single-bead
// file, where apra-fleet-w7ee.1 had run the mutation; the 3-bead handler
// itself had never been mutated, so this guard was unproven rather than
// known-falsifiable). Deleting exactly apra-fleet-66u.4's three-line
// `for (const id of verifyIds) { await runCmd(`bd close ${id}`, tempDir); }`
// loop from build3BeadFleetApi()'s integ-test-runner handler above (leaving
// the canned {featuresClosed, passed:true} response, and leaving the doer
// handler's own closes intact), then running
// `node scripts/run-tests.mjs real test/golden-transcript-3bead.test.mjs`,
// was OBSERVED to take the file from pass=9 fail=0 to pass=6 fail=3 in
// 137.7s: this test's named assertion #1 failed with
//   "Expected no false-stall abort on the mock golden 3-bead sprint's
//    same-cycle Integ Test closure of the childful epic, got: Sprint
//    stalled: 2 consecutive cycle(s) made no new high-water-mark progress
//    (closed beads + verify-routed beads) ... Closed-count history:
//    [3, 3, 3] (high-water mark on progress score: 4) ... 1 bead(s) were
//    routed to verify this sprint but never closed -- the verifier may be
//    failing"
// (the [3,3,3]/high-water-4 shape is the 3-bead analogue of the
// single-bead file's [1,1,1]/high-water-2 signature: three closed tasks
// plus the one verify-routed epic that the mutated verifier never closes).
// The snapshot and determinism-proof subtests aborted with the same
// StalledSprintError. The file was then restored byte-for-byte from a
// pre-mutation copy; no committed golden fixture was regenerated. So this
// guard is falsifiable on the 3-bead path, not vacuous.
// =============================================================================
test('golden transcript (3-bead): Integ Test closing the childful epic in the same cycle it becomes verify-eligible credits progress and avoids a false stall (apra-fleet-66u.5)', async () => {
    let caught = null;
    let dispatchLog = null;
    let result = null;
    try {
        ({ dispatchLog, result } = await run3BeadScenario('golden-3bead-prog'));
    } catch (err) {
        caught = err;
    }

    // Named assertion #1: no false-stall abort fired.
    assert.ok(
        !(caught instanceof StalledSprintError),
        'Expected no false-stall abort on the mock golden 3-bead sprint\'s same-cycle ' +
        `Integ Test closure of the childful epic, got: ${caught ? caught.message : 'none'}`
    );
    if (caught) throw caught;

    // Named assertion #2: the sprint reached success (not merely "did not
    // throw" -- confirms the whole runner.js cycle loop actually exited
    // cleanly via the goal-priority + verify-set completion path).
    assert.strictEqual(
        result.status, 'success',
        `Expected the golden 3-bead mock sprint to complete successfully, got: ${JSON.stringify(result)}`
    );

    // Named assertion #3: this run genuinely exercised the same-cycle
    // verify-closure path apra-fleet-66u.4 fixed -- an integ-test-runner
    // dispatch actually named the epic in its verification-closure clause
    // once all three sibling tasks closed.
    const integPrompts = dispatchLog.filter((e) => e.kind === 'prompt' && e.agentType === 'integ-test-runner');
    assert.ok(integPrompts.length > 0, 'Expected at least one integ-test-runner dispatch in the 3-bead dispatch log');
    const epicPlaceholder = '<BEAD:epic-fleet-member-management-apis-3-bead>';
    const verifyDispatch = integPrompts.find(
        (e) => e.prompt.includes('verification-closure:') && e.prompt.includes(epicPlaceholder)
    );
    assert.ok(
        verifyDispatch,
        `Expected an integ-test-runner dispatch naming the epic (${epicPlaceholder}) in its ` +
        `verification-closure clause -- got prompts: ${JSON.stringify(integPrompts.map((e) => e.prompt))}`
    );
});

// apra-fleet-j918.7.8: run1 is the MEMOIZED 'golden-3bead-main' run the
// snapshot test above already performed (golden3BeadMainRun()) -- this file
// used to pay for a second, byte-identically-configured full sprint run
// purely to have a "first run" to diff against. run2 is still a genuinely
// INDEPENDENT second execution (tag 'golden-3bead-det-2', its own tempDir,
// its own full sprint), so this remains a real two-independent-runs
// comparison, not a run compared against itself. See
// golden-transcript.test.mjs's identical-purpose test for the falsification
// record proving the comparison still fires on a real divergence.
test('golden transcript (3-bead): two consecutive runs produce an identical snapshot (determinism proof)', async () => {
    const run1 = await golden3BeadMainRun();
    // run1 may have been the FIRST sprint scenario this test process ever
    // ran, which is when dolt-sync.mjs's per-member sync.remote/tip
    // memoization (apra-fleet-akuv) is still cold -- see
    // golden-transcript.test.mjs's identical reset for why this is required
    // for an apples-to-apples comparison against run2.
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    const run2 = await run3BeadScenario('golden-3bead-det-2');

    const jsonl1 = artifactsToJsonl(run1.artifacts);
    const jsonl2 = artifactsToJsonl(run2.artifacts);

    if (jsonl1 !== jsonl2) {
        const diff = diffFirstDivergence(jsonl1, jsonl2);
        assert.fail(`Two runs of the identical 3-bead mock sprint produced different order-sensitive artifacts (non-deterministic).\n\n${diff}`);
    }
});
