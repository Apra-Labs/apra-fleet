import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import {
    doltPushAfter,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

// A D-push whose execute_command hits the inactivity timeout must reach the
// D-push transient retry ladder through FleetWorkflow.command(), instead of
// being reported as a landed push. The fake fleet API returns the exact result
// shape the fleet server sends for an exec timeout (structuredContent.isError,
// reason 'timeout', exitCode -1) on the first push, then a clean exit 0.

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const TIMEOUT_TEXT = 'Failed to execute command on "m1": Command timed out after 600000ms of inactivity';

function fakeFleetApi({ pushResults }) {
    const pushes = [];
    return {
        pushes,
        async executePrompt() { throw new Error('not used'); },
        async executeCommand({ command }) {
            if (/dolt push/.test(command)) {
                pushes.push(command);
                const next = pushResults.length > 1 ? pushResults.shift() : pushResults[0];
                return next;
            }
            return { content: [{ type: 'text', text: 'Exit code: 0\n' }], structuredContent: { exitCode: 0, stdout: '', stderr: '' } };
        },
    };
}

const timeoutResult = {
    content: [{ type: 'text', text: TIMEOUT_TEXT }],
    structuredContent: { isError: true, reason: 'timeout', exitCode: -1, stdout: '', stderr: 'Command timed out after 600000ms of inactivity' },
};
const okResult = { content: [{ type: 'text', text: 'Exit code: 0\n' }], structuredContent: { exitCode: 0, stdout: '', stderr: '' } };

// The same timeout as an older server reported it: bare text, no structuredContent.
const legacyTimeoutResult = { content: [{ type: 'text', text: TIMEOUT_TEXT }] };

for (const [shape, first] of [['typed isError result', timeoutResult], ['legacy bare-text result', legacyTimeoutResult]]) test(`a timed-out D-push (${shape}) is retried by the transient ladder, then lands`, async () => {
    const api = fakeFleetApi({ pushResults: [first, okResult] });
    const wf = new FleetWorkflow(api);
    const ends = [];
    wf.on('activity:end', (m) => ends.push(m));
    const logs = [];
    const outcome = await doltPushAfter('m1', {
        command: (cmd, opts) => wf.command(cmd, opts),
        checkSyncRemoteConfigured: async () => true,
        log: (l) => logs.push(l),
        sleep: async () => {},
    });
    assert.ok(api.pushes.length >= 2, `expected a retry after the timeout, saw ${api.pushes.length} push attempt(s)`);
    assert.ok(logs.some((l) => /transient failure for member 'm1'.*retry 1\//.test(l) && /timed out/.test(l)), `no transient-retry log line:\n${logs.join('\n')}`);
    const pushEnds = ends.filter((e) => /dolt push/.test(e.command));
    assert.equal(pushEnds[0].success, false, 'the timed-out push activity must be recorded success:false');
    assert.equal(pushEnds.at(-1).success, true);
    assert.ok(outcome && outcome.pushed !== false, `expected the retried push to land, got ${JSON.stringify(outcome)}`);
});

test('a D-push that keeps timing out is never logged as landed', async () => {
    const api = fakeFleetApi({ pushResults: [timeoutResult] });
    const wf = new FleetWorkflow(api);
    const logs = [];
    await assert.rejects(() => doltPushAfter('m1', {
        command: (cmd, opts) => wf.command(cmd, opts),
        checkSyncRemoteConfigured: async () => true,
        log: (l) => logs.push(l),
        sleep: async () => {},
        maxTransientRetries: 2,
    }));
    assert.equal(api.pushes.length, 3, 'initial attempt plus two retries');
    assert.ok(!logs.some((l) => /landed/.test(l)), `a push that never landed was logged as landed:\n${logs.join('\n')}`);
});
