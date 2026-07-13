#!/usr/bin/env node
// Mechanical regeneration of test/fixtures/vendor-apra-pm-schemas/ from a
// real vendor/apra-pm/agents/schemas/ checkout.
//
// Why: that fixture directory is a byte-for-byte snapshot of the real
// vendored schemas, used by contracts-schema-loader.test.mjs and
// contracts-schema-observability.test.mjs to exercise contracts.mjs's
// loader/fallback/warning logic without depending on the vendor/apra-pm
// submodule being initialized in the environment running the test. Hand-
// copying that snapshot invites silent drift; this script makes
// regenerating it (and checking whether it has drifted) a single
// mechanical, testable operation.
//
// Usage:
//   node packages/apra-fleet-se/scripts/regen-vendor-schema-fixtures.mjs [--source <dir>] [--check]
//
//   --source <dir>  Real vendor/apra-pm/agents/schemas/ directory to copy
//                    *.json files FROM. Defaults to this repo's own
//                    vendor/apra-pm submodule (vendor/apra-pm/agents/schemas
//                    relative to the repo root). Pass --source to point at a
//                    different checkout instead.
//   --check          Do not write anything; report whether the destination
//                     fixture is out of sync with --source and exit 1 if
//                     so. Read-only -- safe to run against any checkout
//                     without ever modifying it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DEST_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'vendor-apra-pm-schemas');
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'vendor', 'apra-pm', 'agents', 'schemas');

/**
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ sourceDir: string, check: boolean }}
 */
export function parseArgs(argv) {
    let sourceDir = DEFAULT_SOURCE_DIR;
    let check = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--source') {
            sourceDir = argv[i + 1];
            i += 1;
        } else if (argv[i] === '--check') {
            check = true;
        }
    }
    return { sourceDir, check };
}

/**
 * Reads every *.json file directly inside `sourceDir` (non-recursive) and
 * returns a map of filename -> raw file contents, byte-for-byte (no
 * reformatting). Pure/read-only -- safe to call against a directory (e.g.
 * a submodule checkout) that must not be modified.
 * @param {string} sourceDir
 * @returns {Record<string, string>}
 */
export function readVendorSchemaFiles(sourceDir) {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw new Error(`[regen-vendor-schema-fixtures] source directory does not exist: ${sourceDir}`);
    }
    const result = {};
    for (const entry of fs.readdirSync(sourceDir)) {
        if (!entry.endsWith('.json')) continue;
        result[entry] = fs.readFileSync(path.join(sourceDir, entry), 'utf-8');
    }
    return result;
}

/**
 * Compares `readVendorSchemaFiles(sourceDir)` against the current contents
 * of `destDir`, file by file. Pure/read-only (never writes).
 * @param {string} sourceDir
 * @param {string} destDir
 * @returns {{ inSync: boolean, added: string[], changed: string[], removed: string[] }}
 */
export function diffAgainstDest(sourceDir, destDir) {
    const source = readVendorSchemaFiles(sourceDir);
    const destFiles = fs.existsSync(destDir)
        ? fs.readdirSync(destDir).filter((name) => name.endsWith('.json'))
        : [];

    const added = [];
    const changed = [];
    for (const [name, content] of Object.entries(source)) {
        const destPath = path.join(destDir, name);
        if (!fs.existsSync(destPath)) {
            added.push(name);
        } else if (fs.readFileSync(destPath, 'utf-8') !== content) {
            changed.push(name);
        }
    }
    const removed = destFiles.filter((name) => !(name in source));

    return {
        inSync: added.length === 0 && changed.length === 0 && removed.length === 0,
        added,
        changed,
        removed,
    };
}

/**
 * Writes `readVendorSchemaFiles(sourceDir)` into `destDir`, byte-for-byte,
 * creating `destDir` if needed. Only adds/overwrites files present in
 * `sourceDir` -- does not delete pre-existing files in `destDir` that are
 * no longer in `sourceDir` (inspect `diffAgainstDest(...).removed` first if
 * strict mirroring is required).
 * @param {string} sourceDir
 * @param {string} destDir
 */
export function writeFixtures(sourceDir, destDir) {
    const source = readVendorSchemaFiles(sourceDir);
    fs.mkdirSync(destDir, { recursive: true });
    for (const [name, content] of Object.entries(source)) {
        fs.writeFileSync(path.join(destDir, name), content, 'utf-8');
    }
}

function main() {
    const { sourceDir, check } = parseArgs(process.argv.slice(2));

    if (check) {
        const diff = diffAgainstDest(sourceDir, DEST_DIR);
        if (diff.inSync) {
            console.log(`[regen-vendor-schema-fixtures] ${DEST_DIR} is in sync with ${sourceDir}`);
            process.exit(0);
        }
        console.error(`[regen-vendor-schema-fixtures] ${DEST_DIR} is OUT OF SYNC with ${sourceDir}:`);
        if (diff.added.length) console.error(`  added:   ${diff.added.join(', ')}`);
        if (diff.changed.length) console.error(`  changed: ${diff.changed.join(', ')}`);
        if (diff.removed.length) console.error(`  removed: ${diff.removed.join(', ')}`);
        console.error('Run without --check to regenerate.');
        process.exit(1);
        return;
    }

    writeFixtures(sourceDir, DEST_DIR);
    console.log(`[regen-vendor-schema-fixtures] wrote ${DEST_DIR} from ${sourceDir}`);
}

// Only run main() when this file is executed directly (not when imported
// by a test for its pure helper functions). Compared via resolved paths
// (not raw string equality against a file:// URL) so this is correct on
// Windows too, where argv[1] uses backslashes.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
    main();
}
