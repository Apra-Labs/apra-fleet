// A Windows member's `bd dolt pull`/`bd dolt push` runs bd with a bounded
// GOMAXPROCS (bd's embedded Dolt otherwise starts one git.exe per remote chunk
// at once and Windows refuses the burst with ERROR_NOT_ENOUGH_MEMORY), built
// in JS per member shell; linux/macOS strings stay byte-identical. A sync that
// still ends on the Windows process-creation limit after its retry budget
// raises a typed error, not a generic sync failure. No Windows host needed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { bdSyncCommandFor, WINDOWS_BD_GOMAXPROCS } from '../fleet-sprint/bd-sync-command.mjs';
import {
    doltPullBefore,
    doltPushAfter,
    setMemberTargetResolver,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    WINDOWS_SPAWN_LIMIT_REMEDY,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltWindowsSpawnLimitError, DoltSyncError, DOLT_WINDOWS_SPAWN_LIMIT_CODE } from '../fleet-sprint/errors.mjs';

// Exact strings per member OS/shell.
const EXPECTED = [
    { name: 'linux', target: { os: 'linux', shell: '' }, pull: 'bd dolt pull', push: 'bd dolt push' },
    { name: 'macOS', target: { os: 'darwin', shell: '' }, pull: 'bd dolt pull', push: 'bd dolt push' },
    { name: 'Windows PowerShell (no shell recorded)', target: { os: 'windows', shell: '' }, pull: "$env:GOMAXPROCS='1'; bd dolt pull", push: "$env:GOMAXPROCS='1'; bd dolt push" },
    { name: 'Windows PowerShell 5', target: { os: 'windows', shell: 'powershell5' }, pull: "$env:GOMAXPROCS='1'; bd dolt pull", push: "$env:GOMAXPROCS='1'; bd dolt push" },
    { name: 'Windows pwsh 7', target: { os: 'windows', shell: 'pwsh7' }, pull: "$env:GOMAXPROCS='1'; bd dolt pull", push: "$env:GOMAXPROCS='1'; bd dolt push" },
    { name: 'Windows Git Bash', target: { os: 'windows', shell: 'gitbash' }, pull: 'GOMAXPROCS=1 bd dolt pull', push: 'GOMAXPROCS=1 bd dolt push' },
];

/** A `$` anywhere other than the PowerShell GOMAXPROCS assignment would be a shell expansion. */
function assertNoShellExpansion(cmd) {
    const withoutAssignment = cmd.replace(/^\$env:GOMAXPROCS='\d+'; /, '');
    assert.doesNotMatch(withoutAssignment, /\$|`|%[A-Za-z_]+%/, `member-bound command must not read a variable: ${cmd}`);
}

const SYNC_REMOTE = 'git+https://example.com/org/repo.git';

/** Records every command; answers the sync.remote probe; `syncResult` decides bd dolt pull/push. */
function recordingCommand(syncResult = () => ({ ok: true, output: '', error: null })) {
    const calls = [];
    let pushed = 0;
    const command = async (cmd, opts) => {
        calls.push({ cmd, member: opts && opts.member_name });
        if (cmd.includes('bd config get sync.remote')) {
            return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
        }
        // The D-push landed check reads refs/dolt/data before and after the
        // push: report a tip that moves once a push has succeeded.
        if (cmd.includes('ls-remote')) {
            return { ok: true, output: `${(pushed > 0 ? 'b' : 'a').repeat(40)}	refs/dolt/data
`, error: null };
        }
        if (/bd dolt (pull|push)$/.test(cmd)) {
            const res = syncResult(cmd);
            if (res.ok && cmd.endsWith('push')) pushed += 1;
            return res;
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls, syncCalls: () => calls.filter((c) => /bd dolt (pull|push)$/.test(c.cmd)).map((c) => c.cmd) };
}

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    setMemberTargetResolver(null);
});
afterEach(() => setMemberTargetResolver(null));

describe('bdSyncCommandFor: exact command strings per member OS/shell', () => {
    for (const row of EXPECTED) {
        test(row.name, () => {
            assert.strictEqual(bdSyncCommandFor('bd dolt pull', row.target), row.pull);
            assert.strictEqual(bdSyncCommandFor('bd dolt push', row.target), row.push);
            assertNoShellExpansion(row.pull);
            assertNoShellExpansion(row.push);
        });
    }

    test('a Node platform string (win32) is a Windows member; an unresolved member is POSIX', () => {
        assert.strictEqual(bdSyncCommandFor('bd dolt push', { os: 'win32', shell: '' }), "$env:GOMAXPROCS='1'; bd dolt push");
        assert.strictEqual(bdSyncCommandFor('bd dolt push', null), 'bd dolt push');
        assert.strictEqual(bdSyncCommandFor('bd dolt push', { os: '', shell: '' }), 'bd dolt push');
        assert.strictEqual(WINDOWS_BD_GOMAXPROCS, '1');
    });
});

describe('D-pull / D-push issue the per-OS strings', () => {
    for (const row of EXPECTED) {
        test(`${row.name}: D-pull and D-push`, async () => {
            const pull = recordingCommand();
            await doltPullBefore('m1', { command: pull.command, remoteTipFingerprint: false, memberTarget: row.target });
            assert.deepStrictEqual(pull.syncCalls(), [row.pull]);

            const push = recordingCommand();
            await doltPushAfter('m1', { command: push.command, memberTarget: row.target });
            assert.deepStrictEqual(push.syncCalls(), [row.push]);
            for (const c of [...pull.calls, ...push.calls]) assertNoShellExpansion(c.cmd);
        });
    }

    test('with no memberTarget the sprint-wide resolver decides, looked up by member name', async () => {
        const looked = [];
        setMemberTargetResolver(async (member) => { looked.push(member); return { os: 'windows', shell: 'gitbash' }; });
        const rec = recordingCommand();
        await doltPullBefore('win-gb', { command: rec.command, remoteTipFingerprint: false });
        assert.deepStrictEqual(rec.syncCalls(), ['GOMAXPROCS=1 bd dolt pull']);
        assert.deepStrictEqual(looked, ['win-gb']);
    });

    test('with neither, or a resolver that throws, the strings are the unchanged POSIX ones', async () => {
        const plain = recordingCommand();
        await doltPullBefore('m1', { command: plain.command, remoteTipFingerprint: false });
        assert.deepStrictEqual(plain.syncCalls(), ['bd dolt pull']);

        setMemberTargetResolver(async () => { throw new Error('member_detail unavailable'); });
        const logs = [];
        const failing = recordingCommand();
        await doltPullBefore('m1', { command: failing.command, remoteTipFingerprint: false, log: (l) => logs.push(l) });
        assert.deepStrictEqual(failing.syncCalls(), ['bd dolt pull']);
        assert.ok(logs.some((l) => /could not resolve the OS\/shell of member 'm1'/.test(l)), 'the degrade is logged');
    });
});

// The live incident shape: Go's os/exec spawn refusal on the fork/exec line.
const SPAWN_LIMIT_OUTPUT = `Pulling from Dolt remote...

Error: fetch from origin/main: Error 1105: failed to get remote db; the remote: origin '${SYNC_REMOTE}' could not be accessed; git command failed
error: fork/exec C:\\Program Files\\Git\\mingw64\\bin\\git.exe: Not enough memory resources are available to process this command.
hint: dolt does not support interactive credential prompts
`;

describe('Windows spawn-limit exhaustion is a typed error', () => {
    test('D-pull failing with the spawn limit on every attempt ends with DOLT_WINDOWS_SPAWN_LIMIT and a remedy', async () => {
        let clock = 0;
        const rec = recordingCommand(() => ({ ok: false, output: '', error: SPAWN_LIMIT_OUTPUT }));
        const err = await doltPullBefore('win-m', {
            command: rec.command,
            remoteTipFingerprint: false,
            memberTarget: { os: 'windows', shell: '' },
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
        }).then(() => null, (e) => e);

        assert.ok(err instanceof DoltWindowsSpawnLimitError, `expected the typed error, got ${err && err.name}`);
        assert.ok(err instanceof DoltSyncError, 'still a DoltSyncError for existing handlers');
        assert.strictEqual(err.code, DOLT_WINDOWS_SPAWN_LIMIT_CODE);
        assert.strictEqual(err.code, 'DOLT_WINDOWS_SPAWN_LIMIT');
        assert.match(err.message, /Windows process-creation limit/);
        assert.ok(err.message.includes(WINDOWS_SPAWN_LIMIT_REMEDY), 'the message carries the remedy');
        assert.strictEqual(err.details.cause, 'windows-spawn-limit');
        assert.ok(rec.syncCalls().length > 1, 'the transient spawn-outage retries still ran');
        for (const cmd of rec.syncCalls()) assert.strictEqual(cmd, "$env:GOMAXPROCS='1'; bd dolt pull");
    });

    test('an ordinary exhausted transient failure stays a generic DoltSyncError', async () => {
        const rec = recordingCommand(() => ({ ok: false, output: '', error: 'connection reset by peer' }));
        const err = await doltPullBefore('m1', {
            command: rec.command, remoteTipFingerprint: false, sleep: async () => {},
        }).then(() => null, (e) => e);
        assert.ok(err instanceof DoltSyncError);
        assert.ok(!(err instanceof DoltWindowsSpawnLimitError));
        assert.strictEqual(err.code, 'DOLT_SYNC_FAILED');
    });
});
