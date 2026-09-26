import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    createDeployPermissionsProvisioner,
    parseRunbookPermissions,
    RUNBOOK_BY_ROLE,
} from '../fleet-sprint/member-provisioning.mjs';
import { RunbookPermissionsError, RUNBOOK_PERMISSIONS_FAILURE_REASONS } from '../fleet-sprint/errors.mjs';
import { runDeployPhase } from '../fleet-sprint/phases/deploy.mjs';
import { runIntegTestPhase } from '../fleet-sprint/phases/integ-test.mjs';
import { runRegressionTestPhase } from '../fleet-sprint/phases/regression-test.mjs';
import { findShellCommandViolations } from '../fleet-sprint/shell-command-guard.mjs';
import { CancelledError, BudgetExceededError } from '@apralabs/apra-fleet-workflow';

// apra-fleet-v6t7.12 -- the runbook-permissions provisioner. Before each
// deployer / integ-test-runner / regression-test-runner dispatch the engine
// must grant the Permissions entries of THAT role's own runbook, and fail
// loudly (never log-and-continue) when compose_permissions cannot grant one.

// compose_permissions' status glyphs, built from code points so this file stays ASCII.
const OK_MARK = String.fromCodePoint(0x2705);
const FAIL_MARK = String.fromCodePoint(0x274c);

const RUNBOOKS = {
    'deploy.md': [
        '# Deploy',
        '',
        '## Permissions',
        '',
        'Commands below require these prefixes:',
        '- `Bash(npm ci)`',
        '- `Bash(npm run build)` -- the build step, see `## Deploy`.',
        '  continuation prose with `Bash(not-an-entry *)` stays prose.',
        '',
        '## Deploy',
        '- `Bash(outside-the-section *)`',
    ].join('\n'),
    'integ-test-playbook.md': [
        '# Integ',
        '',
        '## Permissions',
        '',
        '- `curl ...` (e.g. `Bash(curl *)`) -- drives an HTTP API',
        '- `npm test ...` (e.g. `Bash(npm test*)`)',
        '- a bullet with no permission-shaped token at all: `just prose`',
        '',
        '## Setup',
    ].join('\r\n'),
    'regression-test-playbook.md': [
        '# Regression',
        '',
        '## Permissions',
        '',
        '- `Bash(kill:*)` -- supervisor stop steps.',
        '- `Bash(mkdir *)`',
        '- `Bash(node:*)`',
    ].join('\n'),
};

const EXPECTED = {
    'deploy.md': ['Bash(npm ci)', 'Bash(npm run build)'],
    'integ-test-playbook.md': ['Bash(curl *)', 'Bash(npm test*)'],
    'regression-test-playbook.md': ['Bash(kill:*)', 'Bash(mkdir *)', 'Bash(node:*)'],
};

/** Decodes the runbook file name the member-side reader was asked for. */
function requestedFile(cmd) {
    const m = /"([A-Za-z0-9+/=]+)"\s*$/.exec(cmd);
    assert.ok(m, `reader command carries a base64 argv token: ${cmd}`);
    return Buffer.from(m[1], 'base64').toString('utf8');
}

function makeFakes({ files = RUNBOOKS, composeReply } = {}) {
    const commands = [];
    const toolCalls = [];
    const command = async (cmd, opts) => {
        commands.push({ cmd, opts, file: requestedFile(cmd) });
        const text = files[requestedFile(cmd)];
        return { ok: true, output: text ?? '' };
    };
    const callTool = async (name, args) => {
        toolCalls.push({ name, args });
        if (composeReply) return composeReply(name, args);
        return { content: [{ type: 'text', text: `${OK_MARK} Granted ${args.grant.length} permissions on "${args.member_name}" (claude):\n  ${args.grant.join('\n  ')}` }] };
    };
    return { commands, toolCalls, command, callTool };
}

describe('parseRunbookPermissions', () => {
    test('takes the first permission-shaped token per top-level bullet, section-scoped', () => {
        for (const [file, text] of Object.entries(RUNBOOKS)) {
            assert.deepStrictEqual(parseRunbookPermissions(text), EXPECTED[file], file);
        }
    });

    test('a runbook without a Permissions section yields no entries', () => {
        assert.deepStrictEqual(parseRunbookPermissions('# Deploy\n\n## Deploy\n- `Bash(npm ci)`\n'), []);
        assert.deepStrictEqual(parseRunbookPermissions(''), []);
    });
});

describe('createDeployPermissionsProvisioner -- per-role runbook', () => {
    for (const [role, runbook] of Object.entries(RUNBOOK_BY_ROLE)) {
        test(`${role} is provisioned from ${runbook}'s own Permissions section`, async () => {
            const fakes = makeFakes();
            const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
            await ensure('m1', role);

            assert.strictEqual(fakes.commands.length, 1);
            assert.strictEqual(fakes.commands[0].file, runbook);
            assert.strictEqual(fakes.commands[0].opts.member_name, 'm1');
            assert.strictEqual(fakes.toolCalls.length, 1);
            assert.strictEqual(fakes.toolCalls[0].name, 'compose_permissions');
            assert.strictEqual(fakes.toolCalls[0].args.member_name, 'm1');
            assert.deepStrictEqual(fakes.toolCalls[0].args.grant, EXPECTED[runbook]);
        });
    }

    test('one member playing all three roles receives every runbook, each exactly once', async () => {
        const fakes = makeFakes();
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        for (let cycle = 0; cycle < 2; cycle++) {
            for (const role of Object.keys(RUNBOOK_BY_ROLE)) await ensure('solo', role);
        }
        assert.deepStrictEqual(fakes.commands.map(c => c.file), Object.values(RUNBOOK_BY_ROLE));
        // Cumulative: a provider whose grant mode REPLACES the allow list must
        // not lose an earlier runbook's entries to a later runbook's grant.
        const [d, i, r] = Object.values(RUNBOOK_BY_ROLE).map(rb => EXPECTED[rb]);
        assert.deepStrictEqual(fakes.toolCalls.map(c => c.args.grant), [d, [...d, ...i], [...d, ...i, ...r]]);
    });

    test('grants to one member never carry over to another member', async () => {
        const fakes = makeFakes();
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await ensure('a', 'deployer');
        await ensure('b', 'integ-test-runner');
        assert.deepStrictEqual(fakes.toolCalls.map(c => [c.args.member_name, c.args.grant]), [
            ['a', EXPECTED['deploy.md']],
            ['b', EXPECTED['integ-test-playbook.md']],
        ]);
    });

    test('an unknown role is refused rather than guessed', async () => {
        const fakes = makeFakes();
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await assert.rejects(() => ensure('m1', 'doer'), TypeError);
        await assert.rejects(() => ensure('m1'), TypeError);
        assert.strictEqual(fakes.commands.length, 0);
    });

    test('the member-bound reader command is shell-agnostic', async () => {
        const fakes = makeFakes();
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await ensure('m1', 'regression-test-runner');
        const cmd = fakes.commands[0].cmd;
        assert.ok(!/[$`%~]/.test(cmd), `no $, backtick, % or ~ in the member-bound command: ${cmd}`);
        assert.ok(!cmd.includes('regression-test-playbook.md'), 'the file name travels base64-encoded, not inline');
        assert.deepStrictEqual(findShellCommandViolations(`command(\`${cmd.replace(/\\/g, '\\\\')}\`, { member_name: m });`), []);
    });
});

describe('createDeployPermissionsProvisioner -- no-op cases', () => {
    test('a runbook without a Permissions section is a no-op (no compose_permissions call)', async () => {
        const fakes = makeFakes({ files: { 'deploy.md': '# Deploy\n\n## Deploy\n- `Bash(npm ci)`\n' } });
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await ensure('m1', 'deployer');
        await ensure('m1', 'deployer');
        assert.strictEqual(fakes.toolCalls.length, 0);
        assert.strictEqual(fakes.commands.length, 1, 'parsed once per runbook, not re-read');
    });

    test('an absent runbook is a no-op', async () => {
        const fakes = makeFakes({ files: {} });
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await ensure('m1', 'integ-test-runner');
        assert.strictEqual(fakes.toolCalls.length, 0);
    });
});

describe('createDeployPermissionsProvisioner -- loud failure', () => {
    test('a denylist rejection throws RunbookPermissionsError naming the runbook and the refused entry', async () => {
        const logs = [];
        const fakes = makeFakes({
            files: { 'integ-test-playbook.md': '## Permissions\n- `Bash(npm test*)`\n- `Bash(curl * localhost:9001/api/x)`\n' },
            // Mirrors compose_permissions: a batch containing a refused entry is
            // refused as a whole; a batch of grantable entries succeeds.
            composeReply: (_name, args) => (args.grant.some(g => g.startsWith('Bash(curl'))
                ? { content: [{ type: 'text', text: `${FAIL_MARK} Cannot auto-grant dangerous permissions: Bash(curl * localhost:9001/api/x). Escalate to user.` }] }
                : { content: [{ type: 'text', text: `${OK_MARK} Granted ${args.grant.length} permissions` }] }),
        });
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command, log: (l) => logs.push(l) });
        await assert.rejects(
            () => ensure('m1', 'integ-test-runner'),
            (err) => {
                assert.ok(err instanceof RunbookPermissionsError, `expected RunbookPermissionsError, got ${err?.name}: ${err?.message}`);
                assert.strictEqual(err.reason, RUNBOOK_PERMISSIONS_FAILURE_REASONS.GRANT_FAILED);
                assert.strictEqual(err.runbook, 'integ-test-playbook.md');
                assert.strictEqual(err.member, 'm1');
                assert.deepStrictEqual(err.entries, ['Bash(curl * localhost:9001/api/x)']);
                assert.match(err.message, /integ-test-playbook\.md/);
                assert.match(err.message, /Bash\(curl \* localhost:9001\/api\/x\)/);
                assert.ok(!/[^\x00-\x7F]/.test(err.message), 'surfaced message stays ASCII');
                return true;
            },
        );
        // The failing batch, then each entry on its own to pin the refused one.
        assert.deepStrictEqual(fakes.toolCalls.map(c => c.args.grant), [
            ['Bash(npm test*)', 'Bash(curl * localhost:9001/api/x)'],
            ['Bash(npm test*)'],
            ['Bash(curl * localhost:9001/api/x)'],
        ]);
        // Not recorded as provisioned: the next dispatch attempt re-checks.
        await assert.rejects(() => ensure('m1', 'integ-test-runner'), RunbookPermissionsError);
        assert.strictEqual(fakes.toolCalls.length, 6);
    });

    test('a thrown compose_permissions call is surfaced, not swallowed', async () => {
        const fakes = makeFakes({ composeReply: () => { throw new Error('fleet unreachable'); } });
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        await assert.rejects(
            () => ensure('m1', 'regression-test-runner'),
            (err) => err instanceof RunbookPermissionsError
                && err.reason === RUNBOOK_PERMISSIONS_FAILURE_REASONS.GRANT_FAILED
                && err.runbook === 'regression-test-playbook.md'
                && /fleet unreachable/.test(err.message)
                && err.entries.includes('Bash(kill:*)'),
        );
    });

    test('an isError / persist-failure result is surfaced, not swallowed', async () => {
        for (const reply of [
            { isError: true, content: [{ type: 'text', text: 'boom' }] },
            { content: [{ type: 'text', text: `${FAIL_MARK} Failed to persist permissions to .claude/settings.local.json on "m1" (claude): write failed` }] },
            { content: [{ type: 'text', text: 'Member "m1" not found.' }] },
        ]) {
            const fakes = makeFakes({ composeReply: () => reply });
            const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
            await assert.rejects(() => ensure('m1', 'deployer'), (err) =>
                err instanceof RunbookPermissionsError
                && err.reason === RUNBOOK_PERMISSIONS_FAILURE_REASONS.GRANT_FAILED
                && err.runbook === 'deploy.md');
        }
    });

    test('a failed runbook read is surfaced, not treated as "no permissions"', async () => {
        const ensure = createDeployPermissionsProvisioner({
            callTool: async () => { throw new Error('must not be called'); },
            command: async () => ({ ok: false, output: 'ssh: connection refused' }),
        });
        await assert.rejects(() => ensure('m1', 'deployer'), (err) =>
            err instanceof RunbookPermissionsError
            && err.reason === RUNBOOK_PERMISSIONS_FAILURE_REASONS.READ_FAILED
            && err.runbook === 'deploy.md'
            && /connection refused/.test(err.message));
    });
});

// The phase modules must each hand the provisioner their OWN role, so a phase
// wired to the wrong runbook goes red here rather than only in a live sprint.
// The fake provisioner records the call and then throws a sentinel, which both
// stops the phase before any dispatch and shows what the phase does with a
// provisioning failure. Deploy and integ let it propagate (loud, pre-dispatch).
// Regression must NOT: it runs after the verdict is decided and must never
// abort the sprint, so it degrades to a FAILED report instead -- see below.
function phaseState(extra, { dispatched, calls, ensureDeployPermissions, dashboards = [] }) {
    return {
        ...extra,
        phase: () => {},
        log: () => {},
        command: async () => { dispatched.push('command'); return { ok: true, output: '' }; },
        dispatchCtx: new Proxy({}, { get: () => () => { dispatched.push('dispatch'); } }),
        getMemberForRole: (r) => `member-for-${r}`,
        ensureUnattendedAuto: async () => {},
        ensureDeployPermissions: async (member, r) => { calls.push([member, r]); return ensureDeployPermissions(member, r); },
        updateDashboard: async () => { dashboards.push('update'); },
    };
}

describe('phase wiring -- each runbook-driven phase provisions its own role before dispatch', () => {
    const SENTINEL = new Error('provisioning sentinel');
    const cases = [
        ['deployer', runDeployPhase, { cycle: 1, deployFailures: [], deployedThisCycle: false }],
        ['integ-test-runner', runIntegTestPhase, { cycle: 1 }],
    ];
    for (const [role, runPhase, extra] of cases) {
        test(`${role} phase`, async () => {
            const calls = [];
            const dispatched = [];
            await assert.rejects(
                () => runPhase(phaseState(extra, { dispatched, calls, ensureDeployPermissions: async () => { throw SENTINEL; } })),
                (err) => err === SENTINEL,
            );
            assert.deepStrictEqual(calls, [[`member-for-${role}`, role]]);
            assert.deepStrictEqual(dispatched, [], 'nothing dispatched after a provisioning failure');
        });
    }

    test('regression-test-runner phase provisions its own role and DEGRADES on failure, never propagating', async () => {
        const calls = [];
        const dispatched = [];
        const dashboards = [];
        const { regressionResult } = await runRegressionTestPhase(phaseState(
            { finalCycleLabel: '1', regressionResult: null },
            { dispatched, calls, dashboards, ensureDeployPermissions: async () => { throw SENTINEL; } },
        ));
        assert.deepStrictEqual(calls, [['member-for-regression-test-runner', 'regression-test-runner']]);
        assert.deepStrictEqual(dispatched, [], 'nothing dispatched after a provisioning failure');
        assert.strictEqual(regressionResult.passed, false);
        assert.match(regressionResult.summary, /provisioning sentinel/);
        assert.deepStrictEqual(dashboards, ['update']);
    });
});

// A provisioning failure in the regression phase must surface loudly (a FAILED
// report naming the runbook and the refused entry) without aborting a sprint
// whose verdict is already decided. Driven through the REAL provisioner with a
// compose_permissions fake that refuses one entry.
describe('regression phase -- a runbook-permissions refusal degrades, it does not abort', () => {
    test('a refused regression-playbook entry yields a FAILED, schema-shaped report naming runbook and entry', async () => {
        const refused = 'Bash(kill:*)';
        const fakes = makeFakes({
            composeReply: (name, args) => ({
                content: [{ type: 'text', text: args.grant.includes(refused)
                    ? `${FAIL_MARK} Refused to auto-grant ${refused} on "${args.member_name}": matches the never-auto-grant list`
                    : `${OK_MARK} Granted ${args.grant.length} permissions on "${args.member_name}" (claude)` }],
            }),
        });
        const ensure = createDeployPermissionsProvisioner({ callTool: fakes.callTool, command: fakes.command });
        const calls = [];
        const dispatched = [];
        const logs = [];
        const state = phaseState({ finalCycleLabel: '1', regressionResult: null }, { dispatched, calls, ensureDeployPermissions: ensure });
        state.log = (m) => logs.push(m);

        const { regressionResult } = await runRegressionTestPhase(state);

        assert.deepStrictEqual(dispatched, [], 'the runner is not dispatched onto a member missing its grants');
        for (const field of ['passed', 'suitePassed', 'smokePassed', 'bugsFiled', 'summary']) {
            assert.ok(Object.prototype.hasOwnProperty.call(regressionResult, field), `regressionReport field ${field}`);
        }
        assert.strictEqual(regressionResult.passed, false);
        assert.match(regressionResult.summary, /regression-test-playbook\.md/);
        assert.ok(regressionResult.summary.includes(refused), regressionResult.summary);
        assert.match(regressionResult.summary, /NOT RUN/);
        assert.ok(logs.some((l) => l.includes('Regression pass reported FAILURES') && l.includes(refused)),
            `the failure must be logged loudly, got: ${JSON.stringify(logs)}`);
    });

    test('run-level control signals still propagate out of the regression provisioning step', async () => {
        for (const err of [new CancelledError('operator cancelled'), new BudgetExceededError('spend ceiling reached')]) {
            const calls = [];
            const dispatched = [];
            await assert.rejects(
                () => runRegressionTestPhase(phaseState(
                    { finalCycleLabel: '1', regressionResult: null },
                    { dispatched, calls, ensureDeployPermissions: async () => { throw err; } },
                )),
                (thrown) => thrown === err,
            );
            assert.deepStrictEqual(dispatched, []);
        }
    });
});
