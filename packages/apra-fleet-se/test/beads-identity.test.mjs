import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBdWhere,
    parseBdConfigValue,
    normalizeRemoteUrl,
    parseBeadsIdentity,
    isCompleteIdentity,
    compareIdentity,
    serializeExpectedIdentity,
    parseExpectedIdentity,
    formatBeadsIdentity,
} from '../fleet-sprint/beads-identity.mjs';

// =============================================================================
// beads-identity.mjs: pure parsing/comparison of `bd where` / `bd config get
// sync.remote` / `git remote get-url origin` probe output. No I/O in the
// module under test; this file only feeds it strings.
// =============================================================================

describe('parseBdWhere', () => {
    test('parses --json output with a Windows path', () => {
        const text = '{"database_path":"C:\\\\x\\\\.beads\\\\beads.db","path":"C:\\\\x\\\\.beads","prefix":"apra-fleet","schema_version":1}';
        const r = parseBdWhere(text);
        assert.deepEqual(r, {
            beadsDir: 'C:\\x\\.beads',
            prefix: 'apra-fleet',
            databasePath: 'C:\\x\\.beads\\beads.db',
        });
    });

    test('parses --json output with a POSIX path', () => {
        const text = '{"database_path":"/home/u/proj/.beads/beads.db","path":"/home/u/proj/.beads","prefix":"proj","schema_version":1}';
        const r = parseBdWhere(text);
        assert.deepEqual(r, {
            beadsDir: '/home/u/proj/.beads',
            prefix: 'proj',
            databasePath: '/home/u/proj/.beads/beads.db',
        });
    });

    test('parses plain (non-json) bd where output', () => {
        const text = '/home/u/proj/.beads\n  prefix: proj\n  database: /home/u/proj/.beads/beads.db\n';
        const r = parseBdWhere(text);
        assert.deepEqual(r, {
            beadsDir: '/home/u/proj/.beads',
            prefix: 'proj',
            databasePath: '/home/u/proj/.beads/beads.db',
        });
    });

    test('garbage or empty text returns null', () => {
        assert.equal(parseBdWhere(''), null);
        assert.equal(parseBdWhere('not a beads dir at all'), null);
        assert.equal(parseBdWhere(undefined), null);
        assert.equal(parseBdWhere(null), null);
    });

    test('leading noise before the JSON still parses', () => {
        const text = 'warning: some banner line\n{"path":"/x/.beads","prefix":"x","database_path":"/x/.beads/beads.db"}';
        const r = parseBdWhere(text);
        assert.equal(r.beadsDir, '/x/.beads');
        assert.equal(r.prefix, 'x');
    });
});

describe('parseBdConfigValue', () => {
    test('parses json with a value', () => {
        const text = '{"key":"sync.remote","value":"git+https://github.com/Org/repo.git"}';
        assert.equal(parseBdConfigValue(text), 'git+https://github.com/Org/repo.git');
    });

    test('json with value "" returns empty string', () => {
        assert.equal(parseBdConfigValue('{"key":"sync.remote","value":""}'), '');
    });

    test('plain raw value', () => {
        assert.equal(parseBdConfigValue('git+https://github.com/Org/repo.git\n'), 'git+https://github.com/Org/repo.git');
    });

    test('empty input returns empty string', () => {
        assert.equal(parseBdConfigValue(''), '');
        assert.equal(parseBdConfigValue(undefined), '');
    });
});

describe('normalizeRemoteUrl', () => {
    const scpForm = 'git' + '@github.com:' + 'Org/repo.git';

    const forms = [
        'git+https://github.com/Org/Repo.git',
        'https://github.com/org/repo',
        scpForm,
        'ssh://git@github.com/Org/repo.git',
        'https://github.com/org/repo/',
        'HTTPS://GITHUB.COM/ORG/REPO',
    ];

    for (const form of forms) {
        test(`normalizes ${JSON.stringify(form)} to github.com/org/repo`, () => {
            assert.equal(normalizeRemoteUrl(form), 'github.com/org/repo');
        });
    }

    test('empty or non-string input returns empty string', () => {
        assert.equal(normalizeRemoteUrl(''), '');
        assert.equal(normalizeRemoteUrl('   '), '');
        assert.equal(normalizeRemoteUrl(undefined), '');
        assert.equal(normalizeRemoteUrl(null), '');
        assert.equal(normalizeRemoteUrl(123), '');
    });
});

describe('parseBeadsIdentity', () => {
    test('builds the full record from three probe outputs', () => {
        const id = parseBeadsIdentity({
            where: '{"path":"/x/.beads","prefix":"x","database_path":"/x/.beads/beads.db"}',
            syncRemote: '{"key":"sync.remote","value":"git+https://github.com/Org/repo.git"}',
            repoRemote: 'git+https://github.com/Org/repo.git\n',
        });
        assert.deepEqual(id, {
            beadsDir: '/x/.beads',
            prefix: 'x',
            databasePath: '/x/.beads/beads.db',
            syncRemote: 'git+https://github.com/Org/repo.git',
            repoRemote: 'git+https://github.com/Org/repo.git',
        });
    });

    test('repoRemote takes the first line, trimmed', () => {
        const id = parseBeadsIdentity({
            where: '{"path":"/x/.beads","prefix":"x"}',
            syncRemote: '',
            repoRemote: '  https://github.com/org/repo  \nsome-other-line\n',
        });
        assert.equal(id.repoRemote, 'https://github.com/org/repo');
    });

    test('unparseable where leaves beadsDir/prefix/databasePath empty', () => {
        const id = parseBeadsIdentity({ where: '', syncRemote: '', repoRemote: '' });
        assert.deepEqual(id, {
            beadsDir: '',
            prefix: '',
            databasePath: '',
            syncRemote: '',
            repoRemote: '',
        });
    });
});

describe('isCompleteIdentity', () => {
    test('true when all four fields are set', () => {
        assert.equal(isCompleteIdentity({
            beadsDir: '/x/.beads',
            prefix: 'x',
            syncRemote: 'https://github.com/org/repo',
            repoRemote: 'https://github.com/org/repo',
        }), true);
    });

    test('false when any field is missing, or record is null/undefined', () => {
        const full = { beadsDir: '/x/.beads', prefix: 'x', syncRemote: 'r', repoRemote: 'r' };
        for (const field of ['beadsDir', 'prefix', 'syncRemote', 'repoRemote']) {
            assert.equal(isCompleteIdentity({ ...full, [field]: '' }), false);
        }
        assert.equal(isCompleteIdentity(null), false);
        assert.equal(isCompleteIdentity(undefined), false);
    });
});

describe('compareIdentity', () => {
    const base = {
        beadsDir: '/a/.beads',
        prefix: 'proj',
        syncRemote: 'git+https://github.com/org/repo.git',
        repoRemote: 'https://github.com/org/repo',
    };

    test('ok when equal, including remotes expressed in different forms', () => {
        const actual = {
            beadsDir: '/somewhere/else/.beads',
            prefix: 'proj',
            syncRemote: 'https://github.com/Org/Repo/',
            repoRemote: 'git' + '@github.com:' + 'org/repo.git',
        };
        const r = compareIdentity(base, actual);
        assert.deepEqual(r, { ok: true, mismatches: [] });
    });

    test('reports a prefix mismatch', () => {
        const actual = { ...base, prefix: 'other' };
        const r = compareIdentity(base, actual);
        assert.equal(r.ok, false);
        assert.deepEqual(r.mismatches, [{ field: 'prefix', expected: 'proj', actual: 'other' }]);
    });

    test('reports a syncRemote mismatch', () => {
        const actual = { ...base, syncRemote: 'https://github.com/other/repo' };
        const r = compareIdentity(base, actual);
        assert.equal(r.ok, false);
        assert.deepEqual(r.mismatches, [{
            field: 'syncRemote',
            expected: base.syncRemote,
            actual: 'https://github.com/other/repo',
        }]);
    });

    test('reports a repoRemote mismatch', () => {
        const actual = { ...base, repoRemote: 'https://github.com/other/repo' };
        const r = compareIdentity(base, actual);
        assert.equal(r.ok, false);
        assert.deepEqual(r.mismatches, [{
            field: 'repoRemote',
            expected: base.repoRemote,
            actual: 'https://github.com/other/repo',
        }]);
    });

    test('empty actual vs a set expected is a mismatch on all three compared fields', () => {
        const actual = { beadsDir: '', prefix: '', syncRemote: '', repoRemote: '' };
        const r = compareIdentity(base, actual);
        assert.equal(r.ok, false);
        assert.equal(r.mismatches.length, 3);
        const fields = r.mismatches.map((m) => m.field).sort();
        assert.deepEqual(fields, ['prefix', 'repoRemote', 'syncRemote']);
    });

    test('beadsDir difference alone is not a mismatch', () => {
        const actual = { ...base, beadsDir: '/totally/different/.beads' };
        const r = compareIdentity(base, actual);
        assert.deepEqual(r, { ok: true, mismatches: [] });
    });
});

describe('serializeExpectedIdentity / parseExpectedIdentity', () => {
    test('round trips a full identity record', () => {
        const id = {
            beadsDir: '/x/.beads',
            prefix: 'proj',
            syncRemote: 'https://github.com/org/repo',
            repoRemote: 'https://github.com/org/repo',
            databasePath: '/x/.beads/beads.db',
        };
        const serialized = serializeExpectedIdentity(id);
        const parsed = parseExpectedIdentity(serialized);
        assert.deepEqual(parsed, {
            beadsDir: '/x/.beads',
            prefix: 'proj',
            syncRemote: 'https://github.com/org/repo',
            repoRemote: 'https://github.com/org/repo',
        });
    });

    test('parseExpectedIdentity of invalid JSON returns null', () => {
        assert.equal(parseExpectedIdentity('{not json'), null);
    });

    test('parseExpectedIdentity of an object normalizes it directly', () => {
        const parsed = parseExpectedIdentity({ beadsDir: ' /x/.beads ', prefix: 'proj', syncRemote: 5, repoRemote: null });
        assert.deepEqual(parsed, { beadsDir: '/x/.beads', prefix: 'proj', syncRemote: '', repoRemote: '' });
    });

    test('parseExpectedIdentity of an empty string returns null', () => {
        assert.equal(parseExpectedIdentity(''), null);
        assert.equal(parseExpectedIdentity('   '), null);
    });
});

describe('formatBeadsIdentity', () => {
    test('includes the label when given', () => {
        const id = { beadsDir: '/x/.beads', prefix: 'proj', syncRemote: 'https://github.com/org/repo', repoRemote: '' };
        const s = formatBeadsIdentity(id, { label: 'member-a' });
        assert.ok(s.startsWith('member-a beads: '));
    });

    test('omits the label when not given', () => {
        const id = { beadsDir: '/x/.beads', prefix: 'proj', syncRemote: 'https://github.com/org/repo', repoRemote: '' };
        const s = formatBeadsIdentity(id, {});
        assert.ok(s.startsWith('beads: '));
    });

    test('null id formats as (unknown)', () => {
        assert.equal(formatBeadsIdentity(null), 'beads: (unknown)');
        assert.equal(formatBeadsIdentity(null, { label: 'member-a' }), 'member-a: beads: (unknown)');
    });

    test('origin is shown only when repoRemote differs from syncRemote after normalization', () => {
        const same = {
            beadsDir: '/x/.beads',
            prefix: 'proj',
            syncRemote: 'git+https://github.com/org/repo.git',
            repoRemote: 'https://github.com/org/repo',
        };
        const sSame = formatBeadsIdentity(same);
        assert.ok(!sSame.includes('origin='));

        const different = { ...same, repoRemote: 'https://github.com/other/repo' };
        const sDiff = formatBeadsIdentity(different);
        assert.ok(sDiff.includes('origin=https://github.com/other/repo'));
    });
});
