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

const { resolveSchemasDir } = await import('../auto-sprint/contracts.mjs');

describe('resolveSchemasDir path-precedence (direct exercise, no real filesystem dependency)', () => {
    test('scenario a: dist/agents/schemas present resolves first, even with lower-precedence candidates also present', () => {
        const seen = [];
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => {
                seen.push(candidate);
                return true; // every candidate "exists" -- precedence order must still pick the first checked
            },
        });
        assert.ok(/dist[\\/]agents[\\/]schemas$/.test(result), result);
        // dist/agents/schemas must be the FIRST candidate probed, proving the
        // root-bundled layout wins over the standalone/dev fallbacks when present.
        assert.ok(/dist[\\/]agents[\\/]schemas$/.test(seen[0]), seen[0]);
    });

    test('scenario b: package-local apra-pm resolves when dist/agents/schemas is absent (standalone install layout)', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => !/dist[\\/]agents[\\/]schemas$/.test(candidate),
        });
        assert.ok(/apra-fleet-se[\\/]apra-pm[\\/]agents[\\/]schemas$/.test(result), result);
    });

    test('scenario c: neither bundled location exists -- returns null', () => {
        const result = resolveSchemasDir({ env: {}, exists: () => false });
        assert.strictEqual(result, null);
    });
});

describe('wired end-to-end resolution against a real OS temp directory', () => {
    test('scenario c (wired): an empty/no-schemas directory still produces a fully working, non-crashing module', async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-empty-'));
        try {
            const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = emptyDir;
            try {
                const wired = await import(`../auto-sprint/contracts.mjs?packaging-test-empty=${Date.now()}-${Math.random()}`);
                for (const name of ['planReviewerVerdict', 'reviewerVerdict', 'doerReport', 'deployerReport', 'integReport', 'ciReport', 'harvesterReport']) {
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
            const wired = await import(`../auto-sprint/contracts.mjs?packaging-test-fixtures=${Date.now()}-${Math.random()}`);
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
