import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeSqlForShell,
    ensurePinnedDolt,
    spawnEphemeralServer,
    runDoltSql,
    DOLT_VERSION,
} from '../fleet-sprint/dolt-settle.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-7dir.25: pin the dolt-settle behaviour for a Windows member whose
// REGISTERED shell is Git-for-Windows bash ({ os: 'windows', shell: 'gitbash' }
// / { platform: 'win32', shell: 'gitbash' }), introduced by apra-fleet-7dir.16
// (dialect resolution via se-os-commands.mjs's getSeCommands) and wired to the
// script call sites by apra-fleet-7dir.21/.22/.23. Before this file, only
// escapeSqlForShell's bare 'linux'/'win32' cases were covered
// (dolt-settle.test.mjs:72-93); the gitbash dialect and the INTERIM-STATE
// psDoltPath split were only verifiable by hand.
// =============================================================================

function decodeEncodedCommand(cmd) {
    const match = cmd.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
    if (!match) return null;
    return Buffer.from(match[1], 'base64').toString('utf16le');
}

// ---------------------------------------------------------------------------
// 1. escapeSqlForShell({ os: 'windows', shell: 'gitbash' }, sql) must equal
//    escapeSqlForShell('linux', sql) -- POSIX escaping, not PowerShell.
// ---------------------------------------------------------------------------

test('escapeSqlForShell: a Windows member whose registered shell is gitbash gets the bash dialect, not PowerShell', () => {
    const bq = String.fromCharCode(96);
    const sql = `SELECT ${bq}table${bq} FROM t WHERE a = "b" AND c = '$d';`;
    const gitbash = escapeSqlForShell({ os: 'windows', shell: 'gitbash' }, sql);
    const linux = escapeSqlForShell('linux', sql);
    const powershell = escapeSqlForShell('win32', sql);
    assert.equal(gitbash, linux, 'windows+gitbash must escape identically to POSIX, never PowerShell');
    assert.notEqual(gitbash, powershell, 'the gitbash dialect must differ from the bare win32 (PowerShell) dialect for SQL containing backticks/quotes/$');
});

test('escapeSqlForShell: win32 platform string with no shell recorded still resolves to PowerShell (back-compat, unaffected by this bead)', () => {
    const bq = String.fromCharCode(96);
    const sql = `SELECT ${bq}x${bq} FROM t;`;
    assert.equal(escapeSqlForShell({ os: 'win32', shell: '' }, sql), escapeSqlForShell('win32', sql));
});

// ---------------------------------------------------------------------------
// 2. ensurePinnedDolt for { platform: 'win32', shell: 'gitbash' } must return
//    doltPath in bash dialect (.exe retained) and psDoltPath in PowerShell
//    dialect, and the commands actually dispatched to
//    installPinnedDolt/killProcessAtPath must carry the $env: form wrapped
//    for bash invocation (the INTERIM-STATE clause, now verifiable
//    end-to-end instead of only by hand).
// ---------------------------------------------------------------------------

function makeGitbashInstallFixture({ initialVersion = null, installLockedThenOk = false } = {}) {
    const calls = [];
    let installed = initialVersion;
    let installAttempts = 0;
    const command = async (cmd) => {
        calls.push(cmd);
        const decoded = decodeEncodedCommand(cmd) || cmd;
        // dolt version probe: bash-native path, no PowerShell envelope at all.
        if (/dolt\.exe" version$/.test(cmd.trim())) {
            return installed ? { ok: true, output: `dolt version ${installed}\n`, error: null } : { ok: false, output: '', error: 'not found' };
        }
        if (/Invoke-WebRequest/.test(decoded)) {
            installAttempts += 1;
            if (installLockedThenOk && installAttempts === 1) {
                return { ok: false, output: '', error: 'Access to the path is denied: being used by another process' };
            }
            installed = DOLT_VERSION.replace(/^v/, '');
            return { ok: true, output: '', error: null };
        }
        if (/Stop-Process/.test(decoded)) {
            return { ok: true, output: '', error: null };
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

test('ensurePinnedDolt: windows+gitbash returns doltPath in bash form and psDoltPath in PowerShell form', async () => {
    const { command } = makeGitbashInstallFixture({ initialVersion: DOLT_VERSION.replace(/^v/, '') });
    const result = await ensurePinnedDolt({ command, member: 'winbash1', platform: 'win32', shell: 'gitbash' });
    assert.equal(result.doltPath, '"$HOME/.apra-fleet/bin/dolt.exe"', 'doltPath must be the bash-dialect path with .exe retained (Windows binary, bash invocation)');
    assert.equal(result.psDoltPath, '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"', 'psDoltPath must always be the PowerShell-dialect form for the raw script bodies');
});

test('ensurePinnedDolt: windows+gitbash install/kill/retry commands are wrapped -EncodedCommand invocations, and the PowerShell payload inside still uses $env:, never $HOME', async () => {
    const { command, calls } = makeGitbashInstallFixture({ initialVersion: null });
    const result = await ensurePinnedDolt({ command, member: 'winbash2', platform: 'win32', shell: 'gitbash', arch: 'x64' });
    assert.equal(result.pinned, true);

    const installCalls = calls.filter((c) => decodeEncodedCommand(c) && /Invoke-WebRequest/.test(decodeEncodedCommand(c)));
    check(installCalls.length > 0, 'the install script must actually have been dispatched');
    for (const c of installCalls) {
        check(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/.test(c), `install command must be a bash-invocable -EncodedCommand wrapper, got: ${c}`);
        const decoded = decodeEncodedCommand(c);
        check(decoded.includes('$env:USERPROFILE'), 'the wrapped PowerShell script body must still use $env:USERPROFILE (PowerShell dialect), even though this member\'s own shell is bash');
        check(!decoded.includes('$HOME'), 'the wrapped PowerShell script body must NEVER use $HOME -- that would not expand inside PowerShell');
    }
});

test('ensurePinnedDolt: windows+gitbash locked-file retry wraps killProcessAtPath the same way, and it too stays in PowerShell dialect', async () => {
    const { command, calls } = makeGitbashInstallFixture({ initialVersion: '1.86.3', installLockedThenOk: true });
    const result = await ensurePinnedDolt({ command, member: 'winbash3', platform: 'win32', shell: 'gitbash' });
    assert.equal(result.pinned, true);

    const killCalls = calls.filter((c) => decodeEncodedCommand(c) && /Stop-Process/.test(decodeEncodedCommand(c)));
    check(killCalls.length > 0, 'a locked-file install failure must still trigger a kill attempt for a gitbash member');
    for (const c of killCalls) {
        check(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/.test(c), `kill command must be a bash-invocable -EncodedCommand wrapper, got: ${c}`);
        const decoded = decodeEncodedCommand(c);
        check(decoded.includes('$env:USERPROFILE'), 'killProcessAtPath\'s wrapped script must still reference the PowerShell-dialect path');
    }
});

// ---------------------------------------------------------------------------
// spawnEphemeralServer: same wrap-for-gitbash contract, directly exercised
// (exported, no need to drive it through ensurePinnedDolt).
// ---------------------------------------------------------------------------

test('spawnEphemeralServer: windows+gitbash wraps the WMI spawn script as a bash-invocable -EncodedCommand, PowerShell dialect preserved inside', async () => {
    const psDoltPath = '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"';
    let captured = null;
    const command = async (cmd) => {
        captured = cmd;
        return { ok: true, output: 'PID:4242' };
    };
    const result = await spawnEphemeralServer({
        command, member: 'winbash4', platform: 'win32', doltPath: psDoltPath,
        dataDir: 'C:\\data', host: '127.0.0.1', port: 13300, shell: 'gitbash',
    });
    assert.equal(result.pid, 4242);
    check(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/.test(captured), `spawn command must be wrapped for bash invocation, got: ${captured}`);
    const decoded = decodeEncodedCommand(captured);
    check(decoded.includes('Invoke-CimMethod'), 'the WMI spawn incantation must be preserved verbatim inside the wrapped script');
    check(decoded.includes('$env:USERPROFILE'), 'the doltPath embedded in the script body must stay in PowerShell dialect');
    check(!decoded.includes('$HOME'), 'must never leak the bash $HOME form into the PowerShell script body');
});

test('spawnEphemeralServer: windows with no shell recorded (plain powershell member) stays byte-identical -- no wrapping applied', async () => {
    const psDoltPath = '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"';
    let captured = null;
    const command = async (cmd) => {
        captured = cmd;
        return { ok: true, output: 'PID:99' };
    };
    await spawnEphemeralServer({
        command, member: 'winps1', platform: 'win32', doltPath: psDoltPath,
        dataDir: 'C:\\data', host: '127.0.0.1', port: 13301, shell: '',
    });
    check(!/-EncodedCommand/i.test(captured), 'a plain PowerShell member must receive the raw script text unwrapped, byte-identical to pre-shell-aware behavior');
    check(captured.includes('Invoke-CimMethod'), 'raw script text must be present directly, not base64-encoded');
});

// ---------------------------------------------------------------------------
// 3. invokeBinary (exercised via the exported runDoltSql) for a gitbash
//    target must emit no leading PowerShell call operator.
// ---------------------------------------------------------------------------

test('runDoltSql: windows+gitbash invokes the quoted dolt path with no leading PowerShell call operator', async () => {
    let captured = null;
    const command = async (cmd) => {
        captured = cmd;
        return { ok: true, output: '{}' };
    };
    await runDoltSql({
        command, member: 'winbash5', platform: 'win32',
        doltPath: '"$HOME/.apra-fleet/bin/dolt.exe"', host: '127.0.0.1', port: 13300,
        query: 'SELECT 1;', shell: 'gitbash',
    });
    check(captured.startsWith('"$HOME/.apra-fleet/bin/dolt.exe"'), `gitbash invocation must start with the bare quoted path, no leading call operator, got: ${captured}`);
    check(!captured.startsWith('&'), 'a leading & is a bash syntax error -- must never be emitted for a gitbash target');
});

test('runDoltSql: windows with no shell recorded (plain powershell member) keeps the call operator', async () => {
    let captured = null;
    const command = async (cmd) => {
        captured = cmd;
        return { ok: true, output: '{}' };
    };
    await runDoltSql({
        command, member: 'winps2', platform: 'win32',
        doltPath: '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"', host: '127.0.0.1', port: 13300,
        query: 'SELECT 1;', shell: '',
    });
    check(captured.startsWith('& "$env:USERPROFILE'), `a plain PowerShell member must keep the call operator, got: ${captured}`);
});

test('runDoltSql: POSIX target (linux) also has no leading call operator, matching gitbash', async () => {
    let captured = null;
    const command = async (cmd) => {
        captured = cmd;
        return { ok: true, output: '{}' };
    };
    await runDoltSql({
        command, member: 'lin1', platform: 'linux',
        doltPath: '"$HOME/.apra-fleet/bin/dolt"', host: '127.0.0.1', port: 13300,
        query: 'SELECT 1;',
    });
    check(!captured.startsWith('&'), 'POSIX must never carry the PowerShell call operator either');
});

// ---------------------------------------------------------------------------
// 4. apra-fleet-ka1u bug #2: MSYS bash silently truncates any `bash -c
//    <string>` over 8186 chars (bisected empirically), which resolveLwwTable()'s
//    per-column UPDATE for a wide table (e.g. 53-column 'issues') can exceed by
//    a wide margin (a live incident hit 14,064 chars). A short query must stay
//    on the exact live-verified -q "<query>" path unchanged; a long one must
//    route through a chunked scratch file + -f, with every single dispatched
//    command staying safely under the limit.
// ---------------------------------------------------------------------------

function buildOversizedQuery(approxLength) {
    const clause = () => 'SET col = CASE WHEN c.our_col <=> c.their_col THEN c.our_col ELSE c.their_col END, ';
    let sql = 'UPDATE `issues` t JOIN dolt_conflicts_issues c ON t.`id` = c.our_id ';
    while (sql.length < approxLength) sql += clause();
    return `${sql}WHERE 1=1;`;
}

test('runDoltSql: a short query (below the inline limit) is byte-identical to the pre-existing -q "<query>" invocation -- no scratch file, one command() call', async () => {
    const calls = [];
    const command = async (cmd) => { calls.push(cmd); return { ok: true, output: '{}' }; };
    await runDoltSql({
        command, member: 'winbash-short', platform: 'win32', shell: 'gitbash',
        doltPath: '"$HOME/.apra-fleet/bin/dolt.exe"', host: '127.0.0.1', port: 13300,
        query: 'SELECT 1;',
    });
    check(calls.length === 1, `a short query must be exactly one command() call, got ${calls.length}`);
    check(calls[0].includes(' -q "'), `a short query must still use -q, got: ${calls[0]}`);
    check(!calls[0].includes(' -f '), 'a short query must never route through the scratch-file/-f path');
});

test('runDoltSql: an oversized query (past the inline limit, mirroring the live 14,064-char resolveLwwTable UPDATE) never dispatches a single command() call anywhere near bash\'s 8186-char -c truncation limit', async () => {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes(' -f ')) return { ok: true, output: '{}' };
        return { ok: true, output: '', error: null }; // scratch-file create/append/cleanup
    };
    const bigQuery = buildOversizedQuery(14064);
    check(bigQuery.length >= 14000, 'sanity: the constructed query must actually be large');

    await runDoltSql({
        command, member: 'orchestrator', platform: 'win32', shell: 'gitbash',
        doltPath: '"$HOME/.apra-fleet/bin/dolt.exe"', host: '127.0.0.1', port: 13300,
        query: bigQuery,
    });

    check(calls.length > 1, `an oversized query must be split across multiple command() calls, got ${calls.length}`);
    const maxLen = Math.max(...calls.map((c) => c.length));
    check(maxLen < 8186, `every single dispatched command must stay under bash's 8186-char -c truncation limit, got a max of ${maxLen}`);
    check(calls.some((c) => c.includes(' -f "')), 'the final invocation must use -f <scratch file>, not -q "<query>"');
    check(!calls.some((c) => / -q "/.test(c)), 'an oversized query must never fall back to -q "<query>" for any call in the sequence');
});

test('runDoltSql: an oversized query still throws DoltSyncError with the full original query text if the final -f invocation itself fails', async () => {
    const command = async (cmd) => {
        if (cmd.includes(' -f ')) return { ok: false, output: '', error: 'boom' };
        return { ok: true, output: '', error: null };
    };
    const bigQuery = buildOversizedQuery(9000);
    let threw = null;
    try {
        await runDoltSql({
            command, member: 'orchestrator', platform: 'win32', shell: 'gitbash',
            doltPath: '"$HOME/.apra-fleet/bin/dolt.exe"', host: '127.0.0.1', port: 13300,
            query: bigQuery,
        });
    } catch (err) {
        threw = err;
    }
    check(threw !== null, 'a failed -f invocation must still surface as a thrown error, exactly like a failed -q invocation does today');
    check(threw && threw.message.includes(bigQuery), 'the thrown error must still carry the full original (un-chunked) query text for diagnosis');
});
