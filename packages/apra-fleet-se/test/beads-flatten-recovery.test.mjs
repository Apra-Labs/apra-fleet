// Automatic recovery of a beads clone whose shared remote was flattened or
// rewritten (no common ancestor): fleet-sprint/beads-flatten-recovery.mjs and
// its callers (the launch health gate, the member beads set-up, repair()).
//
// A simulated member work folder interprets the member-bound command strings
// -- POSIX and PowerShell (decoded from -EncodedCommand) -- so the tests assert
// both what is issued, in which order, and what the folder looks like after.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    findLocalOnlyWork,
    classifyLocalWork,
    syncBoundary,
    findFreshOnlyIds,
    parseHistoryProbe,
    lastChangeMs,
    parseBeadsExport,
    parseExportCount,
    pickLeftoverBackup,
    recoverFlattenedClone,
    restoreLeftoverFlattenBackup,
    longPathHint,
    FLATTEN_BACKUP_PREFIX,
    FLATTEN_PENDING_PREFIX,
    FLATTEN_DISCARD_PREFIX,
    FLATTEN_LOCAL_EXPORT,
    FLATTEN_RECOVERY_WARNING_PREFIX,
} from '../fleet-sprint/beads-flatten-recovery.mjs';
import { preflightBeadsHealthGate, repair } from '../fleet-sprint/dolt-sync.mjs';
import { setupMemberBeads } from '../fleet-sprint/beads-identity-check.mjs';
import {
    BeadsFlattenRecoveryRefusedError,
    BeadsFlattenRecoveryFailedError,
    DoltUnrelatedHistoryError,
    BEADS_FLATTEN_RECOVERY_REFUSED_CODE,
} from '../fleet-sprint/errors.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

import { FIXTURE, REMOTE, decodePs, makeMember } from './helpers/flatten-member.mjs';
const posix = getSeCommands({ os: 'linux', shell: 'bash' });
const powershell = getSeCommands({ os: 'windows', shell: 'powershell' });

const issue = (id, updatedAt) => ({ _type: 'issue', id, title: id, status: 'open', updated_at: updatedAt });
const memory = (key, value) => ({ _type: 'memory', key, value });

const gateOpts = (member, logs, extra = {}) => ({
    command: member.command,
    log: (l) => logs.push(l),
    checkSyncRemoteConfigured: async () => true,
    remoteTipFingerprint: false,
    sleep: async () => {},
    ...extra,
});

const LOCAL_SAME = [issue('p-1', '2026-11-20T10:00:00Z'), issue('p-2', '2026-11-20T10:00:00Z'), memory('k', 'v')];
const REMOTE_SAME = [issue('p-1', '2026-11-20T10:00:00Z'), issue('p-2', '2026-11-20T10:00:00Z'), memory('k', 'v')];

function indexOfText(texts, pred, from = 0) {
    for (let i = from; i < texts.length; i++) if (pred(texts[i])) return i;
    return -1;
}

describe('findLocalOnlyWork (pure comparison)', () => {
    test('an id absent from the fresh export is local-only work', () => {
        const out = findLocalOnlyWork([issue('a', '2026-01-01T00:00:00Z'), issue('b', '2026-01-01T00:00:00Z')], [issue('a', '2026-01-01T00:00:00Z')]);
        assert.deepEqual(out.map((w) => [w.id, w.reason]), [['b', 'absent']]);
    });

    test('a local updated_at newer than the fresh copy is local-only work; equal or older is not', () => {
        const local = [issue('a', '2026-01-02T00:00:00Z'), issue('b', '2026-01-01T00:00:00Z'), issue('c', '2026-01-01T00:00:00Z')];
        const fresh = [issue('a', '2026-01-01T00:00:00Z'), issue('b', '2026-01-01T00:00:00Z'), issue('c', '2026-01-05T00:00:00Z')];
        const out = findLocalOnlyWork(local, fresh);
        assert.deepEqual(out, [{ id: 'a', kind: 'changed', reason: 'newer', localUpdatedAt: '2026-01-02T00:00:00Z', freshUpdatedAt: '2026-01-01T00:00:00Z' }]);
    });

    test('timestamps compare as instants, not strings', () => {
        assert.equal(findLocalOnlyWork([issue('a', '2026-01-01T01:00:00+01:00')], [issue('a', '2026-01-01T00:00:00Z')]).length, 0);
    });

    test('unreadable timestamps that differ count as local work (the safe direction)', () => {
        assert.equal(findLocalOnlyWork([issue('a', 'garbage')], [issue('a', '2026-01-01T00:00:00Z')]).length, 1);
        assert.equal(findLocalOnlyWork([issue('a', 'same')], [issue('a', 'same')]).length, 0);
    });

    test('memories: absent or changed value is local work', () => {
        const out = findLocalOnlyWork([memory('x', '1'), memory('y', '2'), memory('z', '3')], [memory('x', '1'), memory('y', 'other')]);
        assert.deepEqual(out.map((w) => [w.id, w.reason]), [['memory:y', 'changed'], ['memory:z', 'absent']]);
    });

    test('nothing local -> nothing local-only', () => {
        assert.deepEqual(findLocalOnlyWork([], [issue('a', '2026-01-01T00:00:00Z')]), []);
    });

    // The pinned bd does not bump updated_at for these: compared directly.
    const T0 = '2026-01-01T00:00:00Z';
    const dep = (on, type = 'blocks') => ({ issue_id: 'a', depends_on_id: on, type, created_at: '2026-01-02T00:00:00Z', created_by: 'x', metadata: '{}' });
    const comment = (id, text) => ({ id, issue_id: 'a', author: 'x', text, created_at: '2026-01-02T00:00:00Z' });
    const withFields = (base, fields) => ({ ...base, ...fields });

    test('a dependency add with an unchanged updated_at is local work of kind dependency', () => {
        const out = findLocalOnlyWork([withFields(issue('a', T0), { dependencies: [dep('b')], dependency_count: 1 })], [issue('a', T0)]);
        assert.deepEqual(out, [{ id: 'a', kind: 'dependency', reason: 'dependency', items: ['b (blocks)'] }]);
    });

    test('a label add with an unchanged updated_at is local work of kind label', () => {
        const out = findLocalOnlyWork([withFields(issue('a', T0), { labels: ['area:x', 'keep'] })], [withFields(issue('a', T0), { labels: ['keep'] })]);
        assert.deepEqual(out, [{ id: 'a', kind: 'label', reason: 'label', items: ['area:x'] }]);
    });

    test('a comment add with an unchanged updated_at is local work of kind comment', () => {
        const out = findLocalOnlyWork(
            [withFields(issue('a', T0), { comments: [comment('c-1', 'old'), comment('c-2', 'new')], comment_count: 2 })],
            [withFields(issue('a', T0), { comments: [comment('c-1', 'old')], comment_count: 1 })],
        );
        assert.deepEqual(out, [{ id: 'a', kind: 'comment', reason: 'comment', items: ['c-2'] }]);
    });

    test('a fresh-only id the clone history knew is local work of kind deleted', () => {
        const out = findLocalOnlyWork([issue('a', T0)], [issue('a', T0), issue('gone', T0)], { locallyDeleted: ['gone'] });
        assert.deepEqual(out, [{ id: 'gone', kind: 'deleted', reason: 'deleted' }]);
        assert.deepEqual(findLocalOnlyWork([issue('a', T0)], [issue('a', T0), issue('gone', T0)]), [], 'a remote-only bead the history did not know is not work');
    });

    test('identical records (derived counts and sub-list order aside) are not work; a removal is not counted', () => {
        const local = withFields(issue('a', T0), { labels: ['x', 'y'], dependencies: [dep('b')], dependent_count: 0 });
        const fresh = withFields(issue('a', T0), { labels: ['y', 'x', 'z'], dependencies: [dep('b'), dep('c')], dependent_count: 3 });
        assert.deepEqual(findLocalOnlyWork([local], [fresh]), []);
    });

    test('findFreshOnlyIds lists remote-only issue ids, never memories', () => {
        assert.deepEqual(findFreshOnlyIds([issue('a', T0)], [issue('a', T0), issue('b', T0), memory('m', 'v')]), ['b']);
    });

    test('parseHistoryProbe: entries, null, empty and garbage', () => {
        assert.equal(parseHistoryProbe('[\n  {"CommitHash": "x"}\n]'), true);
        assert.equal(parseHistoryProbe('null\n'), false);
        assert.equal(parseHistoryProbe('[]'), false);
        assert.equal(parseHistoryProbe(''), null);
        assert.equal(parseHistoryProbe('Error: no database'), null);
    });
});

describe('pruned beads (bd prune ran before the rewrite)', () => {
    const closed = (id, ts, extra = {}) => ({ _type: 'issue', id, title: id, status: 'closed', updated_at: ts, closed_at: ts, ...extra });
    const SYNCED = issue('s-1', '2026-03-01T00:00:00Z');

    test('the sync boundary is the newest change among identical records', () => {
        assert.equal(syncBoundary([SYNCED, issue('x', '2026-04-01T00:00:00Z')], [SYNCED, issue('x', '2026-03-15T00:00:00Z')]), Date.parse('2026-03-01T00:00:00Z'));
        assert.equal(syncBoundary([issue('x', '2026-04-01T00:00:00Z')], []), -Infinity);
    });

    test('a closed bead older than the boundary and absent from the remote is pruned, not local work', () => {
        const r = classifyLocalWork([SYNCED, closed('old', '2026-01-01T00:00:00Z')], [SYNCED]);
        assert.deepEqual(r.work, []);
        assert.deepEqual(r.pruned, ['old']);
    });

    test('a closed bead changed after the boundary (unpushed) is local work', () => {
        const changed = closed('old', '2026-01-01T00:00:00Z', { comments: [{ id: 'c-9', text: 'late', created_at: '2026-03-02T00:00:00Z' }] });
        const r = classifyLocalWork([SYNCED, changed], [SYNCED]);
        assert.deepEqual(r.work.map((w) => [w.id, w.kind]), [['old', 'absent']]);
        assert.deepEqual(r.pruned, []);
        assert.equal(lastChangeMs(changed), Date.parse('2026-03-02T00:00:00Z'));
    });

    test('open, pinned, unreadable-timestamp or boundary-less absent beads stay local work', () => {
        const old = '2026-01-01T00:00:00Z';
        const local = [SYNCED, issue('open-old', old), closed('pinned', old, { pinned: true }), closed('bad', old, { closed_at: 'garbage' })];
        assert.deepEqual(classifyLocalWork(local, [SYNCED]).work.map((w) => w.id), ['open-old', 'pinned', 'bad']);
        assert.deepEqual(classifyLocalWork([closed('old', old)], []).work.map((w) => w.id), ['old'], 'no identical record: no boundary');
    });
});

describe('export parsing', () => {
    test('every non-blank line must be a JSON object (a truncated read throws)', () => {
        assert.equal(parseBeadsExport('{"id":"a"}\n\n{"id":"b"}\n').length, 2);
        assert.throws(() => parseBeadsExport('{"id":"a"}\n{"id":"b'), /not JSON/);
        assert.throws(() => parseBeadsExport('[1]'), /not a JSON object/);
    });

    test('the bd export count line', () => {
        assert.equal(parseExportCount('Exported 2 issues and 1 memories to x'), 3);
        assert.equal(parseExportCount('Exported 1 issue to x'), 1);
        assert.equal(parseExportCount('nothing'), null);
    });

    test('pickLeftoverBackup', () => {
        assert.deepEqual(pickLeftoverBackup(['.beads', 'src']), { backup: null, pending: false, hasBeads: true });
        assert.equal(pickLeftoverBackup(['src', `${FLATTEN_PENDING_PREFIX}1`, `${FLATTEN_PENDING_PREFIX}2`]).backup, `${FLATTEN_PENDING_PREFIX}2`);
        assert.equal(pickLeftoverBackup(['.beads', `${FLATTEN_PENDING_PREFIX}1`]).hasBeads, true);
        assert.equal(pickLeftoverBackup([`${FLATTEN_BACKUP_PREFIX}1`]).backup, `${FLATTEN_BACKUP_PREFIX}1`);
        assert.equal(pickLeftoverBackup(['.beads', `${FLATTEN_BACKUP_PREFIX}1`]).backup, null, 'a finished backup next to a live .beads is left alone');
        // A bd lock file sharing the prefix is never taken for a backup.
        assert.deepEqual(pickLeftoverBackup(['.beads', `${FLATTEN_PENDING_PREFIX}20261125T000000000Z.gate.lock`]), { backup: null, pending: false, hasBeads: true });
        assert.equal(pickLeftoverBackup([`${FLATTEN_BACKUP_PREFIX}1Z.gate.lock`]).backup, null);
    });
});

for (const [dialect, shell] of [['POSIX', posix], ['PowerShell', powershell]]) {
    describe(`health gate on a ${dialect} member`, () => {
        test('unrelated history, no local-only work: export, rename, bootstrap in order; WARN names the backup; the launch continues', async () => {
            const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
            const logs = [];
            const res = await preflightBeadsHealthGate('m1', gateOpts(member, logs, { flattenRecovery: async () => shell }));
            assert.equal(res.ok, true);
            assert.equal(res.recovered, true);
            assert.ok(res.backup.startsWith(FLATTEN_BACKUP_PREFIX), res.backup);

            const texts = member.texts();
            const iExport = indexOfText(texts, (t) => t === `bd export --all -o .beads/${FLATTEN_LOCAL_EXPORT}`);
            const iRename = indexOfText(texts, (t) => t.includes(`'.beads'`) && t.includes(FLATTEN_PENDING_PREFIX) && (t.includes('mv --') || t.includes('Move-Item')));
            const iBoot = indexOfText(texts, (t) => t === 'bd bootstrap --yes');
            assert.ok(iExport >= 0 && iRename > iExport && iBoot > iRename, `order export(${iExport}) < rename(${iRename}) < bootstrap(${iBoot})`);

            const warn = logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX));
            assert.equal(warn.length, 1, logs.join('\n'));
            assert.ok(warn[0].includes(`'m1'`) && warn[0].includes(res.backup) && /flattened/.test(warn[0]), warn[0]);

            // The folder: a fresh .beads, the original kept as the backup.
            assert.equal(member.fsx.get('.beads').db.original, false);
            assert.equal(member.fsx.get(res.backup).db.original, true);
            assert.ok(![...member.fsx.keys()].some((k) => k.startsWith(FLATTEN_PENDING_PREFIX) || k.startsWith(FLATTEN_DISCARD_PREFIX)));
        });

        test('local-only work: refused with the ids and the fix, original .beads renamed back, no bootstrap result kept', async () => {
            const local = [...LOCAL_SAME, issue('p-3', '2026-11-21T10:00:00Z'), issue('p-1x', '2026-11-22T10:00:00Z')];
            const remote = [...REMOTE_SAME, issue('p-1x', '2026-11-21T10:00:00Z')];
            const member = makeMember({ local, remote });
            const original = member.fsx.get('.beads');
            const logs = [];
            await assert.rejects(
                () => preflightBeadsHealthGate('m1', gateOpts(member, logs, { flattenRecovery: shell })),
                (err) => {
                    assert.ok(err instanceof BeadsFlattenRecoveryRefusedError, err && err.stack);
                    assert.equal(err.code, BEADS_FLATTEN_RECOVERY_REFUSED_CODE);
                    assert.deepEqual(err.details.localOnly.map((w) => w.id).sort(), ['p-1x', 'p-3']);
                    assert.ok(err.message.includes('p-3') && err.message.includes('p-1x'), err.message);
                    assert.ok(err.message.includes(`.beads/${FLATTEN_LOCAL_EXPORT}`), err.message);
                    assert.ok(/Fix:/.test(err.message) && /bd bootstrap --yes/.test(err.message), err.message);
                    assert.equal(err.details.restored, true);
                    return true;
                },
            );
            assert.strictEqual(member.fsx.get('.beads'), original, 'the original .beads is back in place');
            assert.equal(original.db.original, true);
            assert.ok(original.files.has(FLATTEN_LOCAL_EXPORT), 'the export stays with the clone');
            assert.deepEqual([...member.fsx.keys()], ['.beads'], 'no backup, pending or discarded fresh clone left');
            const texts = member.texts();
            const iBoot = indexOfText(texts, (t) => t === 'bd bootstrap --yes');
            const iBack = indexOfText(texts, (t) => t.includes(FLATTEN_PENDING_PREFIX) && (t.includes(`'.beads'`)) && texts.indexOf(t) > iBoot && (t.includes('mv --') || t.includes('Move-Item')), iBoot + 1);
            assert.ok(iBack > iBoot, 'the rename back comes after the bootstrap');
            assert.equal(logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX)).length, 0, 'no success warning');
        });

        test('bootstrap failure after the rename: the rename back is issued before the error propagates', async () => {
            const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME, failOn: { 'bd bootstrap --yes': 'fatal: remote unreachable' } });
            const original = member.fsx.get('.beads');
            await assert.rejects(
                () => preflightBeadsHealthGate('m1', gateOpts(member, [], { flattenRecovery: shell })),
                (err) => err instanceof BeadsFlattenRecoveryFailedError && err.details.step === 'bootstrap' && err.details.restored === true,
            );
            const texts = member.texts();
            const iBoot = indexOfText(texts, (t) => t === 'bd bootstrap --yes');
            const iBack = indexOfText(texts, (t) => t.includes(FLATTEN_PENDING_PREFIX) && (t.includes('mv --') || t.includes('Move-Item')), iBoot + 1);
            assert.ok(iBoot >= 0 && iBack > iBoot, 'rename back after the failed bootstrap');
            assert.strictEqual(member.fsx.get('.beads'), original);
            assert.deepEqual([...member.fsx.keys()], ['.beads']);
        });

        test('a leftover recovery backup with no .beads is restored before the pull', async () => {
            const original = { db: { records: REMOTE_SAME, unrelated: false, original: true }, files: new Map() };
            const member = makeMember({ entries: { src: { files: new Map() }, [`${FLATTEN_PENDING_PREFIX}20261125T000000000Z`]: original } });
            const logs = [];
            const res = await preflightBeadsHealthGate('m1', gateOpts(member, logs, { flattenRecovery: shell }));
            assert.equal(res.ok, true);
            const texts = member.texts();
            const iRestore = indexOfText(texts, (t) => t.includes(FLATTEN_PENDING_PREFIX) && (t.includes('mv --') || t.includes('Move-Item')));
            const iPull = indexOfText(texts, (t) => /^bd dolt pull/.test(t));
            assert.ok(iRestore >= 0 && iPull > iRestore, `restore(${iRestore}) before pull(${iPull})`);
            assert.strictEqual(member.fsx.get('.beads'), original);
            assert.ok(logs.some((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX) && l.includes('interrupted')), logs.join('\n'));
        });

        test('member commands carry no shell variable expansion', async () => {
            const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
            await preflightBeadsHealthGate('m1', gateOpts(member, [], { flattenRecovery: shell }));
            const shellCmds = member.calls.filter((c) => !/^bd /.test(c.cmd));
            assert.ok(shellCmds.length >= 6, 'the recovery issued its file-system commands');
            for (const c of shellCmds) {
                if (dialect === 'PowerShell') {
                    assert.equal(c.dialect, 'ps', `wrapped for PowerShell: ${c.cmd}`);
                    for (const bad of ['$env:', '$HOME', '~/', String.fromCharCode(96)]) assert.ok(!c.text.includes(bad), `${bad} in ${c.text}`);
                } else if (!/info\/exclude/.test(c.text)) {
                    // ensureGitExcluded assigns and reads its own local variable only.
                    assert.ok(!c.text.includes('$') && !c.text.includes('~/') && !c.text.includes(String.fromCharCode(96)), c.text);
                }
            }
        });
    });
}

describe('health gate without the recovery option', () => {
    test('the unrelated-history error propagates unchanged and nothing is renamed', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        await assert.rejects(() => preflightBeadsHealthGate('m1', gateOpts(member, [])), (err) => err instanceof DoltUnrelatedHistoryError);
        assert.ok(!member.texts().some((t) => /mv --|Move-Item|bootstrap/.test(t)));
    });
});

describe('recoverFlattenedClone: failures before anything destructive', () => {
    test('a local export that cannot be read back intact fails before the rename', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        const command = async (cmd, opts) => {
            if (/^cat -- /.test(cmd)) return { ok: true, output: '{"_type":"issue","id":"p-1"}\n{"_type":"iss', error: null };
            return member.command(cmd, opts);
        };
        await assert.rejects(
            () => recoverFlattenedClone({ command, member: 'm1', shell: posix }),
            (err) => err instanceof BeadsFlattenRecoveryFailedError && err.details.step === 'export' && err.details.restored === true,
        );
        assert.ok(!member.texts().some((t) => /mv --/.test(t)), 'never renamed');
    });

    test('a read-back count that differs from what bd exported fails before the rename', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        const command = async (cmd, opts) => {
            if (/^cat -- /.test(cmd)) return { ok: true, output: '{"_type":"issue","id":"p-1"}\n', error: null };
            return member.command(cmd, opts);
        };
        await assert.rejects(() => recoverFlattenedClone({ command, member: 'm1', shell: posix }), /read back 1 record\(s\) but bd exported 3/);
        assert.ok(!member.texts().some((t) => /mv --/.test(t)));
    });

    test('a bootstrap that would not clone the remote is never run', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        member.fsx.get('.beads').files.delete('config.local.yaml');
        await assert.rejects(
            () => recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix }),
            (err) => err instanceof BeadsFlattenRecoveryFailedError && err.details.step === 'plan' && err.details.restored,
        );
        assert.ok(!member.texts().includes('bd bootstrap --yes'));
        assert.equal(member.fsx.get('.beads').db.original, true);
    });
});

describe('recoverFlattenedClone: every kind of unpushed local work is refused', () => {
    const T = '2026-11-20T10:00:00Z';
    const base = [issue('p-1', T), issue('p-2', T), issue('p-3', T)];
    const plus = (id, fields) => base.map((r) => (r.id === id ? { ...r, ...fields } : r));
    const cases = [
        ['dependency', plus('p-1', { dependencies: [{ issue_id: 'p-1', depends_on_id: 'p-2', type: 'blocks', created_at: T }] }), base, {}, /dependency add/],
        ['label', plus('p-1', { labels: ['area:x'] }), base, {}, /label add/],
        ['comment', plus('p-1', { comments: [{ id: 'c-1', issue_id: 'p-1', author: 'a', text: 'hi', created_at: T }] }), base, {}, /comment add/],
        ['deleted', base.filter((r) => r.id !== 'p-3'), base, { knownHistory: ['p-1', 'p-2', 'p-3'] }, /local delete/],
    ];
    for (const [kind, local, remote, extra, summary] of cases) {
        test(`only a ${kind} is unpushed: REFUSED naming the kind, the clone left intact`, async () => {
            const member = makeMember({ local, remote, ...extra });
            const original = member.fsx.get('.beads');
            await assert.rejects(
                () => recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix }),
                (err) => {
                    assert.ok(err instanceof BeadsFlattenRecoveryRefusedError, err && err.stack);
                    assert.deepEqual(err.details.localOnly.map((w) => w.kind), [kind]);
                    assert.match(err.message, summary);
                    assert.ok(!/no local-only work found/.test(err.message), err.message);
                    assert.equal(err.details.restored, true);
                    return true;
                },
            );
            assert.strictEqual(member.fsx.get('.beads'), original, 'the original .beads is back in place');
            assert.deepEqual([...member.fsx.keys()], ['.beads']);
            assert.ok(!member.texts().includes('bd status --json'), 'never reached the success re-check');
        });
    }

    test('no unpushed work at all: re-bootstrapped; a bead new on the remote is probed once and not counted', async () => {
        const member = makeMember({ local: base, remote: [...base, issue('p-new', T)] });
        const logs = [];
        const res = await recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix, log: (l) => logs.push(l) });
        assert.equal(res.recovered, true);
        const probes = member.texts().filter((t) => /history/.test(t));
        assert.equal(probes.length, 1);
        assert.match(probes[0], new RegExp(`^bd --db ${FLATTEN_PENDING_PREFIX}\\S+ --readonly --json history p-new --limit 1$`));
        assert.ok(logs.some((l) => l.includes('no local-only work found')), logs.join('\n'));
        assert.deepEqual([...member.fsx.keys()].sort(), ['.beads', res.backup].sort(), 'the probe lock file was dropped');
    });

    test('a clone holding only closed beads the remote pruned is re-bootstrapped', async () => {
        const old = '2026-01-01T00:00:00Z';
        const pruned = { _type: 'issue', id: 'p-old', title: 'old', status: 'closed', updated_at: old, closed_at: old };
        const member = makeMember({ local: [...base, pruned], remote: base });
        const logs = [];
        const res = await recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix, log: (l) => logs.push(l) });
        assert.equal(res.recovered, true);
        assert.ok(logs.some((l) => /1 closed bead\(s\) the remote pruned/.test(l)), logs.join('\n'));
    });

    test('a pruned-looking closed bead changed locally after the last sync is refused', async () => {
        const later = '2026-11-21T10:00:00Z';
        const changed = { _type: 'issue', id: 'p-old', title: 'old', status: 'closed', updated_at: later, closed_at: '2026-01-01T00:00:00Z' };
        const member = makeMember({ local: [...base, changed], remote: base });
        await assert.rejects(
            () => recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix }),
            (err) => err instanceof BeadsFlattenRecoveryRefusedError && err.details.localOnly.map((w) => w.id).join() === 'p-old',
        );
        assert.equal(member.fsx.get('.beads').db.original, true);
    });

    test('a history probe that fails aborts the recovery and puts the clone back', async () => {
        const member = makeMember({ local: base, remote: [...base, issue('p-new', T)], failOn: { '--readonly --json history': 'database locked' } });
        await assert.rejects(
            () => recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix }),
            (err) => err instanceof BeadsFlattenRecoveryFailedError && err.details.step === 'probe-deletes' && err.details.restored === true,
        );
        assert.equal(member.fsx.get('.beads').db.original, true);
        assert.deepEqual([...member.fsx.keys()], ['.beads']);
    });

    test('a remote-only id unsafe for a command string is never probed and counts as an unverified delete', async () => {
        const member = makeMember({ local: base, remote: [...base, issue("p-4'; rm -rf x", T)] });
        await assert.rejects(
            () => recoverFlattenedClone({ command: member.command, member: 'm1', shell: posix }),
            (err) => err instanceof BeadsFlattenRecoveryRefusedError && err.details.localOnly[0].kind === 'deleted' && err.details.localOnly[0].unverified === true,
        );
        assert.ok(!member.texts().some((t) => /history/.test(t)));
    });
});

describe('restoreLeftoverFlattenBackup', () => {
    test('a pending backup next to an unverified fresh .beads: the fresh one is dropped and the original restored', async () => {
        const original = { db: { records: LOCAL_SAME, original: true }, files: new Map() };
        const member = makeMember({ entries: { '.beads': { db: { records: [], original: false }, files: new Map() }, [`${FLATTEN_PENDING_PREFIX}1`]: original } });
        const r = await restoreLeftoverFlattenBackup({ command: member.command, member: 'm1', shell: posix });
        assert.equal(r.restored, true);
        assert.strictEqual(member.fsx.get('.beads'), original);
        assert.deepEqual([...member.fsx.keys()], ['.beads']);
    });

    test('a healthy folder issues the listing only', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        const r = await restoreLeftoverFlattenBackup({ command: member.command, member: 'm1', shell: powershell });
        assert.deepEqual(r, { checked: true, restored: false });
        assert.equal(member.calls.length, 1);
    });
});

describe('member beads set-up (existing database, pull through DoltSync)', () => {
    test('an unrelated-history pull is recovered and the set-up succeeds', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        const logs = [];
        const command = async (cmd, opts) => {
            if (cmd === 'bd dolt remote list --json') return { ok: true, output: JSON.stringify([{ name: 'origin', url: REMOTE }]), error: null };
            if (cmd === 'git rev-parse --show-prefix') return { ok: true, output: '\n', error: null };
            return member.command(cmd, opts);
        };
        await setupMemberBeads({
            command,
            member: 'm2',
            url: REMOTE,
            hasDb: true,
            memberShell: async () => posix,
            pullBeads: async () => { throw new DoltUnrelatedHistoryError('pull failed', { member: 'm2', doltOutput: FIXTURE, details: { operation: 'pull' } }); },
            log: (l) => logs.push(l),
        });
        assert.equal(member.fsx.get('.beads').db.original, false, 're-bootstrapped');
        assert.ok(logs.some((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX) && l.includes(`'m2'`)), logs.join('\n'));
    });

    test('local-only work on the member: the typed refusal propagates and the clone is untouched', async () => {
        const member = makeMember({ local: [...LOCAL_SAME, issue('p-9', '2026-11-23T00:00:00Z')], remote: REMOTE_SAME });
        const original = member.fsx.get('.beads');
        const command = async (cmd, opts) => {
            if (cmd === 'bd dolt remote list --json') return { ok: true, output: JSON.stringify([{ name: 'origin', url: REMOTE }]), error: null };
            if (cmd === 'git rev-parse --show-prefix') return { ok: true, output: '\n', error: null };
            return member.command(cmd, opts);
        };
        await assert.rejects(
            () => setupMemberBeads({
                command, member: 'm2', url: REMOTE, hasDb: true, memberShell: async () => posix,
                pullBeads: async () => { throw new DoltUnrelatedHistoryError('pull failed', { member: 'm2', doltOutput: FIXTURE }); },
            }),
            (err) => err instanceof BeadsFlattenRecoveryRefusedError && err.message.includes('p-9'),
        );
        assert.strictEqual(member.fsx.get('.beads'), original);
    });
});

describe('repair()', () => {
    test('kind unrelated-history runs the same recovery', async () => {
        const member = makeMember({ local: LOCAL_SAME, remote: REMOTE_SAME });
        const res = await repair('m1', { command: member.command, flattenRecovery: posix, kind: 'unrelated-history' });
        assert.equal(res.repaired, true);
        assert.equal(res.result.recovered, true);
        assert.equal(member.fsx.get('.beads').db.original, false);
    });

    test('a refusal is reported, not thrown', async () => {
        const member = makeMember({ local: [...LOCAL_SAME, issue('p-9', '2026-11-23T00:00:00Z')], remote: REMOTE_SAME });
        const res = await repair('m1', { command: member.command, flattenRecovery: powershell, kind: 'unrelated-history' });
        assert.equal(res.repaired, false);
        assert.equal(res.escalation, 'flatten-recovery-refused');
        assert.equal(member.fsx.get('.beads').db.original, true);
    });

    test('unrelated history without the command primitives is not configured', async () => {
        const res = await repair('m1', { command: async () => ({ ok: true, output: '' }), kind: 'unrelated-history' });
        assert.equal(res.repaired, false);
        assert.match(res.escalation, /not-configured/);
    });
});

// ---------------------------------------------------------------------------
// The new SE primitives on a real shell.
// ---------------------------------------------------------------------------
const tmpRoots = [];
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});
const hasBash = (() => { const r = spawnSync('bash', ['-c', 'true']); return !r.error && r.status === 0; })();

describe('flatten-recovery primitives on bash', { skip: !hasBash && 'no bash on this host' }, () => {
    const sh = (dir, cmd) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    test('rename refuses a missing source and an existing destination; list, copy, read, remove work', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-prims-'));
        tmpRoots.push(dir);
        fs.mkdirSync(path.join(dir, '.beads'));
        fs.writeFileSync(path.join(dir, '.beads', 'config.yaml'), 'a: 1\n');
        assert.notEqual(sh(dir, posix.renamePath('.nope', '.x')).status, 0);
        fs.mkdirSync(path.join(dir, '.taken'));
        assert.notEqual(sh(dir, posix.renamePath('.beads', '.taken')).status, 0);
        assert.ok(fs.existsSync(path.join(dir, '.beads', 'config.yaml')), 'nothing moved');
        assert.equal(sh(dir, posix.renamePath('.beads', '.beads.flatten-pending-1')).status, 0);
        assert.ok(sh(dir, posix.listDirectory('.')).stdout.split('\n').includes('.beads.flatten-pending-1'));
        fs.mkdirSync(path.join(dir, '.beads'));
        assert.equal(sh(dir, posix.copyFileIfPresent('.beads.flatten-pending-1/config.yaml', '.beads/config.yaml')).status, 0);
        assert.equal(sh(dir, posix.copyFileIfPresent('.beads.flatten-pending-1/absent.yaml', '.beads/absent.yaml')).status, 0);
        assert.ok(!fs.existsSync(path.join(dir, '.beads', 'absent.yaml')));
        assert.equal(sh(dir, posix.readFile('.beads/config.yaml')).stdout, 'a: 1\n');
        assert.equal(sh(dir, posix.removeDirectory('.beads.flatten-pending-1')).status, 0);
        assert.ok(!fs.existsSync(path.join(dir, '.beads.flatten-pending-1')));
    });

    test('unsafe paths and the work folder itself are refused', () => {
        for (const s of [posix, powershell]) {
            assert.throws(() => s.renamePath('../x', '.y'));
            assert.throws(() => s.readFile("a'b"));
            assert.throws(() => s.removeDirectory('.'));
            assert.throws(() => s.listDirectory('/etc'));
        }
    });
});

test('longPathHint names core.longpaths for a Windows MAX_PATH failure of dolt\'s git remote cache, nothing otherwise', () => {
    const maxPath = "Error 1105: error: cannot lock ref 'refs/dolt/remotes/origin/dolt/data/x': Unable to create 'C:\\w\\.beads\\embeddeddolt\\beads\\.dolt\\git-remote-cache\\ab\\repo.git/refs/dolt/remotes/origin/dolt/data/x.lock': Filename too long";
    assert.match(longPathHint(maxPath), /core\.longpaths true/);
    assert.match(longPathHint('fatal: cannot create directory: Filename too long'), /core\.longpaths/);
    assert.match(longPathHint("Error 1105: unknown push error; addTableFiles, updateManifestAddFiles: fatal: update_ref failed for ref 'refs/dolt/blobstore/origin/dolt/data/x'"), /core\.longpaths/);
    assert.equal(longPathHint('Error: remote not found'), '');
    assert.equal(longPathHint(undefined), '');
});

describe('flatten-recovery primitives on Windows PowerShell',{ skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const ps = (dir, cmd) => spawnSync('powershell', cmd.replace(/^powershell /, '').split(' '), { cwd: dir, encoding: 'utf8' });
    test('removeDirectory drops a clone whose files pass MAX_PATH (a bd git-remote-cache under a discard name) and a lock file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-prims-'));
        tmpRoots.push(dir);
        const name = '.beads.flatten-discard-20261125T101010Z';
        const deep = path.join(dir, name, 'embeddeddolt', 'beads', '.dolt', 'git-remote-cache', 'f'.repeat(64), 'repo.git', 'refs', 'dolt', 'remotes', 'origin', 'dolt', 'data');
        fs.mkdirSync(deep, { recursive: true });
        const leaf = path.join(deep, `${'0'.repeat(Math.max(8, 300 - deep.length))}.lock`);
        fs.writeFileSync(leaf, 'x');
        assert.ok(leaf.length > 260, `test tree passes MAX_PATH (${leaf.length})`);
        fs.writeFileSync(path.join(dir, `${name}.gate.lock`), '');
        const r = ps(dir, powershell.removeDirectory(name));
        assert.equal(r.status, 0, r.stderr);
        assert.ok(!fs.existsSync(path.join(dir, name)));
        assert.equal(ps(dir, powershell.removeDirectory(`${name}.gate.lock`)).status, 0);
        assert.ok(!fs.existsSync(path.join(dir, `${name}.gate.lock`)));
        assert.equal(ps(dir, powershell.removeDirectory('.absent')).status, 0, 'a missing path is a no-op');
    });
});
