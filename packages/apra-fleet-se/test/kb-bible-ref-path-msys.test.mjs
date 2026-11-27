import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { createBranchWithdrawnEntries, createBaseBibleIds } from '../fleet-sprint/runner.js';

// Git Bash (MSYS) rewrites a git argument such as `origin/main:.fleet/x.json`
// into the path list `origin\main;.fleet\x.json` before git.exe sees it, so
// the bible reads failed on every Windows gitbash member. Every member-bound
// `git ... <ref>:<path>` is built through gitRefPathCommand.

const BIBLE = '.fleet/kb-canonical.json';
const posix = getSeCommands({ os: 'linux', shell: '' });
const powershell = getSeCommands({ os: 'windows', shell: 'powershell5' });
const windowsNoShell = getSeCommands({ os: 'windows', shell: '' });
const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' });
const CMD = `git show origin/main:${BIBLE}`;

describe('gitRefPathCommand per dialect', () => {
    test('gitbash disables MSYS argument conversion with a plain env assignment', () => {
        assert.equal(gitbash.gitRefPathCommand(CMD), `MSYS_NO_PATHCONV=1 ${CMD}`);
    });
    test('POSIX and PowerShell members get the command byte-identical', () => {
        for (const cmds of [posix, powershell, windowsNoShell]) assert.equal(cmds.gitRefPathCommand(CMD), CMD);
    });
});

const tomb = (id) => ({ id, reason: 'withdrawn', note: `note ${id}`, evidence_files: [] });

function recordingCommand(byCmd) {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        const v = byCmd[cmd];
        return v === undefined ? { ok: false, output: 'fatal: bad revision' } : { ok: true, output: typeof v === 'string' ? v : JSON.stringify(v) };
    };
    return { calls, command };
}

describe('bible reads route <ref>:<path> through the member shell', () => {
    const head = { entries: [], demotions: [tomb('kb-base'), tomb('kb-mine')] };
    const base = { entries: [], demotions: [tomb('kb-base')] };

    test('gitbash maintainer: base tombstones are recognised, only the branch\'s own withdrawal is offered', async () => {
        const P = 'MSYS_NO_PATHCONV=1 ';
        const { calls, command } = recordingCommand({ [`${P}git show HEAD:${BIBLE}`]: head, [`${P}git show origin/main:${BIBLE}`]: base });
        const memberShell = async () => gitbash;
        const rows = await createBranchWithdrawnEntries({ command, baseBranch: 'main', memberShell })('win-maint');
        assert.deepEqual(rows.map((r) => r.id), ['kb-mine']);
        assert.deepEqual(calls, [`${P}git show HEAD:${BIBLE}`, `${P}git show origin/main:${BIBLE}`]);
    });

    test('POSIX maintainer: commands unchanged', async () => {
        const { calls, command } = recordingCommand({ [`git show HEAD:${BIBLE}`]: head, [`git show origin/main:${BIBLE}`]: base });
        const rows = await createBranchWithdrawnEntries({ command, baseBranch: 'main', memberShell: async () => posix })('lin-maint');
        assert.deepEqual(rows.map((r) => r.id), ['kb-mine']);
        assert.deepEqual(calls, [`git show HEAD:${BIBLE}`, `git show origin/main:${BIBLE}`]);
    });

    test('createBaseBibleIds: gitbash prefixes the <commit>:<path> read', async () => {
        const sha = '36416c219711c11c435a46cf36b93dbd8549fce7';
        const { calls, command } = recordingCommand({
            [`git ls-tree --name-only ${sha} -- ${BIBLE}`]: BIBLE,
            [`MSYS_NO_PATHCONV=1 git show ${sha}:${BIBLE}`]: { entries: [{ id: 'kb-1' }] },
        });
        const ids = await createBaseBibleIds({ command, memberShell: async () => gitbash })('win-maint', sha);
        assert.deepEqual([...ids], ['kb-1']);
        assert.equal(calls[1], `MSYS_NO_PATHCONV=1 git show ${sha}:${BIBLE}`);
    });
});

// Guard: no member-bound git command with a `<ref>:<path>` argument may
// bypass gitRefPathCmd. Scans every fleet-sprint source file.
describe('guard: no raw <ref>:<path> git command in fleet-sprint', () => {
    test('every `git ... <ref>:<path>` template is built through gitRefPathCmd', () => {
        const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fleet-sprint');
        const files = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(m?js)$/.test(e.name)) files.push(p);
            }
        };
        walk(root);
        // A backtick git command whose argument is `<ref or ${...}>:<${...} or .path>`.
        const refPath = /`git [^`]*?[\w}]:(\$\{|\.)/;
        const offenders = [];
        for (const f of files) {
            fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
                if (/^\s*(\/\/|\*)/.test(line)) return;
                if (refPath.test(line) && !line.includes('gitRefPathCmd(')) offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
            });
        }
        assert.ok(files.length > 10, 'scanned the fleet-sprint sources');
        assert.deepEqual(offenders, [], 'route these through gitRefPathCmd (Git Bash would rewrite the argument)');
    });
});

// Real Git Bash: the bare command is mangled, the built one reads the bible.
function findGitBash() {
    if (process.platform !== 'win32') return null;
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    // <git root>/mingw64/libexec/git-core -> <git root>/usr/bin/bash.exe
    const bash = path.join(r.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe');
    return fs.existsSync(bash) ? bash : null;
}
const gitBash = findGitBash();

describe('real Git Bash', { skip: gitBash ? false : 'needs Git for Windows bash (win32 only)' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msys-refpath-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('origin/main:.fleet/kb-canonical.json reads only with the gitbash form', () => {
        const git = (...a) => {
            const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
            return r.stdout.trim();
        };
        git('init', '-q');
        fs.mkdirSync(path.join(dir, '.fleet'));
        fs.writeFileSync(path.join(dir, BIBLE), '{"entries":[]}\n');
        git('add', '.');
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'bible');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        // Conversion must be on, whatever the host shell exports.
        const env = { ...process.env };
        delete env.MSYS_NO_PATHCONV;
        delete env.MSYS2_ARG_CONV_EXCL;
        const run = (cmd) => spawnSync(gitBash, ['-c', cmd], { cwd: dir, encoding: 'utf8', env });

        const bare = run(CMD);
        assert.notEqual(bare.status, 0, 'Git Bash mangles the bare argument');
        assert.match(bare.stderr, /origin\\main;\.fleet\\kb-canonical\.json/);

        const built = run(gitbash.gitRefPathCommand(CMD));
        assert.equal(built.status, 0, built.stderr);
        assert.deepEqual(JSON.parse(built.stdout), { entries: [] });
    });
});
