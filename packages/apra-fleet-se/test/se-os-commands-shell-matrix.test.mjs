import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
        // gitbash member: a bare unquoted $HOME/... path to a .bat helper.
        assert.equal(command, '$HOME/.fleet-git-credential-github-push-pr.bat');
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

    test('a plain "linux" OS string (back-compat callers) gets the byte-identical historical POSIX string', () => {
        const { command, descriptor } = buildCredentialReadCommand('linux', 'github-push-pr');
        assert.equal(command, '$HOME/.fleet-git-credential-github-push-pr');
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
    test('no se-os-commands implementation spawns a process or shells out to build a command string', () => {
        // Every primitive below is pure string construction; none of them
        // should require (or attempt) to invoke a real shell binary. Driving
        // the full resolution + read-credential-helper matrix here, with no
        // child_process interception installed and no failure, is itself the
        // proof: if any implementation shelled out on a host with neither
        // gitbash.exe nor powershell.exe on PATH, this test would throw
        // ENOENT rather than return a string.
        const matrix = [
            { os: 'linux', shell: '' },
            { os: 'darwin', shell: '' },
            { os: 'windows', shell: 'gitbash' },
            { os: 'windows', shell: 'pwsh7' },
            { os: 'windows', shell: 'powershell5' },
            { os: 'windows', shell: '' },
        ];
        for (const target of matrix) {
            const cmds = getSeCommands(target);
            const { command, descriptor } = cmds.readCredentialHelper('github');
            assert.equal(typeof command, 'string');
            assert.ok(command.length > 0);
            assert.equal(typeof descriptor, 'string');
            assert.ok(descriptor.length > 0);
        }
    });
});
