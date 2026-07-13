import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import {
    validateArgs,
    validateIssueId,
    validateBranchName,
} from '../auto-sprint/runner.js';

// Unit + mock-level tests for apra-fleet-unw.14: the CLI->runner argument
// contract (validateArgs/validateIssueId/validateBranchName), and proof
// that valid branch/goal/base_branch/max_cycles values (a) actually reach
// the runner's execution and (b) a malicious/invalid arg is rejected
// BEFORE any fleet dispatch (A7 defense in depth).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_SCRIPT_PATH = path.join(__dirname, '../auto-sprint/runner.js');

const VALID_ARGS = Object.freeze({
    target_issues: ['bd-1', 'bd-2'],
    members: ['local'],
    branch: 'auto-sprint/feature-x',
    base_branch: 'main',
});

// ---------------------------------------------------------------------------
// validateArgs / validateIssueId / validateBranchName -- pure unit tests
// ---------------------------------------------------------------------------

describe('validateIssueId', () => {
    test('accepts ids matching the safe pattern', () => {
        for (const id of ['bd-1', 'BD-42', 'epic.1_2', 'a']) {
            assert.strictEqual(validateIssueId(id), id);
        }
    });

    test('rejects shell-injection-style ids', () => {
        assert.throws(() => validateIssueId('BD-1; rm -rf ~'), /Invalid issue id/);
        assert.throws(() => validateIssueId('BD-1 && echo pwned'), /Invalid issue id/);
        assert.throws(() => validateIssueId('BD-1 | cat /etc/passwd'), /Invalid issue id/);
        assert.throws(() => validateIssueId('$(whoami)'), /Invalid issue id/);
        assert.throws(() => validateIssueId('`whoami`'), /Invalid issue id/);
    });

    test('rejects empty string, non-strings', () => {
        assert.throws(() => validateIssueId(''), /Invalid issue id/);
        assert.throws(() => validateIssueId(undefined), /Invalid issue id/);
        assert.throws(() => validateIssueId(42), /Invalid issue id/);
        assert.throws(() => validateIssueId(null), /Invalid issue id/);
    });
});

describe('validateBranchName', () => {
    test('accepts branch names with slashes/dots/dashes/underscores', () => {
        for (const name of ['main', 'auto-sprint/feature-x', 'release/1.2.3', 'feat_x']) {
            assert.strictEqual(validateBranchName(name, 'branch'), name);
        }
    });

    test('rejects shell-injection-style branch names', () => {
        assert.throws(() => validateBranchName('main; rm -rf ~', 'branch'), /Invalid branch/);
        assert.throws(() => validateBranchName('main && echo pwned', 'base_branch'), /Invalid base_branch/);
    });

    test('rejects empty string / non-strings', () => {
        assert.throws(() => validateBranchName('', 'branch'), /Invalid branch/);
        assert.throws(() => validateBranchName(undefined, 'branch'), /Invalid branch/);
    });
});

describe('validateArgs', () => {
    test('accepts a minimal valid args object and fills in defaults', () => {
        const result = validateArgs(VALID_ARGS);
        assert.deepStrictEqual(result.targetIssues, ['bd-1', 'bd-2']);
        assert.deepStrictEqual(result.members, ['local']);
        assert.strictEqual(result.branch, 'auto-sprint/feature-x');
        assert.strictEqual(result.baseBranch, 'main');
        assert.strictEqual(result.goal, 'P1/P2'); // default
        assert.strictEqual(result.maxCycles, 5); // default
    });

    test('accepts legacy single target_issue', () => {
        const result = validateArgs({ ...VALID_ARGS, target_issues: undefined, target_issue: 'bd-1' });
        assert.deepStrictEqual(result.targetIssues, ['bd-1']);
    });

    test('accepts explicit goal/max_cycles/requirementsFile/roleMap', () => {
        const result = validateArgs({
            ...VALID_ARGS,
            goal: 'P1',
            max_cycles: 3,
            requirementsFile: 'requirements.md',
            roleMap: { planner: ['member-a'] },
        });
        assert.strictEqual(result.goal, 'P1');
        assert.strictEqual(result.maxCycles, 3);
        assert.strictEqual(result.requirementsFile, 'requirements.md');
        assert.deepStrictEqual(result.roleMap, { planner: ['member-a'] });
    });

    // -------------------------------------------------------------------
    // N15 (apra-fleet-unw2.11): roleMap key normalization + the
    // 'orchestrator' application-level pseudo-role.
    // -------------------------------------------------------------------

    test('normalizes mixed-case/whitespace-variant roleMap keys to canonical lowercase', () => {
        const result = validateArgs({
            ...VALID_ARGS,
            roleMap: {
                '  Doer  ': ['member-a'],
                'REVIEWER': ['member-b'],
                'Plan-Reviewer': ['member-c'],
            },
        });
        assert.deepStrictEqual(result.roleMap, {
            doer: ['member-a'],
            reviewer: ['member-b'],
            'plan-reviewer': ['member-c'],
        });
    });

    test('accepts the "orchestrator" pseudo-role as a roleMap key (not a member of ROLES) without throwing', () => {
        const result = validateArgs({
            ...VALID_ARGS,
            roleMap: { orchestrator: ['member-a'], doer: ['member-b'] },
        });
        assert.deepStrictEqual(result.roleMap, { orchestrator: ['member-a'], doer: ['member-b'] });
    });

    test('normalizes a mixed-case "Orchestrator" roleMap key to lowercase "orchestrator"', () => {
        const result = validateArgs({
            ...VALID_ARGS,
            roleMap: { Orchestrator: ['member-a'] },
        });
        assert.deepStrictEqual(result.roleMap, { orchestrator: ['member-a'] });
    });

    test('rejects roleMap keys that collide once normalized', () => {
        assert.throws(
            () => validateArgs({ ...VALID_ARGS, roleMap: { Doer: ['member-a'], doer: ['member-b'] } }),
            /roleMap: key "doer" normalizes to "doer", which collides/
        );
    });

    test('roleMap is undefined when not passed (no normalization side effect)', () => {
        const result = validateArgs(VALID_ARGS);
        assert.strictEqual(result.roleMap, undefined);
    });

    test('rejects unknown args loudly', () => {
        assert.throws(
            () => validateArgs({ ...VALID_ARGS, bogus_flag: 'x' }),
            /Unknown arg\(s\): bogus_flag/
        );
    });

    test('rejects when both target_issues and target_issue are missing', () => {
        const { target_issues, ...rest } = VALID_ARGS;
        assert.throws(() => validateArgs(rest), /Missing required arg: target_issues/);
    });

    test('rejects when members is missing or empty', () => {
        assert.throws(() => validateArgs({ ...VALID_ARGS, members: undefined }), /Missing required arg: members/);
        assert.throws(() => validateArgs({ ...VALID_ARGS, members: [] }), /Missing required arg: members/);
    });

    test('rejects when branch is missing', () => {
        assert.throws(() => validateArgs({ ...VALID_ARGS, branch: undefined }), /Missing required arg: branch/);
    });

    test('rejects when base_branch is missing', () => {
        assert.throws(() => validateArgs({ ...VALID_ARGS, base_branch: undefined }), /Missing required arg: base_branch/);
    });

    test('rejects a malicious issue id inside target_issues', () => {
        assert.throws(
            () => validateArgs({ ...VALID_ARGS, target_issues: ['BD-1; rm -rf ~'] }),
            /Invalid issue id/
        );
    });

    test('rejects a malicious branch name', () => {
        assert.throws(
            () => validateArgs({ ...VALID_ARGS, branch: 'sprint; rm -rf ~' }),
            /Invalid branch/
        );
    });

    test('rejects an invalid goal value', () => {
        assert.throws(() => validateArgs({ ...VALID_ARGS, goal: 'P9' }), /Invalid goal/);
    });

    test('rejects a non-integer / non-positive max_cycles', () => {
        assert.throws(() => validateArgs({ ...VALID_ARGS, max_cycles: 0 }), /Invalid max_cycles/);
        assert.throws(() => validateArgs({ ...VALID_ARGS, max_cycles: 1.5 }), /Invalid max_cycles/);
        assert.throws(() => validateArgs({ ...VALID_ARGS, max_cycles: 'five' }), /Invalid max_cycles/);
    });

    test('rejects a non-object args value', () => {
        assert.throws(() => validateArgs(null), /args must be an object/);
        assert.throws(() => validateArgs('nope'), /args must be an object/);
        assert.throws(() => validateArgs(['a']), /args must be an object/);
    });
});

// ---------------------------------------------------------------------------
// Mock-level tests: prove branch/goal/base_branch/max_cycles reach the
// runner's execution (not just parsed and dropped), and that a malicious
// issue id is rejected with zero fleet dispatches.
// ---------------------------------------------------------------------------

/**
 * A minimal spy fleetApi: counts every executeCommand/executePrompt call
 * (so tests can assert "zero fleet dispatches" precisely) and returns a
 * scripted, deterministic response for whichever agentType/command is
 * dispatched so the full runner.js sprint loop can run to completion.
 */
// apra-fleet-7ll: replicate the real execute_command MCP tool's response
// shape (src/tools/execute-command.ts) -- "Exit code: N\n<output>" display
// text PLUS a structuredContent.stdout/stderr/exitCode machine-readable
// channel -- see the identical helper in advanced-mock-runner-test.mjs /
// golden-transcript.test.mjs / budget-live.test.mjs.
function mockCmdResult(code, stdout, stderr = '') {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    const output = parts.join('\n') || '(no output)';
    return {
        content: [{ text: `Exit code: ${code}\n${output}` }],
        structuredContent: { exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' },
    };
}

function buildSpyFleetApi() {
    const calls = { executeCommand: 0, executePrompt: 0 };
    const commandLog = [];
    const promptLog = [];
    // N15 (apra-fleet-unw2.11): parallel log of { command, member_name } for
    // tests that need to assert WHICH member a given command dispatched to
    // (commandLog above is command-strings-only and used by pre-existing
    // assertions that must not change shape).
    const dispatchLog = [];

    return {
        calls,
        commandLog,
        promptLog,
        dispatchLog,
        executeCommand: async (opts) => {
            calls.executeCommand++;
            commandLog.push(opts.command);
            dispatchLog.push({ command: opts.command, member_name: opts.member_name });

            if (/^(git|gh)\s/.test(opts.command)) {
                return mockCmdResult(0, 'ok');
            }
            if (/^bd list .*--ready/.test(opts.command)) {
                // First ready-list call returns one bead so the sprint can
                // proceed; subsequent calls (post-doer) return none so the
                // develop loop and cycle loop both terminate immediately.
                const alreadyReturnedReady = commandLog.filter((c) => /^bd list .*--ready/.test(c)).length > 1;
                return mockCmdResult(0, alreadyReturnedReady ? '[]' : '[{"id":"bd-1","title":"Task"}]');
            }
            if (/^bd list /.test(opts.command)) {
                return mockCmdResult(0, '[]');
            }
            if (opts.command.includes("existsSync")) {
                return mockCmdResult(0, 'not found');
            }
            return mockCmdResult(0, '');
        },
        executePrompt: async (opts) => {
            calls.executePrompt++;
            promptLog.push({ agent: opts.agent, prompt: opts.prompt });

            if (opts.agent === 'plan-reviewer') {
                // apra-fleet-unw.15: plan-reviewer verdicts are now
                // schema-validated JSON (contracts.mjs planReviewerVerdict),
                // not free text.
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Looks good.',
                            taskAssignments: [],
                        })
                    }]
                };
            }
            if (opts.agent === 'reviewer') {
                // apra-fleet-unw.17: the Final Review dispatch (agentType
                // 'reviewer', finalVerdict schema) is distinguished from a
                // regular per-round review (reviewerVerdict schema) by its
                // fixed prompt prefix (buildFinalVerdictPrompt) -- both are
                // schema-validated JSON now, not free text.
                if (opts.prompt.startsWith('Final review for sprint scope issue id(s):')) {
                    return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Looks good.' }) }] };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Approved.',
                            reopenIds: [],
                            newTasks: [],
                        })
                    }]
                };
            }
            if (opts.agent === 'deployer') {
                return { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed.' }) }] };
            }
            if (opts.agent === 'integ-test-runner') {
                return { content: [{ text: JSON.stringify({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'OK.' }) }] };
            }
            if (opts.agent === 'harvester') {
                return { content: [{ text: JSON.stringify({ status: 'OK', notes: 'Harvested.' }) }] };
            }
            return { content: [{ text: 'ok' }] };
        },
    };
}

describe('runner.js mock-level execution', () => {
    test('branch/goal/base_branch/max_cycles reach the runner and are returned/published', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const publishedStates = [];
        workflow.on('state', (evt) => publishedStates.push(evt));
        const engine = new WorkflowEngine(workflow);

        const result = await engine.executeFile(RUNNER_SCRIPT_PATH, {
            target_issue: 'bd-1',
            members: ['local'],
            branch: 'auto-sprint/reach-test',
            base_branch: 'develop',
            goal: 'P1',
            max_cycles: 1,
        }, true);

        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.branch, 'auto-sprint/reach-test');
        assert.strictEqual(result.baseBranch, 'develop');
        assert.strictEqual(result.goal, 'P1');
        assert.strictEqual(result.maxCycles, 1);

        const argsState = publishedStates.find((e) => e.namespace === 'sprint-args');
        assert.ok(argsState, 'expected a publishState("sprint-args", ...) call');
        assert.strictEqual(argsState.data.branch, 'auto-sprint/reach-test');
        assert.strictEqual(argsState.data.baseBranch, 'develop');
        assert.strictEqual(argsState.data.goal, 'P1');
        assert.strictEqual(argsState.data.maxCycles, 1);

        // Git semantics: branch-ensure at start, push+PR at finalization.
        assert.match(spy.commandLog[0], /^git fetch origin develop/);
        assert.ok(spy.commandLog[0].includes('git checkout -B auto-sprint/reach-test origin/develop'));
        const last2 = spy.commandLog.slice(-2);
        assert.match(last2[0], /^git push -u origin auto-sprint\/reach-test/);
        assert.match(last2[1], /^gh pr create --base "develop" --head "auto-sprint\/reach-test"/);
    });

    test('a malicious issue id is rejected with a validation error and results in ZERO fleet dispatches', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        await assert.rejects(
            () => engine.executeFile(RUNNER_SCRIPT_PATH, {
                target_issues: ['BD-1; rm -rf ~'],
                members: ['local'],
                branch: 'auto-sprint/malicious-test',
                base_branch: 'main',
            }, true),
            /Invalid issue id/
        );

        assert.strictEqual(spy.calls.executeCommand, 0, 'expected zero executeCommand dispatches');
        assert.strictEqual(spy.calls.executePrompt, 0, 'expected zero executePrompt dispatches');
    });

    test('a malicious branch name is rejected with a validation error and results in ZERO fleet dispatches', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        await assert.rejects(
            () => engine.executeFile(RUNNER_SCRIPT_PATH, {
                target_issue: 'bd-1',
                members: ['local'],
                branch: 'sprint; rm -rf ~',
                base_branch: 'main',
            }, true),
            /Invalid branch/
        );

        assert.strictEqual(spy.calls.executeCommand, 0, 'expected zero executeCommand dispatches');
        assert.strictEqual(spy.calls.executePrompt, 0, 'expected zero executePrompt dispatches');
    });

    test('missing required args (no branch/base_branch/members) are rejected with ZERO fleet dispatches', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        await assert.rejects(
            () => engine.executeFile(RUNNER_SCRIPT_PATH, {
                target_issue: 'bd-1',
            }, true),
            /Missing required arg/
        );

        assert.strictEqual(spy.calls.executeCommand, 0);
        assert.strictEqual(spy.calls.executePrompt, 0);
    });

    test('an unknown arg is rejected with ZERO fleet dispatches', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        await assert.rejects(
            () => engine.executeFile(RUNNER_SCRIPT_PATH, {
                target_issue: 'bd-1',
                members: ['local'],
                branch: 'auto-sprint/unknown-arg-test',
                base_branch: 'main',
                totally_bogus: true,
            }, true),
            /Unknown arg\(s\)/
        );

        assert.strictEqual(spy.calls.executeCommand, 0);
        assert.strictEqual(spy.calls.executePrompt, 0);
    });

    // -------------------------------------------------------------------
    // N15 (apra-fleet-unw2.11): a roleMap with mixed-case/whitespace-variant
    // keys dispatches to the mapped member, and the 'orchestrator'
    // pseudo-role is honored WITHOUT being validated against contracts.ROLES.
    // -------------------------------------------------------------------

    test('a mixed-case roleMap key normalizes and dispatches orchestrator-side bd commands to the mapped member', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        const result = await engine.executeFile(RUNNER_SCRIPT_PATH, {
            target_issue: 'bd-1',
            members: ['local', 'member-x'],
            branch: 'auto-sprint/rolemap-casing-test',
            base_branch: 'main',
            max_cycles: 1,
            // Mixed casing/whitespace: must resolve identically to the
            // canonical lowercase 'orchestrator' key and route every
            // orchestrator-side `bd` command to 'member-x'. (git
            // fetch/checkout commands go to the UNION of orchestrator/doer/
            // reviewer pools -- see runner.js's branchEnsureMembers/N4 -- so
            // this asserts on the `bd `-prefixed commands specifically,
            // which always use `orchestratorMember`.)
            roleMap: { '  Orchestrator  ': ['member-x'] },
        }, true);

        assert.strictEqual(result.status, 'success');

        const bdDispatches = spy.dispatchLog.filter((d) => d.command.startsWith('bd '));
        assert.ok(bdDispatches.length > 0, 'expected at least one `bd` command() dispatch');
        for (const { command, member_name } of bdDispatches) {
            assert.strictEqual(member_name, 'member-x', `expected command "${command}" to dispatch to 'member-x', got '${member_name}'`);
        }
    });

    test('roleMap: { orchestrator: [...] } (lowercase) is honored for orchestrator-side bd dispatch, with no ROLES/schema validation involved', async () => {
        const spy = buildSpyFleetApi();
        const workflow = new FleetWorkflow(spy);
        const engine = new WorkflowEngine(workflow);

        const result = await engine.executeFile(RUNNER_SCRIPT_PATH, {
            target_issue: 'bd-1',
            members: ['local', 'member-y'],
            branch: 'auto-sprint/rolemap-orchestrator-test',
            base_branch: 'main',
            max_cycles: 1,
            roleMap: { orchestrator: ['member-y'] },
        }, true);

        assert.strictEqual(result.status, 'success');

        const bdDispatches = spy.dispatchLog.filter((d) => d.command.startsWith('bd '));
        assert.ok(bdDispatches.length > 0, 'expected at least one `bd` command() dispatch');
        for (const { command, member_name } of bdDispatches) {
            assert.strictEqual(member_name, 'member-y', `expected command "${command}" to dispatch to 'member-y', got '${member_name}'`);
        }
        // 'orchestrator' must never surface as a dispatched agent role (it
        // has no vendor/apra-pm/agents/*.md definition/schema): confirm no
        // executePrompt() call ever used agent === 'orchestrator'.
        assert.ok(
            spy.promptLog.every((p) => p.agent !== 'orchestrator'),
            'orchestrator must never be dispatched as an agent (it is not a member of contracts.ROLES)'
        );
    });
});
