import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    discoverBeadsDir,
    resolveBeadsDirArg,
    probeBeadsIdentity,
    createBeadsIdentityState,
    toBeadsSummary,
    formatNoBeadsWarning,
    formatProbeFailedWarning,
    missingIdentityFields,
    checkProjectFolderIdentity,
    PROJECT_FOLDER_REQUIREMENTS,
    BEADS_DIR_NAME,
} from '../src/supervisor/beads-identity.mjs';
import { isCompleteIdentity } from '../fleet-sprint/beads-identity.mjs';
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
        const fs = fakeFs([ROOT, path.join(ROOT, BEADS_DIR_NAME), path.join(ROOT, BEADS_DIR_NAME, 'metadata.json')]);
        assert.deepEqual(discoverBeadsDir({ cwd: ROOT, fs }), {
            beadsDir: path.join(ROOT, '.beads'),
            repoRoot: ROOT,
        });
    });

    test('walks up to an ancestor holding .beads and reports that ancestor as repoRoot', () => {
        const deep = path.join(ROOT, 'packages', 'x', 'src');
        const fs = fakeFs([ROOT, path.join(ROOT, '.beads'), path.join(ROOT, '.beads', 'metadata.json'), deep]);
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

/** A fully resolved identity -- every field the engine's own
 *  isCompleteIdentity() requires. */
const COMPLETE = Object.freeze({
    beadsDir: '/p/.beads', prefix: 'p1', databasePath: '/p/.beads/db',
    syncRemote: 'https://example.invalid/acme/demo.git',
    repoRemote: 'https://example.invalid/acme/demo.git',
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

    test('unknown at startup: get() is null, getWarning() carries the reason + fix; a later successful refresh() recovers it and clears the warning', async () => {
        const warning = formatNoBeadsWarning(ROOT);
        let ok = false;
        const probe = async () => {
            if (!ok) throw new Error('bd where --json failed: no beads');
            return COMPLETE;
        };
        const state = createBeadsIdentityState({ cwd: ROOT, initial: null, warning, probe });
        assert.equal(state.get(), null);
        assert.equal(state.getWarning(), warning);
        // A failed refresh while still unknown refreshes the warning to the current probe error (+ fix) and rethrows.
        await assert.rejects(() => state.refresh(), /no beads/);
        assert.equal(state.get(), null);
        assert.match(state.getWarning(), /could not resolve the beads identity under .*: bd where --json failed: no beads/);
        assert.match(state.getWarning(), /To fix: run 'bd where' in .* to see the error, ensure bd is on PATH and the project is initialised \(bd init \/ sync\.remote set\), then GET \/api\/health\?refresh=1\./);
        ok = true;
        assert.equal((await state.refresh()).prefix, 'p1');
        assert.equal(state.get().prefix, 'p1');
        assert.equal(state.getWarning(), null);
    });

    test('a resolved AND COMPLETE state never reports a warning, even when one was passed', () => {
        const state = createBeadsIdentityState({ cwd: ROOT, initial: COMPLETE, warning: 'stale' });
        assert.equal(state.getWarning(), null);
    });

    // The defect this pins: a probe that SUCCEEDS can still return a record
    // the engine's own precondition rejects. Reporting no warning for it made
    // health read healthy right up to the first failed sprint launch.
    test('a resolved but INCOMPLETE state warns, naming each missing field and its fix', () => {
        const state = createBeadsIdentityState({
            cwd: ROOT,
            initial: { ...COMPLETE, syncRemote: '', repoRemote: '' },
        });
        const warning = state.getWarning();
        assert.ok(warning, 'an incomplete identity must not be reported as healthy');
        assert.ok(warning.includes(ROOT), warning);
        assert.match(warning, /bd config set sync\.remote <url>/);
        assert.match(warning, /git remote add origin <url>/);
        assert.ok(!warning.includes('bd init'), 'a satisfied requirement must not be named');
        assert.match(warning, /restart the supervisor/);
    });

    test('an incomplete state that a refresh() completes stops warning (the warning is derived, never stale)', async () => {
        let next = { ...COMPLETE, syncRemote: '' };
        const state = createBeadsIdentityState({ cwd: ROOT, initial: next, probe: async () => next });
        assert.ok(state.getWarning());
        next = COMPLETE;
        await state.refresh();
        assert.equal(state.getWarning(), null);
    });

    test('the warning texts say what was found AND what to do', () => {
        const none = formatNoBeadsWarning('C:\\somewhere\\else');
        assert.match(none, /^no beads database found walking up from C:\\somewhere\\else\./);
        assert.match(none, /Backlog and scope-overlap checks are disabled and sprints will verify against the orchestrator member's beads instead\./);
        assert.match(none, /To fix: restart fleet-se from inside the project folder, or pass --beads-dir <project-or-\.beads-path>, then GET \/api\/health\?refresh=1\./);
        const failed = formatProbeFailedWarning('/proj', new Error('bd: command not found'));
        assert.match(failed, /^could not resolve the beads identity under \/proj: bd: command not found\./);
        assert.match(failed, /To fix: run 'bd where' in \/proj to see the error, ensure bd is on PATH and the project is initialised \(bd init \/ sync\.remote set\), then GET \/api\/health\?refresh=1\./);
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
        assert.equal(renderBeadsHeaderHtml(null, ''), '');
    });

    test('identity unknown + warning: an amber "Beads: NOT RESOLVED -- <warning>" line with the guidance, HTML-escaped, in place of the identity line', () => {
        const warning = formatNoBeadsWarning('C:\\some\\dir<x>');
        const html = renderIndexPageHtml([], undefined, undefined, { beads: null, beadsWarning: warning });
        const line = html.indexOf('class="beads-identity beads-identity-warning"');
        assert.ok(line > 0, 'warning header line rendered');
        assert.ok(line < html.indexOf('Sprint Stack'), 'rendered above the Sprint Stack');
        assert.ok(html.includes('color: #f59e0b'), 'visibly styled (amber)');
        assert.ok(html.includes('<strong>Beads: NOT RESOLVED</strong> -- no beads database found walking up from C:\\some\\dir&lt;x&gt;.'));
        assert.ok(html.includes('Backlog and scope-overlap checks are disabled'));
        assert.ok(html.includes('To fix: restart fleet-se from inside the project folder, or pass --beads-dir &lt;project-or-.beads-path&gt;, then GET /api/health?refresh=1.'));
        assert.ok(!html.includes('dir<x>'), 'raw cwd must be escaped');
        assert.ok(!html.includes('| prefix '), 'no identity line alongside the warning');
    });

    test('a resolved identity wins over a stale warning', () => {
        const html = renderBeadsHeaderHtml({ dir: '/p/.beads', prefix: 'proj', syncRemote: '' }, 'ignored');
        assert.ok(html.includes('| prefix '));
        assert.ok(!html.includes('NOT RESOLVED'));
    });

    test('a sprint card shows its recorded beads prefix (small, optional) and /state carries it', () => {
        const base = { sprintId: 's1', branch: 'b', goal: null, status: WATCHDOG_STATUS.RUNNING_HEALTHY, issueRoots: [], beadCount: null, progress: null, members: [], base: 'main', baseDrift: null };
        assert.ok(renderSprintSection({ ...base, beadsPrefix: 'pro<j' }).includes('Beads prefix:</span> pro&lt;j'));
        assert.ok(!renderSprintSection(base).includes('Beads prefix'));
        assert.equal(buildStatePayload([{ ...base, beadsPrefix: 'proj' }]).sprints[0].beadsPrefix, 'proj');
        assert.equal(buildStatePayload([base]).sprints[0].beadsPrefix, null);
    });
});

// =============================================================================
// Project-folder usability -- the SET-time question: could a sprint actually
// run against this folder? The engine treats an incomplete beads identity as
// fatal, so this is the same predicate, asked early.
// =============================================================================
describe('project-folder usability', () => {
    test('missingIdentityFields() is exactly the inverse of the engine\'s own isCompleteIdentity()', () => {
        const cases = [
            null,
            {},
            { beadsDir: '/p/.beads' },
            { beadsDir: '/p/.beads', prefix: 'p' },
            { beadsDir: '/p/.beads', prefix: 'p', syncRemote: 'u' },
            COMPLETE,
        ];
        for (const id of cases) {
            assert.equal(
                missingIdentityFields(id).length === 0,
                isCompleteIdentity(id),
                `disagreement on ${JSON.stringify(id)} -- the two predicates must never fork`,
            );
        }
    });

    test('every requirement carries a field, a human label and a single fix command', () => {
        assert.deepEqual(
            PROJECT_FOLDER_REQUIREMENTS.map((r) => r.field),
            ['beadsDir', 'prefix', 'syncRemote', 'repoRemote'],
        );
        for (const req of PROJECT_FOLDER_REQUIREMENTS) {
            assert.ok(req.label && req.fix, JSON.stringify(req));
        }
    });

    test('a complete folder is ok, with no error and nothing missing', async () => {
        const check = await checkProjectFolderIdentity({ cwd: ROOT, probe: async () => COMPLETE });
        assert.equal(check.ok, true);
        assert.deepEqual(check.missing, []);
        assert.equal(check.error, null);
        assert.equal(check.detail, null);
    });

    test('a probe that THROWS is reported as every requirement missing, with the raw cause kept -- never a rejected promise', async () => {
        const check = await checkProjectFolderIdentity({
            cwd: ROOT,
            probe: async () => { throw new Error('spawn bd ENOENT'); },
        });
        assert.equal(check.ok, false);
        assert.deepEqual(check.missing, ['beadsDir', 'prefix', 'syncRemote', 'repoRemote']);
        assert.equal(check.detail, 'spawn bd ENOENT');
        assert.ok(check.error.includes('spawn bd ENOENT'), check.error);
        assert.ok(check.error.includes(ROOT), check.error);
    });

    test('a partially resolved folder names only what is missing, and the message is generic (no product paths)', async () => {
        const check = await checkProjectFolderIdentity({
            cwd: ROOT,
            probe: async () => ({ ...COMPLETE, syncRemote: '' }),
        });
        assert.equal(check.ok, false);
        assert.deepEqual(check.missing, ['syncRemote']);
        assert.match(check.error, /bd config set sync\.remote <url>/);
        assert.ok(!check.error.includes('bd init'), check.error);
        assert.ok(!/apra-fleet/i.test(check.error), `the operator-facing text must stay generic: ${check.error}`);
    });

    test('the injected execBd/execGit reach the real probe -- no bd or git is ever needed', async () => {
        const calls = [];
        const execBd = async (args) => {
            calls.push(['bd', ...args].join(' '));
            if (args[0] === 'where') return { stdout: JSON.stringify({ path: '/p/.beads', prefix: 'p1' }) };
            return { stdout: JSON.stringify({ key: 'sync.remote', value: 'https://example.invalid/acme/demo.git' }) };
        };
        const execGit = async (file, args) => {
            calls.push([file, ...args].join(' '));
            return { stdout: 'https://example.invalid/acme/demo.git\n' };
        };
        const check = await checkProjectFolderIdentity({ cwd: ROOT, execBd, execGit });
        assert.equal(check.ok, true, check.error ?? '');
        assert.deepEqual(calls, [
            'bd where --json',
            'bd config get sync.remote --json',
            'git remote get-url origin',
        ]);
    });
});
