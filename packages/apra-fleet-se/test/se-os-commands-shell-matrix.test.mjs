import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    getSeCommands,
    SePosixCommands,
    SeWindowsCommands,
    SeWindowsGitbashCommands,
} from '../fleet-sprint/se-os-commands.mjs';
import { buildCredentialReadCommand } from '../fleet-sprint/runner.js';
import { buildCreatePrCommand } from '../fleet-sprint/vcs-module.mjs';
import { crtParseCommandLine, legacyBinderCommandLine } from './helpers/windows-argv.mjs';

// apra-fleet-7dir.3.4: getSeCommands() is the single place fleet-sprint and
// the supervisor resolve "what does a command string look like for THIS
// member?". This suite pins its resolution matrix and the shape of the
// strings it hands back, entirely at the string level -- no PowerShell.exe
// or Git-for-Windows bash.exe is ever spawned, so this suite is exercisable
// on a host that has neither installed (the feature's explicit testability
// acceptance criterion).
//
// A local reimplementation of core's src/os/windows.ts wrapPowerShellEncoded
// (byte-identical to it, and to se-windows.mjs's wrapForMember and to
// runner.js's now-removed wrapPowerShellEncodedForMember -- see commit
// 593f6c08) golden-pins the PowerShell envelope so a change to that shape
// fails loudly here rather than silently drifting.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The full resolution matrix getSeCommands() must answer for. */
const SHELL_MATRIX = [
    { os: 'linux', shell: '' },
    { os: 'darwin', shell: '' },
    { os: 'windows', shell: 'gitbash' },
    { os: 'windows', shell: 'pwsh7' },
    { os: 'windows', shell: 'powershell5' },
    { os: 'windows', shell: '' },
];

function coreWrapPowerShellEncoded(psScript) {
    const guarded = `$ErrorActionPreference = 'Stop'; try { ${psScript}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`;
    return `powershell -EncodedCommand ${Buffer.from(guarded, 'utf16le').toString('base64')}`;
}

describe('getSeCommands resolution matrix (apra-fleet-7dir.3.4)', () => {
    test('linux resolves to the POSIX implementation', () => {
        const cmds = getSeCommands({ os: 'linux', shell: '' });
        assert.ok(cmds instanceof SePosixCommands, 'linux must resolve to SePosixCommands');
        assert.ok(!(cmds instanceof SeWindowsGitbashCommands), 'linux must not resolve to the gitbash subclass');
        assert.equal(cmds.shell, 'posix');
    });

    test('macos (darwin) resolves to the POSIX implementation', () => {
        const cmds = getSeCommands({ os: 'darwin', shell: '' });
        assert.ok(cmds instanceof SePosixCommands, 'darwin must resolve to SePosixCommands');
        assert.equal(cmds.shell, 'posix');

        // A bare OS string (no shell field) must resolve the same way --
        // back-compat for callers that only know the OS.
        const bare = getSeCommands('darwin');
        assert.ok(bare instanceof SePosixCommands);
    });

    test('windows + gitbash resolves to the Git-for-Windows bash implementation', () => {
        const cmds = getSeCommands({ os: 'windows', shell: 'gitbash' });
        assert.ok(cmds instanceof SeWindowsGitbashCommands, 'windows+gitbash must resolve to SeWindowsGitbashCommands');
        assert.ok(cmds instanceof SePosixCommands, 'the gitbash implementation must extend the POSIX base');
        assert.equal(cmds.shell, 'gitbash');

        // win32 is a recognized OS alias for windows.
        const alias = getSeCommands({ os: 'win32', shell: 'gitbash' });
        assert.ok(alias instanceof SeWindowsGitbashCommands);
    });

    test('windows + pwsh7 resolves to the PowerShell implementation', () => {
        const cmds = getSeCommands({ os: 'windows', shell: 'pwsh7' });
        assert.ok(cmds instanceof SeWindowsCommands, 'windows+pwsh7 must resolve to SeWindowsCommands');
        assert.ok(!(cmds instanceof SePosixCommands), 'the PowerShell implementation must not extend the POSIX base');
        assert.equal(cmds.shell, 'powershell');
    });

    test('windows + powershell5 resolves to the PowerShell implementation', () => {
        const cmds = getSeCommands({ os: 'windows', shell: 'powershell5' });
        assert.ok(cmds instanceof SeWindowsCommands, 'windows+powershell5 must resolve to SeWindowsCommands');
        assert.equal(cmds.shell, 'powershell');
    });

    test('windows with no shell recorded resolves to the PowerShell implementation (historical default)', () => {
        const cmds = getSeCommands({ os: 'windows', shell: '' });
        assert.ok(cmds instanceof SeWindowsCommands, 'a shell-less windows member must degrade to PowerShell, not throw or default to POSIX');
        assert.equal(cmds.shell, 'powershell');

        // A bare 'windows' OS string (no shell field at all) must resolve the
        // same way -- this is the pre-shell-aware call shape every caller
        // used before member shell was recorded.
        const bare = getSeCommands('windows');
        assert.ok(bare instanceof SeWindowsCommands);
    });

    test('an unresolvable/unknown OS degrades to POSIX, not to a throw', () => {
        const cmds = getSeCommands({ os: '', shell: '' });
        assert.ok(cmds instanceof SePosixCommands);
        const unknown = getSeCommands({ os: 'freebsd', shell: '' });
        assert.ok(unknown instanceof SePosixCommands);
    });
});

describe('gitbash command strings carry no PowerShell dialect (apra-fleet-7dir.3.4)', () => {
    test('readCredentialHelper for a gitbash member is a bare bash string with no cmdlet or -EncodedCommand envelope', () => {
        const cmds = getSeCommands({ os: 'windows', shell: 'gitbash' });
        const { command, descriptor } = cmds.readCredentialHelper('github-push-pr');

        assert.ok(!/powershell/i.test(command), `gitbash command must not mention powershell: ${command}`);
        assert.ok(!/-EncodedCommand/i.test(command), `gitbash command must not carry a -EncodedCommand envelope: ${command}`);
        assert.ok(!/^&\s+"/.test(command), `gitbash command must not use the PowerShell call operator: ${command}`);
        assert.ok(!/\$env:USERPROFILE/.test(command), `gitbash command must use $HOME, not $env:USERPROFILE: ${command}`);

        // Same shape apra-fleet core's Windows credential-write used for a
        // gitbash member, now double-quoted (apra-fleet-j918.12) so a HOME
        // containing whitespace still resolves; the descriptor (used only for
        // human-readable error messages) stays the bare path.
        assert.equal(command, '"$HOME/.fleet-git-credential-github-push-pr.bat"');
        assert.equal(descriptor, '$HOME/.fleet-git-credential-github-push-pr.bat');
    });

    test('gitbash wrapForMember is the POSIX identity passthrough', () => {
        const cmds = getSeCommands({ os: 'windows', shell: 'gitbash' });
        const script = 'echo hello';
        assert.equal(cmds.wrapForMember(script), script, 'gitbash must not wrap the script in any PowerShell envelope');
        assert.ok(!/EncodedCommand/i.test(cmds.wrapForMember(script)));
    });
});

describe('PowerShell envelope is golden-pinned against the pre-refactor wrapPowerShellEncodedForMember shape (apra-fleet-7dir.3.4)', () => {
    test('SeWindowsCommands#wrapForMember matches the reimplemented core wrapPowerShellEncoded byte-for-byte', () => {
        const cmds = new SeWindowsCommands();
        const scripts = [
            'echo hello',
            '& "$env:USERPROFILE\\.fleet-git-credential-github.bat"',
            "Get-Item 'C:\\some path\\with spaces' -ErrorAction SilentlyContinue",
        ];
        for (const script of scripts) {
            const actual = cmds.wrapForMember(script);
            const golden = coreWrapPowerShellEncoded(script);
            assert.equal(actual, golden, `wrapForMember must stay byte-identical to core's wrapPowerShellEncoded for script: ${script}`);
            // Envelope shape sanity: base64 -EncodedCommand form.
            assert.match(actual, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
        }
    });

    test('readCredentialHelper for a PowerShell (pwsh7/powershell5/unset) member golden-matches the pre-refactor envelope', () => {
        for (const shell of ['pwsh7', 'powershell5', '']) {
            const cmds = getSeCommands({ os: 'windows', shell });
            const { command, descriptor } = cmds.readCredentialHelper('github-push-pr');

            const expectedDescriptor = '$env:USERPROFILE\\.fleet-git-credential-github-push-pr.bat';
            assert.equal(descriptor, expectedDescriptor, `shell=${shell}`);

            const expectedInner = '& "$env:USERPROFILE\\.fleet-git-credential-github-push-pr.bat"';
            const expectedCommand = coreWrapPowerShellEncoded(expectedInner);
            assert.equal(command, expectedCommand, `shell=${shell} command must golden-match the pre-refactor envelope`);
            assert.match(command, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
        }
    });
});

describe('runner.js buildCredentialReadCommand routes through getSeCommands (apra-fleet-7dir.3.4)', () => {
    // These assertions exercise the routing task (apra-fleet-7dir.3.3): if
    // that routing were reverted to its pre-refactor shape (a local, OS-only
    // wrapPowerShellEncodedForMember builder in runner.js that ignores
    // shell), a gitbash member would get a PowerShell -EncodedCommand string
    // instead of the bash form asserted below, and this test would fail.
    test('a windows+gitbash target gets the bash credential-read form, not PowerShell', () => {
        const target = { os: 'windows', shell: 'gitbash' };
        const { command, descriptor } = buildCredentialReadCommand(target, 'github-push-pr');
        const expected = getSeCommands(target).readCredentialHelper('github-push-pr');
        assert.equal(command, expected.command);
        assert.equal(descriptor, expected.descriptor);
        assert.ok(!/powershell/i.test(command), `expected bash form, got: ${command}`);
    });

    test('a windows+pwsh7 target gets the golden PowerShell envelope', () => {
        const target = { os: 'windows', shell: 'pwsh7' };
        const { command } = buildCredentialReadCommand(target, 'github-push-pr');
        const expectedInner = '& "$env:USERPROFILE\\.fleet-git-credential-github-push-pr.bat"';
        assert.equal(command, coreWrapPowerShellEncoded(expectedInner));
    });

    test('a plain "linux" OS string (back-compat callers) gets the quoted POSIX string (apra-fleet-j918.12)', () => {
        const { command, descriptor } = buildCredentialReadCommand('linux', 'github-push-pr');
        assert.equal(command, '"$HOME/.fleet-git-credential-github-push-pr"');
        assert.equal(descriptor, '$HOME/.fleet-git-credential-github-push-pr');
    });
});

describe('wrapPowerShellScript: wraps a whole PowerShell script for invocation from a member-appropriate shell (apra-fleet-7dir.21)', () => {
    test('windows with pwsh7/powershell5/no shell recorded returns the script UNCHANGED (no envelope)', () => {
        const script = [
            'New-Item -ItemType Directory -Force "$env:USERPROFILE\\.apra-fleet\\bin" | Out-Null',
            'Invoke-WebRequest -Uri "https://example.invalid/dolt.zip" -OutFile "$env:TEMP\\dolt.zip"',
        ].join('; ');
        for (const shell of ['pwsh7', 'powershell5', '']) {
            const cmds = getSeCommands({ os: 'windows', shell });
            assert.equal(cmds.wrapPowerShellScript(script), script, `shell=${shell} must return the script byte-identical -- no envelope added`);
        }
    });

    test('windows+gitbash returns a bash-invocable PowerShell invocation whose base64 payload decodes back to the exact original script', () => {
        const script = 'Get-Process | Where-Object { $_.Path -eq "$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe" } | Stop-Process -Force -ErrorAction SilentlyContinue';
        const cmds = getSeCommands({ os: 'windows', shell: 'gitbash' });
        const wrapped = cmds.wrapPowerShellScript(script);

        assert.match(wrapped, /^powershell(\.exe)? /i, 'must start with a PowerShell executable invocation');
        assert.match(wrapped, /-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i, 'must carry a base64 -EncodedCommand payload');
        assert.ok(!/\$env:USERPROFILE|Get-Process|Stop-Process/.test(wrapped), 'no raw PowerShell script text may survive unescaped into the bash-invoked string -- it must be entirely inside the opaque base64 blob');

        const b64 = wrapped.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i)[1];
        const decoded = Buffer.from(b64, 'base64').toString('utf16le');
        assert.equal(decoded, script, 'decoding the base64 payload as UTF-16LE must reproduce the original script exactly');
    });

    test('linux and macos throw rather than returning the script -- a POSIX member has no PowerShell to hand it to', () => {
        for (const os of ['linux', 'darwin']) {
            const cmds = getSeCommands({ os, shell: '' });
            assert.throws(() => cmds.wrapPowerShellScript('Write-Output "hi"'), /PowerShell/i, `os=${os} must throw a clear error, not silently return the script`);
        }
    });
});

describe('VCS create-pull-request curl builders quote by member shell across the shell matrix (apra-fleet-5co8.21)', () => {
    // apra-fleet-5co8.17 threaded the member's registered shell (not just the
    // bare OS) into buildCreatePrCommand()'s shQuote() calls for BOTH
    // providers -- github.mjs already did this before 5co8.17; azure-devops.mjs
    // was the gap that task closed. This block pins the same shell matrix
    // se-os-commands.mjs's own resolution table uses (see the describe block
    // at the top of this file) against BOTH providers' built curl commands, so
    // a regression in either builder's shell-threading is caught here, at the
    // string level, with no member, no network, and no credential store.

    // A title carrying BOTH an apostrophe and a double quote: the apostrophe
    // is the character whose escaping differs between the two shell dialects
    // (POSIX closes/reopens the quote as '\''; PowerShell doubles it as ''),
    // and the double quote must survive untouched since curl's -d payload is
    // a JSON *string embedded inside the shell's own quoting* -- neither
    // shell dialect treats a bare double quote specially inside a
    // single-quoted argument, but a decoder that mishandled the argument
    // boundary would corrupt it too.
    const TITLE = `Sprint's "big" PR`;
    const BODY = `It's a "test" body`;
    const TOKEN = 'PAT-TOKEN-shell-matrix';

    const GITHUB_PARAMS = Object.freeze({
        provider: 'github',
        repo: 'mock-org/mock-repo',
        base: 'main',
        head: 'auto-sprint/shell-matrix',
        title: TITLE,
        body: BODY,
        token: TOKEN,
    });

    const ADO_REPO_REF = Object.freeze({ org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' });
    const ADO_PARAMS = Object.freeze({
        provider: 'azure-devops',
        repoRef: ADO_REPO_REF,
        base: 'main',
        head: 'auto-sprint/shell-matrix',
        title: TITLE,
        body: BODY,
        token: TOKEN,
    });

    // The shell matrix, alongside the expected quoting DIALECT for each --
    // mirrors usesPowerShellQuoting()'s own resolution table
    // (shell-helpers.mjs) and se-os-commands.mjs's getSeCommands() matrix at
    // the top of this file: gitbash -> POSIX even on Windows; pwsh7/
    // powershell5 -> PowerShell doubling; an unresolved shell on Windows ->
    // PowerShell doubling (the legacy fallback); any non-Windows os -> POSIX.
    const SHELL_MATRIX = [
        { label: 'windows+gitbash', os: 'windows', shell: 'gitbash', dialect: 'posix' },
        { label: 'windows+pwsh7', os: 'windows', shell: 'pwsh7', dialect: 'powershell' },
        { label: 'windows+powershell5', os: 'windows', shell: 'powershell5', dialect: 'powershell' },
        { label: 'windows+unresolved-shell', os: 'windows', shell: '', dialect: 'powershell' },
        { label: 'linux', os: 'linux', shell: '', dialect: 'posix' },
        { label: 'darwin', os: 'darwin', shell: '', dialect: 'posix' },
    ];

    // Real POSIX shell argv-word parsing for a token that starts exactly at
    // `start` (no leading whitespace): a `'...'` segment contributes its
    // contents literally, a backslash outside any quoted segment escapes the
    // single next character, and unquoted whitespace ends the word. This is
    // the general POSIX quoting grammar, not a hand-inversion of shQuote's
    // own regex -- it would decode ANY POSIX-quoted word this way, including
    // ones shQuote never produces.
    function nextPosixArg(str, start) {
        let i = start;
        let out = '';
        while (i < str.length) {
            const ch = str[i];
            if (ch === "'") {
                const close = str.indexOf("'", i + 1);
                assert.ok(close !== -1, `unterminated single quote in POSIX argument starting at ${start}: ${str}`);
                out += str.slice(i + 1, close);
                i = close + 1;
            } else if (ch === '\\' && i + 1 < str.length) {
                out += str[i + 1];
                i += 2;
            } else if (/\s/.test(ch)) {
                break;
            } else {
                out += ch;
                i += 1;
            }
        }
        return { value: out, end: i };
    }

    // Real PowerShell single-quoted-string parsing: the token starting at
    // `start` MUST begin with `'`; a doubled quote `''` inside the string is
    // the literal-quote escape, any other character (including whitespace)
    // is taken literally until the closing (non-doubled) `'`.
    function nextPowerShellArg(str, start) {
        assert.equal(str[start], "'", `expected a PowerShell single-quoted argument to start at ${start}: ${str}`);
        let i = start + 1;
        let out = '';
        while (i < str.length) {
            if (str[i] === "'") {
                if (str[i + 1] === "'") {
                    out += "'";
                    i += 2;
                } else {
                    i += 1;
                    break;
                }
            } else {
                out += str[i];
                i += 1;
            }
        }
        return { value: out, end: i };
    }

    // For the PowerShell dialect the string literal is only stage 1: the
    // value PowerShell parses out is then handed to the NATIVE curl.exe
    // through Windows PowerShell 5.1's legacy argument binder and the child's
    // C-runtime argv parser -- the stages that stripped every double quote
    // out of the JSON on a live member. helpers/windows-argv.mjs models those
    // (see test/vcs-powershell-argv-roundtrip.test.mjs for the real-
    // powershell.exe proof), so this returns what curl.exe actually receives.
    function extractDashDPayload(command, dialect) {
        const marker = ' -d ';
        const markerIndex = command.indexOf(marker);
        assert.ok(markerIndex !== -1, `expected a ' -d ' flag in the built command: ${command}`);
        const argStart = markerIndex + marker.length;
        if (dialect === 'posix') return nextPosixArg(command, argStart).value;
        const { value } = nextPowerShellArg(command, argStart);
        const argv = crtParseCommandLine(legacyBinderCommandLine([value]));
        assert.equal(argv.length, 1, `the -d word must reach curl.exe as exactly one argument, got ${JSON.stringify(argv)}`);
        return argv[0];
    }

    for (const { label, os, shell, dialect } of SHELL_MATRIX) {
        test(`github: ${label} -> ${dialect} quoting, -d payload round-trips to the exact same JSON object`, () => {
            const built = buildCreatePrCommand({ ...GITHUB_PARAMS, os, shell });
            const payloadText = extractDashDPayload(built.command, dialect);
            const payload = JSON.parse(payloadText);
            assert.deepEqual(payload, { title: TITLE, head: GITHUB_PARAMS.head, base: GITHUB_PARAMS.base, body: BODY });
        });

        test(`azure-devops: ${label} -> ${dialect} quoting, -d payload round-trips to the exact same JSON object`, () => {
            const built = buildCreatePrCommand({ ...ADO_PARAMS, os, shell });
            const payloadText = extractDashDPayload(built.command, dialect);
            const payload = JSON.parse(payloadText);
            assert.deepEqual(payload, {
                sourceRefName: `refs/heads/${ADO_PARAMS.head}`,
                targetRefName: `refs/heads/${ADO_PARAMS.base}`,
                title: TITLE,
                description: BODY,
            });
        });

        test(`curlBinary stays OS-keyed for ${label} (never shell-keyed): both providers agree`, () => {
            const expectedBinary = os === 'windows' ? 'curl.exe' : 'curl';
            const githubBuilt = buildCreatePrCommand({ ...GITHUB_PARAMS, os, shell });
            const adoBuilt = buildCreatePrCommand({ ...ADO_PARAMS, os, shell });
            assert.ok(githubBuilt.command.startsWith(`${expectedBinary} -sS -X POST`), `github: expected curl binary '${expectedBinary}' for os=${os}, got: ${githubBuilt.command}`);
            assert.ok(adoBuilt.command.startsWith(`${expectedBinary} -sS -X POST`), `azure-devops: expected curl binary '${expectedBinary}' for os=${os}, got: ${adoBuilt.command}`);
        });
    }

    // Revert-proofing anchor for apra-fleet-5co8.17: the windows+gitbash case
    // above is the one that fails if azure-devops.mjs's shQuote calls drop
    // back to two arguments (os only) -- usesPowerShellQuoting('windows',
    // undefined) is true, so a reverted builder would emit PowerShell-doubled
    // quoting ('' instead of '\'') for a gitbash member, corrupting the -d
    // JSON payload exactly as the paired [impl] bead describes. Pin the
    // DISTINCT string shapes directly (not just successful JSON.parse, which
    // a sufficiently-simple payload could satisfy under either dialect) so a
    // dialect mix-up is caught even when JSON.parse would not itself throw.
    test('azure-devops: windows+gitbash produces POSIX close-reopen quoting, DISTINCT from windows+unresolved-shell PowerShell doubling', () => {
        const gitbash = buildCreatePrCommand({ ...ADO_PARAMS, os: 'windows', shell: 'gitbash' });
        const unresolved = buildCreatePrCommand({ ...ADO_PARAMS, os: 'windows', shell: '' });

        assert.ok(gitbash.command.includes(`Sprint'\\''s`), `expected POSIX close-reopen quoting ('\\'') for the embedded apostrophe under gitbash, got: ${gitbash.command}`);
        assert.ok(!gitbash.command.includes(`Sprint''s`), `gitbash must NOT use PowerShell doubling for the embedded apostrophe, got: ${gitbash.command}`);

        assert.ok(unresolved.command.includes(`Sprint''s`), `expected PowerShell doubling ('') for the embedded apostrophe when shell is unresolved on windows, got: ${unresolved.command}`);
        assert.ok(!unresolved.command.includes(`Sprint'\\''s`), `unresolved-shell windows must NOT use POSIX close-reopen quoting, got: ${unresolved.command}`);

        assert.notEqual(gitbash.command, unresolved.command, 'the two dialects must not coincidentally produce byte-identical commands');
    });
});

describe('the whole interface is exercisable with neither gitbash nor PowerShell installed on the host (apra-fleet-7dir.3.4)', () => {
    // apra-fleet-j918.6.3: this test used to be named for spawning but only
    // asserted `typeof command === 'string'`, which cannot catch a quoting or
    // escaping defect in the emitted command -- the one class of bug that
    // actually reaches a member. Prove the claim properly instead: BUILD every
    // command in a child node process whose PATH is an EMPTY directory, so any
    // implementation that shelled out to a shell binary fails with ENOENT
    // rather than being taken on trust.
    test('no se-os-commands implementation spawns a process or shells out to build a command string (PATH emptied, so a shell-out would ENOENT)', () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-nopath-'));
        const modUrl = pathToFileURL(path.join(__dirname, '..', 'fleet-sprint', 'se-os-commands.mjs')).href;
        const script = `
            import { getSeCommands } from ${JSON.stringify(modUrl)};
            const matrix = ${JSON.stringify(SHELL_MATRIX)};
            const out = matrix.map((t) => ({ t, r: getSeCommands(t).readCredentialHelper('github') }));
            process.stdout.write(JSON.stringify(out));
        `;
        try {
            const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                encoding: 'utf8',
                // PATH is a real but EMPTY directory: nothing is executable.
                env: { ...process.env, PATH: emptyDir },
            });
            assert.equal(res.status, 0, `building the command matrix with an empty PATH must not spawn anything.\nstderr: ${res.stderr}`);
            const built = JSON.parse(res.stdout);
            assert.equal(built.length, SHELL_MATRIX.length);
            for (const { t, r } of built) {
                assert.ok(r.command && r.command.length > 0, `empty command for ${JSON.stringify(t)}`);
                assert.ok(r.descriptor && r.descriptor.length > 0, `empty descriptor for ${JSON.stringify(t)}`);
            }
        } finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });
});

// =============================================================================
// apra-fleet-j918.6.3 -- ARGUMENT-LEVEL round-trip of the emitted commands.
//
// Everything above this point asserts on command TEXT. Text assertions cannot
// answer the only question that matters at dispatch time: given this string,
// what arguments does the target shell actually deliver to the helper? A
// mis-quoted path does not change the text in any way a `typeof` or even a
// substring assertion notices -- it changes what the shell splits it into.
//
// So: run the emitted command through the REAL target shell against a real
// executable stand-in for the credential helper, and assert on the argv that
// stand-in receives.
// =============================================================================

const HOSTILE_DIRNAME = "O'Brien Home";           // apostrophe + space
const PLAIN_DIRNAME = 'plain-home';

/** Write an executable stand-in for the deployed credential helper that
 *  reports the argv it was handed. Named exactly as the production helper is,
 *  including the .bat extension for the Windows shapes -- with a /bin/sh
 *  shebang so a POSIX host can still exec it (the extension is what the
 *  emitted command names; the interpreter is this harness's business). */
function writeHelperStandIn(dir, fileName) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    if (fileName.endsWith('.bat') && process.platform === 'win32') {
        const content = [
            '@echo off',
            'echo ARGV0=%~f0',
            'set ARGC=0',
            'for %%A in (%*) do set /a ARGC+=1',
            'echo ARGC=%ARGC%',
            'for %%A in (%*) do echo ARG=%%~A',
        ].join('\r\n') + '\r\n';
        fs.writeFileSync(file, content);
    } else {
        fs.writeFileSync(file, '#!/bin/sh\necho "ARGV0=$0"\necho "ARGC=$#"\nfor a in "$@"; do echo "ARG=$a"; done\n');
        fs.chmodSync(file, 0o755);
    }
    return file;
}

function parseArgvReport(stdout) {
    const lines = String(stdout).split('\n').map((l) => l.replace(/\r$/, ''));
    const argv0 = (lines.find((l) => l.startsWith('ARGV0=')) || '').slice('ARGV0='.length);
    const argcLine = lines.find((l) => l.startsWith('ARGC='));
    const args = lines.filter((l) => l.startsWith('ARG=')).map((l) => l.slice('ARG='.length));
    return { argv0, argc: argcLine ? Number(argcLine.slice('ARGC='.length)) : null, args };
}

function assertArgv0MatchesHelper(gotArgv0, helperPath, label) {
    const parts = String(gotArgv0).split(/[\\/]/).filter(Boolean);
    const gotBase = parts[parts.length - 1];
    const gotParent = parts[parts.length - 2];
    const expectedBase = path.basename(helperPath);
    const expectedParent = path.basename(path.dirname(helperPath));
    assert.equal(gotBase, expectedBase, label + ": exec'd helper filename must match. got=" + gotArgv0 + " expected=" + helperPath);
    assert.equal(gotParent, expectedParent, label + ": exec'd helper parent dir must match. got=" + gotArgv0 + " expected=" + helperPath);
}

function detectPowerShell() {
    for (const bin of ['pwsh', 'powershell.exe', 'powershell']) {
        let probe;
        try {
            probe = spawnSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
        } catch {
            continue;
        }
        if (probe && probe.status === 0 && probe.stdout.trim()) return { bin, version: probe.stdout.trim() };
    }
    return null;
}
const POWERSHELL = detectPowerShell();
// A missing shell DEGRADES LOUDLY with a named reason (CLAUDE.md: an advisory
// warning that never blocks is a false success), never to a silent pass.
const POWERSHELL_SKIP = POWERSHELL
    ? false
    : 'DEGRADED: no real PowerShell on PATH (tried pwsh, powershell.exe, powershell), so the emitted'
      + ' PowerShell command cannot be ROUND-TRIPPED and the arguments it would deliver are unverified'
      + ' on this host. Install PowerShell 7 (`pwsh`) -- it is cross-platform -- to run this test.';
const BASH = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).status === 0;
const BASH_SKIP = BASH
    ? false
    : 'DEGRADED: no bash on PATH, so the emitted POSIX/gitbash command cannot be ROUND-TRIPPED and the'
      + ' arguments it would deliver are unverified on this host.';

describe('emitted commands round-trip through the REAL target shell and deliver the arguments they claim (apra-fleet-j918.6.3)', () => {
    for (const target of [
        { label: 'windows+pwsh7', os: 'windows', shell: 'pwsh7' },
        { label: 'windows+powershell5', os: 'windows', shell: 'powershell5' },
        { label: 'windows+unresolved-shell', os: 'windows', shell: '' },
    ]) {
        test(`${target.label}: real PowerShell execs the helper at USERPROFILE with ZERO arguments, even when that path carries a quote and a space`, { skip: POWERSHELL_SKIP }, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-psrt-'));
            try {
                const home = path.join(root, HOSTILE_DIRNAME);
                const helper = writeHelperStandIn(home, '.fleet-git-credential-github.bat');
                const { command, descriptor } = getSeCommands(target).readCredentialHelper('github');

                // Decode the REAL emitted envelope; do not rebuild it.
                const m = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/);
                assert.ok(m, `expected a -EncodedCommand envelope for ${target.label}, got: ${command}`);
                const script = Buffer.from(m[1], 'base64').toString('utf16le');
                assert.match(descriptor, /USERPROFILE/, 'the Windows descriptor names USERPROFILE');

                // Point the env var the emitted script reads at the hostile
                // home, then let real PowerShell parse and run the script.
                const preamble = `$env:USERPROFILE = '${home.replace(/'/g, "''")}'; `;
                const res = spawnSync(POWERSHELL.bin, ['-NoProfile', '-Command', preamble + script], { encoding: 'utf8' });
                assert.equal(res.status, 0, `the emitted command must run cleanly under ${POWERSHELL.bin} ${POWERSHELL.version}.\nstderr: ${res.stderr}`);

                const got = parseArgvReport(res.stdout);
                assert.equal(
                    path.resolve(got.argv0),
                    path.resolve(helper),
                    `${target.label}: PowerShell must exec exactly the deployed helper. A quoting defect splits the path at the space or terminates the literal at the apostrophe.\nstdout: ${res.stdout}`,
                );
                assert.equal(got.argc, 0, `${target.label}: the credential helper takes NO arguments; got ${got.argc}: ${JSON.stringify(got.args)}`);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }

    for (const target of [
        { label: 'linux', os: 'linux', shell: '', file: '.fleet-git-credential-github' },
        { label: 'darwin', os: 'darwin', shell: '', file: '.fleet-git-credential-github' },
        { label: 'windows+gitbash', os: 'windows', shell: 'gitbash', file: '.fleet-git-credential-github.bat' },
    ]) {
        test(`${target.label}: real bash execs the helper at HOME with ZERO arguments`, { skip: BASH_SKIP }, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-shrt-'));
            try {
                const home = path.join(root, PLAIN_DIRNAME);
                const helper = writeHelperStandIn(home, target.file);
                const { command } = getSeCommands(target).readCredentialHelper('github');
                const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: home } });
                assert.equal(res.status, 0, `the emitted command must run cleanly under bash.\ncommand: ${command}\nstderr: ${res.stderr}`);

                const got = parseArgvReport(res.stdout);
                assertArgv0MatchesHelper(got.argv0, helper, target.label);
                assert.equal(got.argc, 0, `${target.label}: the credential helper takes NO arguments; got ${got.argc}: ${JSON.stringify(got.args)}`);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }

    // Formerly a KNOWN LIMIT pin: the POSIX/gitbash shapes used to emit a BARE
    // `$HOME/...` word, so the member's own shell word-split it when HOME
    // contained whitespace and the helper was never found. Fixed by
    // apra-fleet-j918.12 (SePosixCommands#invoke now double-quotes the path,
    // inherited by the gitbash subclass) -- replaced with the same positive
    // round-trip assertion the PowerShell targets above already make, so this
    // must not be able to regress back unnoticed.
    for (const target of [
        { label: 'linux', os: 'linux', shell: '', file: '.fleet-git-credential-github' },
        { label: 'darwin', os: 'darwin', shell: '', file: '.fleet-git-credential-github' },
        { label: 'windows+gitbash', os: 'windows', shell: 'gitbash', file: '.fleet-git-credential-github.bat' },
    ]) {
        test(`${target.label}: real bash execs the helper at HOME with ZERO arguments, even when that path carries a quote and a space (apra-fleet-j918.12)`, { skip: BASH_SKIP }, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-shrt-hostile-'));
            try {
                const home = path.join(root, HOSTILE_DIRNAME);
                const helper = writeHelperStandIn(home, target.file);
                const { command } = getSeCommands(target).readCredentialHelper('github');
                const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: home } });
                assert.equal(res.status, 0, `the emitted command must run cleanly under bash even when HOME contains a quote and a space.\ncommand: ${command}\nstderr: ${res.stderr}`);

                const got = parseArgvReport(res.stdout);
                assertArgv0MatchesHelper(got.argv0, helper, target.label);
                assert.equal(got.argc, 0, `${target.label}: the credential helper takes NO arguments; got ${got.argc}: ${JSON.stringify(got.args)}`);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
