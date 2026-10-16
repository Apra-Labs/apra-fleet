import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// End-to-end pin for the false "D-push landed" bug. A post-dispatch D-push
// whose execute_command timed out, failed at the transport, or exited 0
// without moving the shared remote used to be recorded success:true and
// logged "D-push ... landed".
//
// Drives the real sprint engine (runner.js -> withGitSync -> DoltSync D-push
// -> FleetWorkflow.command()) over the mock fleet API. Every D-push command is
// answered by `onCommand` against a tiny model of ONE shared Dolt remote
// (refs/dolt/data), with a git-transport sync.remote so the D-pull fingerprint
// and the D-push landed check both run:
//   (a) the first push answers with the fleet server's inactivity-timeout
//       result, (b) with its transport-failure result, (c) every push exits
//       0 but the remote tip never moves while the clone keeps unpushed
//       changes. Plus the normal case: every push moves the tip.
// The D-pull before the first dispatch records a remote-tip fingerprint, so a
// push the engine believes landed logs the "landed" line -- that line is the
// observable this file pins.
// =============================================================================

const SYNC_REMOTE = 'git+https://example.invalid/org/beads.git';
const LS_REMOTE_RE = / ls-remote https:\/\/example\.invalid\/org\/beads\.git refs\/dolt\/data$/;
const LANDED_RE = /D-push for member 'local' landed/;

const exit0 = (stdout = '') => ({
    content: [{ type: 'text', text: `Exit code: 0\n${stdout}` }],
    structuredContent: { exitCode: 0, stdout, stderr: '' },
});
// The exact result shapes src/tools/execute-command.ts returns when the exec
// never produced an exit code.
const TIMEOUT_RESULT = {
    content: [{ type: 'text', text: 'Failed to execute command on "local": Command timed out after 600000ms of inactivity' }],
    structuredContent: { isError: true, reason: 'timeout', exitCode: -1, stdout: '', stderr: 'Command timed out after 600000ms of inactivity' },
};
// What the fleet server returned for the same timeout BEFORE the fix: bare
// text, no isError, no structuredContent -- the shape that was read as
// success. command() must still treat it as a failure (older servers).
const LEGACY_TIMEOUT_RESULT = {
    content: [{ type: 'text', text: 'Failed to execute command on "local": Command timed out after 600000ms of inactivity' }],
};
const TRANSPORT_RESULT = {
    content: [{ type: 'text', text: 'Failed to execute command on "local": connect ECONNREFUSED 10.0.0.5:22' }],
    structuredContent: { isError: true, reason: 'transport_error', exitCode: -1, stdout: '', stderr: 'connect ECONNREFUSED 10.0.0.5:22' },
};

/**
 * onCommand over one shared Dolt remote. `push(n)` answers the n-th
 * `bd dolt push` with `{ result, moves }`: the execute_command result, and
 * whether that push advances refs/dolt/data.
 */
function sharedDoltRemote(push) {
    const state = { tip: 'a'.repeat(40), pushes: 0, minted: 0 };
    const onCommand = ({ command }) => {
        if (/^bd config get sync\.remote/.test(command)) return exit0(JSON.stringify({ key: 'sync.remote', value: SYNC_REMOTE }));
        if (LS_REMOTE_RE.test(command)) return exit0(`${state.tip}\trefs/dolt/data\n`);
        if (command === 'bd dolt pull') return exit0('Pull complete.\n');
        if (command === 'bd vc status --json') return exit0(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
        if (command === 'bd diff remotes/origin/main main --json') return exit0(JSON.stringify([{ IssueID: 'mock-1', DiffType: 'modified' }]));
        if (command === 'bd dolt push') {
            state.pushes += 1;
            const { result, moves } = push(state.pushes);
            if (moves) {
                state.minted += 1;
                state.tip = String(state.minted).padStart(40, '0');
            }
            return result;
        }
        return undefined;
    };
    return { state, onCommand };
}

async function runScenario(tag, push) {
    const remote = sharedDoltRemote(push);
    const activityEnds = [];
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: `Task: ${tag} D-push false-success scenario work` }],
        maxCycles: 1,
        onCommand: remote.onCommand,
        activityEnds,
    });
    const pushEnds = activityEnds.filter((e) => e.command === 'bd dolt push');
    return { scenario, remote, pushEnds };
}

const indexOf = (logs, re) => logs.findIndex((l) => re.test(l));

test('normal: a push that moves the remote logs landed and reports success', { timeout: 180000 }, async () => {
    await withScenarioMarkers('dpushok', async () => {
        const { scenario, remote, pushEnds } = await runScenario('dpushok', () => ({ result: exit0('Push complete.\n'), moves: true }));
        assert.equal(scenario.error, null, `sprint failed: ${scenario.error && scenario.error.message}`);
        assert.ok(remote.state.pushes >= 1);
        assert.ok(pushEnds.length >= 1 && pushEnds.every((e) => e.success === true));
        assert.ok(scenario.logs.some((l) => LANDED_RE.test(l)), `expected a landed line:\n${scenario.logs.join('\n')}`);
    });
});

for (const [name, tag, failure, retryRe] of [
    ['(a) inactivity timeout', 'dpushtimeout', TIMEOUT_RESULT, /transient failure for member 'local' \(D-push for 'local'\); retry 1\//],
    ['(a-legacy) inactivity timeout, pre-fix server shape', 'dpushtimeoutlegacy', LEGACY_TIMEOUT_RESULT, /transient failure for member 'local' \(D-push for 'local'\); retry 1\//],
    ['(b) transport failure', 'dpushtransport', TRANSPORT_RESULT, /D-push for 'local'.*(retry|self-heal)/],
]) {
    test(`${name}: the failed push is recorded success:false, never logged as landed, and the sync is retried`, { timeout: 180000 }, async () => {
        await withScenarioMarkers(tag, async () => {
            const { scenario, remote, pushEnds } = await runScenario(tag, (n) => (n === 1
                ? { result: failure, moves: false }
                : { result: exit0('Push complete.\n'), moves: true }));
            assert.equal(scenario.error, null, `the retried push should let the sprint finish: ${scenario.error && scenario.error.message}`);
            assert.equal(pushEnds[0].success, false, 'the failed push activity must be recorded success:false');
            assert.match(String(pushEnds[0].error), /Failed to execute command on "local"/);
            assert.ok(remote.state.pushes >= 2, `expected the push to be retried, saw ${remote.state.pushes} push(es)`);
            const retryAt = indexOf(scenario.logs, retryRe);
            assert.ok(retryAt >= 0, `no retry log line:\n${scenario.logs.join('\n')}`);
            const firstLanded = indexOf(scenario.logs, LANDED_RE);
            assert.ok(firstLanded === -1 || firstLanded > retryAt, `a landed line was logged for the failed push (before its retry):\n${scenario.logs.join('\n')}`);
        });
    });
}

test('(c) exit 0 but the remote tip never moves: no landed line, the push is reported failed', { timeout: 180000 }, async () => {
    await withScenarioMarkers('dpushunlanded', async () => {
        const { scenario, remote } = await runScenario('dpushunlanded', () => ({ result: exit0('Push complete.\n'), moves: false }));
        assert.ok(scenario.error, 'the sprint must surface the unlanded push, not report success');
        assert.match(String(scenario.error.message), /did not land on the remote/);
        assert.ok(remote.state.pushes >= 2, 'the unlanded push is retried before it is reported');
        assert.ok(!scenario.logs.some((l) => LANDED_RE.test(l)), `an unlanded push was logged as landed:\n${scenario.logs.join('\n')}`);
        assert.ok(scenario.logs.some((l) => /reported success but the push did NOT land/.test(l)));
    });
});
