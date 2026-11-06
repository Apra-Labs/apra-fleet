#!/usr/bin/env node
/**
 * check-bible-entry-count.mjs -- fails when a knowledge-bank canonical file's
 * provenance.entry_count differs from its entries length. git merges the file
 * as text, so a clean textual merge can leave a stale count (main once held
 * 127 entries with entry_count 124).
 *
 * Usage: node scripts/check-bible-entry-count.mjs [file ...]
 * Default file: .fleet/kb-canonical.json. A missing file is skipped. The
 * legacy bare-array shape has no provenance and is skipped.
 * Wired into `npm test` via tests/check-bible-entry-count.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BIBLES = ['.fleet/kb-canonical.json'];

/** Returns a list of problem strings for one parsed document (empty = ok). */
export function checkDocument(doc, label = 'bible') {
    if (Array.isArray(doc)) return [];
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
        return [`${label}: not a canonical bible (no entries array)`];
    }
    const count = doc.provenance?.entry_count;
    if (count !== doc.entries.length) {
        return [`${label}: provenance.entry_count is ${count} but entries has ${doc.entries.length}`];
    }
    return [];
}

export function checkFiles(files = DEFAULT_BIBLES, repoRoot = REPO_ROOT) {
    const problems = [];
    for (const rel of files) {
        const abs = path.resolve(repoRoot, rel);
        if (!fs.existsSync(abs)) continue;
        let doc;
        try {
            doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
        } catch (err) {
            problems.push(`${rel}: invalid JSON (${err.message})`);
            continue;
        }
        problems.push(...checkDocument(doc, rel));
    }
    return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const problems = checkFiles(args.length > 0 ? args : DEFAULT_BIBLES);
    if (problems.length > 0) {
        for (const p of problems) console.error(`FAIL ${p}`);
        process.exit(1);
    }
    console.log('OK: bible entry_count matches entries length.');
}
