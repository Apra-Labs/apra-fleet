import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, CommandError } from '../src/workflow/index.mjs';

// command() must treat an execute_command call that never produced an exit
// code (exec inactivity timeout, transport failure) as a failure: a typed
// CommandError carrying the server's reason, ok:false under failSoft, and an
// activity:end with success:false. Before the fix the server returned a bare
// text for these, which command() reported as success.

const MEMBER = 'm1';
const TIMEOUT_TEXT = 'Failed to execute command on "m1": Command timed out after 600000ms of inactivity';
const TRANSPORT_TEXT = 'Failed to execute command on "m1": connect ECONNREFUSED 10.0.0.5:22';

function serverFailure(text, reason) {
    return {
        content: [{ type: 'text', text }],
        structuredContent: { isError: true, reason, exitCode: -1, stdout: '', stderr: text.split(': ').slice(1).join(': ') },
    };
}

function wfReturning(result) {
    return new FleetWorkflow({
        async executePrompt() { throw new Error('not used'); },
        async executeCommand() { return result; },
    });
}

const cases = [
    { name: 'inactivity timeout', result: serverFailure(TIMEOUT_TEXT, 'timeout'), reason: 'timeout', match: /timed out after 600000ms/ },
    { name: 'transport failure', result: serverFailure(TRANSPORT_TEXT, 'transport_error'), reason: 'transport_error', match: /ECONNREFUSED/ },
    // An older server sent the same text with no structuredContent at all.
    { name: 'unflagged timeout text from an older server', result: { content: [{ type: 'text', text: TIMEOUT_TEXT }] }, reason: 'unflagged_failure', match: /timed out/ },
];

describe('command(): exec timeout / transport failure is a typed failure', () => {
    for (const c of cases) {
        test(`${c.name}: throws CommandError with the reason, activity:end success:false`, async () => {
            const wf = wfReturning(c.result);
            const ends = [];
            wf.on('activity:end', (m) => ends.push(m));
            await assert.rejects(
                () => wf.command('bd dolt push', { member_name: MEMBER, silent: true }),
                (err) => {
                    assert.ok(err instanceof CommandError, `expected CommandError, got ${err && err.constructor && err.constructor.name}`);
                    assert.strictEqual(err.code, 'COMMAND_FAILED');
                    assert.strictEqual(err.details.reason, c.reason);
                    assert.match(err.message, c.match);
                    return true;
                },
            );
            assert.strictEqual(ends.length, 1);
            assert.strictEqual(ends[0].success, false);
            assert.match(String(ends[0].error), c.match);
        });

        test(`${c.name}: failSoft returns ok:false with the error message`, async () => {
            const wf = wfReturning(c.result);
            const ends = [];
            wf.on('activity:end', (m) => ends.push(m));
            const res = await wf.command('bd dolt push', { member_name: MEMBER, silent: true, failSoft: true });
            assert.strictEqual(res.ok, false);
            assert.match(res.error, c.match);
            assert.strictEqual(ends.length, 1);
            assert.strictEqual(ends[0].success, false);
        });
    }

    test('a command that exits 0 is unchanged', async () => {
        const wf = wfReturning({ content: [{ type: 'text', text: 'Exit code: 0\npushed' }], structuredContent: { exitCode: 0, stdout: 'pushed', stderr: '' } });
        const ends = [];
        wf.on('activity:end', (m) => ends.push(m));
        assert.strictEqual(await wf.command('bd dolt push', { member_name: MEMBER, silent: true }), 'pushed');
        assert.deepStrictEqual(await wf.command('bd dolt push', { member_name: MEMBER, silent: true, failSoft: true }), { ok: true, output: 'pushed', error: null });
        assert.deepStrictEqual(ends.map((e) => e.success), [true, true]);
    });
});
