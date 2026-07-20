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

// apra-fleet-eft.6.7: `allBeadsJson`/`readyJson`/`backlogJson` let a caller
// substitute the canned `bd list --all --limit 0 --json` / `--ready` /
// backlog-fetch responses (default: the existing single-level bd-1 ->
// bd-1-child fixture every other test in this suite already relies on),
// so a test can exercise a deeper hierarchy (e.g. a 3-level
// epic->feature->task tree) without duplicating the whole spy.
function buildSpyFleetApi(overrides = {}) {
    const {
        allBeadsJson = '[{"id":"bd-1-child","parent":"bd-1","status":"open","title":"Task"}]',
        readyJson = '[{"id":"bd-1-child","parent":"bd-1","status":"open","title":"Task"}]',
        backlogJson = null,
    } = overrides;

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

            // auto-sprint-3: bdListScoped now issues a project-wide
            // `bd list --all --limit 0 --json` first and computes scope via
            // an in-memory parent/child BFS from targetIssues -- it never
            // includes a target issue itself, only its descendants (same
            // semantics `bd list --parent <target>` always had). So this
            // canned bead must be a CHILD of 'bd-1' (the target used by
            // every test in this suite), not 'bd-1' itself, or it falls
            // outside scope and every downstream call sees nothing.
            if (/^bd list --all --limit 0 --json$/.test(opts.command)) {
                return mockCmdResult(0, allBeadsJson);
            }
            if (/^bd list .*--ready/.test(opts.command)) {
                // The first TWO ready-list calls return one bead so the
                // sprint can proceed; subsequent calls (post-doer) return
                // none so the develop loop and cycle loop both terminate
                // immediately. Two, not one: apra-fleet-xbu.C6 added an
                // early --ready fetch inside updateDashboard() (to annotate
                // the dashboard's per-bead ready/blocked badge) that now
                // runs once, unconditionally, before pre-sprint validation's
                // own initialBeads --ready check -- so the "give the bead
                // once" allowance has to cover both calls, or pre-sprint
                // validation sees an empty ready list on its very first
                // real check and hard-fails as if there were no work at all.
                const readyCallsSoFar = commandLog.filter((c) => /^bd list .*--ready/.test(c)).length;
                const alreadyReturnedReady = readyCallsSoFar > 2;
                return mockCmdResult(0, alreadyReturnedReady ? '[]' : readyJson);
            }
            // bdListScoped(rest)'s plain, non-empty-but-non---ready/--status
            // filterLabel branch (e.g. updateDashboard()'s
            // `bdListScoped('--json')` for sprintTasks): rest is truthy
            // ('--json'), so bdListScoped skips its cheap in-memory-only
            // path and issues a second project-wide `bd list --json --limit
            // 0` query, then intersects it with the structurally-discovered
            // scope. Mirror the same open-bead set as allBeadsJson so that
            // intersection is non-empty, same as a real `bd` would return.
            if (/^bd list --json --limit 0$/.test(opts.command)) {
                return mockCmdResult(0, allBeadsJson);
            }
            // updateDashboard()'s backlog panel fetch: project-wide,
            // status-only, no --parent scoping (see BACKLOG_STATUSES in
            // runner.js). Only intercepted when a test supplies backlogJson;
            // otherwise it falls through to the generic '[]' handler below,
            // same as every other `bd list` call.
            if (backlogJson !== null && /^bd list --status="open,deferred,blocked" --json$/.test(opts.command)) {
                return mockCmdResult(0, backlogJson);
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
        // apra-fleet-zzu: fetch + checkout are two sequential command()
        // calls (not one `a && b` shell string, which PowerShell 5.1
        // rejects) -- assert across the two now-separate entries.
        // auto-sprint-9: a THIRD command was added -- a failSoft fetch of
        // origin/<branch> itself, so real pushed sprint work is adopted
        // instead of always being force-reset to base. This spy's git/gh
        // interceptor succeeds for any command by default, so the fetch
        // "succeeds" here and the checkout adopts origin/<branch> as its
        // start point, not origin/<baseBranch>.
        assert.match(spy.commandLog[0], /^git fetch origin develop/);
        assert.match(spy.commandLog[1], /^git fetch origin auto-sprint\/reach-test\b/);
        assert.ok(spy.commandLog[2].includes('git checkout -B auto-sprint/reach-test origin/auto-sprint/reach-test'));
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
            // orchestrator-side BOOKKEEPING `bd` command (bd list/show/
            // update -- the orchestrator's own reads/writes, dispatched via
            // `orchestratorMember`) to 'member-x'. (git fetch/checkout
            // commands go to the UNION of orchestrator/doer/reviewer pools --
            // see runner.js's branchEnsureMembers/N4 -- so this asserts on
            // the `bd `-prefixed commands specifically.)
            //
            // `bd dolt pull`/`bd dolt push` are deliberately EXCLUDED here
            // (apra-fleet-eft.8.x/9.x, withGitSync()): those are per-member
            // beads-sync brackets around EACH DISPATCHED AGENT's own call
            // (planner/reviewer/deployer/etc.), not orchestrator bookkeeping
            // -- they correctly sync THAT agent's own member (here 'local',
            // since 'planner' etc. have no roleMap entry of their own and
            // fall back to the first physical member), never
            // `orchestratorMember`. Verified live: every non-dolt `bd `
            // command in this scenario dispatches to 'member-x' as expected;
            // only `bd dolt pull`/`bd dolt push` legitimately go to 'local'.
            roleMap: { '  Orchestrator  ': ['member-x'] },
        }, true);

        assert.strictEqual(result.status, 'success');

        // `bd config get sync.remote` is part of the same per-member D-push
        // bracket (the Issue 31 pre-gate reads the BRACKET member's own
        // sync.remote before deciding whether to push), so it is excluded
        // alongside `bd dolt *` for the same reason.
        const bdDispatches = spy.dispatchLog.filter((d) => d.command.startsWith('bd ')
            && !d.command.startsWith('bd dolt') && !d.command.startsWith('bd config get sync.remote'));
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

        // `bd dolt pull`/`bd dolt push` excluded -- see the detailed comment
        // in the mixed-case roleMap test above: those are per-member
        // beads-sync brackets around each dispatched agent's own call, not
        // orchestrator bookkeeping, and correctly use that agent's own
        // member rather than `orchestratorMember`.
        // `bd config get sync.remote` excluded like `bd dolt *` -- part of
        // the per-member D-push bracket (Issue 31 pre-gate), see above.
        const bdDispatches = spy.dispatchLog.filter((d) => d.command.startsWith('bd ')
            && !d.command.startsWith('bd dolt') && !d.command.startsWith('bd config get sync.remote'));
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

    // -------------------------------------------------------------------
    // apra-fleet-eft.6.7: bdListScoped()'s BFS (auto-sprint-3) must recurse
    // through every level of the sprint's target tree, not just one -- and
    // updateDashboard()'s sprintTasks/backlogTasks split (built on top of
    // bdListScoped) must reflect that: a leaf TASK two levels below the
    // sprint's epic (epic -> feature -> task) belongs under Sprint, never
    // Backlog, even though the dashboard's separate backlog fetch is
    // project-wide and would otherwise see it too.
    // -------------------------------------------------------------------

    test('a grandchild task two levels below the sprint epic renders under Sprint (sprintTasks), never Backlog', async () => {
        const spy = buildSpyFleetApi({
            // bd-1 is the sprint's target epic (never itself returned by
            // `bd list --all`'s BFS -- see the comment above); feat-1 is its
            // direct feature child; task-1 is feat-1's own task child, i.e.
            // a grandchild of bd-1 -- exactly the depth a single-level
            // `bd list --parent` cannot see.
            allBeadsJson: JSON.stringify([
                { id: 'feat-1', parent: 'bd-1', status: 'open', title: 'Feature' },
                { id: 'task-1', parent: 'feat-1', status: 'open', title: 'Task' },
            ]),
            readyJson: JSON.stringify([
                { id: 'task-1', parent: 'feat-1', status: 'open', title: 'Task' },
            ]),
            // The dashboard's backlog fetch has no --parent scoping, so a
            // real bd would return task-1 here too -- return it alongside a
            // genuinely unrelated backlog bead so the assertion below
            // actually exercises updateDashboard()'s sprintIds subtraction,
            // not just an absence in the canned data.
            backlogJson: JSON.stringify([
                { id: 'task-1', parent: 'feat-1', status: 'open', title: 'Task' },
                { id: 'unrelated-1', status: 'open', title: 'Unrelated backlog item' },
            ]),
        });
        const workflow = new FleetWorkflow(spy);
        const publishedStates = [];
        workflow.on('state', (evt) => publishedStates.push(evt));
        const engine = new WorkflowEngine(workflow);

        const result = await engine.executeFile(RUNNER_SCRIPT_PATH, {
            target_issue: 'bd-1',
            members: ['local'],
            branch: 'auto-sprint/dashboard-grandchild-test',
            base_branch: 'main',
            max_cycles: 1,
        }, true);

        assert.strictEqual(result.status, 'success');

        const beadsStates = publishedStates.filter((e) => e.namespace === 'beads');
        assert.ok(beadsStates.length > 0, 'expected at least one publishState("beads", ...) call');
        const lastBeads = beadsStates[beadsStates.length - 1];

        const sprintIds = lastBeads.data.sprintTasks.map((t) => t.id);
        const backlogIds = lastBeads.data.backlogTasks.map((t) => t.id);

        assert.ok(sprintIds.includes('task-1'), `expected grandchild task-1 in sprintTasks, got: ${JSON.stringify(sprintIds)}`);
        assert.ok(!backlogIds.includes('task-1'), `expected grandchild task-1 NOT in backlogTasks, got: ${JSON.stringify(backlogIds)}`);
        assert.ok(backlogIds.includes('unrelated-1'), 'expected an unrelated backlog bead to remain classified as backlog');
    });
});
