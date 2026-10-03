import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

// ensureFile: create a work-folder-relative file (and its parent dir) when
// absent, never truncating an existing one. String shape for every dialect,
// plus real-shell behaviour (bash everywhere it exists; Windows PowerShell on
// a Windows host) run twice to prove idempotence.

const FILE = '.beads/config.yaml';
const posix = getSeCommands({ os: 'linux', shell: 'bash' });
const powershell = getSeCommands({ os: 'windows', shell: 'powershell' });
const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' });

function decodePs(command) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
    assert.ok(m, `not a PowerShell -EncodedCommand envelope: ${command}`);
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

const tmpRoots = [];
function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ensure-file-'));
    tmpRoots.push(d);
    return d;
}
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

function hasExe(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

describe('ensureFile command shape', () => {
    test('POSIX (and gitbash): mkdir -p of the parent, then create only when absent', () => {
        const expected = `mkdir -p -- '.beads' && { [ -e '.beads/config.yaml' ] || : > '.beads/config.yaml'; }`;
        assert.equal(posix.ensureFile(FILE), expected);
        assert.equal(gitbash.ensureFile(FILE), expected);
        assert.equal(posix.ensureFile('x.txt'), `{ [ -e 'x.txt' ] || : > 'x.txt'; }`);
    });

    test('PowerShell: Test-Path guarded, literal paths only, no member environment reads', () => {
        const script = decodePs(powershell.ensureFile(FILE));
        assert.ok(script.includes(`if (-not (Test-Path -LiteralPath '.beads')) { New-Item -ItemType Directory -Force -Path '.beads' | Out-Null }`), script);
        assert.ok(script.includes(`if (-not (Test-Path -LiteralPath '.beads/config.yaml')) { New-Item -ItemType File -Path '.beads/config.yaml' | Out-Null }`), script);
        for (const bad of ['$env:', '$HOME', '~/', String.fromCharCode(96)]) assert.ok(!script.includes(bad), `${bad} in ${script}`);
    });

    test('refuses unsafe paths', () => {
        for (const bad of ['../x', '/etc/passwd', "a'b", 'a b', '-x']) {
            assert.throws(() => posix.ensureFile(bad));
            assert.throws(() => powershell.ensureFile(bad));
        }
    });
});

describe('ensureFile on real shells', () => {
    const runTwice = (run) => {
        const dir = mkTmp();
        run(dir);
        const target = path.join(dir, '.beads', 'config.yaml');
        assert.ok(fs.existsSync(target), 'created');
        assert.equal(fs.readFileSync(target, 'utf8'), '');
        fs.writeFileSync(target, 'keep: me\n');
        run(dir);
        assert.equal(fs.readFileSync(target, 'utf8'), 'keep: me\n', 'an existing file is never truncated');
    };

    test('bash', { skip: !hasExe('bash', ['-c', 'true']) && 'no bash on this host' }, () => {
        runTwice((dir) => {
            const r = spawnSync('bash', ['-c', posix.ensureFile(FILE)], { cwd: dir, encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
        });
    });

    test('Windows PowerShell', { skip: process.platform !== 'win32' && 'not a Windows host' }, () => {
        runTwice((dir) => {
            const [exe, flag, b64] = powershell.ensureFile(FILE).split(' ');
            const r = spawnSync(exe, ['-NoProfile', flag, b64], { cwd: dir, encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
        });
    });
});
