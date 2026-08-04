import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
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
// This test is a no-op skip when dist/agents/schemas does not exist locally
// (the common case, including CI) -- it only activates for a developer who
// already has a local dist/ build, which is exactly the population at risk
// of silent staleness. When dist/agents/schemas DOES exist, every schema
// file in it must be byte-identical to its package-local source
// counterpart; any mismatch fails loudly and lists every drifted file with
// a `npm run dist-pm` remediation hint, rather than letting the drift
// manifest later as a confusing, hard-to-diagnose schema-validation failure.

const { DIST_BUNDLED_SCHEMAS_DIR, PACKAGE_LOCAL_SCHEMAS_DIR } = await import('../fleet-sprint/contracts.mjs');

describe('dist/agents/schemas staleness guard', () => {
    test('every dist-bundled schema (if present) is byte-identical to its package-local source', () => {
        if (!isDirectory(DIST_BUNDLED_SCHEMAS_DIR)) {
            // Nothing to guard: this checkout has no local dist/ build, so
            // resolveSchemasDir() cannot possibly resolve a stale bundled
            // schema -- the package-local source below is what will load.
            return;
        }

        const distFiles = fs.readdirSync(DIST_BUNDLED_SCHEMAS_DIR).filter((f) => f.endsWith('.json'));
        const drifted = [];
        const missingSource = [];

        for (const fileName of distFiles) {
            const distPath = path.join(DIST_BUNDLED_SCHEMAS_DIR, fileName);
            const sourcePath = path.join(PACKAGE_LOCAL_SCHEMAS_DIR, fileName);

            if (!fs.existsSync(sourcePath)) {
                missingSource.push(fileName);
                continue;
            }

            const distContent = fs.readFileSync(distPath, 'utf-8');
            const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
            if (distContent !== sourceContent) {
                drifted.push(fileName);
            }
        }

        if (drifted.length > 0 || missingSource.length > 0) {
            const lines = [
                'Stale dist/agents/schemas detected -- these schemas differ from (or are missing from) the package-local apra-pm source:',
                ...drifted.map((f) => `  DRIFTED: ${f}`),
                ...missingSource.map((f) => `  ONLY IN DIST (no package-local source): ${f}`),
                '',
                'Fix: run `npm run dist-pm` to refresh dist/ from the current source schemas.',
            ];
            assert.fail(lines.join('\n'));
        }
    });
});

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}
