import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { exec } from 'child_process';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { SprintPlanRejectedError } from '../auto-sprint/errors.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Deterministic, CI-friendly mock of a full auto-sprint cycle driven against
// packages/apra-fleet-se/auto-sprint/runner.js. No live MCP server, no
// Math.random(), no fixed multi-second sleeps -- every branch below matches
// the EXACT lowercase `agentType` strings runner.js dispatches:
//   planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, harvester
//
// Set MOCK_SPRINT_DELAY_MS to simulate LLM latency locally; defaults to 0 for CI.
const DELAY_MS = Number(process.env.MOCK_SPRINT_DELAY_MS || 0);

// Helper to run shell commands in JS
const runCmd = (cmd, cwd) => new Promise((resolve) => {
    exec(cmd, { cwd, env: { ...process.env, BD_ALLOW_REMOTE_MIGRATE: '1' } }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
    });
});

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function setup(tempDirSuffix) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    await runCmd('bd init', tempDir);

    await runCmd('bd create -t epic "Epic: Fleet Member Management APIs" -d "This epic covers the implementation of member management APIs for apra-fleet-client. It includes registerMember, listMembers, and ensuring they integrate securely using fetch across the MCP JSON-RPC boundary."', tempDir);
    await runCmd('bd create "Task: Implement registerMember in client.js" -d "Implement a registerMember(config) function in the ApraFleet API class. It should accept an object with name, prompt, url, token, etc., and map to the register_member tool."', tempDir);
    await runCmd('bd create "Task: Implement listMembers in client.js" -d "Implement a listMembers() function in the ApraFleet API class. It should call the list_members tool and return the parsed JSON array of active fleet members."', tempDir);

    const initialList = await runCmd('bd list --json', tempDir);
    const allBeads = JSON.parse(initialList.stdout || '[]');
    const epicBead = allBeads.find((b) => b.title.includes('Epic:'));
    const task1 = allBeads.find((b) => b.title.includes('registerMember'));
    const task2 = allBeads.find((b) => b.title.includes('listMembers'));

    await runCmd(`bd update ${task1.id} --parent ${epicBead.id}`, tempDir);
    await runCmd(`bd update ${task2.id} --parent ${epicBead.id}`, tempDir);

    // deploy.md / integ-test-playbook.md let runner.js's fs.existsSync probes
    // (via `node -e "require('fs').existsSync(...)"`) resolve to "found",
    // enabling the Deploy and Integ Test phases deterministically.
    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');

    return { tempDir, epicBead, task1, task2 };
}

/**
 * Minimal setup variant for the apra-fleet-unw.16 develop/review-loop
 * scenarios below: an epic + N plain tasks, NO deploy.md/integ-test-
 * playbook.md (so those phases are deterministically skipped and don't need
 * their own mock branches), and returns the created task bead objects in
 * creation order so scenario code can address them by id without re-parsing
 * `bd list` output itself.
 */
async function setupMinimal(tempDirSuffix, taskSpecs) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    await runCmd('bd init', tempDir);
    await runCmd(`bd create -t epic "Epic: ${tempDirSuffix}" -d "Scenario epic for apra-fleet-unw.16 mock test."`, tempDir);
    const epicList = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
    const epicBead = epicList.find((b) => b.title.startsWith('Epic:'));

    const tasks = [];
    for (const spec of taskSpecs) {
        const createRes = await runCmd(`bd create "${spec.title}" -d "${spec.description || 'Scenario task.'}" --silent`, tempDir);
        const id = createRes.stdout.trim();
        await runCmd(`bd update ${id} --parent ${epicBead.id}`, tempDir);
        tasks.push({ id, title: spec.title });
    }

    return { tempDir, epicBead, tasks };
}

/**
 * Builds a deterministic mock FleetApi. Every executePrompt() call is
 * recorded into `dispatched` so the caller can assert on the exact sequence
 * of agentType dispatches, and can diff that sequence across repeated runs.
 * Every dispatched entry also carries `member` (opts.member_name) so tests
 * can assert on WHICH member a doer/reviewer dispatch landed on
 * (apra-fleet-unw.16 acceptance criterion 1: the doer pool must not
 * collapse to a single member when 2+ are configured).
 *
 * Every executeCommand() call is additionally recorded into `commandLog` in
 * dispatch order -- used to assert on the git/gh command-call log added by
 * apra-fleet-unw.14 (branch creation at sprint start, push + PR raise at
 * finalization) and, as of apra-fleet-unw.16, on the orchestrator-issued
 * `bd update --status=open` reopen calls (the reviewer must never issue
 * these itself -- see the reviewer-dispatch-prompt grep assertions below).
 *
 * `planReviewerMode` (apra-fleet-unw.15) controls the plan-reviewer mock's
 * behaviour:
 *   - 'reject-then-approve' (default): CHANGES_NEEDED (schema-valid JSON)
 *     on round 1, APPROVED on round 2+. Exercises the normal happy path.
 *   - 'always-reject-free-text': every round, the reviewer returns
 *     free-text containing the literal substring "APPROVED" inside a
 *     non-approving sentence ("This can NOT be APPROVED") and is never
 *     valid JSON. This must never be misread as an approval (no substring
 *     matching in runner.js's plan phase) and must exhaust the schema-repair
 *     loop every round, ultimately aborting the sprint via
 *     SprintPlanRejectedError with zero doer dispatches.
 *   - 'approve-immediately': APPROVED on round 1, every round. Used by the
 *     apra-fleet-unw.16 develop/review-loop scenarios below, which don't
 *     care about plan-phase re-planning and want to reach Develop in one
 *     round for a smaller, easier-to-reason-about dispatch sequence.
 *
 * `doerHandler(ctx)` / `reviewerHandler(ctx)` (apra-fleet-unw.16), when
 * provided, let a scenario override the doer/reviewer mock's behavior
 * (e.g. throw, lie about closing a bead, or return specific
 * reopenIds/newTasks) without needing a second, near-duplicate mock
 * builder. Each receives `{ opts, tempDir, runCmd, epicBead, reviewRound }`
 * and must return the same `{ content: [{ text }] }` shape `executePrompt`
 * itself returns. When omitted, sensible defaults (close every assigned
 * bead / approve-with-no-reopens) are used -- these defaults are what the
 * original run1/run2 happy-path scenario relies on.
 */
function buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const {
        planReviewerMode = 'reject-then-approve',
        doerHandler = null,
        reviewerHandler = null,
        addExtraTaskDuringPlan = true,
    } = options;

    let planRound = 0;
    let reviewRound = 0;
    let extraTaskAdded = false;

    const defaultDoerHandler = async ({ opts }) => {
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
    };

    const defaultReviewerHandler = async ({ opts, reviewRound: rRound }) => {
        // Scripted, deterministic scenario: reopen exactly once, on the
        // first review round, then approve on every subsequent round. No
        // Math.random() -- identical on every run. Per apra-fleet-unw.16,
        // the mock reviewer only ever RETURNS reopenIds -- it never runs
        // `bd update` itself; the runner (orchestrator) is responsible for
        // applying the transition. See the reviewer-dispatch-prompt grep
        // assertions in main() below, which confirm the prompt text itself
        // forbids the reviewer from mutating beads.
        if (rRound === 1) {
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
    };

    return {
        executeCommand: async (opts) => {
            commandLog.push(opts.command);

            // git/gh commands (apra-fleet-unw.14's branch-ensure/push/PR
            // steps) are intercepted rather than run for real: tempDir is a
            // bare `bd init` scratch directory, not a git repo with an
            // 'origin' remote, so there is nothing real to git-fetch/push/
            // gh-pr-create against here. This keeps the mock hermetic while
            // still exercising and asserting on runner.js's dispatch of
            // these commands.
            if (/^(git|gh)\s/.test(opts.command)) {
                return { content: [{ text: 'ok (mocked -- no real git remote in this mock sprint)' }] };
            }

            // No stale intercepts here otherwise: runner.js's Deploy/Integ
            // probes, `bd show`/`bd update`/`bd create` reopen/newTasks
            // calls, etc. are executed for real against tempDir, same as
            // every other bd/node command below.
            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                return { isError: true, content: [{ text: stderr || err.message }] };
            }
            return { content: [{ text: stdout }] };
        },
        executePrompt: async (opts) => {
            // Note: the workflow layer's agent() payload does NOT forward
            // opts.label into executePrompt (see
            // packages/apra-fleet-workflow/src/workflow/index.mjs, payload
            // only carries prompt/model/member/agent/etc.), so the Final
            // Review phase cannot be distinguished from the regular
            // per-round review via opts.label here. Both share agentType
            // 'reviewer'; distinguish by the (fixed, runner.js-authored)
            // prompt text instead.
            const isFinalReview = opts.agent === 'reviewer' && opts.prompt.trim() === 'Pass or Fail?';
            const isStreakAssignment = opts.agent === 'planner' && opts.prompt.includes('Ready bead ids:');
            dispatched.push({ agent: opts.agent, label: isFinalReview ? 'Final Review' : null, prompt: opts.prompt, member: opts.member_name });
            await sleep(DELAY_MS);

            // --- plan phase: planner ---
            if (opts.agent === 'planner' && !isStreakAssignment) {
                if (addExtraTaskDuringPlan && !extraTaskAdded) {
                    extraTaskAdded = true;
                    await runCmd('bd create -t task "Task: Add tests for API endpoints"', tempDir);
                    const list = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
                    const newTask = list.find((i) => i.title.includes('Add tests for API endpoints'));
                    if (newTask) {
                        await runCmd(`bd update ${newTask.id} --parent ${epicBead.id}`, tempDir);
                    }
                }
                return {
                    content: [{
                        text: 'Analyzed the Fleet Member API epic. Ensured tasks exist for implementation and for e2e tests covering registerMember and listMembers.'
                    }]
                };
            }

            // --- plan phase: plan-reviewer ---
            if (opts.agent === 'plan-reviewer') {
                planRound++;

                // apra-fleet-unw.15: plan-reviewer responses are now
                // schema-validated JSON (contracts.mjs `planReviewerVerdict`)
                // consumed via agent()'s { schema } option, not free text.
                if (planReviewerMode === 'always-reject-free-text') {
                    // Deliberately NOT JSON, and deliberately contains the
                    // substring "APPROVED" inside a rejection sentence --
                    // this must never be misread as an approval, and must
                    // exhaust agent()'s bounded schema-repair loop (it can
                    // never be coerced into schema-valid JSON) every round.
                    return { content: [{ text: 'This can NOT be APPROVED: the DAG is still missing a documentation task.' }] };
                }

                if (planReviewerMode === 'approve-immediately' || planRound >= 2) {
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
            // apra-fleet-unw.16: the runner now dispatches this with a
            // schema (contracts.mjs `streakAssignment`) and actually
            // consumes the result -- the mock returns real, schema-valid
            // JSON (one bead per streak, covering every ready bead id
            // exactly once) rather than free text, so the "real
            // consumption" path is exercised, not the invalid-output
            // fallback.
            if (isStreakAssignment) {
                const idsMatch = opts.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                return { content: [{ text: JSON.stringify({ streaks: ids.map((id) => [id]) }) }] };
            }

            // --- develop phase: doer ---
            if (opts.agent === 'doer') {
                const handler = doerHandler || defaultDoerHandler;
                return handler({ opts, tempDir, runCmd, epicBead });
            }

            // --- review phase: reviewer (dev-loop review; final review handled separately below) ---
            if (opts.agent === 'reviewer' && !isFinalReview) {
                reviewRound++;
                const handler = reviewerHandler || defaultReviewerHandler;
                return handler({ opts, tempDir, runCmd, epicBead, reviewRound });
            }

            // --- final review ---
            if (isFinalReview) {
                return { content: [{ text: 'Pass! Excellent velocity and solid implementation.' }] };
            }

            // --- deploy phase ---
            if (opts.agent === 'deployer') {
                return { content: [{ text: 'Successfully ran `npm publish` and published @apralabs/apra-fleet-client to the local registry.' }] };
            }

            // --- integ test phase ---
            if (opts.agent === 'integ-test-runner') {
                return { content: [{ text: 'All vitest e2e specs passed successfully.' }] };
            }

            // --- harvest phase ---
            if (opts.agent === 'harvester') {
                return { content: [{ text: 'Harvested API usage patterns to memory. Updated context docs.' }] };
            }

            // Any agentType reaching here means runner.js dispatched something
            // this mock doesn't know about -- fail loudly instead of silently
            // falling through to a generic stub (that's exactly the bug this
            // test exists to catch).
            throw new Error(`advanced-mock-runner-test: unhandled agentType '${opts.agent}' (label=${opts.label})`);
        }
    };
}

async function teardown(tempDir) {
    if (!tempDir) return;
    let retries = 8;
    while (retries > 0) {
        try {
            // Windows can hold file handles open briefly after child
            // processes (bd CLI) exit; retry on EBUSY.
            await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
            return;
        } catch (e) {
            if (e.code === 'EBUSY' && retries > 1) {
                retries--;
                await sleep(400);
            } else {
                console.error('Could not fully clean up temp dir:', tempDir, e.message);
                return;
            }
        }
    }
}

async function runOnce(tag, planReviewerMode = 'reject-then-approve') {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);

        // apra-fleet-unw.14: runner.js now validates a full CLI->runner arg
        // contract (branch/base_branch/members are required; goal/max_cycles
        // are optional with defaults) before any dispatch, and uses
        // branch/base_branch for the git checkout/push/PR steps below.
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
        const result = await engine.executeFile(scriptPath, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: 'auto-sprint/mock-sprint',
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
        }, true);

        // bd list hides closed issues by default -- pass --all so the final
        // state assertion actually sees closed beads.
        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeads = finalBeadsRaw
            .map((b) => ({ title: b.title, status: b.status }))
            .sort((a, b) => a.title.localeCompare(b.title));

        return { dispatched, result, finalBeads, commandLog, epicBeadId: epicBead.id };
    } finally {
        await teardown(tempDir);
    }
}

/**
 * apra-fleet-unw.15 scenario: the plan-reviewer never approves (always
 * returns non-JSON free text containing "APPROVED" inside a rejection
 * sentence, exhausting the schema-repair loop every round). Expects
 * engine.executeFile() to REJECT with a SprintPlanRejectedError, and
 * expects zero doer dispatches -- the sprint must never reach Develop with
 * an unapproved plan.
 */
async function runRejectedPlanScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode: 'always-reject-free-text' });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

        let error = null;
        try {
            await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: 'auto-sprint/mock-sprint-rejected',
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 5,
            }, true);
        } catch (err) {
            error = err;
        }

        return { dispatched, error };
    } finally {
        await teardown(tempDir);
    }
}

/**
 * Shared harness for the apra-fleet-unw.16 develop/review-loop scenarios:
 * minimal setup (no deploy.md/integ-test-playbook.md, no plan-phase
 * re-planning churn -- plan approves immediately), a `logs` array capturing
 * every `FleetWorkflow` 'log' event (so scenarios can assert on the
 * orchestrator's own reasoning, e.g. "treating streak as FAILED", without
 * having to reverse-engineer internal round-counting), and pass-through
 * doer/reviewer handler overrides.
 */
async function runDevelopLoopScenario(tag, { members, taskSpecs, doerHandler, reviewerHandler }) {
    const { tempDir, epicBead, tasks } = await setupMinimal(tag, taskSpecs);
    const dispatched = [];
    const commandLog = [];
    const logs = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
            doerHandler,
            reviewerHandler,
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members,
                branch: `auto-sprint/mock-${tag}`,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
            }, true);
        } catch (err) {
            error = err;
        }

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeadsById = new Map(finalBeadsRaw.map((b) => [b.id, b]));

        return { dispatched, commandLog, logs, error, result, tasks, epicBeadId: epicBead.id, finalBeadsById };
    } finally {
        await teardown(tempDir);
    }
}

const REQUIRED_AGENT_TYPES = ['planner', 'plan-reviewer', 'doer', 'reviewer', 'deployer', 'integ-test-runner', 'harvester'];

async function main() {
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };

    console.log('Running mock sprint scenario (pass 1)...');
    const run1 = await runOnce('run1');
    console.log('Running mock sprint scenario (pass 2)...');
    const run2 = await runOnce('run2');

    check(run1.result && run1.result.status === 'success', `Run1 did not succeed: ${JSON.stringify(run1.result)}`);
    check(run2.result && run2.result.status === 'success', `Run2 did not succeed: ${JSON.stringify(run2.result)}`);

    // apra-fleet-unw.14: branch/base_branch/goal/max_cycles values passed
    // into executeFile() must actually reach and be exposed by the runner,
    // not just be parsed and dropped.
    check(run1.result && run1.result.branch === 'auto-sprint/mock-sprint', `Run1 result did not expose branch: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.baseBranch === 'main', `Run1 result did not expose baseBranch: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.goal === 'P1/P2', `Run1 result did not expose goal: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.maxCycles === 5, `Run1 result did not expose maxCycles: ${JSON.stringify(run1.result)}`);

    // apra-fleet-unw.14: git semantics -- ensure/create the sprint branch is
    // the very first command dispatched (before any bd/node command), and
    // push + PR-raise are the last two commands dispatched (finalization).
    check(
        run1.commandLog.length >= 3 && /^git fetch /.test(run1.commandLog[0]) && run1.commandLog[0].includes('git checkout -B auto-sprint/mock-sprint'),
        `Expected first commandLog entry to be the sprint-branch-ensure git command, got: ${JSON.stringify(run1.commandLog[0])}`
    );
    const pushIdx = run1.commandLog.length - 2;
    const prIdx = run1.commandLog.length - 1;
    check(
        run1.commandLog[pushIdx] && run1.commandLog[pushIdx].startsWith('git push -u origin auto-sprint/mock-sprint'),
        `Expected second-to-last commandLog entry to be the branch push, got: ${JSON.stringify(run1.commandLog[pushIdx])}`
    );
    check(
        run1.commandLog[prIdx] && run1.commandLog[prIdx].startsWith('gh pr create') && run1.commandLog[prIdx].includes('--base "main"') && run1.commandLog[prIdx].includes('--head "auto-sprint/mock-sprint"'),
        `Expected last commandLog entry to be the PR-raise (not merge) command, got: ${JSON.stringify(run1.commandLog[prIdx])}`
    );
    check(
        !run1.commandLog.some((c) => /^git\s+merge|gh\s+pr\s+merge/.test(c)),
        `Runner must never auto-merge (pm skill R12); found a merge command in the log: ${JSON.stringify(run1.commandLog)}`
    );

    const seq1 = run1.dispatched.map((d) => `${d.agent}${d.label ? ':' + d.label : ''}`);
    const seq2 = run2.dispatched.map((d) => `${d.agent}${d.label ? ':' + d.label : ''}`);
    check(
        JSON.stringify(seq1) === JSON.stringify(seq2),
        `Dispatched agent sequences differ between runs (non-deterministic).\nRun1: ${seq1.join(', ')}\nRun2: ${seq2.join(', ')}`
    );

    for (const type of REQUIRED_AGENT_TYPES) {
        check(run1.dispatched.some((d) => d.agent === type), `Phase for agentType '${type}' was never dispatched (run1)`);
        check(run2.dispatched.some((d) => d.agent === type), `Phase for agentType '${type}' was never dispatched (run2)`);
    }
    check(
        run1.dispatched.some((d) => d.agent === 'reviewer' && d.label === 'Final Review'),
        "Final Review phase (agentType 'reviewer', label 'Final Review') was not dispatched (run1)"
    );

    check(
        JSON.stringify(run1.finalBeads) === JSON.stringify(run2.finalBeads),
        `Final beads DB state differs between runs.\nRun1: ${JSON.stringify(run1.finalBeads)}\nRun2: ${JSON.stringify(run2.finalBeads)}`
    );

    const expectedClosedTitles = [
        'Task: Implement registerMember in client.js',
        'Task: Implement listMembers in client.js',
        'Task: Add tests for API endpoints'
    ];
    for (const title of expectedClosedTitles) {
        const bead = run1.finalBeads.find((b) => b.title === title);
        check(!!bead && bead.status === 'closed', `Expected bead '${title}' to be closed at end of sprint, got: ${JSON.stringify(bead)}`);
    }
    check(!run1.finalBeads.some((b) => b.title.startsWith('Bug:')), 'Unexpected bug bead created despite deterministic passing integ test');
    check(
        run1.finalBeads.filter((b) => b.title === 'Task: Add tests for API endpoints').length === 1,
        'Duplicate "Add tests" bead created (planner mock branch not idempotent across plan-review rounds)'
    );

    // apra-fleet-unw.15, acceptance criterion 4: planner dispatch prompts
    // are self-contained -- they must name the sprint root issue id(s) and
    // the goal, and round-2+ prompts must carry the plan-reviewer's
    // feedback wrapped in the untrusted-content delimiter (contracts.mjs
    // wrapUntrustedBlock, feedback.md A7).
    const planPhasePlannerCalls = run1.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
    check(planPhasePlannerCalls.length >= 2, `Expected at least 2 plan-phase planner dispatches (round 1 rejected, round 2 approved), got ${planPhasePlannerCalls.length}`);
    if (planPhasePlannerCalls.length > 0) {
        const round1Prompt = planPhasePlannerCalls[0].prompt;
        check(round1Prompt.includes('P1/P2'), `Round-1 planner prompt did not include the goal 'P1/P2': ${round1Prompt}`);
        check(
            round1Prompt.includes(run1.epicBeadId),
            `Round-1 planner prompt did not reference the sprint root issue id: ${round1Prompt}`
        );
    }
    if (planPhasePlannerCalls.length > 1) {
        const round2Prompt = planPhasePlannerCalls[1].prompt;
        check(
            round2Prompt.includes('untrusted-agent-output') && round2Prompt.includes('untrusted output from another agent'),
            `Round-2 planner prompt did not include the wrapUntrustedBlock delimiter markers: ${round2Prompt}`
        );
        check(
            round2Prompt.includes('Ensure you also add a documentation task.'),
            `Round-2 planner prompt did not carry the round-1 plan-reviewer feedback text: ${round2Prompt}`
        );
    }

    // apra-fleet-unw.15, acceptance criteria 1-3: a plan-reviewer that
    // never returns an APPROVED schema-valid verdict (here: persistent
    // non-JSON free text containing "APPROVED" inside a rejection sentence)
    // must abort the sprint with SprintPlanRejectedError after 3 rounds,
    // and must NEVER dispatch a doer.
    console.log('Running mock sprint scenario (rejected plan, 3x CHANGES_NEEDED)...');
    const rejected = await runRejectedPlanScenario('rejected');
    check(!!rejected.error, 'Expected engine.executeFile() to reject when the plan is never approved, but it resolved successfully');
    check(
        rejected.error instanceof SprintPlanRejectedError,
        `Expected a SprintPlanRejectedError, got: ${rejected.error ? rejected.error.constructor.name + ': ' + rejected.error.message : 'no error'}`
    );
    check(
        !rejected.dispatched.some((d) => d.agent === 'doer'),
        `Expected zero doer dispatches when the plan is never approved, got: ${JSON.stringify(rejected.dispatched.map((d) => d.agent))}`
    );
    const rejectedPlannerCalls = rejected.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
    check(rejectedPlannerCalls.length === 3, `Expected exactly 3 plan-phase planner dispatches (3 rejected rounds), got ${rejectedPlannerCalls.length}`);

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 1: multi-member doer pool
    // =========================================================================
    // Root-cause regression test for the A2 "Doer/doer casing" pool-collapse
    // bug: getMembersForRole used to special-case the CAPITALIZED
    // 'Doer'/'Reviewer' strings while every call site passed lowercase
    // 'doer'/'reviewer', so the pool silently collapsed to physicalMembers[0]
    // no matter how many members were configured. With 2 distinct members
    // configured and 2 ready (independent) tasks, BOTH members must receive
    // a doer dispatch in round 1.
    console.log('Running mock sprint scenario (multi-member doer pool)...');
    const multiDoer = await runDevelopLoopScenario('multidoer', {
        members: ['m1', 'm2'],
        taskSpecs: [
            { title: 'Task: Implement registerMember in client.js' },
            { title: 'Task: Implement listMembers in client.js' },
        ],
        // Always-approve reviewer: keeps this scenario to a single dev
        // round so the streak-assignment-dispatch-count assertion below
        // (exactly 1) isn't coupled to the default reviewer mock's
        // scripted one-time reopen behavior.
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Both look good.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!multiDoer.error, `Multi-doer scenario did not complete: ${multiDoer.error ? multiDoer.error.message : ''}`);
    const multiDoerFirstRoundDoerCalls = multiDoer.dispatched.filter((d) => d.agent === 'doer');
    const multiDoerMembers = new Set(multiDoerFirstRoundDoerCalls.map((d) => d.member));
    check(multiDoerMembers.has('m1'), `Expected member 'm1' to receive a doer dispatch, got members: ${JSON.stringify([...multiDoerMembers])}`);
    check(multiDoerMembers.has('m2'), `Expected member 'm2' to receive a doer dispatch, got members: ${JSON.stringify([...multiDoerMembers])}`);
    check(multiDoerFirstRoundDoerCalls.length >= 2, `Expected at least 2 doer dispatches (one per ready task), got ${multiDoerFirstRoundDoerCalls.length}`);
    for (const t of multiDoer.tasks) {
        const bead = multiDoer.finalBeadsById.get(t.id);
        check(!!bead && bead.status === 'closed', `Multi-doer scenario: expected bead '${t.id}' (${t.title}) to be closed, got: ${JSON.stringify(bead)}`);
    }

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 2: doer failure isolation + retry
    // =========================================================================
    // One task's doer ALWAYS throws (both the original dispatch and the
    // one retry); a sibling, independent task's doer succeeds normally.
    // Expect: (a) engine.executeFile() still resolves (parallel()'s
    // continueOnError:true isolates the failing streak instead of aborting
    // the whole cycle), (b) the sibling bead closes normally, (c) the
    // failing bead's doer was dispatched exactly twice (original + one
    // retry, no more), (d) the failing bead never closes.
    console.log('Running mock sprint scenario (doer streak throws, sibling completes)...');
    const isolation = await runDevelopLoopScenario('isolation', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Always throws' },
            { title: 'Task: Always succeeds' },
        ],
        doerHandler: async ({ opts, tempDir: td, epicBead: epic }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const throwsTask = listRes.find((b) => b.title === 'Task: Always throws');
            if (throwsTask && ids.includes(throwsTask.id)) {
                throw new Error(`mock doer failure for bead ${throwsTask.id}`);
            }
            for (const id of ids) {
                await runCmd(`bd close ${id}`, td);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!isolation.error, `Doer-failure-isolation scenario should not abort the whole sprint: ${isolation.error ? isolation.error.message : ''}`);
    check(isolation.result && isolation.result.status === 'success', `Doer-failure-isolation scenario did not resolve success: ${JSON.stringify(isolation.result)}`);
    const throwsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always throws').id;
    const succeedsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always succeeds').id;
    // The always-throwing bead is never closed, so it stays `ready` and is
    // re-picked up every subsequent dev round (the loop's own 3-round cap,
    // untouched by apra-fleet-unw.16 -- out of scope, see unw.17): 1
    // original + 1 retry per round, for 3 rounds = 6 total dispatches. The
    // key property under test isn't the absolute count but that it's an
    // exact multiple of 2 (every dispatch was retried exactly once, never
    // more, never left un-retried) and that the sibling only ever needed
    // one attempt.
    const throwsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(throwsTaskId)).length;
    check(throwsDispatchCount === 6, `Expected the always-throwing streak to be dispatched exactly 6 times (1 original + 1 retry, across 3 dev rounds), got ${throwsDispatchCount}`);
    const succeedsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(succeedsTaskId)).length;
    check(succeedsDispatchCount === 1, `Expected the sibling streak to be dispatched exactly once (no throw, no retry needed), got ${succeedsDispatchCount}`);
    check(
        isolation.finalBeadsById.get(succeedsTaskId) && isolation.finalBeadsById.get(succeedsTaskId).status === 'closed',
        `Expected sibling bead '${succeedsTaskId}' to be closed despite the sibling streak throwing, got: ${JSON.stringify(isolation.finalBeadsById.get(succeedsTaskId))}`
    );
    check(
        isolation.finalBeadsById.get(throwsTaskId) && isolation.finalBeadsById.get(throwsTaskId).status !== 'closed',
        `Expected the always-throwing bead '${throwsTaskId}' to remain open (never closed), got: ${JSON.stringify(isolation.finalBeadsById.get(throwsTaskId))}`
    );
    check(
        isolation.logs.some((m) => m.includes('Retrying once')),
        `Expected a "Retrying once" log line for the failed streak, logs: ${JSON.stringify(isolation.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 3: reviewer JSON reopenIds ->
    // ORCHESTRATOR (not the LLM) applies bd update --status=open
    // =========================================================================
    console.log('Running mock sprint scenario (reviewer reopenIds -> orchestrator applies)...');
    const reopen = await runDevelopLoopScenario('reopen', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Reopen target A' },
            { title: 'Task: Reopen target B' },
        ],
        reviewerHandler: async ({ reviewRound: rRound, tempDir: td }) => {
            if (rRound === 1) {
                const listRes = JSON.parse((await runCmd('bd list --all --json', td)).stdout || '[]');
                const targetA = listRes.find((b) => b.title === 'Task: Reopen target A');
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Target A needs a fix.',
                            reopenIds: [targetA.id],
                            newTasks: [],
                        })
                    }]
                };
            }
            return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'All good now.', reopenIds: [], newTasks: [] }) }] };
        },
    });
    check(!reopen.error, `Reopen scenario should not error: ${reopen.error ? reopen.error.message : ''}`);
    const targetAId = reopen.tasks.find((t) => t.title === 'Task: Reopen target A').id;
    const targetBId = reopen.tasks.find((t) => t.title === 'Task: Reopen target B').id;
    check(
        reopen.commandLog.some((c) => c === `bd update ${targetAId} --status=open`),
        `Expected the RUNNER (orchestrator) to issue 'bd update ${targetAId} --status=open', commandLog: ${JSON.stringify(reopen.commandLog)}`
    );
    check(
        !reopen.commandLog.some((c) => c === `bd update ${targetBId} --status=open`),
        `Did NOT expect a reopen command for bead '${targetBId}' (not in reopenIds), commandLog: ${JSON.stringify(reopen.commandLog)}`
    );
    // Confirm the reviewer's own mock handler is a pure JSON-return -- it
    // never calls runCmd('bd update ...'/'bd close ...'), i.e. only the
    // orchestrator's own code (buildMockFleetApi's executeCommand path,
    // invoked FROM runner.js's command() calls) ever issues the reopen.
    // Grep the actual reviewer DISPATCH PROMPT text (not just the mock's
    // behavior) to confirm runner.js's prompt itself forbids bd mutation --
    // this is the "redundant, dispatch-prompt-level" contract required by
    // apra-fleet-unw.16 Work item 4.
    const reviewerDispatchPrompts = reopen.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
    check(reviewerDispatchPrompts.length >= 1, 'Expected at least one non-final reviewer dispatch in the reopen scenario');
    for (const d of reviewerDispatchPrompts) {
        check(
            /do not (run any `?bd`? command yourself|mutate beads directly)/i.test(d.prompt) || d.prompt.includes('Do NOT run any `bd` command yourself'),
            `Reviewer dispatch prompt did not forbid direct bd mutation: ${d.prompt}`
        );
        check(
            d.prompt.includes('reopenIds') && d.prompt.includes('newTasks'),
            `Reviewer dispatch prompt did not mention returning reopenIds/newTasks only: ${d.prompt}`
        );
    }

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 4: doer "lies" (success text,
    // bead never actually closed) is treated as a FAILURE, not a success
    // =========================================================================
    console.log('Running mock sprint scenario (doer lies about closing a bead)...');
    const liar = await runDevelopLoopScenario('liar', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Lied about closing' },
        ],
        doerHandler: async ({ opts }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            // Deliberately do NOT call `bd close` -- report success anyway.
            return {
                content: [{
                    text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'All done, closed successfully!' })
                }]
            };
        },
    });
    check(!liar.error, `Doer-lies scenario should not error: ${liar.error ? liar.error.message : ''}`);
    const liedTaskId = liar.tasks.find((t) => t.title === 'Task: Lied about closing').id;
    check(
        liar.finalBeadsById.get(liedTaskId) && liar.finalBeadsById.get(liedTaskId).status !== 'closed',
        `Expected the bead the doer lied about to remain open, got: ${JSON.stringify(liar.finalBeadsById.get(liedTaskId))}`
    );
    check(
        liar.logs.some((m) => m.includes('treating streak as FAILED') && m.includes(liedTaskId)),
        `Expected a "treating streak as FAILED" log line naming '${liedTaskId}' despite the doer's success-looking report, logs: ${JSON.stringify(liar.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 5: no discarded agent() results
    // =========================================================================
    // Static-ish check on the source itself: every historically-discarded
    // call site (streak assignment result assigned to a variable that was
    // only ever logged) must now feed a real decision. This is exercised
    // functionally above (multi-doer proves streak assignment is consumed;
    // reopen proves reviewerVerdict is consumed); here we additionally
    // confirm the streak-assignment prompt/response shape round-trips (the
    // mock's streak JSON was parsed and used to build actual streaks, not
    // discarded and replaced unconditionally by the one-bead fallback).
    const multiDoerStreakCalls = multiDoer.dispatched.filter((d) => d.agent === 'planner' && d.prompt.includes('Ready bead ids:'));
    check(multiDoerStreakCalls.length === 1, `Expected exactly 1 streak-assignment dispatch in the multi-doer scenario (single dev round), got ${multiDoerStreakCalls.length}`);

    if (failures.length > 0) {
        console.error('\nFAIL advanced-mock-runner-test.mjs:');
        for (const f of failures) console.error(' - ' + f);
        process.exitCode = 1;
    } else {
        console.log('\nPASS advanced-mock-runner-test.mjs: deterministic across 2 runs, all runner.js phases exercised.');
        process.exitCode = 0;
    }
}

main().catch((err) => {
    console.error('advanced-mock-runner-test.mjs crashed:', err);
    process.exitCode = 1;
});
