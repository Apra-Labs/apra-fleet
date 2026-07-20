#!/usr/bin/env node
// Copies this repo's vendor/apra-pm/agents/schemas/*.json into
// packages/apra-fleet-se/vendor/schemas/ -- a package-local, build-time
// snapshot so a standalone install (or a dev checkout that has run this
// script) of @apralabs/apra-fleet-se can resolve its role schemas without
// depending on an ancestor vendor/apra-pm/ existing at all (apra-fleet-bun).
//
// This is the "standalone/dev-package-tree" layout in
// auto-sprint/contracts.mjs's resolveSchemasDir() precedence -- distinct
// from the "root-bundle" layout (dist/agents/schemas), which
// scripts/vendor-pm.mjs already populates for dist/auto-sprint.mjs.
//
// Reuses regen-vendor-schema-fixtures.mjs's pure copy/diff helpers rather
// than reimplementing them.
//
// Usage:
//   node packages/apra-fleet-se/scripts/vendor-schemas.mjs [--source <dir>] [--check]
//
//   --source <dir>  Real vendor/apra-pm/agents/schemas/ directory to copy
//                    *.json files FROM. Defaults to this repo's own
//                    vendor/apra-pm submodule.
//   --check          Do not write anything; report whether the destination
//                     is out of sync with --source and exit 1 if so.
//                     Read-only -- used as a CI drift-detection gate.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorSchemaFiles, diffAgainstDest, writeFixtures } from './regen-vendor-schema-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(PACKAGE_ROOT, '..', '..');
const DEST_DIR = path.join(PACKAGE_ROOT, 'vendor', 'schemas');
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

function main() {
    const { sourceDir, check } = parseArgs(process.argv.slice(2));

    if (check) {
        const diff = diffAgainstDest(sourceDir, DEST_DIR);
        if (diff.inSync) {
            console.log(`[vendor-schemas] ${DEST_DIR} is in sync with ${sourceDir}`);
            process.exit(0);
        }
        console.error(`[vendor-schemas] ${DEST_DIR} is OUT OF SYNC with ${sourceDir}:`);
        if (diff.added.length) console.error(`  added:   ${diff.added.join(', ')}`);
        if (diff.changed.length) console.error(`  changed: ${diff.changed.join(', ')}`);
        if (diff.removed.length) console.error(`  removed: ${diff.removed.join(', ')}`);
        console.error('Run without --check to regenerate.');
        process.exit(1);
        return;
    }

    writeFixtures(sourceDir, DEST_DIR);
    console.log(`[vendor-schemas] wrote ${DEST_DIR} from ${sourceDir}`);
}

// Only run main() when this file is executed directly (not when imported
// by a test for its pure helper functions). Compared via resolved paths
// (not raw string equality against a file:// URL) so this is correct on
// Windows too, where argv[1] uses backslashes.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
    main();
}

export { readVendorSchemaFiles, diffAgainstDest, writeFixtures, DEST_DIR, DEFAULT_SOURCE_DIR };
