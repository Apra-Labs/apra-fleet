import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// apra-fleet-spp.2 -- guard against a stale, gitignored local dist/agents/
// schemas build artifact silently shadowing the committed package-local
// apra-pm source schemas.
//
// Background (apra-fleet-spp.1): contracts.mjs's resolveSchemasDir() prefers
// dist/agents/schemas over packages/apra-fleet-se/apra-pm/agents/schemas
// when both exist (see contracts.mjs's documented precedence). dist/ is
// gitignored and only refreshed by `npm run dist-pm`, so a developer's local
// dist/ can drift out of sync with the source schemas after a schema change
// -- causing local test failures (and confusing local-only verdict-shape
// bugs) that CI never reproduces, because no CI workflow runs dist-pm before
// tests.
//
// This guard follows the freshness-first resolver: resolveSchemasDir() serves
// dist/agents/schemas ONLY when its newest schema is at least as new as the
// package-local source (a strictly older dist is already shadowed by source at
// runtime, so it is harmless and must not fail the suite after a branch
// switch). The guard therefore fails only when the resolver would actually
// serve dist AND a dist schema differs from, or is missing from, the
// package-local source; it lists every offender with a `npm run dist-pm`
// remediation hint. No dist-pm run or pretest hook is needed to run npm test.

const { DIST_BUNDLED_SCHEMAS_DIR, PACKAGE_LOCAL_SCHEMAS_DIR, resolveSchemasDir } = await import('../fleet-sprint/contracts.mjs');

/**
 * Returns the drift report lines for a dist dir, or [] when nothing needs
 * failing. `resolved` is what resolveSchemasDir() returned; the check only
 * applies when it is the dist bundle.
 */
function distDriftReport(resolved, distDir, sourceDir) {
    if (resolved !== DIST_BUNDLED_SCHEMAS_DIR || !isDirectory(distDir)) return [];
    const drifted = [];
    const missingSource = [];
    for (const fileName of fs.readdirSync(distDir).filter((f) => f.endsWith('.json'))) {
        const sourcePath = path.join(sourceDir, fileName);
        if (!fs.existsSync(sourcePath)) { missingSource.push(fileName); continue; }
        if (fs.readFileSync(path.join(distDir, fileName), 'utf-8') !== fs.readFileSync(sourcePath, 'utf-8')) drifted.push(fileName);
    }
    if (drifted.length === 0 && missingSource.length === 0) return [];
    return [
        'Stale dist/agents/schemas detected -- these schemas differ from (or are missing from) the package-local apra-pm source:',
        ...drifted.map((f) => `  DRIFTED: ${f}`),
        ...missingSource.map((f) => `  ONLY IN DIST (no package-local source): ${f}`),
        '',
        'Fix: run `npm run dist-pm` to refresh dist/ from the current source schemas.',
    ];
}

// Resolver with both dirs present and the given freshness (ms) for each.
const resolveWith = (distMs, sourceMs) => resolveSchemasDir({
    env: {},
    exists: () => true,
    newestJsonMtimeMs: (dir) => (dir === DIST_BUNDLED_SCHEMAS_DIR ? distMs : sourceMs),
});

describe('dist/agents/schemas staleness guard', () => {
    test('when the resolver would serve dist, every dist schema is byte-identical to its package-local source', () => {
        const report = distDriftReport(resolveSchemasDir(), DIST_BUNDLED_SCHEMAS_DIR, PACKAGE_LOCAL_SCHEMAS_DIR);
        if (report.length > 0) assert.fail(report.join('\n'));
    });

    describe('temp-dir cases through the resolver deps seam', () => {
        let tmp;
        let dist;
        let src;
        before(() => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-guard-'));
            dist = path.join(tmp, 'dist');
            src = path.join(tmp, 'src');
            fs.mkdirSync(dist);
            fs.mkdirSync(src);
            fs.writeFileSync(path.join(src, 'a.json'), '{"v":2}');
            fs.writeFileSync(path.join(dist, 'a.json'), '{"v":1}');
            fs.writeFileSync(path.join(dist, 'orphan.json'), '{}');
        });
        after(() => fs.rmSync(tmp, { recursive: true, force: true }));

        test('a dist OLDER than source (drifted) passes: the resolver serves source', () => {
            assert.equal(resolveWith(100, 200), PACKAGE_LOCAL_SCHEMAS_DIR);
            assert.deepEqual(distDriftReport(resolveWith(100, 200), dist, src), []);
        });

        test('a dist NEWER than source that has drifted fails with the DRIFTED list and remediation', () => {
            const report = distDriftReport(resolveWith(300, 200), dist, src).join('\n');
            assert.match(report, /DRIFTED: a\.json/);
            assert.match(report, /ONLY IN DIST .*: orphan\.json/);
            assert.match(report, /npm run dist-pm/);
        });

        test('a dist TIED with source that has drifted still fails', () => {
            assert.notDeepEqual(distDriftReport(resolveWith(200, 200), dist, src), []);
        });

        test('an identical newer dist passes', () => {
            const t2 = fs.mkdtempSync(path.join(tmp, 'same-'));
            const d2 = path.join(t2, 'd'); const s2 = path.join(t2, 's');
            fs.mkdirSync(d2); fs.mkdirSync(s2);
            fs.writeFileSync(path.join(d2, 'a.json'), '{}'); fs.writeFileSync(path.join(s2, 'a.json'), '{}');
            assert.deepEqual(distDriftReport(resolveWith(300, 200), d2, s2), []);
        });
    });
});

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}
