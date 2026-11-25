#!/usr/bin/env node
// Re-records unrelated-history.txt: the verbatim output of `bd dolt pull` on a
// clone whose history has no common ancestor with the shared beads remote.
//
// Usage: node record-unrelated-history.mjs [outFile]
// Needs the pinned bd (fleet-sprint/tool-version-pin.mjs BEADS_PACKAGE) and
// git on PATH. Everything runs in a temp sandbox: HOME, USERPROFILE and
// GIT_CONFIG_GLOBAL point inside it, so no real config or beads data is
// touched. ASCII only.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = process.argv[2] || path.join(here, 'unrelated-history.txt');
const T = mkdtempSync(path.join(tmpdir(), 'unrelated-history-'));
const home = path.join(T, 'home');
mkdirSync(home);
const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(T, 'gitconfig'),
    BD_NON_INTERACTIVE: '1', GIT_TERMINAL_PROMPT: '0',
};
const run = (cwd, cmd, args, { allowFail = false } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}${r.stdout}`);
    return r;
};
const versionOf = (cmd, args) => (spawnSync(cmd, args, { env, encoding: 'utf8' }).stdout || '').split('\n')[0].trim();

try {
    const remote = path.join(T, 'remote.git');
    run(T, 'git', ['config', '--global', 'user.email', 'rec@example.invalid']);
    run(T, 'git', ['config', '--global', 'user.name', 'rec']);
    run(T, 'git', ['init', '-q', '--bare', '-b', 'main', remote]);
    // A bare remote with no branch cannot be pushed to by dolt: seed one commit.
    const seed = path.join(T, 'seed');
    run(T, 'git', ['clone', '-q', remote, seed], { allowFail: true });
    run(seed, 'git', ['commit', '-q', '--allow-empty', '-m', 'seed']);
    run(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);

    const A = path.join(T, 'A');
    const B = path.join(T, 'B');
    mkdirSync(A); mkdirSync(B);
    run(A, 'git', ['init', '-q']);
    run(A, 'bd', ['init', '--non-interactive', '--prefix', 'ft']);
    run(A, 'bd', ['dolt', 'remote', 'add', 'origin', remote]);
    run(A, 'bd', ['create', 'first', '-t', 'task']);
    run(A, 'bd', ['create', 'second', '-t', 'task']);
    run(A, 'bd', ['dolt', 'push']);

    // B: a real clone of the remote (same set-up the engine does: workspace
    // files, sync.remote, then bootstrap).
    run(B, 'git', ['init', '-q']);
    mkdirSync(path.join(B, '.beads'));
    writeFileSync(path.join(B, '.beads', 'config.yaml'), '');
    writeFileSync(path.join(B, '.beads', 'config.local.yaml'), `sync.remote: "${remote}"\n`);
    run(B, 'bd', ['config', 'set', 'sync.remote', remote]);
    run(B, 'bd', ['bootstrap', '--yes']);
    run(B, 'bd', ['dolt', 'pull']); // proves B shared history with A

    // CONTROL: the maintenance playbook's flatten + remote data reset on A.
    // Observed on the pinned bd: B's next pull SUCCEEDS, because bd flatten
    // keeps the original root commit, so the histories still share an
    // ancestor. Recorded in the header, not assumed.
    run(A, 'bd', ['flatten', '--force']);
    run(A, 'bd', ['dolt', 'remote', 'reset-data', 'origin', '--yes']);
    run(A, 'bd', ['create', 'third', '-t', 'task']);
    run(A, 'bd', ['dolt', 'push']);
    const controlPull = run(B, 'bd', ['dolt', 'pull'], { allowFail: true });

    // THE CAPTURE: a clone whose history shares NO ancestor with the remote
    // (a database created by its own `bd init`, then pointed at the remote),
    // which is the condition the engine must detect.
    const C = path.join(T, 'C');
    mkdirSync(C);
    run(C, 'git', ['init', '-q']);
    run(C, 'bd', ['init', '--non-interactive', '--prefix', 'ft']);
    run(C, 'bd', ['dolt', 'remote', 'add', 'origin', remote]);
    run(C, 'bd', ['create', 'local-only', '-t', 'task']);
    const pull = run(C, 'bd', ['dolt', 'pull'], { allowFail: true });
    if (pull.status === 0) throw new Error('expected the pull on clone C to fail, but it succeeded');
    const bdV = versionOf('bd', ['--version']);
    const doltV = versionOf('dolt', ['version']);
    const header = [
        '# Verbatim output of `bd dolt pull` on a clone whose Dolt history shares no',
        '# common ancestor with the shared remote (independent `bd init`).',
        `# Control: after bd flatten --force + bd dolt remote reset-data origin --yes on`,
        `# another clone, a bootstrapped clone's pull exited ${controlPull.status} (flatten keeps the root commit).`,
        `# bd: ${bdV}`,
        `# dolt: ${doltV}`,
        `# exit status: ${pull.status}`,
        '# Re-record: node test/fixtures/dolt-unrelated-history/record-unrelated-history.mjs',
        '# Everything below the "---" line is the raw stderr then stdout.',
        '---',
    ].join('\n');
    const body = `${pull.stderr || ''}${pull.stdout ? `\n[stdout]\n${pull.stdout}` : ''}`
        .split(T).join('<SANDBOX>');
    writeFileSync(outFile, `${header}\n${body}`);
    console.log(`wrote ${outFile}`);
} finally {
    rmSync(T, { recursive: true, force: true });
}
