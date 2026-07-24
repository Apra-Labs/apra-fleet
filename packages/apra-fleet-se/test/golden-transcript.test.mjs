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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-unw.19 -- Golden-transcript snapshot test (feedback.md Testing
// gap 4: no golden-transcript test, so prompt drift in runner.js is
// invisible).
//
// This test drives ONE deterministic, full-coverage mock sprint cycle
// against packages/apra-fleet-se/auto-sprint/runner.js (the exact same
// deterministic mock-fleet approach as test/advanced-mock-runner-test.mjs's
// "run1" happy-path scenario: reject-then-approve plan review, default
// doer/reviewer handlers, deploy.md + integ-test-playbook.md both present),
// and records the FULL ordered sequence of every command()/agent() dispatch
// runner.js makes -- member, agentType, schema id (when present), and the
// exact prompt/command text -- into a golden JSONL snapshot
// (test/fixtures/golden-transcript/mock-sprint-happy-path.jsonl), one
// dispatch per line.
//
// Every run's transcript is compared line-by-line against that golden file.
// A mismatch fails with a readable side-by-side diff of the FIRST divergent
// line (see diffFirstDivergence below) -- not just "snapshot mismatch" --
// so a human/CI reader can immediately see WHAT changed (e.g. a reworded
// prompt, a different schema id, a reordered dispatch).
//
// Update path (deliberately NOT automatic): run
//   UPDATE_GOLDEN=1 node --test test/golden-transcript.test.mjs
// (or `npm run update-golden` from this package) to regenerate the golden
// file. A normal `npm test` run NEVER writes the golden file -- an
// intentional prompt change must be a conscious, reviewed diff in the
// commit, not a silent auto-update.
// =============================================================================

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'golden-transcript');
const GOLDEN_PATH = path.join(GOLDEN_DIR, 'mock-sprint-happy-path.jsonl');
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

async function setup(tempDirSuffix) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-golden-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    await runCmd('bd init', tempDir);

    // Deliberately a SINGLE task (not the two-plus-one-added-during-planning
    // shape test/advanced-mock-runner-test.mjs's "run1" scenario uses):
    // with 2+ ready beads, runner.js's Develop loop dispatches one doer
    // streak PER ready bead via `parallel()`, and those streaks are
    // genuinely, correctly concurrent -- their completion order (and so the
    // order their post-dispatch `bd show` verification commands land in the
    // dispatch log) depends on real child-process scheduling, not on
    // anything runner.js or this mock controls. That's true parallelism
    // doing its job, not a determinism bug, and it is out of this golden
    // test's scope to serialize it away. Keeping exactly one ready bead at a
    // time (via the reopen loop below, not concurrency) sidesteps that race
    // entirely while still exercising the full planner -> plan-reviewer ->
    // streak-assignment -> doer -> reviewer -> deploy -> integ -> final
    // review -> harvest sequence, across TWO develop/review rounds (the
    // reviewer mock reopens once, then approves).
    await runCmd('bd create -t epic "Epic: Fleet Member Management APIs" -d "This epic covers the implementation of member management APIs for apra-fleet-client. It includes registerMember and ensuring it integrates securely using fetch across the MCP JSON-RPC boundary."', tempDir);
    await runCmd('bd create "Task: Implement registerMember in client.js" -d "Implement a registerMember(config) function in the ApraFleet API class. It should accept an object with name, prompt, url, token, etc., and map to the register_member tool."', tempDir);

    const initialList = await runCmd('bd list --json', tempDir);
    const allBeads = JSON.parse(initialList.stdout || '[]');
    const epicBead = allBeads.find((b) => b.title.includes('Epic:'));
    const task1 = allBeads.find((b) => b.title.includes('registerMember'));

    await runCmd(`bd update ${task1.id} --parent ${epicBead.id}`, tempDir);

    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');

    return { tempDir, epicBead };
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
 * Extracts a schema's "$id" from a dispatch-time prompt. agent()'s schema
 * option (packages/apra-fleet-workflow/src/workflow/index.mjs) appends the
 * full JSON schema text (including "$id") directly onto the prompt before
 * dispatch, so it is always present verbatim in `opts.prompt` for any
 * schema-validated dispatch and absent otherwise.
 * @param {string} prompt
 * @returns {string|null}
 */
function extractSchemaId(prompt) {
    const match = prompt.match(/"\$id":\s*"([^"]+)"/);
    return match ? match[1] : null;
}

/**
 * Builds a deterministic mock FleetApi that records EVERY executeCommand()
 * and executePrompt() dispatch, in true call order, into `dispatchLog`.
 * Behavior is adapted from test/advanced-mock-runner-test.mjs's default
 * ("run1" happy-path) mock: reject-then-approve plan review (round 1
 * CHANGES_NEEDED, round 2 APPROVED), default doer (closes every assigned
 * bead) / reviewer (reopens the first closed bead once, then approves)
 * handlers, deploy + integ present and both succeeding, and an
 * evidence-based final verdict / harvester OK. Unlike "run1", the planner
 * mock here does NOT create an extra task during planning -- see the
 * single-task comment in setup() above for why (avoiding a genuine,
 * concurrency-driven race in runner.js's parallel doer dispatch that is
 * out of scope for this golden test to eliminate).
 */
function buildTranscriptFleetApi(tempDir, epicBead, dispatchLog) {
    let planRound = 0;
    let reviewRound = 0;

    return {
        executeCommand: async (opts) => {
            dispatchLog.push({
                kind: 'command',
                member: opts.member_name || null,
                command: opts.command,
            });

            // git/gh commands are intercepted rather than run for real:
            // tempDir is a bare `bd init` scratch dir, not a git repo with
            // an 'origin' remote -- see the identical comment in
            // test/advanced-mock-runner-test.mjs.
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
                return { isError: true, content: [{ text: stderr || err.message }] };
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
                schemaId: extractSchemaId(opts.prompt),
                prompt: opts.prompt,
            });

            // --- plan phase: planner ---
            if (opts.agent === 'planner' && !isStreakAssignment) {
                return {
                    content: [{
                        text: 'Analyzed the Fleet Member API epic. Confirmed the implementation task for registerMember is well-formed and ready to develop.'
                    }]
                };
            }

            // --- plan phase: plan-reviewer ---
            if (opts.agent === 'plan-reviewer') {
                planRound++;
                if (planRound >= 2) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'APPROVED',
                                notes: 'Code looks solid. We have tasks for implementation and tests.',
                                taskAssignments: [],
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Ensure you also add a documentation task.',
                            taskAssignments: [],
                        })
                    }]
                };
            }

            // --- develop phase: streak grouping (still agentType 'planner') ---
            if (isStreakAssignment) {
                const idsMatch = opts.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                return { content: [{ text: JSON.stringify({ streaks: ids.map((id) => [id]) }) }] };
            }

            // --- develop phase: doer (default: close every assigned bead) ---
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
                            notes: 'Implemented the requested fleet client methods using fetch to hit the MCP JSON-RPC endpoints. Closed the assigned beads.'
                        })
                    }]
                };
            }

            // --- review phase: reviewer (default: reopen the first closed bead once, then approve) ---
            if (opts.agent === 'reviewer' && !isFinalReview) {
                reviewRound++;
                if (reviewRound === 1) {
                    const closedRes = await runCmd(`bd list --parent ${epicBead.id} --status=closed --json`, tempDir);
                    const closedBeads = JSON.parse(closedRes.stdout || '[]').sort((a, b) => a.id.localeCompare(b.id));
                    if (closedBeads.length > 0) {
                        const target = closedBeads[0];
                        return {
                            content: [{
                                text: JSON.stringify({
                                    verdict: 'CHANGES_NEEDED',
                                    notes: `The implementation for ${target.id} is missing error handling for 401 Unauthorized responses. Please fix.`,
                                    reopenIds: [target.id],
                                    newTasks: [],
                                })
                            }]
                        };
                    }
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Code logic is sound. Error handling and type definitions match the spec. Approved.',
                            reopenIds: [],
                            newTasks: [],
                        })
                    }]
                };
            }

            // --- final review (evidence-based; see the identical mock in
            // test/advanced-mock-runner-test.mjs for the rationale) ---
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
                            notes: 'All goal-priority beads closed, last review APPROVED, deploy/integ phases (if any) succeeded. Excellent velocity and solid implementation.',
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
                            featuresClosed: 2,
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

            throw new Error(`golden-transcript.test.mjs: unhandled agentType '${opts.agent}'`);
        }
    };
}

/**
 * Turns a slugified, human-readable placeholder into a globally-unique bead
 * identifier. bd assigns each bead an id derived from the (random,
 * per-tempdir) scratch-directory name it was created in
 * (`<tempdir-basename>-<random-suffix>`, confirmed by direct inspection: two
 * `bd init` scratch dirs created back-to-back with the identical command
 * sequence get DIFFERENT bead ids) -- so raw bead ids are exactly the kind
 * of volatile, non-deterministic field the golden transcript must never
 * contain. Titles are static, sprint-authored text and so ARE deterministic
 * -- this maps each real (volatile) id to a stable placeholder derived from
 * its bead's title instead.
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

/**
 * @param {Array<{id: string, title: string}>} beads
 * @returns {Map<string, string>} real bead id -> stable "<BEAD:slug>" placeholder
 */
function buildIdNormalizationMap(beads) {
    // Sort by title (deterministic, static text) rather than by id (random
    // per run) so the same title always maps to the same placeholder.
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

// bd's own "<ISO date>T<ISO time>Z" timestamps (created_at/updated_at/
// closed_at) show up verbatim inside `bd show --json` output, which
// runner.js embeds directly into the reviewer's dispatch prompt
// (buildReviewerPrompt's acceptanceCriteriaJson) -- real wall-clock values,
// different on every run, and exactly the "timestamps" volatility this
// issue calls out for normalization.
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;

/**
 * Normalizes volatile content out of a dispatch-log text field: real
 * (per-run-random) bead ids -> stable "<BEAD:slug>" placeholders, bd's own
 * ISO-8601 timestamps (created_at/updated_at/closed_at, embedded verbatim in
 * `bd show --json` output that flows into the reviewer prompt) ->
 * "<TIMESTAMP>", and the absolute scratch-directory path -> "<TMPDIR>"
 * (defensive; no known dispatch text embeds it today, since every bd/probe
 * command runs with `cwd: tempDir` rather than an absolute path baked into
 * the command string, but this keeps the snapshot robust if that ever
 * changes).
 * @param {string} text
 * @param {Map<string, string>} idMap
 * @param {string} tempDir
 * @returns {string}
 */
function normalizeText(text, idMap, tempDir) {
    if (typeof text !== 'string') return text;
    let out = text;
    // Replace longest ids first so no id is ever a substring-prefix of
    // another id it hasn't been replaced with yet.
    const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
    for (const id of ids) {
        out = out.split(id).join(idMap.get(id));
    }
    out = out.replace(ISO_TIMESTAMP_PATTERN, '<TIMESTAMP>');
    // bd's `owner`/`created_by` fields (embedded in `bd show --json` output
    // that flows into the reviewer prompt) reflect the local git identity
    // (git config user.name/user.email) used when the bead was created --
    // nondeterministic across machines/CI. `owner` is only set when a git
    // identity is configured, so it's entirely absent on CI runners rather
    // than merely holding a different value; strip it (with its trailing
    // comma) rather than replacing its value. `created_by` is always
    // present, so normalize its value instead.
    out = out.replace(/\n[ \t]*"owner":\s*"[^"]*",/g, '');
    out = out.replace(/"created_by":\s*"[^"]*"/g, '"created_by": "<CREATED_BY>"');
    if (tempDir) {
        out = out.split(tempDir).join('<TMPDIR>');
        out = out.split(tempDir.replace(/\\/g, '/')).join('<TMPDIR>');
    }
    return out;
}

/**
 * Runs one full deterministic mock sprint and returns the normalized,
 * ordered dispatch transcript: real bead ids and bd's own ISO timestamps are
 * replaced with stable placeholders by normalizeText() above (the mock
 * itself never embeds a run id/wall-clock value directly into any
 * command/prompt text, so no further normalization is needed there).
 * @param {string} tag - unique per-call scratch-dir suffix
 * @returns {Promise<{ transcript: object[], result: object }>}
 */
async function runGoldenScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatchLog = [];
    let currentGroup = null;
    try {
        const fleetApi = buildTranscriptFleetApi(tempDir, epicBead, dispatchLog);
        const workflow = new FleetWorkflow(fleetApi, { targetRepo: tempDir });
        workflow.on('group:start', (e) => { currentGroup = e.title; });
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

        const result = await engine.executeFile(scriptPath, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: 'auto-sprint/mock-sprint',
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
        }, true);

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const idMap = buildIdNormalizationMap(finalBeadsRaw);

        const transcript = dispatchLog.map((entry, index) => {
            const normalized = { seq: index };
            if (entry.kind === 'command') {
                normalized.kind = 'command';
                normalized.member = entry.member;
                normalized.command = normalizeText(entry.command, idMap, tempDir);
            } else {
                normalized.kind = 'prompt';
                normalized.agentType = entry.agentType;
                normalized.label = entry.label;
                normalized.member = entry.member;
                normalized.schemaId = entry.schemaId;
                normalized.prompt = normalizeText(entry.prompt, idMap, tempDir);
            }
            return normalized;
        });

        return { transcript, result };
    } finally {
        await teardown(tempDir);
    }
}

function transcriptToJsonl(transcript) {
    return transcript.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

/**
 * Compares two JSONL transcripts line-by-line and returns a readable
 * side-by-side diff of the FIRST divergent line, or null if they match.
 * @param {string} goldenJsonl
 * @param {string} actualJsonl
 * @returns {string|null}
 */
function diffFirstDivergence(goldenJsonl, actualJsonl) {
    const goldenLines = goldenJsonl.split('\n');
    const actualLines = actualJsonl.split('\n');
    const maxLen = Math.max(goldenLines.length, actualLines.length);

    for (let i = 0; i < maxLen; i++) {
        const g = goldenLines[i];
        const a = actualLines[i];
        if (g === a) continue;

        const lines = [
            `First divergence at JSONL line ${i + 1} (0-indexed dispatch seq ${i}):`,
            '',
        ];

        if (g === undefined) {
            lines.push('  GOLDEN: <no line -- actual transcript has MORE dispatches than golden>');
            lines.push(`  ACTUAL: ${a}`);
            return lines.join('\n');
        }
        if (a === undefined) {
            lines.push(`  GOLDEN: ${g}`);
            lines.push('  ACTUAL: <no line -- actual transcript has FEWER dispatches than golden>');
            return lines.join('\n');
        }

        // Both lines present but differ: parse and do a field-level diff so
        // the reader sees WHICH field changed, not just two giant JSON blobs.
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

test('golden transcript: mock sprint happy-path dispatch sequence matches the committed snapshot', async (t) => {
    const { transcript, result } = await runGoldenScenario('golden-main');
    const actualJsonl = transcriptToJsonl(transcript);

    assert.strictEqual(result.status, 'success', `Golden scenario did not succeed: ${JSON.stringify(result)}`);

    if (UPDATE_GOLDEN) {
        await fs.mkdir(GOLDEN_DIR, { recursive: true });
        await fs.writeFile(GOLDEN_PATH, actualJsonl, 'utf-8');
        t.diagnostic(`UPDATE_GOLDEN=1: wrote ${transcript.length} dispatch(es) to ${GOLDEN_PATH}`);
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
        'Dispatch transcript diverged from the committed golden snapshot ' +
        `(${GOLDEN_PATH}).\n\n${diff}\n\n` +
        'If this divergence is an INTENTIONAL prompt/dispatch change, regenerate the golden ' +
        'file (review the diff before committing it):\n' +
        '  UPDATE_GOLDEN=1 node --test test/golden-transcript.test.mjs\n' +
        'or: npm run update-golden -w @apralabs/apra-fleet-se'
    );
});

test('golden transcript: two consecutive runs of the mock sprint produce an identical transcript (determinism proof)', async () => {
    const run1 = await runGoldenScenario('golden-det-1');
    const run2 = await runGoldenScenario('golden-det-2');

    const jsonl1 = transcriptToJsonl(run1.transcript);
    const jsonl2 = transcriptToJsonl(run2.transcript);

    if (jsonl1 !== jsonl2) {
        const diff = diffFirstDivergence(jsonl1, jsonl2);
        assert.fail(`Two runs of the identical mock sprint produced different transcripts (non-deterministic).\n\n${diff}`);
    }
});
