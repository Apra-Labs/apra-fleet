// A test must never write into THIS checkout's git hooks (shared by every
// worktree): a test-time kb_setup once left the KB post-commit hook in the
// developer's real repository, running `kb invalidate` on every commit.
// run-all-tests.mjs snapshots the hooks dir before each suite and, after it,
// restores the dir and fails that suite naming every hook it added or changed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The checkout's shared hooks dir, or null outside a git checkout. */
export function repoHooksDir(cwd = process.cwd()) {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    return path.resolve(cwd, r.stdout.trim(), 'hooks');
}

/** name -> content of every non-sample hook file in `dir`. */
export function snapshotHooks(dir) {
    const snap = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return snap; }
    for (const name of names) {
        if (name.endsWith('.sample')) continue;
        try {
            const file = path.join(dir, name);
            if (fs.statSync(file).isFile()) snap.set(name, fs.readFileSync(file));
        } catch { /* raced away */ }
    }
    return snap;
}

/** Restores `dir` to `before`; returns the hooks that were added or changed. */
export function restoreLeakedHooks(dir, before) {
    const leaked = [];
    for (const [name, content] of snapshotHooks(dir)) {
        const prior = before.get(name);
        if (prior && prior.equals(content)) continue;
        leaked.push(`${name} (${prior ? 'changed' : 'added'})`);
        try {
            if (prior) fs.writeFileSync(path.join(dir, name), prior);
            else fs.rmSync(path.join(dir, name), { force: true });
        } catch { /* still reported */ }
    }
    return leaked;
}
