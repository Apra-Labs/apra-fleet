import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Guard: the fleet-sprint engine never exports the knowledge bible itself.
//
// The bible reaches the repository only through the kb_maintainer's
// kb_bible_commit (entry-level merge, removals, push guards -- see
// fleet-sprint/kb.mjs commitRepo). An engine-side kb_export call (or a
// helper named exportBible wrapping one) would bypass all of that, so no
// non-test source file under fleet-sprint/ may contain either name.
//
// Same rule as the command-line check
//   rg -n "kb_export|exportBible" packages/apra-fleet-se/fleet-sprint -g '!*test*'
// returning no match: every file is scanned as plain text, and COMMENTS ARE
// INCLUDED on purpose -- a comment naming the tool is cheap to reword, while
// telling comments from code would need a JS tokenizer that can itself miss
// a real call. A path is a test file (skipped) when any of its path segments
// under fleet-sprint/ contains "test", which is what rg's '!*test*' glob skips.
// =============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, '..', 'fleet-sprint');
const FORBIDDEN = /kb_export|exportBible/;

/** Every non-test file under `root` (recursive), as paths relative to root. */
export function engineSourceFiles(root) {
    const out = [];
    const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name === 'node_modules' || ent.name.includes('test')) continue;
            const abs = path.join(dir, ent.name);
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) walk(abs, r);
            else if (ent.isFile()) out.push(r);
        }
    };
    walk(root, '');
    return out.sort();
}

/** `file:line: text` for every line of a non-test file under root naming kb_export or exportBible. */
export function bibleExportHits(root) {
    const hits = [];
    for (const rel of engineSourceFiles(root)) {
        const lines = fs.readFileSync(path.join(root, rel), 'utf-8').split(/\r?\n/);
        lines.forEach((line, i) => {
            if (FORBIDDEN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    return hits;
}

describe('fleet-sprint engine never exports the bible itself', () => {
    test('no non-test source file under fleet-sprint/ contains kb_export or exportBible (comments included)', () => {
        const files = engineSourceFiles(ENGINE_ROOT);
        assert.ok(files.some((f) => f === 'kb.mjs'), `the scan must cover the engine sources (found ${files.length} files)`);
        const hits = bibleExportHits(ENGINE_ROOT);
        assert.deepEqual(hits, [], `the engine must not call kb_export/exportBible -- the bible is written only by the kb_maintainer's kb_bible_commit:\n${hits.join('\n')}`);
    });

    test('the scanner flags a planted call in code or a comment, and skips test paths', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-bible-guard-'));
        try {
            fs.mkdirSync(path.join(root, 'phases'));
            fs.mkdirSync(path.join(root, 'test-helpers'));
            fs.writeFileSync(path.join(root, 'clean.mjs'), 'export const x = 1;\n');
            fs.writeFileSync(path.join(root, 'phases', 'harvest.mjs'), "const a = 1;\nawait memberCall(m, 'kb_export', {});\n");
            fs.writeFileSync(path.join(root, 'notes.mjs'), '// exportBible() used to live here\n');
            fs.writeFileSync(path.join(root, 'kb.test.mjs'), "memberCall(m, 'kb_export');\n");
            fs.writeFileSync(path.join(root, 'test-helpers', 'fake.mjs'), "memberCall(m, 'kb_export');\n");
            assert.deepEqual(bibleExportHits(root), [
                'notes.mjs:1: // exportBible() used to live here',
                "phases/harvest.mjs:2: await memberCall(m, 'kb_export', {});",
            ]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
