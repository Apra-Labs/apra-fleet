// createCurrentFileHashes (the in-sprint ping-pong guard's live re-hash) must
// never let a KB-supplied file path reach the member's shell as syntax. The
// command it builds is run here through a REAL POSIX shell, with paths that
// carry `$(...)`, backticks and double quotes: every file must hash correctly
// and no injected command may run.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCurrentFileHashes } from '../fleet-sprint/runner.js';

const posix = process.platform !== 'win32';

// A real executor: hands the exact command string to /bin/sh in `cwd`.
function shellCommand(cwd) {
    return async (cmd) => {
        try {
            const output = execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' });
            return { ok: true, output };
        } catch (err) {
            return { ok: false, output: String(err.stdout || '') };
        }
    };
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('hostile file paths are hashed as data and never executed by the shell', { skip: !posix && 'needs /bin/sh' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-file-hashes-'));
    try {
        const names = [
            'plain.txt',
            '$(touch PWNED_DOLLAR).txt',
            '`touch PWNED_BACKTICK`.txt',
            'quote"and$HOME.txt',
        ];
        for (const n of names) fs.writeFileSync(path.join(dir, n), 'content of ' + n);

        const hashes = await createCurrentFileHashes({ command: shellCommand(dir) })('member-a', names);

        assert.deepStrictEqual(Object.keys(hashes).sort(), [...names].sort());
        for (const n of names) assert.strictEqual(hashes[n], sha256(path.join(dir, n)), n);
        assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED_DOLLAR')), false, '$(...) in a path was executed');
        assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED_BACKTICK')), false, 'backticks in a path were executed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a missing file is absent from the result, never given a fabricated hash', { skip: !posix && 'needs /bin/sh' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-file-hashes-'));
    try {
        fs.writeFileSync(path.join(dir, 'present.txt'), 'here');
        const hashes = await createCurrentFileHashes({ command: shellCommand(dir) })('member-a', ['present.txt', 'absent.txt']);
        assert.deepStrictEqual(hashes, { 'present.txt': sha256(path.join(dir, 'present.txt')) });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

