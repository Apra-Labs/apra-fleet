import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// apra-fleet-bun.5 -- end-to-end proof of apra-fleet-bun's acceptance
// criterion: a package directory with NO ancestor schema copy present still
// resolves correct, non-stale schemas (or degrades cleanly to the
// hand-written fallback literals without crashing), across every tier of
// resolveSchemasDir()'s bundled-location-first precedence (apra-fleet-bun.1).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas');

// apra-fleet-j918.7.4: the "resolveSchemasDir path-precedence (direct
// exercise, no real filesystem dependency)" describe block that used to
// live here (scenario a/b/c: freshness-tie-to-dist + probe order,
// dist-absent fallthrough, neither-exists-null) duplicated test/contracts-
// schemas-dir.test.mjs's cases 1-4 exactly, plus scenario a's probe-order
// assertion (moved into that file's case 3, verified non-regressed before
// deletion here). contracts-schemas-dir.test.mjs is now the single source
// of truth for the precedence algorithm; this file keeps only its own
// distinct packaging concern below -- real end-to-end resolution wired
// through a real env var and a real temp/fixture directory, proving the
// SCHEMAS export degrades to (or resolves away from) FALLBACK_SCHEMAS
// correctly, which the pure-precedence unit tests never exercise.

describe('wired end-to-end resolution against a real OS temp directory', () => {
    test('scenario c (wired): an empty/no-schemas directory still produces a fully working, non-crashing module', async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-empty-'));
        try {
            const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = emptyDir;
            try {
                const wired = await import(`../fleet-sprint/contracts.mjs?packaging-test-empty=${Date.now()}-${Math.random()}`);
                for (const name of ['planReviewerVerdict', 'reviewerVerdict', 'doerReport', 'deployerReport', 'integReport', 'regressionReport', 'ciReport', 'harvesterReport']) {
                    assert.strictEqual(wired.SCHEMAS[name], wired.FALLBACK_SCHEMAS[name], `expected ${name} to be the fallback literal`);
                }
                const result = wired.validateVerdict('harvesterReport', { status: 'OK', notes: 'ok' });
                assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
            } finally {
                if (previous === undefined) {
                    delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
                } else {
                    process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
                }
            }
        } finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    test('scenario b (wired): a real vendored-schema directory resolves the real (non-literal) schemas', async () => {
        const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        process.env.APRA_FLEET_SE_SCHEMAS_DIR = FIXTURES_DIR;
        try {
            const wired = await import(`../fleet-sprint/contracts.mjs?packaging-test-fixtures=${Date.now()}-${Math.random()}`);
            assert.strictEqual(wired.harvesterReport.$id, 'apra-pm/harvester-output@1');
            assert.notStrictEqual(wired.harvesterReport, wired.FALLBACK_SCHEMAS.harvesterReport);
        } finally {
            if (previous === undefined) {
                delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            } else {
                process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
            }
        }
    });
});
