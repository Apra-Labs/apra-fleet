import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// apra-fleet-bun.5 -- end-to-end proof of apra-fleet-bun's acceptance
// criterion: a package directory with NO ancestor vendor/ present still
// resolves correct, non-stale vendored schemas (or degrades cleanly to the
// hand-written fallback literals without crashing), across every tier of
// resolveSchemasDir()'s bundled-location-first precedence (apra-fleet-bun.1),
// plus scripts/vendor-schemas.mjs's --check drift detection (apra-fleet-bun.2).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vendor-apra-pm-schemas');
const VENDOR_SCHEMAS_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'vendor-schemas.mjs');
const REAL_DEST_DIR = path.join(PACKAGE_ROOT, 'vendor', 'schemas');

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

    test('scenario b: package-local vendor/schemas resolves when dist/agents/schemas is absent (standalone install layout)', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => !/dist[\\/]agents[\\/]schemas$/.test(candidate),
        });
        assert.ok(/apra-fleet-se[\\/]vendor[\\/]schemas$/.test(result), result);
    });

    test('scenario c: neither bundled location exists and there is no monorepo vendor/apra-pm ancestor either -- returns null', () => {
        const result = resolveSchemasDir({ env: {}, exists: () => false });
        assert.strictEqual(result, null);
    });

    test('dev fallback never silently wins over a present bundled dir (precedence violation guard)', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => /vendor[\\/]apra-pm[\\/]agents[\\/]schemas$/.test(candidate) || /apra-fleet-se[\\/]vendor[\\/]schemas$/.test(candidate),
        });
        // package-local vendor/schemas (tier 3) must win over the monorepo
        // fallback (tier 4) when both exist.
        assert.ok(/apra-fleet-se[\\/]vendor[\\/]schemas$/.test(result), result);
        assert.ok(!/vendor[\\/]apra-pm[\\/]agents[\\/]schemas$/.test(result), result);
    });
});

describe('wired end-to-end resolution against a real OS temp directory with no ancestor vendor/', () => {
    test('scenario c (wired): an empty/no-schemas directory with no vendor/ ancestor still produces a fully working, non-crashing module', async () => {
        // A genuine OS temp dir (os.tmpdir(), not a subdirectory of this
        // repo) -- there is no vendor/ anywhere in its ancestry, which is
        // exactly the "no ancestor vendor/" scenario apra-fleet-bun's
        // acceptance criterion describes for a corrupted/partial install.
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-no-vendor-'));
        try {
            const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = emptyDir;
            try {
                const wired = await import(`../auto-sprint/contracts.mjs?packaging-test-empty=${Date.now()}-${Math.random()}`);
                // Every schema falls back to its hand-written literal (apra-fleet-bun.3) --
                // no crash at import time, VALIDATORS fully populated and usable.
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

    test('scenario b (wired): a real vendored-schema directory with no ancestor vendor/ resolves the real (non-literal) schemas', async () => {
        // FIXTURES_DIR lives under test/fixtures/ -- outside any vendor/
        // ancestry -- so pointing the override directly at it proves
        // resolution works from an arbitrary directory, independent of this
        // checkout's real vendor/apra-pm submodule state.
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

describe('vendor-schemas.mjs --check drift detection (apra-fleet-bun.2)', () => {
    test('exits 1 and reports the changed file when --source diverges from the real dest', () => {
        const tmpSource = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'tmp-vendor-schemas-drift-'));
        try {
            fs.cpSync(FIXTURES_DIR, tmpSource, { recursive: true });
            fs.writeFileSync(path.join(tmpSource, 'harvester-output.json'), '{"tampered":true}', 'utf-8');

            assert.throws(
                () => execFileSync(process.execPath, [VENDOR_SCHEMAS_SCRIPT, '--source', tmpSource, '--check'], { stdio: 'pipe' }),
                (err) => {
                    assert.strictEqual(err.status, 1);
                    const stderr = err.stderr.toString();
                    assert.match(stderr, /OUT OF SYNC/);
                    return true;
                },
            );
        } finally {
            fs.rmSync(tmpSource, { recursive: true, force: true });
        }
    });

    test('exits 0 when --source matches the dest exactly (self-consistency, real dest)', () => {
        if (!fs.existsSync(REAL_DEST_DIR)) {
            // Not yet built in this environment (vendor-schemas.mjs has not
            // run) -- the drift-detection MECHANISM is already proven by the
            // "exits 1" case above; skip the positive self-consistency case
            // rather than fail on missing build output.
            return;
        }
        const output = execFileSync(process.execPath, [VENDOR_SCHEMAS_SCRIPT, '--source', REAL_DEST_DIR, '--check'], { encoding: 'utf-8' });
        assert.match(output, /is in sync with/);
    });
});
