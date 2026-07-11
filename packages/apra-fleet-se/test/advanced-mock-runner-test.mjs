import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { exec } from 'child_process';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

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

    return { tempDir, epicBead };
}

/**
 * Builds a deterministic mock FleetApi. Every executePrompt() call is
 * recorded into `dispatched` so the caller can assert on the exact sequence
 * of agentType dispatches, and can diff that sequence across repeated runs.
 *
 * Every executeCommand() call is additionally recorded into `commandLog` in
 * dispatch order -- used to assert on the git/gh command-call log added by
 * apra-fleet-unw.14 (branch creation at sprint start, push + PR raise at
 * finalization).
 */
function buildMockFleetApi(tempDir, epicBead, dispatched, commandLog) {
    let planRound = 0;
    let reviewRound = 0;
    let extraTaskAdded = false;

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
            // probes are `node -e "require('fs').existsSync(...)"`
            // commands, which are executed for real against tempDir (where
            // setup() wrote deploy.md / integ-test-playbook.md), same as
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
            dispatched.push({ agent: opts.agent, label: isFinalReview ? 'Final Review' : null });
            await sleep(DELAY_MS);

            // --- plan phase ---
            if (opts.agent === 'planner' && !opts.prompt.includes('Group')) {
                if (!extraTaskAdded) {
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

            if (opts.agent === 'plan-reviewer') {
                planRound++;
                if (planRound < 2) {
                    return { content: [{ text: 'CHANGES_NEEDED: Ensure you also add a documentation task.' }] };
                }
                return { content: [{ text: 'Code looks solid. We have tasks for implementation and tests. APPROVED.' }] };
            }

            // --- develop phase: streak grouping (still agentType 'planner') ---
            if (opts.agent === 'planner' && opts.prompt.includes('Group')) {
                return { content: [{ text: 'Assigned implementation and test tasks into sequential streaks.' }] };
            }

            // --- develop phase: doer ---
            if (opts.agent === 'doer') {
                const match = opts.prompt.match(/Close the assigned beads:\s*([^.]+)/i);
                if (match) {
                    const ids = match[1].split(',').map((s) => s.trim()).filter(Boolean);
                    for (const id of ids) {
                        await runCmd(`bd close ${id}`, tempDir);
                    }
                }
                return { content: [{ text: 'Implemented the requested fleet client methods using fetch to hit the MCP JSON-RPC endpoints. Closed the assigned beads.' }] };
            }

            // --- review phase: reviewer (dev-loop review AND final review share agentType 'reviewer') ---
            if (opts.agent === 'reviewer') {
                if (isFinalReview) {
                    return { content: [{ text: 'Pass! Excellent velocity and solid implementation.' }] };
                }

                reviewRound++;
                // Scripted, deterministic scenario: reopen exactly once, on
                // the first review round, then approve on every subsequent
                // round. No Math.random() -- identical on every run.
                if (reviewRound === 1) {
                    const closedRes = await runCmd(`bd list --parent ${epicBead.id} --status=closed --json`, tempDir);
                    const closedBeads = JSON.parse(closedRes.stdout || '[]').sort((a, b) => a.id.localeCompare(b.id));
                    if (closedBeads.length > 0) {
                        const target = closedBeads[0];
                        await runCmd(`bd update ${target.id} --status open`, tempDir);
                        return { content: [{ text: `Reopened bead ${target.id}. The implementation is missing error handling for 401 Unauthorized responses. Please fix.` }] };
                    }
                }
                return { content: [{ text: 'Code logic is sound. Error handling and type definitions match the spec. Approved.' }] };
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

async function runOnce(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog);
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

        return { dispatched, result, finalBeads, commandLog };
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
