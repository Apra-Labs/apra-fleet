import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    kbKnowledgeBlock,
    isInjectableKbEntry,
    capKbBlockSummary,
    trimKbBlockSourceFiles,
    KB_MAX_KNOWLEDGE_ENTRIES,
    KB_BLOCK_SUMMARY_MAX,
    KB_BLOCK_SOURCE_FILES_MAX,
} from '../fleet-sprint/kb.mjs';

// The KNOWLEDGE BANK block renders compact JSON: title, capped summary,
// trimmed source_files; no id, no confidence. Which entries appear, and in what
// order, is unchanged: CONFIRMED-and-undisputed filter, then the 12 cap.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 12 real CONFIRMED entries (the longest summaries in the repo's KB export).
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kb-block-compact', 'confirmed-entries.json'), 'utf8'));

/** The JSON array inside the block's untrusted fence. */
function blockEntries(block) {
    const open = block.indexOf('untrusted-agent-output\n');
    assert.ok(open > 0, 'block carries the untrusted fence');
    const body = block.slice(open + 'untrusted-agent-output\n'.length);
    const line = body.slice(0, body.indexOf('\n'));
    assert.ok(line.startsWith('[') && line.endsWith(']'), 'the JSON is a single compact line');
    return JSON.parse(line);
}

const noise = (id, confidence, extra = {}) => ({ id, title: 'title ' + id, summary: 's', confidence, source_files: ['a.ts'], ...extra });

describe('compact KNOWLEDGE BANK block', () => {
    test('same entries, same order as the selection rule (filter, then cap)', () => {
        const many = [...REAL, ...REAL.map((e) => ({ ...e, id: e.id + '-2', title: e.title + ' (copy)' }))];
        const input = [
            noise('i1', 'INFERRED'), many[0], noise('f1', 'CONFIRMED', { flagged_for_review: true }),
            ...many.slice(1, 5), noise('u1', 'UNVERIFIED'), noise('x1', 'CONFIRMED', { contradiction_of: 'y' }),
            ...many.slice(5),
        ];
        const expected = input.filter(isInjectableKbEntry).slice(0, KB_MAX_KNOWLEDGE_ENTRIES).map((e) => e.title);
        assert.equal(expected.length, KB_MAX_KNOWLEDGE_ENTRIES);
        assert.equal(new Set(input.map((e) => e.title)).size, input.length, 'titles identify entries');
        const [block] = kbKnowledgeBlock(input, { source: 'query' });
        assert.deepEqual(blockEntries(block).map((e) => e.title), expected);
    });

    test('rows carry title, summary, source_files -- plus id exactly when the summary was cut; never confidence', () => {
        // Mix cut and uncut rows: half the real entries keep a short summary.
        const mixed = REAL.map((e, i) => (i % 2 ? { ...e, summary: e.summary.slice(0, 120) } : e));
        const [block] = kbKnowledgeBlock(mixed);
        const rows = blockEntries(block);
        let withId = 0;
        rows.forEach((row, i) => {
            const cut = mixed[i].summary.length > KB_BLOCK_SUMMARY_MAX;
            assert.deepEqual(Object.keys(row), cut ? ['id', 'title', 'summary', 'source_files'] : ['title', 'summary', 'source_files']);
            if (cut) { withId++; assert.equal(row.id, mixed[i].id); assert.ok(row.summary.endsWith('...')); }
        });
        assert.ok(withId > 0 && withId < rows.length, 'the fixture has both cut and uncut rows');
        mixed.forEach((e) => {
            const hits = block.split(e.id).length - 1;
            assert.equal(hits, e.summary.length > KB_BLOCK_SUMMARY_MAX ? 1 : 0, 'id appears exactly on its cut row');
        });
        assert.ok(!block.includes('"confidence"'));
    });

    test('summaries are capped on a word boundary and end with "..."', () => {
        const rows = blockEntries(kbKnowledgeBlock(REAL)[0]);
        let cut = 0;
        rows.forEach((row, i) => {
            const full = REAL[i].summary;
            assert.ok(row.summary.length <= KB_BLOCK_SUMMARY_MAX, row.title + ': ' + row.summary.length);
            if (full.length <= KB_BLOCK_SUMMARY_MAX) { assert.equal(row.summary, full); return; }
            cut++;
            assert.ok(row.summary.endsWith('...'));
            const kept = row.summary.slice(0, -3);
            assert.ok(full.startsWith(kept), 'a prefix of the original');
            assert.match(full.slice(kept.length), /^\s/, 'cut at a word boundary');
        });
        assert.ok(cut > 0, 'the fixture exercises the cap');
    });

    test('capKbBlockSummary: short passes through, one long token is cut mid-word within the cap', () => {
        assert.equal(capKbBlockSummary('short'), 'short');
        assert.equal(capKbBlockSummary(undefined), undefined);
        const long = 'x'.repeat(500);
        assert.equal(capKbBlockSummary(long), 'x'.repeat(KB_BLOCK_SUMMARY_MAX - 3) + '...');
    });

    test('source_files keep the first few plus a "+N more" note', () => {
        const rows = blockEntries(kbKnowledgeBlock(REAL)[0]);
        let trimmed = 0;
        rows.forEach((row, i) => {
            const full = REAL[i].source_files;
            if (full.length <= KB_BLOCK_SOURCE_FILES_MAX) { assert.deepEqual(row.source_files, full); return; }
            trimmed++;
            assert.deepEqual(row.source_files, [...full.slice(0, KB_BLOCK_SOURCE_FILES_MAX), `+${full.length - KB_BLOCK_SOURCE_FILES_MAX} more`]);
        });
        assert.ok(trimmed > 0, 'the fixture exercises the trim');
        assert.equal(trimKbBlockSourceFiles(undefined), undefined);
        assert.deepEqual(trimKbBlockSourceFiles(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', '+2 more']);
    });

    test('a 12-entry block of real long entries stays under its size budget', () => {
        assert.equal(REAL.length, KB_MAX_KNOWLEDGE_ENTRIES);
        const [block] = kbKnowledgeBlock(REAL, { source: 'query' });
        // Was 10414 chars as pretty JSON with confidence and full summaries/files.
        assert.ok(block.length <= 8400, `block is ${block.length} chars`);
    });

    test('the header explains the truncation markers', () => {
        const [block] = kbKnowledgeBlock(REAL);
        assert.ok(block.startsWith('KNOWLEDGE BANK -- what this repo already knows.'));
        assert.ok(block.includes('A summary ending in "..." was cut short and carries its id; if you have kb_query, '
            + 'query it with the entry title to read the full entry. "+N more" counts unlisted source files.'));
    });
});
