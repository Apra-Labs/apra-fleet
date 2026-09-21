import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, CommandError, MemberNotFoundError, FleetTransportError } from '../src/workflow/index.mjs';

// `opts.silent` on command() must suppress the `[Command API Error]` console
// line on the ERROR path exactly as it already suppresses the `[Command]`
// dispatch line on the success path -- and suppress NOTHING else.
//
// WHY this exists: some dispatches are deliberate probes whose failure IS the
// success case. beads-children.mjs's assertChildIdFree() runs `bd show <id>
// --json` to prove an id is free before `bd create --id`, and `bd` reports
// "free" by exiting non-zero. It passed `silent: true`, caught the error,
// classified it and proceeded -- and still printed a full error block per
// probe. A real sprint log carried four of them in finalization, about sixty
// lines above a genuine HTTP 401 that cost the run its pull request.
//
// The deliberate exception, pinned below: the member-not-found stopgap stays
// loud even under `silent`, because a missing member is a config fault no
// caller can have been "expecting".

const MEMBER = 'fleet-dev';

let logged;
let origError;
let origLog;

beforeEach(() => {
    logged = { error: [], log: [] };
    origError = console.error;
    origLog = console.log;
    console.error = (...args) => { logged.error.push(args.map(String).join(' ')); };
    console.log = (...args) => { logged.log.push(args.map(String).join(' ')); };
});

afterEach(() => {
    console.error = origError;
    console.log = origLog;
});

function makeApi(executeCommandImpl) {
    return {
        async executePrompt() { return { content: [{ text: 'unused' }] }; },
        executeCommand: executeCommandImpl,
    };
}

const failingApi = () => makeApi(async () => ({
    content: [{ text: '{"error": "no issues found matching the provided IDs"}' }],
    isError: false,
    structuredContent: { exitCode: 1, stdout: '{"error": "no issues found matching the provided IDs"}' },
}));

const transportFailApi = () => makeApi(async () => { throw new Error('socket hang up'); });

function hasCommandApiError() {
    return logged.error.some((line) => line.includes('[Command API Error]'));
}

describe('command() silent suppresses the [Command API Error] console line only', () => {
    test('silent: a failing command logs nothing but throws the identical typed error', async () => {
        const wf = new FleetWorkflow(failingApi());
        let silentErr = null;
        await assert.rejects(
            () => wf.command('bd show free-id --json', { member_name: MEMBER, silent: true }),
            (err) => { silentErr = err; return err instanceof CommandError; },
        );
        assert.strictEqual(hasCommandApiError(), false, 'silent must suppress [Command API Error]');
        assert.strictEqual(logged.log.some((l) => l.includes('[Command]')), false);

        // Same call without silent: same error shape, but the log is back.
        logged = { error: [], log: [] };
        const wf2 = new FleetWorkflow(failingApi());
        let loudErr = null;
        await assert.rejects(
            () => wf2.command('bd show free-id --json', { member_name: MEMBER }),
            (err) => { loudErr = err; return err instanceof CommandError; },
        );
        assert.strictEqual(hasCommandApiError(), true, 'without silent the error line must still print');

        assert.strictEqual(silentErr.message, loudErr.message);
        assert.strictEqual(silentErr.code, loudErr.code);
        assert.deepStrictEqual(silentErr.details, loudErr.details);
        assert.ok(silentErr.details.text.includes('no issues found'));
        assert.strictEqual(silentErr.details.exitCode, 1);
    });

    test('silent: a transport failure still throws FleetTransportError, unlogged', async () => {
        const wf = new FleetWorkflow(transportFailApi());
        await assert.rejects(
            () => wf.command('git status', { member_name: MEMBER, silent: true }),
            (err) => err instanceof FleetTransportError && err.message.includes('socket hang up'),
        );
        assert.strictEqual(hasCommandApiError(), false);
    });

    test('failSoft behaviour is unchanged in both modes', async () => {
        const wf = new FleetWorkflow(failingApi());
        const quiet = await wf.command('bd show free-id --json', { member_name: MEMBER, silent: true, failSoft: true });
        assert.strictEqual(quiet.ok, false);
        assert.strictEqual(quiet.output, '');
        assert.ok(quiet.error.includes('Exit code 1'));
        assert.strictEqual(hasCommandApiError(), false);

        logged = { error: [], log: [] };
        const wf2 = new FleetWorkflow(failingApi());
        const loud = await wf2.command('bd show free-id --json', { member_name: MEMBER, failSoft: true });
        assert.deepStrictEqual({ ok: loud.ok, output: loud.output }, { ok: false, output: '' });
        assert.strictEqual(loud.error, quiet.error);
        assert.strictEqual(hasCommandApiError(), true);
    });

    test('activity:end still emits with success:false in both modes', async () => {
        for (const silent of [true, false]) {
            logged = { error: [], log: [] };
            const wf = new FleetWorkflow(failingApi());
            const ends = [];
            wf.on('activity:end', (e) => ends.push(e));
            await assert.rejects(() => wf.command('bd show free-id --json', { member_name: MEMBER, silent }));
            assert.strictEqual(ends.length, 1, `expected one activity:end (silent=${silent})`);
            assert.strictEqual(ends[0].success, false);
            assert.ok(ends[0].error.includes('Exit code 1'));
            assert.strictEqual(hasCommandApiError(), !silent);
        }
    });

    test('member-not-found stays LOUD even under silent (config fault, never expected)', async () => {
        const api = makeApi(async () => ({ content: [{ text: 'Member "ghost" not found.' }] }));
        const wf = new FleetWorkflow(api);
        const ends = [];
        wf.on('activity:end', (e) => ends.push(e));
        await assert.rejects(
            () => wf.command('git status', { member_name: 'ghost', silent: true }),
            (err) => err instanceof MemberNotFoundError,
        );
        assert.strictEqual(hasCommandApiError(), true, 'member-not-found must log even when silent');
        assert.strictEqual(logged.error.filter((l) => l.includes('[Command API Error]')).length, 1,
            'exactly one line: the stopgap logs, the outer catch stays suppressed');
        assert.strictEqual(ends.length, 1);
        assert.strictEqual(ends[0].success, false);
    });

    test('member-not-found under silent + failSoft still logs and soft-fails', async () => {
        const api = makeApi(async () => ({ content: [{ text: 'Member "ghost" not found.' }] }));
        const wf = new FleetWorkflow(api);
        const res = await wf.command('git status', { member_name: 'ghost', silent: true, failSoft: true });
        assert.strictEqual(res.ok, false);
        assert.ok(res.error.includes('not found'));
        assert.strictEqual(hasCommandApiError(), true);
    });

    test('a silent command that SUCCEEDS is unaffected', async () => {
        const wf = new FleetWorkflow(makeApi(async () => ({
            content: [{ text: 'ok' }], isError: false, structuredContent: { exitCode: 0, stdout: 'ok' },
        })));
        const out = await wf.command('bd list', { member_name: MEMBER, silent: true });
        assert.strictEqual(out, 'ok');
        assert.strictEqual(hasCommandApiError(), false);
    });
});
