import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    getSeCommands,
    SePosixCommands,
    SeWindowsCommands,
    SeWindowsGitbashCommands,
} from '../fleet-sprint/se-os-commands.mjs';
import { buildCredentialReadCommand } from '../fleet-sprint/runner.js';

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
