// createCurrentFileHashes (the in-sprint ping-pong guard's live re-hash) must
// never let a KB-supplied file path reach the member's shell as syntax, and
// must return a PLAIN sha256 of each file's bytes (never a line-ending
// normalised one). The command it builds is run here through the REAL shells
// a member of this OS would run it in -- /bin/sh on POSIX; PowerShell and
// cmd.exe on Windows -- with paths that carry that shell's expansion syntax:
// every file must hash correctly and no injected command may run.
//
// No test here is skipped on any OS: each OS runs the cases for its own
// shells, so the Windows path runs on Windows and the POSIX path on POSIX.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCurrentFileHashes } from '../fleet-sprint/runner.js';

const isWindows = process.platform === 'win32';

function runIn(file, args, cwd, extra = {}) {
    return execFileSync(file, args, { cwd, encoding: 'utf8', windowsHide: true, ...extra });
}

// The shells a member of this OS runs a command string in. Each `run` hands
// the EXACT command string to that shell.
const SHELLS = isWindows
    ? [
        { name: 'PowerShell', run: (cmd, cwd) => runIn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], cwd) },
        // Node's own shell:true form for cmd.exe: /d /s /c "<cmd>", verbatim.
        { name: 'cmd.exe', run: (cmd, cwd) => runIn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], cwd, { windowsVerbatimArguments: true }) },
    ]
    : [
        { name: '/bin/sh', run: (cmd, cwd) => runIn('/bin/sh', ['-c', cmd], cwd) },
    ];

// File names carrying each shell family's expansion syntax. Windows file
// names cannot hold a double quote, so its list differs.
const HOSTILE_NAMES = isWindows
    ? [
        'plain.txt',
        '$(New-Item PWNED_DOLLAR).txt',
        '; New-Item PWNED_SEMI;.txt',
        '%PATH% & mkdir PWNED_PERCENT &.txt',
    ]
    : [
        'plain.txt',
        '$(touch PWNED_DOLLAR).txt',
        '`touch PWNED_BACKTICK`.txt',
        'quote"and$HOME.txt',
    ];
// A name above that the shell executed would create one of these in `cwd`.
const PWNED_MARKERS = ['PWNED_DOLLAR', 'PWNED_BACKTICK', 'PWNED_SEMI', 'PWNED_PERCENT'];

// A real executor: the exact command string runs in `shell` in `cwd`.
function shellCommand(shell, cwd) {
    return async (cmd) => {
        try {
            return { ok: true, output: shell.run(cmd, cwd) };
        } catch (err) {
            return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
        }
    };
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-file-hashes-'));
    return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

for (const shell of SHELLS) {
    test(`[${shell.name}] hostile file paths are hashed as data and never executed by the shell`, async () => {
        await withTempDir(async (dir) => {
            for (const n of HOSTILE_NAMES) fs.writeFileSync(path.join(dir, n), 'content of ' + n);

            const hashes = await createCurrentFileHashes({ command: shellCommand(shell, dir) })('member-a', HOSTILE_NAMES);

            assert.deepStrictEqual(Object.keys(hashes).sort(), [...HOSTILE_NAMES].sort());
            for (const n of HOSTILE_NAMES) assert.strictEqual(hashes[n], sha256(path.join(dir, n)), n);
            for (const marker of PWNED_MARKERS) {
                assert.strictEqual(fs.existsSync(path.join(dir, marker)), false, `${marker}: a path was executed by ${shell.name}`);
            }
        });
    });

    test(`[${shell.name}] the hash is a plain sha256 of the file bytes -- CRLF content is not normalised`, async () => {
        await withTempDir(async (dir) => {
            const crlf = Buffer.from('line one\r\nline two\r\n', 'utf8');
            fs.writeFileSync(path.join(dir, 'crlf.txt'), crlf);
            const expected = crypto.createHash('sha256').update(crlf).digest('hex');
            const normalised = crypto.createHash('sha256').update(Buffer.from('line one\nline two\n', 'utf8')).digest('hex');

            const hashes = await createCurrentFileHashes({ command: shellCommand(shell, dir) })('member-a', ['crlf.txt']);

            assert.strictEqual(hashes['crlf.txt'], expected);
            assert.notStrictEqual(hashes['crlf.txt'], normalised);
        });
    });

    test(`[${shell.name}] a missing file is absent from the result, never given a fabricated hash`, async () => {
        await withTempDir(async (dir) => {
            fs.writeFileSync(path.join(dir, 'present.txt'), 'here');
            const hashes = await createCurrentFileHashes({ command: shellCommand(shell, dir) })('member-a', ['present.txt', 'absent.txt']);
            assert.deepStrictEqual(hashes, { 'present.txt': sha256(path.join(dir, 'present.txt')) });
        });
    });
}
