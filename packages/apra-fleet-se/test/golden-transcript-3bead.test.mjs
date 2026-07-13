import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import { exec } from 'child_process';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

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

const runCmd = (cmd, cwd) => new Promise((resolve) => {
    exec(cmd, { cwd, env: { ...process.env, BD_ALLOW_REMOTE_MIGRATE: '1' } }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
    });
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

async function setup(tempDirSuffix) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-golden-3bead-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    await runCmd('bd init', tempDir);

    await runCmd('bd create -t epic "Epic: Fleet Member Management APIs (3-bead)" -d "Three independent, sibling tasks -- no dependency between them -- so all three are ready in the same Develop cycle and dispatch as concurrent doer streaks."', tempDir);

    const epicList = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
    const epicBead = epicList.find((b) => b.title.startsWith('Epic:'));

    const taskIds = [];
    for (const title of TASK_TITLES) {
        const createRes = await runCmd(`bd create "${title}" -d "Independent sibling task." --silent`, tempDir);
        const id = createRes.stdout.trim();
        await runCmd(`bd update ${id} --parent ${epicBead.id}`, tempDir);
        taskIds.push(id);
    }

    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');

    return { tempDir, epicBead, taskIds };
}

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
            if (/^(git|gh)\s/.test(opts.command)) {
                return mockCmdResult(0, 'ok (mocked -- no real git remote in this mock sprint)', '');
            }

            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                return { isError: true, content: [{ text: stderr || err.message }] };
            }
            return mockCmdResult(0, stdout, stderr);
        },

        executePrompt: async (opts) => {
            const isFinalReview = opts.agent === 'reviewer' && opts.prompt.startsWith('Final review for sprint scope issue id(s):');
            const isStreakAssignment = opts.agent === 'planner' && opts.prompt.includes('Ready bead ids:');

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
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

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

        return { artifacts, result };
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
    const { artifacts, result } = await run3BeadScenario('golden-3bead-main');
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

test('golden transcript (3-bead): two consecutive runs produce an identical snapshot (determinism proof)', async () => {
    const run1 = await run3BeadScenario('golden-3bead-det-1');
    const run2 = await run3BeadScenario('golden-3bead-det-2');

    const jsonl1 = artifactsToJsonl(run1.artifacts);
    const jsonl2 = artifactsToJsonl(run2.artifacts);

    if (jsonl1 !== jsonl2) {
        const diff = diffFirstDivergence(jsonl1, jsonl2);
        assert.fail(`Two runs of the identical 3-bead mock sprint produced different order-sensitive artifacts (non-deterministic).\n\n${diff}`);
    }
});
