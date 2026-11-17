import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-unw2.5 -- observability for the "directory exists but a
// specific expected schema file is missing" case in contracts.mjs's
// apra-pm schema loader.
//
// Two very different absences must be told apart:
//
//   1. resolveSchemasDir() resolves no directory at all (VENDOR_SCHEMAS_DIR
//      === null) -- the expected, quiet, already-documented state when
//      none of the bundled/monorepo candidates exist yet (see contracts.mjs
//      section 2). MUST stay silent.
//
//   2. The directory exists but one role's <role>-output.json is missing
//      from it -- an apra-pm package update silently dropped/never-added a schema
//      file this module expects. MUST warn loudly (console.warn), unless
//      the role is allow-listed as legitimately schema-less (planner).
//
// These tests exercise both the direct unit (warnIfVendorFileUnexpectedly
// Missing, called straight) and the wired end-to-end path (module-load-time
// resolveOutputSchema calls) the same way
// test/contracts-schema-loader.test.mjs's "Group 2" does: by setting
// APRA_FLEET_SE_SCHEMAS_DIR before a cache-busted
// dynamic import.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas');

/**
 * Dynamically (re)imports contracts.mjs with
 * APRA_FLEET_SE_SCHEMAS_DIR pointed at `overrideDir`
 * for the duration of the import, restoring the previous env var value
 * immediately after. Cache-busted via a unique query string so every call
 * gets a fresh module instance (and therefore a fresh module-load-time
 * VENDOR_SCHEMAS_DIR resolution + fresh resolveOutputSchema() calls).
 * @param {string} overrideDir
 */
async function importWired(overrideDir) {
    const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
    process.env.APRA_FLEET_SE_SCHEMAS_DIR = overrideDir;
    try {
        return await import(`../fleet-sprint/contracts.mjs?observability-test=${Date.now()}-${Math.random()}`);
    } finally {
        if (previous === undefined) {
            delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        } else {
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
        }
    }
}

/**
 * Captures every console.warn call made during `fn()` (which may be async),
 * restoring the real console.warn afterward regardless of outcome.
 * @param {() => (void | Promise<void>)} fn
 * @returns {Promise<string[]>} one joined string per console.warn call
 */
async function withCapturedWarnings(fn) {
    const calls = [];
    const original = console.warn;
    console.warn = (...args) => {
        calls.push(args.join(' '));
    };
    try {
        await fn();
    } finally {
        console.warn = original;
    }
    return calls;
}

function makeTmpFixtureCopy(prefix, { omit = [] } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'fixtures', prefix));
    for (const file of fs.readdirSync(FIXTURES_DIR)) {
        if (omit.includes(file)) continue;
        fs.copyFileSync(path.join(FIXTURES_DIR, file), path.join(tmpDir, file));
    }
    return tmpDir;
}

describe('whole-directory absence stays quiet (documented fallback state)', () => {
    test('no console.warn when packages/apra-fleet-se/apra-pm/agents/schemas/ does not exist at all', async () => {
        const missingDir = path.join(__dirname, 'fixtures', 'does-not-exist-vendor-schemas-dir');
        assert.ok(!fs.existsSync(missingDir), 'test setup: this directory must not exist');

        const calls = await withCapturedWarnings(async () => {
            await importWired(missingDir);
        });

        assert.strictEqual(calls.length, 0, `expected zero warnings, got: ${JSON.stringify(calls)}`);
    });
});

describe('directory exists but a specific expected role output file is missing', () => {
    let tmpDir;

    before(() => {
        // Simulate an apra-pm package update that added the directory but dropped
        // doer-output.json specifically.
        tmpDir = makeTmpFixtureCopy('tmp-missing-doer-output-', { omit: ['doer-output.json'] });
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('AC: warns loudly (console.warn), naming the missing role and file', async () => {
        const calls = await withCapturedWarnings(async () => {
            await importWired(tmpDir);
        });

        assert.ok(calls.length > 0, 'expected at least one console.warn call for the missing doer-output.json');
        assert.ok(
            calls.some((c) => c.includes('doer-output') && c.includes('"doer"')),
            `expected a warning naming doer-output/"doer", got: ${JSON.stringify(calls)}`,
        );
    });
});

describe('allowlist: roles with no legitimate output schema never warn', () => {
    // KB trust pipeline Phase 2 (2026-08-03): the planner used to be the sole
    // allow-listed role, on the layering proposal's reasoning that its output IS
    // the beads DAG. It now has agents/schemas/planner-output.json so it can
    // carry kb_captures, which means a MISSING planner-output.json is once again
    // a real defect -- the exact inverse of what this used to assert.
    test('planner now HAS an output schema and is no longer allow-listed', async () => {
        const wired = await importWired(FIXTURES_DIR);
        assert.ok(fs.statSync(FIXTURES_DIR).isDirectory());
        assert.ok(fs.existsSync(path.join(FIXTURES_DIR, 'planner-output.json')));

        const calls = await withCapturedWarnings(() => {
            wired.warnIfVendorFileUnexpectedlyMissing('planner', 'planner-output-that-does-not-exist');
        });

        assert.strictEqual(calls.length, 1, `expected planner to warn like any other role, got: ${JSON.stringify(calls)}`);
    });

    test('a non-allow-listed role in the same directory still warns (control case)', async () => {
        const wired = await importWired(FIXTURES_DIR);

        const calls = await withCapturedWarnings(() => {
            wired.warnIfVendorFileUnexpectedlyMissing('doer', 'doer-output-that-does-not-exist');
        });

        assert.strictEqual(calls.length, 1, `expected exactly one warning, got: ${JSON.stringify(calls)}`);
    });

    test('ROLES_WITHOUT_OUTPUT_SCHEMA is empty -- every role now has an output contract', async () => {
        // The mechanism is kept for a future legitimately schema-less role; the
        // set being empty is the assertion that no role is currently exempt.
        const wired = await importWired(FIXTURES_DIR);
        assert.deepStrictEqual([...wired.ROLES_WITHOUT_OUTPUT_SCHEMA], []);
    });
});
