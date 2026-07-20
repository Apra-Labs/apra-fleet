import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorSchemaFiles, diffAgainstDest, writeFixtures } from '../scripts/regen-vendor-schema-fixtures.mjs';

// Tests for scripts/regen-vendor-schema-fixtures.mjs's pure copy/diff
// mechanics, plus the actual acceptance criterion: the checked-in
// test/fixtures/vendor-apra-pm-schemas/ snapshot matches what the script
// would currently produce from this repo's real vendor/apra-pm submodule
// checkout (read-only -- this test never writes to the submodule).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vendor-apra-pm-schemas');
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const REAL_VENDOR_SOURCE_DIR = path.join(REPO_ROOT, 'vendor', 'apra-pm', 'agents', 'schemas');

describe('regen-vendor-schema-fixtures.mjs: pure copy mechanics', () => {
    let tmpSrc;
    let tmpDest;

    before(() => {
        tmpSrc = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'tmp-regen-src-'));
        tmpDest = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'tmp-regen-dest-'));
    });

    after(() => {
        fs.rmSync(tmpSrc, { recursive: true, force: true });
        fs.rmSync(tmpDest, { recursive: true, force: true });
    });

    test('readVendorSchemaFiles reads only *.json files, byte-for-byte', () => {
        fs.writeFileSync(path.join(tmpSrc, 'a-output.json'), '{"$id":"a"}', 'utf-8');
        fs.writeFileSync(path.join(tmpSrc, 'README.md'), 'ignored', 'utf-8');
        const files = readVendorSchemaFiles(tmpSrc);
        assert.deepStrictEqual(files, { 'a-output.json': '{"$id":"a"}' });
    });

    test('readVendorSchemaFiles throws a clear error for a nonexistent source directory', () => {
        assert.throws(
            () => readVendorSchemaFiles(path.join(tmpSrc, 'does-not-exist')),
            /source directory does not exist/,
        );
    });

    test('writeFixtures reproduces the source directory into an empty destination', () => {
        fs.writeFileSync(path.join(tmpSrc, 'b-output.json'), '{"$id":"b"}', 'utf-8');
        writeFixtures(tmpSrc, tmpDest);
        assert.deepStrictEqual(fs.readdirSync(tmpDest).sort(), ['a-output.json', 'b-output.json']);
        assert.strictEqual(fs.readFileSync(path.join(tmpDest, 'b-output.json'), 'utf-8'), '{"$id":"b"}');
    });

    test('diffAgainstDest reports inSync: true once destination matches source', () => {
        const diff = diffAgainstDest(tmpSrc, tmpDest);
        assert.deepStrictEqual(diff, { inSync: true, added: [], changed: [], removed: [] });
    });

    test('diffAgainstDest detects a changed file after a downstream edit', () => {
        fs.writeFileSync(path.join(tmpDest, 'a-output.json'), '{"$id":"a-mutated"}', 'utf-8');
        const diff = diffAgainstDest(tmpSrc, tmpDest);
        assert.strictEqual(diff.inSync, false);
        assert.deepStrictEqual(diff.changed, ['a-output.json']);
    });

    test('diffAgainstDest detects an added and a removed file', () => {
        fs.writeFileSync(path.join(tmpSrc, 'c-output.json'), '{"$id":"c"}', 'utf-8'); // new in source, not yet in dest
        fs.writeFileSync(path.join(tmpDest, 'stale-output.json'), '{"$id":"stale"}', 'utf-8'); // in dest, not in source
        const diff = diffAgainstDest(tmpSrc, tmpDest);
        assert.strictEqual(diff.inSync, false);
        assert.deepStrictEqual(diff.added, ['c-output.json']);
        assert.deepStrictEqual(diff.removed, ['stale-output.json']);
    });
});

describe('regen-vendor-schema-fixtures.mjs: checked-in fixture consistency', () => {
    test('the checked-in fixture is self-consistent (diffAgainstDest against itself is inSync)', () => {
        const diff = diffAgainstDest(FIXTURES_DIR, FIXTURES_DIR);
        assert.deepStrictEqual(diff, { inSync: true, added: [], changed: [], removed: [] });
    });

    const realSourceAvailable = fs.existsSync(REAL_VENDOR_SOURCE_DIR) && fs.statSync(REAL_VENDOR_SOURCE_DIR).isDirectory();

    test(
        'AC: the checked-in fixture matches what the script would currently produce from the real vendored submodule',
        { skip: realSourceAvailable ? false : `vendor/apra-pm submodule not initialized at ${REAL_VENDOR_SOURCE_DIR} -- run: git submodule update --init` },
        () => {
            const diff = diffAgainstDest(REAL_VENDOR_SOURCE_DIR, FIXTURES_DIR);
            assert.deepStrictEqual(
                diff,
                { inSync: true, added: [], changed: [], removed: [] },
                `test/fixtures/vendor-apra-pm-schemas/ is out of sync with ${REAL_VENDOR_SOURCE_DIR} -- ` +
                    'run: node packages/apra-fleet-se/scripts/regen-vendor-schema-fixtures.mjs',
            );
        },
    );
});
