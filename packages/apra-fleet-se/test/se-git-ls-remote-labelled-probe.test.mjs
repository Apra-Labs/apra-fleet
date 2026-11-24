// The VCS preflight's git channel probe: `git ls-remote origin HEAD` through
// ONLY the fleet-labelled credential helper (helper list reset, then the
// labelled helper file), non-interactive, on every member dialect (posix,
// gitbash, powershell). The helper path is resolved in JavaScript from the
// home memberHomeProbe printed, so the command relies on no shell expansion.
// String-level, plus one POSIX run of the built string against a stub `git`
// that prints the argv it received (temp dir only; nothing else touched).
// ASCII only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

const MEMBER_ID = '3f2c9a10-1111-4222-8333-944455556666';
const BQ = String.fromCharCode(96);

const decodeInner = (cmd) => {
    const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
    assert.ok(m, `expected an encoded PowerShell envelope, got: ${cmd}`);
    const full = Buffer.from(m[1], 'base64').toString('utf16le');
    // The script this builder wrote, without the shared envelope's own
    // $ErrorActionPreference / $LASTEXITCODE handling.
    const inner = /try \{ ([\s\S]*); if \(\$LASTEXITCODE/.exec(full);
    assert.ok(inner, full);
    return inner[1];
};

const dialects = [
    {
        name: 'posix',
        target: { os: 'linux', shell: '' },
        home: '/home/dev',
        legacy: '/home/dev/.fleet-git-credential-bitbucket',
        scoped: `/home/dev/.fleet-git-credential-bitbucket.${MEMBER_ID}`,
        script: (c) => c,
    },
    {
        name: 'gitbash',
        target: { os: 'windows', shell: 'gitbash' },
        home: 'C:/Users/dev\n',
        legacy: 'C:/Users/dev/.fleet-git-credential-bitbucket.bat',
        scoped: `C:/Users/dev/.fleet-git-credential-bitbucket.${MEMBER_ID}.bat`,
        script: (c) => c,
    },
    {
        name: 'powershell',
        target: { os: 'windows', shell: 'powershell5' },
        home: 'C:\\Users\\dev',
        legacy: 'C:/Users/dev/.fleet-git-credential-bitbucket.bat',
        scoped: `C:/Users/dev/.fleet-git-credential-bitbucket.${MEMBER_ID}.bat`,
        script: decodeInner,
    },
];

describe('gitLsRemoteLabelledProbe: labelled helper only, per dialect', () => {
    for (const d of dialects) {
        for (const [variant, memberId, expected] of [['legacy', undefined, d.legacy], ['member-scoped', MEMBER_ID, d.scoped]]) {
            test(`${d.name} ${variant}: resets the helper list, names exactly the labelled helper, never prompts, no shell expansion`, () => {
                const built = getSeCommands(d.target).gitLsRemoteLabelledProbe('bitbucket', memberId, d.home);
                assert.equal(built.descriptor, expected);
                const s = d.script(built.command);
                // Helper list reset BEFORE the labelled helper.
                const reset = s.search(/-c '?credential\.helper='? /);
                const named = s.indexOf(`credential.helper=!`);
                assert.ok(reset >= 0 && named > reset, s);
                // Exactly one helper named, and it is the labelled file.
                assert.equal(s.split('credential.helper=!').length - 1, 1, s);
                assert.ok(s.includes(`'${expected}'`), s);
                assert.equal(s.split('.fleet-git-credential-').length - 1, 1, s);
                if (memberId) assert.ok(s.includes(MEMBER_ID), s);
                else assert.ok(!s.includes(MEMBER_ID), s);
                assert.match(s, /ls-remote origin HEAD$/);
                // Non-interactive.
                assert.match(s, /GIT_TERMINAL_PROMPT[ =-]+(Value )?'?0'?/);
                assert.match(s, /GCM_INTERACTIVE[ =-]+(Value )?'?never'?/);
                assert.match(s, /core\.askPass=/);
                assert.match(s, /GIT_ASKPASS/);
                // No shell expansion of any kind.
                assert.ok(!s.includes('$'), `no $ expansion: ${s}`);
                assert.ok(!s.includes('~/'), `no ~/ expansion: ${s}`);
                assert.ok(!s.includes(BQ), `no backtick: ${s}`);
            });
        }

        test(`${d.name}: an unusable home or label is refused, never embedded`, () => {
            const se = getSeCommands(d.target);
            assert.throws(() => se.gitLsRemoteLabelledProbe('bitbucket', undefined, 'relative/home'), /unusable member home/);
            assert.throws(() => se.gitLsRemoteLabelledProbe('bitbucket', undefined, d.name === 'posix' ? '/home/$USER' : 'C:/Users/$x'), /unusable member home/);
            assert.throws(() => se.gitLsRemoteLabelledProbe('bitbucket', undefined, ''), /unusable member home/);
            assert.throws(() => se.gitLsRemoteLabelledProbe('a; rm -rf /', undefined, d.legacy.split('/.fleet')[0]), /unsafe VCS credential label/);
            assert.throws(() => se.gitLsRemoteLabelledProbe('bitbucket', 'id;rm', d.legacy.split('/.fleet')[0]), /unsafe member id/);
        });
    }

    test('the home probe is per dialect', () => {
        assert.equal(getSeCommands({ os: 'linux' }).memberHomeProbe(), `printf '%s' "$HOME"`);
        assert.equal(getSeCommands({ os: 'windows', shell: 'gitbash' }).memberHomeProbe(), 'cygpath -m "$HOME"');
        const ps = getSeCommands({ os: 'windows', shell: '' }).memberHomeProbe();
        assert.match(Buffer.from(ps.split(' ').pop(), 'base64').toString('utf16le'), /\[Console\]::Out\.Write\(\$env:USERPROFILE\)/);
    });

    test('a home with a space and an apostrophe is quoted, not refused (powershell)', () => {
        const built = getSeCommands({ os: 'windows', shell: '' }).gitLsRemoteLabelledProbe('bitbucket', undefined, "C:\\Users\\Jo O'Neil");
        assert.equal(built.descriptor, "C:/Users/Jo O'Neil/.fleet-git-credential-bitbucket.bat");
        // git value !'C:/Users/Jo O'\''Neil/...' inside a PowerShell literal ('' for ').
        assert.ok(decodeInner(built.command).includes(`-c 'credential.helper=!''C:/Users/Jo O''\\''''Neil/.fleet-git-credential-bitbucket.bat''' ls-remote`), decodeInner(built.command));
    });
});

describe('gitLsRemoteLabelledProbe: the POSIX string reaches git as intended', { skip: process.platform === 'win32' }, () => {
    test('git receives the reset, the askpass reset and the one labelled helper value; env disables prompts', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelled-probe-'));
        try {
            const stub = path.join(dir, 'git');
            fs.writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf "ARG<%s>\\n" "$a"; done\nprintf "ENV<%s|%s|%s|%s>\\n" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "${GIT_ASKPASS-unset}" "${SSH_ASKPASS-unset}"\n');
            fs.chmodSync(stub, 0o755);
            const home = "/home/a b/O'Neil";
            const built = getSeCommands({ os: 'linux' }).gitLsRemoteLabelledProbe('bitbucket', MEMBER_ID, home);
            const out = execFileSync('/bin/sh', ['-c', built.command], { env: { PATH: `${dir}:/usr/bin:/bin`, GIT_ASKPASS: '/x/askpass' }, encoding: 'utf8' });
            assert.deepEqual(out.trim().split('\n'), [
                'ARG<-c>', 'ARG<credential.helper=>',
                'ARG<-c>', 'ARG<core.askPass=>',
                'ARG<-c>', `ARG<credential.helper=!'/home/a b/O'\\''Neil/.fleet-git-credential-bitbucket.${MEMBER_ID}'>`,
                'ARG<ls-remote>', 'ARG<origin>', 'ARG<HEAD>',
                'ENV<0|never||>',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
