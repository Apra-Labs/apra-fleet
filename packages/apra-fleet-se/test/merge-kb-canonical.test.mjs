import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    mergeKbCanonical,
    entryIdentity,
    contentSignature,
    formatSummary,
    formatConflicts,
    parseArgs,
    CONTENT_FIELDS,
} from '../scripts/merge-kb-canonical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'merge-kb-canonical.mjs');

// =============================================================================
// Title-keyed three-way merge of the knowledge-bank canonical export.
//
// The invariant this suite locks in is the identity key: the merge matches
// entries across base/ours/theirs by TRIMMED TITLE, never by `id`. `id` is
// re-minted per export -- measured on two real consecutive exports of this
// repo's own canonical file, only 76.5% of base ids survived while 99.0% of
// titles did, and 45 entries were byte-identical in content yet carried a
// different id. An id-keyed merge would read those 45 as delete+add pairs.
// The reexport() helper below is the regression guard for that: every
// scenario deliberately re-mints ids between sides, so any future switch back
// to id-keyed matching fails loudly here instead of silently duplicating or
// dropping harvested entries in production.
// =============================================================================

let idCounter = 0;
/** Build an entry with a deliberately fresh, non-reused id every time. */
function entry(title, overrides = {}) {
    idCounter += 1;
    return {
        id: `id-${idCounter}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'knowledge',
        title,
        summary: `summary of ${title}`,
        symbols: [],
        source_files: [`src/${title.replace(/\s+/g, '-')}.js`],
        confidence: 'CONFIRMED',
        updated_at: '2020-01-01T00:00:00.000Z',
        ...overrides,
    };
}

/** Re-export an entry: same content, brand-new id and timestamp. */
function reexport(e, overrides = {}) {
    idCounter += 1;
    return { ...e, id: `id-${idCounter}-reexport`, updated_at: new Date().toISOString(), ...overrides };
}

function doc(entries, extra = {}) {
    return { version: 2, provenance: { commit: 'deadbeef', branch: 'b', entry_count: entries.length }, entries, ...extra };
}

const titlesOf = (result) => result.merged.entries.map((e) => e.title);

test('identity is the trimmed title, not the id', () => {
    const a = entry('Same finding');
    const b = reexport(a, { title: '  Same finding  ' });
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(entryIdentity(a), entryIdentity(b));
    assert.strictEqual(contentSignature(a), contentSignature(b));
});

test('content signature ignores id and updated_at', () => {
    assert.ok(!CONTENT_FIELDS.includes('id'));
    assert.ok(!CONTENT_FIELDS.includes('updated_at'));
    const a = entry('X');
    assert.strictEqual(contentSignature(a), contentSignature(reexport(a)));
});

test('identical-content passthrough: re-minted ids do not look like changes', () => {
    const base = doc([entry('A'), entry('B'), entry('C')]);
    // Both sides re-exported the same three findings with fresh ids.
    const ours = doc(base.entries.map((e) => reexport(e)));
    const theirs = doc(base.entries.map((e) => reexport(e)));

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.strictEqual(result.summary.keptUnchanged, 3);
    assert.strictEqual(result.summary.addedByOurs, 0);
    assert.strictEqual(result.summary.addedByTheirs, 0);
    assert.strictEqual(result.summary.removedByOurs, 0);
    assert.strictEqual(result.summary.removedByTheirs, 0);
    assert.deepStrictEqual(titlesOf(result), ['A', 'B', 'C']);
});

test('pure addition by ours only is kept', () => {
    const base = doc([entry('A')]);
    const ours = doc([reexport(base.entries[0]), entry('Ours new')]);
    const theirs = doc([reexport(base.entries[0])]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.strictEqual(result.summary.addedByOurs, 1);
    assert.strictEqual(result.summary.addedByTheirs, 0);
    assert.deepStrictEqual(titlesOf(result), ['A', 'Ours new']);
});

test('pure addition by theirs only is kept', () => {
    const base = doc([entry('A')]);
    const ours = doc([reexport(base.entries[0])]);
    const theirs = doc([reexport(base.entries[0]), entry('Theirs new')]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.strictEqual(result.summary.addedByOurs, 0);
    assert.strictEqual(result.summary.addedByTheirs, 1);
    assert.deepStrictEqual(titlesOf(result), ['A', 'Theirs new']);
});

test('both sides add the same title: de-duplicated to one entry', () => {
    const base = doc([entry('A')]);
    const shared = entry('Both discovered this');
    const ours = doc([reexport(base.entries[0]), reexport(shared)]);
    const theirs = doc([reexport(base.entries[0]), reexport(shared)]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.deepStrictEqual(titlesOf(result), ['A', 'Both discovered this']);
    assert.strictEqual(result.summary.addedByOurs, 1);
    assert.strictEqual(result.summary.addedByTheirs, 0);
    assert.strictEqual(result.summary.addedByBothDeduplicated, 1);
    assert.strictEqual(result.summary.mergedEntries, 2);
});

test('both sides add the same title with different content: still one entry, not a conflict', () => {
    // No common ancestor exists for a both-sides addition, so there is nothing
    // to arbitrate against -- de-dup rather than block the whole merge.
    const base = doc([]);
    const ours = doc([entry('Shared title', { summary: 'ours wording' })]);
    const theirs = doc([entry('Shared title', { summary: 'theirs wording' })]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.strictEqual(result.merged.entries.length, 1);
    assert.strictEqual(result.merged.entries[0].summary, 'ours wording');
});

test('deletion by ours is respected and NOT resurrected from theirs', () => {
    const base = doc([entry('Keep me'), entry('Ours deleted this')]);
    const ours = doc([reexport(base.entries[0])]);
    const theirs = doc(base.entries.map((e) => reexport(e)));

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(titlesOf(result), ['Keep me']);
    assert.strictEqual(result.summary.removedByOurs, 1);
    assert.strictEqual(result.summary.removedByTheirs, 0);
    assert.strictEqual(result.summary.addedByTheirs, 0, 'a deleted entry must not come back as a theirs-side addition');
});

test('deletion by theirs is respected and NOT resurrected from ours', () => {
    const base = doc([entry('Keep me'), entry('Theirs deleted this')]);
    const ours = doc(base.entries.map((e) => reexport(e)));
    const theirs = doc([reexport(base.entries[0])]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(titlesOf(result), ['Keep me']);
    assert.strictEqual(result.summary.removedByTheirs, 1);
    assert.strictEqual(result.summary.removedByOurs, 0);
    assert.strictEqual(result.summary.addedByOurs, 0, 'a deleted entry must not come back as an ours-side addition');
});

test('deletion by both sides is counted once as a mutual removal', () => {
    const base = doc([entry('Keep me'), entry('Nobody wants this')]);
    const ours = doc([reexport(base.entries[0])]);
    const theirs = doc([reexport(base.entries[0])]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(titlesOf(result), ['Keep me']);
    assert.strictEqual(result.summary.removedByBoth, 1);
});

test('a change by exactly one side wins without a conflict', () => {
    const base = doc([entry('A'), entry('B')]);
    const ours = doc([reexport(base.entries[0], { summary: 'ours refined this' }), reexport(base.entries[1])]);
    const theirs = doc([reexport(base.entries[0]), reexport(base.entries[1], { confidence: 'PROVISIONAL' })]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.strictEqual(result.summary.changedByOurs, 1);
    assert.strictEqual(result.summary.changedByTheirs, 1);
    assert.strictEqual(result.merged.entries[0].summary, 'ours refined this');
    assert.strictEqual(result.merged.entries[1].confidence, 'PROVISIONAL');
});

test('both sides make the SAME change: taken, not flagged', () => {
    const base = doc([entry('A')]);
    const ours = doc([reexport(base.entries[0], { summary: 'agreed wording' })]);
    const theirs = doc([reexport(base.entries[0], { summary: 'agreed wording' })]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(result.conflicts, []);
    assert.strictEqual(result.summary.changedByBothIdentically, 1);
    assert.strictEqual(result.merged.entries[0].summary, 'agreed wording');
});

test('genuine conflict: same title changed differently by both sides is reported, never resolved', () => {
    const base = doc([entry('Contested'), entry('Fine')]);
    const ours = doc([reexport(base.entries[0], { summary: 'ours says X' }), reexport(base.entries[1])]);
    const theirs = doc([reexport(base.entries[0], { summary: 'theirs says Y' }), reexport(base.entries[1])]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.strictEqual(result.summary.genuineConflicts, 1);
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].identity, 'Contested');
    assert.strictEqual(result.conflicts[0].ours.summary, 'ours says X');
    assert.strictEqual(result.conflicts[0].theirs.summary, 'theirs says Y');
    assert.strictEqual(result.merged, null, 'a conflicted merge must not hand back a document to write');

    const report = formatConflicts(result.conflicts);
    assert.match(report, /Contested/);
    assert.match(report, /ours says X/);
    assert.match(report, /theirs says Y/);
});

test('merged document carries a corrected entry_count and a base-first order', () => {
    const base = doc([entry('A'), entry('B')]);
    const ours = doc(base.entries.map((e) => reexport(e)).concat(entry('O1')));
    const theirs = doc(base.entries.map((e) => reexport(e)).concat(entry('T1')));

    const result = mergeKbCanonical(base, ours, theirs);
    assert.deepStrictEqual(titlesOf(result), ['A', 'B', 'O1', 'T1']);
    assert.strictEqual(result.merged.provenance.entry_count, 4);
    assert.strictEqual(result.merged.version, 2);
});

test('duplicate titles within one side are dropped, first occurrence wins', () => {
    const base = doc([]);
    const ours = doc([entry('Dup', { summary: 'first' }), entry('Dup', { summary: 'second' })]);
    const theirs = doc([]);

    const result = mergeKbCanonical(base, ours, theirs);
    assert.strictEqual(result.merged.entries.length, 1);
    assert.strictEqual(result.merged.entries[0].summary, 'first');
    assert.strictEqual(result.summary.duplicateIdentitiesDropped, 1);
});

test('a non-canonical input throws rather than merging garbage', () => {
    assert.throws(() => mergeKbCanonical(doc([]), { entries: 'nope' }, doc([])), /not a canonical document/);
    assert.throws(() => mergeKbCanonical(null, doc([]), doc([])), /base is not a canonical document/);
});

test('formatSummary emits every required count as plain text', () => {
    const { summary } = mergeKbCanonical(doc([]), doc([]), doc([]));
    const text = formatSummary(summary);
    for (const label of ['kept unchanged', 'added by ours', 'added by theirs', 'removed by ours', 'removed by theirs', 'genuine conflicts']) {
        assert.match(text, new RegExp(label.replace(/ /g, '\\s')));
    }
});

test('parseArgs understands paths, refs and output options', () => {
    const opts = parseArgs(['b', 'o', 't', '--refs', '--repo', 'r', '--path', 'p.json', '--out', 'out.json']);
    assert.deepStrictEqual(opts.positional, ['b', 'o', 't']);
    assert.strictEqual(opts.refs, true);
    assert.strictEqual(opts.repo, 'r');
    assert.strictEqual(opts.relPath, 'p.json');
    assert.strictEqual(opts.out, 'out.json');
    assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});

// ---------------------------------------------------------------------------
// CLI behaviour: exit codes and the written artifact.
// ---------------------------------------------------------------------------

function withTmpDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-merge-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function runCli(dir, docs, extraArgs = []) {
    const paths = ['base', 'ours', 'theirs'].map((name, i) => {
        const p = path.join(dir, `${name}.json`);
        fs.writeFileSync(p, JSON.stringify(docs[i], null, 2));
        return p;
    });
    return spawnSync(process.execPath, [SCRIPT, ...paths, ...extraArgs], { encoding: 'utf8' });
}

test('CLI exits 0 and writes the merged file on a clean merge', () => {
    withTmpDir((dir) => {
        const base = doc([entry('A')]);
        const ours = doc([reexport(base.entries[0]), entry('O1')]);
        const theirs = doc([reexport(base.entries[0]), entry('T1')]);
        const out = path.join(dir, 'merged.json');

        const res = runCli(dir, [base, ours, theirs], ['--out', out]);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.match(res.stderr, /Three-way merge summary/);
        assert.match(res.stderr, /added by ours\s+: 1/);
        assert.match(res.stderr, /added by theirs\s+: 1/);

        const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
        assert.deepStrictEqual(merged.entries.map((e) => e.title), ['A', 'O1', 'T1']);
        assert.strictEqual(merged.provenance.entry_count, 3);
    });
});

test('CLI writes the merged document to stdout when no --out is given', () => {
    withTmpDir((dir) => {
        const base = doc([entry('A')]);
        const res = runCli(dir, [base, doc([reexport(base.entries[0])]), doc([reexport(base.entries[0])])]);
        assert.strictEqual(res.status, 0, res.stderr);
        const merged = JSON.parse(res.stdout);
        assert.deepStrictEqual(merged.entries.map((e) => e.title), ['A']);
    });
});

test('CLI exits non-zero on a genuine conflict and writes nothing', () => {
    withTmpDir((dir) => {
        const base = doc([entry('Contested')]);
        const ours = doc([reexport(base.entries[0], { summary: 'ours says X' })]);
        const theirs = doc([reexport(base.entries[0], { summary: 'theirs says Y' })]);
        const out = path.join(dir, 'merged.json');

        const res = runCli(dir, [base, ours, theirs], ['--out', out]);
        assert.strictEqual(res.status, 1);
        assert.match(res.stderr, /genuine conflict/i);
        assert.match(res.stderr, /Contested/);
        assert.match(res.stderr, /ours says X/);
        assert.match(res.stderr, /theirs says Y/);
        assert.strictEqual(res.stdout, '', 'a conflicted run must not emit a document');
        assert.strictEqual(fs.existsSync(out), false, 'a conflicted run must not write an output file');
    });
});

test('CLI exits 2 on bad usage', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'only-one'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /expected 3 positional arguments/);
});

test('CLI --help exits 0', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage: node merge-kb-canonical\.mjs/);
});
