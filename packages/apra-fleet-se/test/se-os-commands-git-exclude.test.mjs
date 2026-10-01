import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    getSeCommands,
    SePosixCommands,
    SeWindowsCommands,
    SeWindowsGitbashCommands,
} from '../fleet-sprint/se-os-commands.mjs';

// The ensureGitExcluded / removeFile primitives (member-call.mjs's args-file
// cleanup). String-level shape for every dialect, plus real-bash behaviour in
// temp git repos, plus (when pwsh happens to be installed) real-PowerShell
// behaviour of the decoded -EncodedCommand payload.

const ENTRY = '.apra-call/';
const FILE = '.apra-call/call-abc123.json';

const posix = getSeCommands({ os: 'linux', shell: 'bash' });
const powershell = getSeCommands({ os: 'windows', shell: 'powershell' });
const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' });

const EXPECTED_POSIX_EXCLUDE = `if excl=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -n "$excl" ]; then `
    + `mkdir -p "$(dirname "$excl")" && { grep -qxF -- '.apra-call/' "$excl" 2>/dev/null || { `
    + `if [ -s "$excl" ] && [ -n "$(tail -c 1 "$excl")" ]; then printf '\\n' >> "$excl"; fi; `
    + `printf '%s\\n' '.apra-call/' >> "$excl"; }; }; fi`;

/** Decode a `powershell -EncodedCommand <b64>` string (se-windows envelope). */
function decodePs(command) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
    assert.ok(m, `not a PowerShell -EncodedCommand envelope: ${command}`);
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

function assertNoMemberEnvExpansion(text) {
    for (const bad of ['$env:', '$HOME', '~/', String.fromCharCode(96)]) {
        assert.ok(!text.includes(bad), `generated command must not contain ${JSON.stringify(bad)}: ${text}`);
    }
}

const tmpRoots = [];
function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'se-git-exclude-'));
    tmpRoots.push(d);
    return d;
}
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** Env that stops git discovery at `ceiling` so a non-git temp dir is never inside some outer repo. */
function gitEnv(ceiling) {
    return { ...process.env, GIT_CEILING_DIRECTORIES: ceiling };
}

function initRepo(dir) {
    const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
}

function runBash(command, cwd, env) {
    return spawnSync('bash', ['-c', command], { cwd, env, encoding: 'utf8' });
}

function excludePath(repoDir) {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repoDir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return path.resolve(repoDir, r.stdout.trim());
}

function countLines(file, line) {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l === line).length;
}

const isWin = process.platform === 'win32';
const hasPwsh = !isWin && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe('git-exclude / remove-file primitives: shape per dialect', () => {
    test('every dialect exposes both primitives', () => {
        for (const cmds of [posix, powershell, gitbash]) {
            assert.equal(typeof cmds.ensureGitExcluded, 'function', `${cmds.shell} ensureGitExcluded`);
            assert.equal(typeof cmds.removeFile, 'function', `${cmds.shell} removeFile`);
        }
        assert.ok(posix instanceof SePosixCommands);
        assert.ok(powershell instanceof SeWindowsCommands);
        assert.ok(gitbash instanceof SeWindowsGitbashCommands);
    });

    test('POSIX: exact command strings (plain, unwrapped)', () => {
        assert.equal(posix.ensureGitExcluded(ENTRY), EXPECTED_POSIX_EXCLUDE);
        assert.equal(posix.removeFile(FILE), `rm -f -- '.apra-call/call-abc123.json'`);
    });

    test('gitbash: bash strings identical to POSIX (inherited)', () => {
        assert.equal(gitbash.ensureGitExcluded(ENTRY), EXPECTED_POSIX_EXCLUDE);
        assert.equal(gitbash.removeFile(FILE), posix.removeFile(FILE));
    });

    test('PowerShell: -EncodedCommand envelope whose decoded script resolves the exclude file via git', () => {
        const script = decodePs(powershell.ensureGitExcluded(ENTRY));
        assert.ok(script.startsWith(`$ErrorActionPreference = 'Stop'; try { `), script);
        assert.ok(script.includes('git rev-parse --git-path info/exclude 2>$null'), script);
        assert.ok(script.includes(`-notcontains '.apra-call/'`), script);
        assert.ok(script.includes(`Add-Content -LiteralPath $excl -NoNewline -Value ($prefix + '.apra-call/' + $lf)`), script);
        assert.ok(script.includes('New-Item -ItemType Directory -Force -Path $dir'), script);
        assert.ok(script.includes('$global:LASTEXITCODE = 0'), script);

        const rm = decodePs(powershell.removeFile(FILE));
        assert.ok(rm.includes(`if (Test-Path -LiteralPath '.apra-call/call-abc123.json') { Remove-Item -LiteralPath '.apra-call/call-abc123.json' -Force }`), rm);
    });

    test('no generated command (decoded for PowerShell) expands member environment', () => {
        for (const cmds of [posix, gitbash]) {
            assertNoMemberEnvExpansion(cmds.ensureGitExcluded(ENTRY));
            assertNoMemberEnvExpansion(cmds.removeFile(FILE));
        }
        assertNoMemberEnvExpansion(decodePs(powershell.ensureGitExcluded(ENTRY)));
        assertNoMemberEnvExpansion(decodePs(powershell.removeFile(FILE)));
    });

    test('unsafe paths are rejected with a thrown error, never interpolated', () => {
        const unsafe = [
            '.apra-call/$x.json', '.apra-call/' + String.fromCharCode(96) + 'id' + String.fromCharCode(96),
            '.apra-call/a b.json', '~/x.json', '.apra-call/a;rm.json', '../x.json', '.apra-call/../../x',
            '/etc/passwd', '-rf', '', "a'b",
        ];
        for (const cmds of [posix, powershell, gitbash]) {
            for (const p of unsafe) {
                assert.throws(() => cmds.removeFile(p), /unsafe file path/, `${cmds.shell} removeFile(${JSON.stringify(p)})`);
                assert.throws(() => cmds.ensureGitExcluded(p), /unsafe git-exclude entry/, `${cmds.shell} ensureGitExcluded(${JSON.stringify(p)})`);
            }
        }
    });
});

describe('git-exclude / remove-file primitives: real bash', { skip: isWin ? 'POSIX command strings are executed with bash; skipped on win32 hosts' : false }, () => {
    test('exclude run twice in a temp git repo leaves exactly one entry line', () => {
        const root = mkTmp();
        const repo = path.join(root, 'repo');
        initRepo(repo);
        for (let i = 0; i < 2; i++) {
            const r = runBash(posix.ensureGitExcluded(ENTRY), repo, gitEnv(root));
            assert.equal(r.status, 0, r.stderr);
        }
        assert.equal(countLines(excludePath(repo), ENTRY), 1);
    });

    test('exclude from a repo subdirectory with no info/ dir creates it; missing trailing newline is repaired', () => {
        const root = mkTmp();
        const repo = path.join(root, 'repo');
        initRepo(repo);
        fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
        const sub = path.join(repo, 'a', 'b');
        fs.mkdirSync(sub, { recursive: true });
        let r = runBash(posix.ensureGitExcluded(ENTRY), sub, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), `${ENTRY}\n`);

        fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'foo');
        r = runBash(posix.ensureGitExcluded(ENTRY), sub, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), `foo\n${ENTRY}\n`);
    });

    test('exclude in a non-git temp dir exits 0 and creates nothing', () => {
        const root = mkTmp();
        const plain = path.join(root, 'plain');
        fs.mkdirSync(plain);
        const r = runBash(posix.ensureGitExcluded(ENTRY), plain, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(fs.readdirSync(plain), []);
        assert.deepEqual(fs.readdirSync(root), ['plain']);
    });

    test('remove deletes a present file and exits 0 on a missing one', () => {
        const root = mkTmp();
        fs.mkdirSync(path.join(root, '.apra-call'));
        fs.writeFileSync(path.join(root, FILE), '{}');
        let r = runBash(posix.removeFile(FILE), root, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.existsSync(path.join(root, FILE)), false);
        r = runBash(posix.removeFile(FILE), root, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
    });
});

describe('git-exclude / remove-file primitives: real PowerShell', { skip: hasPwsh ? false : 'pwsh not installed on this host' }, () => {
    /** Run the se-windows envelope with pwsh (same -EncodedCommand payload a Windows member's powershell gets). */
    function runPs(command, cwd, env) {
        const b64 = command.split(' ').pop();
        return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { cwd, env, encoding: 'utf8' });
    }

    test('exclude twice -> one LF-terminated line; non-git dir -> exit 0, nothing created', () => {
        const root = mkTmp();
        const repo = path.join(root, 'repo');
        initRepo(repo);
        fs.writeFileSync(excludePath(repo), 'foo');
        for (let i = 0; i < 2; i++) {
            const r = runPs(powershell.ensureGitExcluded(ENTRY), repo, gitEnv(root));
            assert.equal(r.status, 0, r.stderr);
        }
        assert.equal(fs.readFileSync(excludePath(repo), 'utf8'), `foo\n${ENTRY}\n`);

        const plain = path.join(root, 'plain');
        fs.mkdirSync(plain);
        const r = runPs(powershell.ensureGitExcluded(ENTRY), plain, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(fs.readdirSync(plain), []);
    });

    test('remove deletes a present file and exits 0 on a missing one', () => {
        const root = mkTmp();
        fs.mkdirSync(path.join(root, '.apra-call'));
        fs.writeFileSync(path.join(root, FILE), '{}');
        let r = runPs(powershell.removeFile(FILE), root, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.existsSync(path.join(root, FILE)), false);
        r = runPs(powershell.removeFile(FILE), root, gitEnv(root));
        assert.equal(r.status, 0, r.stderr);
    });
});
