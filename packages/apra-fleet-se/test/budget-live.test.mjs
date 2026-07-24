import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import { FleetWorkflow, BudgetExceededError } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
// bd record/replay-aware runCmd -- same (cmd, cwd) signature, and in real
// mode (APRA_FLEET_BD_MOCK=0) byte-for-byte the local exec() copy this
// replaced; see test/helpers/bd-replay.mjs for the APRA_FLEET_BD_MOCK
// contract.
import { runCmd } from './helpers/bd-replay.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

// N10 (apra-fleet-unw2.8): regression coverage for "cost/budget is live",
// i.e. that a real auto-sprint run (a) actually debits budget._spent
// (proven here via the exact `activity:end` event stream the dashboard
// viewer itself sums into `state.stats.totalCost` -- see
// packages/apra-fleet-workflow/src/viewer/index.mjs's `workflow.on(
// 'activity:end', ...)` handler, which this test's own listener mirrors)
// and (b) can actually trip BudgetExceededError, not just define it.
//
// Before this fix: runner.js never passed `opts.model` on ANY dispatch, so
// every activity priced as `calculateCost('default', usage)` -> null ->
// `_spent` never moved -> a budget ceiling could never be reached. This
// suite fails on a revert of either the per-bead doer model wiring or the
// FIXED_ROLE_TIER constants (see runner.js), and fails on a revert of the
// pricing.mjs fleet-model rows (fable/opus/sonnet/haiku) or tier-band rows
// (cheap/standard/premium, apra-fleet-dv5.2).

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

// A fixed usage shape dispatched on every mock LLM call, so every priced
// activity contributes a known, nonzero cost regardless of which model it
// was priced against.
const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

/**
 * Minimal, hermetic single-bead sprint scaffold: one epic, one task with a
 * declared doer model tier recorded via beads `--metadata` (the N1,
 * apra-fleet-unw2.1 convention this issue's fix reads back). No
 * deploy.md/integ-test-playbook.md -- Deploy/Integ phases are
 * deterministically skipped so this test only has to model the roles that
 * always run: planner, plan-reviewer, streak-assignment (agentType
 * 'planner'), doer, reviewer (dev-loop + final), harvester.
 */
async function setup(tag, { doerModel = 'haiku' } = {}) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-budget-live-${tag}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    await runCmd('bd init', tempDir);
    await runCmd('bd create -t epic "Epic: Budget Live Test"', tempDir);
    const epicList = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
    const epicBead = epicList.find((b) => b.title.startsWith('Epic:'));

    // NOTE: double-quoted with escaped inner quotes (not single-quoted) so
    // this survives Windows cmd.exe, exactly like the equivalent call in
    // advanced-mock-runner-test.mjs.
    const createRes = await runCmd(
        `bd create "Task: Budget live test task" -d "Scenario task for apra-fleet-unw2.8." --metadata "{\\"model\\": \\"${doerModel}\\"}" --silent`,
        tempDir
    );
    const taskId = createRes.stdout.trim();
    await runCmd(`bd update ${taskId} --parent ${epicBead.id}`, tempDir);

    return { tempDir, epicBead, taskId };
}

async function teardown(tempDir) {
    if (!tempDir) return;
    // Windows can hold file handles open briefly after child processes (bd
    // CLI) exit; retry on EBUSY, matching advanced-mock-runner-test.mjs's
    // teardown().
    let retries = 8;
    while (retries > 0) {
        try {
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
 * Builds a mock FleetApi that (a) responds to every role this scenario's
 * runner dispatches with a schema-valid, single-round happy-path verdict,
 * (b) attaches real `usage` to every executePrompt response (so every
 * dispatch is priceable -- see USAGE above), and (c) records `{ agent,
 * model }` for every dispatch so a test can assert the wiring end to end
 * (which role got which model, per FIXED_ROLE_TIER / the doer's per-bead
 * metadata).
 */
// apra-fleet-dv5.3/dv5.6: `pricingByMember` optionally supplies a
// get_member_model_pricing response per member_name -- omitted (the
// default for every existing test in this file) means the mock fleet has
// NO get_member_model_pricing tool at all, so every tier-keyword dispatch
// exercises the "tool unavailable -> tier-band fallback" degrade path
// exactly as it did before apra-fleet-dv5.6 existed (identical totals to
// pre-dv5.6 behavior -- this is what proves fallback-safety end to end,
// not a separate test).
function buildMockFleetApi(tempDir, epicBead, taskId, dispatched, { pricingByMember } = {}) {
    return {
        ...(pricingByMember ? {
            getMemberModelPricing: async ({ member_name }) => ({
                content: [{ text: JSON.stringify({ member_name, pricing: pricingByMember[member_name] ?? { cheap: null, standard: null, premium: null } }) }]
            })
        } : {}),
        executeCommand: async (opts) => {
            // apra-fleet-eft.64.1: answer `git remote get-url origin` (now
            // resolved+classified by the Publish PR step before it decides
            // whether to attempt `gh pr create`) with a hosted GitHub URL,
            // so this mock keeps exercising the same `gh pr create` path it
            // did before that classifier existed, rather than silently
            // diverting onto the new skip-PR/direct-close path.
            if (/^git remote get-url origin\b/.test(opts.command)) {
                return mockCmdResult(0, 'https://github.com/mock-org/mock-repo.git', '');
            }
            if (/^(git|gh)\s/.test(opts.command)) {
                return mockCmdResult(0, 'ok (mocked -- no real git remote in this mock sprint)', '');
            }
            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) return { isError: true, content: [{ text: stderr || err.message }] };
            return mockCmdResult(0, stdout, stderr);
        },
        executePrompt: async (opts) => {
            dispatched.push({ agent: opts.agent, model: opts.model, member: opts.member_name });
            const isFinalReview = opts.agent === 'reviewer' && opts.prompt.startsWith('Final review for sprint scope issue id(s):');
            // Not gated on opts.agent === 'planner': runner.js no longer sets
            // agentType on this dispatch (see the streakAssignment schema
            // comment in contracts.mjs) -- detect it by prompt content instead.
            const isStreakAssignment = opts.prompt.includes('Ready bead ids:');

            const json = (obj) => ({ content: [{ text: JSON.stringify(obj) }], usage: USAGE });

            if (opts.agent === 'planner' && !isStreakAssignment) {
                return { content: [{ text: 'Plan: one task, already created with its model tier via --metadata.' }], usage: USAGE };
            }
            if (opts.agent === 'plan-reviewer') {
                return json({ verdict: 'APPROVED', notes: 'Single task, well scoped.', taskAssignments: [] });
            }
            if (isStreakAssignment) {
                const idsMatch = opts.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                return json({ streaks: ids.map((id) => [id]) });
            }
            if (opts.agent === 'doer') {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, tempDir);
                }
                return json({ status: 'VERIFY', closedIds: ids, notes: 'Closed the assigned bead.' });
            }
            if (opts.agent === 'reviewer' && !isFinalReview) {
                return json({ verdict: 'APPROVED', notes: 'Looks correct.', reopenIds: [], newTasks: [] });
            }
            if (isFinalReview) {
                return json({ verdict: 'PASS', notes: 'All goal-priority beads closed.' });
            }
            if (opts.agent === 'deployer') {
                return json({ deployed: true, notes: 'Deployed.' });
            }
            if (opts.agent === 'integ-test-runner') {
                return json({ featuresClosed: 1, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'All tests passed.' });
            }
            if (opts.agent === 'harvester') {
                return json({ status: 'OK', notes: 'Harvested.' });
            }
            throw new Error(`budget-live.test: unhandled agentType '${opts.agent}'`);
        }
    };
}

function baseArgs(epicBead) {
    return {
        target_issue: epicBead.id,
        members: ['local'],
        branch: 'auto-sprint/budget-live',
        base_branch: 'main',
        goal: 'P1/P2',
        max_cycles: 3,
    };
}

describe('apra-fleet-unw2.8 (N10): live budget accounting', () => {
    test('a mock sprint run genuinely accrues nonzero cost across its dispatches (budget is no longer inert)', async () => {
        const { tempDir, epicBead, taskId } = await setup('spent', { doerModel: 'cheap' });
        const dispatched = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, taskId, dispatched);
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });

            // Mirrors EXACTLY how the dashboard viewer accumulates
            // `state.stats.totalCost` (packages/apra-fleet-workflow/src/
            // viewer/index.mjs's `workflow.on('activity:end', ...)`
            // handler): only a known numeric `meta.cost` is summed, an
            // explicit `cost: null` (unpriced) is tallied separately. If
            // this test's totalCost ends up nonzero, the dashboard's
            // "$0.000 Spent" figure is provably no longer permanent for a
            // run with real usage -- same event, same accumulation rule.
            let totalCost = 0;
            let unknownCostCount = 0;
            let pricedCount = 0;
            workflow.on('activity:end', (meta) => {
                if (typeof meta.cost === 'number') {
                    totalCost += meta.cost;
                    pricedCount++;
                } else if (meta.type === 'agent' && meta.cost === null) {
                    unknownCostCount++;
                }
            });

            const engine = new WorkflowEngine(workflow);
            await engine.executeFile(scriptPath, baseArgs(epicBead), true);

            assert.ok(pricedCount > 0, 'Expected at least one activity to be priced (nonzero pricedCount) -- got 0, meaning opts.model never reached a pricing-table match.');
            assert.ok(totalCost > 0, `Expected totalCost > 0 (a live sprint with real usage should genuinely accrue cost), got ${totalCost}.`);
            assert.strictEqual(unknownCostCount, 0, 'Expected every dispatch in this scenario to be priced (every role has a FIXED_ROLE_TIER entry or per-bead metadata) -- an unpriced dispatch means a model failed to reach calculateCost().');

            // Sanity: the doer dispatch for our single task was actually
            // priced against the tier keyword recorded in ITS bead metadata
            // ('cheap', apra-fleet-dv5.1's tier vocabulary), not some other
            // role's fixed default.
            const doerDispatch = dispatched.find((d) => d.agent === 'doer');
            assert.ok(doerDispatch, 'Expected a doer dispatch to have happened.');
            assert.strictEqual(doerDispatch.model, 'cheap', `Doer dispatch should be priced against the bead's declared metadata tier ('cheap'), got '${doerDispatch.model}'.`);

            // Sanity: the fixed reviewer-class roles used their documented
            // default tier ('premium', apra-fleet-dv5.1), independent of
            // the bead's own tier.
            const reviewerDispatch = dispatched.find((d) => d.agent === 'reviewer');
            assert.ok(reviewerDispatch, 'Expected a reviewer dispatch to have happened.');
            assert.strictEqual(reviewerDispatch.model, 'premium', `Reviewer dispatch should use the fixed role tier ('premium'), got '${reviewerDispatch.model}'.`);

            const finalBeads = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = finalBeads.find((b) => b.id === taskId);
            assert.strictEqual(task.status, 'closed', 'Expected the single task to have been closed by the doer.');
        } finally {
            await teardown(tempDir);
        }
    });

    // apra-fleet-dv5.1/dv5.3: a literal (non-tier-keyword) model ID in a
    // bead's metadata is a fully legitimate, permanent value -- e.g. for a
    // planner/human that already knows the target member's provider and
    // wants a specific model family from it -- not deprecated, not
    // rewritten, not warned about. This proves runner.js passes it through
    // to the doer dispatch completely unchanged, end to end.
    test('a bead declaring a literal, provider-meaningful model ID (not a tier keyword) dispatches UNCHANGED -- no rewriting', async () => {
        const { tempDir, epicBead, taskId } = await setup('literal-id', { doerModel: 'minimax-abab' });
        const dispatched = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, taskId, dispatched);
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            const engine = new WorkflowEngine(workflow);

            await engine.executeFile(scriptPath, baseArgs(epicBead), true);

            const doerDispatch = dispatched.find((d) => d.agent === 'doer');
            assert.ok(doerDispatch, 'Expected a doer dispatch to have happened.');
            assert.strictEqual(doerDispatch.model, 'minimax-abab', `A literal model ID must pass through unchanged, got '${doerDispatch.model}'.`);

            const finalBeads = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = finalBeads.find((b) => b.id === taskId);
            assert.strictEqual(task.status, 'closed', 'Expected the single task to have been closed by the doer.');
        } finally {
            await teardown(tempDir);
        }
    });

    // apra-fleet-dv5.3 (c): apra-fleet-se-side end-to-end coverage of
    // apra-fleet-dv5.6's real-vs-fallback pricing selection (the
    // apra-fleet-workflow-side unit-level assertions live in
    // apra-fleet-workflow-real-pricing.test.mjs -- this test proves the
    // SAME behavior surfaces through a real runner.js mock sprint, not
    // just an isolated FleetWorkflow.agent() call).
    test('a member with real get_member_model_pricing data is priced at the real rate, not the pricing.mjs tier-band fallback', async () => {
        const { tempDir, epicBead, taskId } = await setup('real-pricing', { doerModel: 'cheap' });
        const dispatched = [];
        try {
            // Deliberately priced far outside pricing.mjs's fallback rows
            // (premium: $15/$75 per 1M) so a match against these numbers
            // can only come from the real-pricing path, never a
            // coincidental fallback hit.
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, taskId, dispatched, {
                pricingByMember: {
                    local: {
                        cheap: { model: 'local-cheap-model', promptPrice: 1000, completionPrice: 2000 },
                        standard: null,
                        premium: { model: 'local-premium-model', promptPrice: 1000, completionPrice: 2000 },
                    }
                }
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });

            let totalCost = 0;
            workflow.on('activity:end', (meta) => { if (typeof meta.cost === 'number') totalCost += meta.cost; });

            const engine = new WorkflowEngine(workflow);
            await engine.executeFile(scriptPath, baseArgs(epicBead), true);

            // USAGE = 1000 prompt + 500 completion tokens per dispatch.
            // Real 'cheap' rate: 1000/1e6*1000 + 500/1e6*2000 = 1 + 1 = 2.00 per dispatch (doer).
            // Real 'premium' rate: same numbers = 2.00 per dispatch (planner/plan-reviewer/reviewer/final-review).
            // pricing.mjs's fallback premium row would give only 0.0525 per dispatch --
            // a run that used the fallback for these would total far less than 2.00 per priced dispatch.
            const doerDispatch = dispatched.find((d) => d.agent === 'doer');
            assert.ok(doerDispatch, 'Expected a doer dispatch to have happened.');
            assert.ok(totalCost >= 2.0, `Expected totalCost to reflect the real per-member rate (>= $2.00 for at least one dispatch), got ${totalCost} -- this would be far lower ($0.0525-scale) if the tier-band fallback was used instead of real pricing.`);
        } finally {
            await teardown(tempDir);
        }
    });

    test('a deliberately low budget ceiling actually trips BudgetExceededError (the exception path is reachable, not just defined)', async () => {
        const { tempDir, epicBead, taskId } = await setup('exceeded');
        const dispatched = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, taskId, dispatched);
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            const engine = new WorkflowEngine(workflow);

            // The planner dispatch alone (FIXED_ROLE_TIER.planner = 'premium',
            // priced identically to the old 'opus' row:
            // 1000 prompt tokens * $15/1M + 500 completion tokens * $75/1M =
            // 0.015 + 0.0375 = $0.0525) already exceeds this ceiling once
            // its cost is debited, so the very next dispatch (plan-reviewer)
            // must be refused before it ever reaches the fleet.
            const args = { ...baseArgs(epicBead), budget: 0.05 };

            await assert.rejects(
                () => engine.executeFile(scriptPath, args, true),
                (err) => {
                    assert.ok(err instanceof BudgetExceededError, `Expected a BudgetExceededError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
                    assert.strictEqual(err.code, 'BUDGET_EXCEEDED');
                    return true;
                }
            );

            // Prove the abort happened BEFORE the run could complete its
            // work -- the task must still be open (the doer was never
            // reached).
            const finalBeads = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = finalBeads.find((b) => b.id === taskId);
            assert.notStrictEqual(task.status, 'closed', 'Expected the run to have been aborted by the budget ceiling before the doer could close the task.');

            // At most the planner dispatch (and possibly its own repair
            // attempts) ran before the very next dispatch was refused --
            // the doer/reviewer/harvester must never have been reached.
            assert.ok(!dispatched.some((d) => d.agent === 'doer'), 'Doer must never be dispatched once the budget is exhausted.');
            assert.ok(!dispatched.some((d) => d.agent === 'harvester'), 'Harvester must never be dispatched once the budget is exhausted.');
        } finally {
            await teardown(tempDir);
        }
    });

    test('with no budget configured, a run dispatches without a ceiling (unchanged default behavior)', async () => {
        const { tempDir, epicBead, taskId } = await setup('unlimited');
        const dispatched = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, taskId, dispatched);
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            const engine = new WorkflowEngine(workflow);

            // No `budget` key at all -- validateArgs must accept this
            // exactly as before this issue (budget is purely additive/optional).
            await engine.executeFile(scriptPath, baseArgs(epicBead), true);

            const finalBeads = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = finalBeads.find((b) => b.id === taskId);
            assert.strictEqual(task.status, 'closed', 'Expected the task to be closed when no budget ceiling is configured.');
        } finally {
            await teardown(tempDir);
        }
    });
});
