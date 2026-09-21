import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    discoverBeadsDir,
    resolveBeadsDirArg,
    probeBeadsIdentity,
    createBeadsIdentityState,
    toBeadsSummary,
    BEADS_DIR_NAME,
} from '../src/supervisor/beads-identity.mjs';
import { renderIndexPageHtml, renderBeadsHeaderHtml, renderSprintSection, buildStatePayload } from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

// src/supervisor/beads-identity.mjs -- which .beads the supervisor runs
// against: bd-style walk-up discovery, the three read-only probes (parsed by
// the shared fleet-sprint/beads-identity.mjs helper) with injected fakes so
// no real bd/git is ever needed, and the refreshable state handle.

/** An in-memory fs exposing only the directories in `dirs` (absolute paths). */
function fakeFs(dirs) {
    const set = new Set(dirs.map((d) => path.resolve(d)));
    return {
        existsSync: (p) => set.has(path.resolve(p)),
        statSync: (p) => {
            if (!set.has(path.resolve(p))) throw new Error('ENOENT');
            return { isDirectory: () => true };
        },
    };
}

const ROOT = path.resolve('/proj');

describe('discoverBeadsDir', () => {
    test('finds .beads directly in cwd', () => {
        const fs = fakeFs([ROOT, path.join(ROOT, BEADS_DIR_NAME)]);
        assert.deepEqual(discoverBeadsDir({ cwd: ROOT, fs }), {
            beadsDir: path.join(ROOT, '.beads'),
            repoRoot: ROOT,
        });
    });

    test('walks up to an ancestor holding .beads and reports that ancestor as repoRoot', () => {
        const deep = path.join(ROOT, 'packages', 'x', 'src');
        const fs = fakeFs([ROOT, path.join(ROOT, '.beads'), deep]);
        assert.deepEqual(discoverBeadsDir({ cwd: deep, fs }), {
            beadsDir: path.join(ROOT, '.beads'),
            repoRoot: ROOT,
        });
    });

    test('returns null when no ancestor has .beads', () => {
        const fs = fakeFs([ROOT, path.join(ROOT, 'a')]);
        assert.equal(discoverBeadsDir({ cwd: path.join(ROOT, 'a'), fs }), null);
    });

    test('a .beads FILE (not a directory) does not count', () => {
        const fs = {
            existsSync: () => true,
            statSync: () => ({ isDirectory: () => false }),
        };
        assert.equal(discoverBeadsDir({ cwd: ROOT, fs }), null);
    });
});

describe('resolveBeadsDirArg', () => {
    test('a project folder resolves to itself; its .beads dir resolves to the parent', () => {
        const fs = fakeFs([ROOT, path.join(ROOT, '.beads')]);
        assert.equal(resolveBeadsDirArg(ROOT, { fs }), ROOT);
        assert.equal(resolveBeadsDirArg(path.join(ROOT, '.beads'), { fs }), ROOT);
    });

    test('a nonexistent path or empty value throws a clear error', () => {
        const fs = fakeFs([ROOT]);
        assert.throws(() => resolveBeadsDirArg(path.join(ROOT, 'missing'), { fs }), /--beads-dir '.*missing' does not exist/);
        assert.throws(() => resolveBeadsDirArg('', { fs }), /requires a path/);
    });
});

const WHERE_JSON = JSON.stringify({ database_path: 'C:\\x\\.beads\\embeddeddolt', path: 'C:\\x\\.beads', prefix: 'proj', schema_version: 1 });
const REMOTE_JSON = JSON.stringify({ key: 'sync.remote', value: 'git+https://github.com/Org/repo.git' });

/** Fake execBd/execGit pair; records every call's args + cwd. */
function fakeExecs({ where = WHERE_JSON, remote = REMOTE_JSON, origin = 'https://github.com/Org/repo.git\n', whereFails = null } = {}) {
    const calls = [];
    const execBd = async (args, options) => {
        calls.push({ kind: 'bd', args, cwd: options.cwd });
        if (args[0] === 'where') {
            if (whereFails) throw whereFails;
            return { stdout: where, stderr: '' };
        }
        if (args[0] === 'config') return { stdout: remote, stderr: '' };
        throw new Error(`unexpected bd args ${args.join(' ')}`);
    };
    const execGit = async (file, args, options) => {
        calls.push({ kind: 'git', file, args, cwd: options.cwd });
        if (origin instanceof Error) throw origin;
        return { stdout: origin, stderr: '' };
    };
    return { execBd, execGit, calls };
}

describe('probeBeadsIdentity', () => {
    test('runs the three probes in the given cwd and parses them into one record', async () => {
        const { execBd, execGit, calls } = fakeExecs();
        const id = await probeBeadsIdentity({ cwd: ROOT, execBd, execGit });
        assert.deepEqual(id, {
            beadsDir: 'C:\\x\\.beads',
            prefix: 'proj',
            databasePath: 'C:\\x\\.beads\\embeddeddolt',
            syncRemote: 'git+https://github.com/Org/repo.git',
            repoRemote: 'https://github.com/Org/repo.git',
        });
        assert.deepEqual(calls.map((c) => c.kind === 'bd' ? c.args.join(' ') : `${c.file} ${c.args.join(' ')}`), [
            'where --json',
            'config get sync.remote --json',
            'git remote get-url origin',
        ]);
        assert.ok(calls.every((c) => c.cwd === ROOT), 'every probe runs in the requested cwd');
    });

    test('an unset sync.remote (bd exit 0, value "") is not an error: syncRemote is simply empty', async () => {
        const { execBd, execGit } = fakeExecs({ remote: JSON.stringify({ key: 'sync.remote', value: '' }) });
        const id = await probeBeadsIdentity({ cwd: ROOT, execBd, execGit });
        assert.equal(id.syncRemote, '');
        assert.equal(id.prefix, 'proj');
    });

    test('a failing git origin probe folds to an empty repoRemote (no throw)', async () => {
        const { execBd, execGit } = fakeExecs({ origin: new Error('fatal: No such remote') });
        const id = await probeBeadsIdentity({ cwd: ROOT, execBd, execGit });
        assert.equal(id.repoRemote, '');
    });

    test('a failing `bd where` throws a message naming the command, the cwd and bd\'s own output', async () => {
        const err = Object.assign(new Error('Command failed: bd where --json'), {
            stdout: JSON.stringify({ error: 'no_beads_directory', message: 'No active beads workspace found.' }),
            stderr: '',
        });
        const { execBd, execGit } = fakeExecs({ whereFails: err });
        await assert.rejects(
            () => probeBeadsIdentity({ cwd: ROOT, execBd, execGit }),
            (e) => e.message.includes("'bd where --json' failed in") && e.message.includes(ROOT) && e.message.includes('no_beads_directory'),
        );
    });

    test('a `bd where` answer with no path is rejected rather than reported as an empty identity', async () => {
        const { execBd, execGit } = fakeExecs({ where: '{}' });
        await assert.rejects(() => probeBeadsIdentity({ cwd: ROOT, execBd, execGit }), /returned no \.beads path/);
    });
});

describe('createBeadsIdentityState', () => {
    test('get() returns the initial record; refresh() re-probes and replaces it', async () => {
        let n = 0;
        const probe = async ({ cwd }) => ({ beadsDir: cwd, prefix: `p${++n}`, syncRemote: '', repoRemote: '' });
        const state = createBeadsIdentityState({ cwd: ROOT, initial: { beadsDir: ROOT, prefix: 'p0', syncRemote: '', repoRemote: '' }, probe });
        assert.equal(state.get().prefix, 'p0');
        assert.equal((await state.refresh()).prefix, 'p1');
        assert.equal(state.get().prefix, 'p1');
        assert.equal(state.cwd, ROOT);
    });

    test('a failing refresh() rethrows and leaves the last good record in place', async () => {
        const probe = async () => { throw new Error('bd gone'); };
        const state = createBeadsIdentityState({ cwd: ROOT, initial: { beadsDir: ROOT, prefix: 'p0' }, probe });
        await assert.rejects(() => state.refresh(), /bd gone/);
        assert.equal(state.get().prefix, 'p0');
    });

    test('toBeadsSummary picks the four display fields and never databasePath', () => {
        assert.deepEqual(toBeadsSummary({ beadsDir: '/p/.beads', prefix: 'x', databasePath: '/p/.beads/db', syncRemote: 'r', repoRemote: 'o' }),
            { dir: '/p/.beads', prefix: 'x', syncRemote: 'r', repoRemote: 'o' });
        assert.equal(toBeadsSummary(null), null);
    });
});

describe('dashboard -- beads identity rendering', () => {
    test('renderIndexPageHtml shows one "Beads: <dir> | prefix <p> | <remote>" header line above the Sprint Stack, HTML-escaped', () => {
        const html = renderIndexPageHtml([], undefined, undefined, {
            beads: { dir: 'C:\\p\\.beads', prefix: 'proj<1>', syncRemote: 'git+https://x/y.git?a=1&b=2', repoRemote: '' },
        });
        const line = html.indexOf('class="beads-identity"');
        assert.ok(line > 0, 'header line rendered');
        assert.ok(line < html.indexOf('Sprint Stack'), 'rendered above the Sprint Stack');
        assert.ok(html.includes('Beads: <span style="color:#d4d4d8;">C:\\p\\.beads</span> | prefix <span style="color:#d4d4d8;">proj&lt;1&gt;</span>'));
        assert.ok(html.includes('git+https://x/y.git?a=1&amp;b=2'));
        assert.ok(!html.includes('proj<1>'), 'raw prefix must be escaped');
    });

    test('no header line without an identity (existing callers unchanged)', () => {
        assert.ok(!renderIndexPageHtml([]).includes('class="beads-identity"'));
        assert.ok(!renderIndexPageHtml([], undefined, undefined, { beads: null }).includes('class="beads-identity"'));
        assert.equal(renderBeadsHeaderHtml(undefined), '');
    });

    test('a sprint card shows its recorded beads prefix (small, optional) and /state carries it', () => {
        const base = { sprintId: 's1', branch: 'b', goal: null, status: WATCHDOG_STATUS.RUNNING_HEALTHY, issueRoots: [], beadCount: null, progress: null, members: [], base: 'main', baseDrift: null };
        assert.ok(renderSprintSection({ ...base, beadsPrefix: 'pro<j' }).includes('Beads prefix:</span> pro&lt;j'));
        assert.ok(!renderSprintSection(base).includes('Beads prefix'));
        assert.equal(buildStatePayload([{ ...base, beadsPrefix: 'proj' }]).sprints[0].beadsPrefix, 'proj');
        assert.equal(buildStatePayload([base]).sprints[0].beadsPrefix, null);
    });
});
