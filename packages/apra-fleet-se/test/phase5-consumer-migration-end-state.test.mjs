import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as runner from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-3swo.7.7 -- the observable end state of the Phase 5 consumer
// migration: no orchestrator path parses provision/reservation PROSE anymore,
// and the two retired prose-scraping helpers are truly gone (not merely
// deprecated), while the ONE symbol that was deliberately KEPT
// (buildCredentialReadCommand -- dead in production, live in tests, per
// apra-fleet-3swo.7.15's decision gate) stays declared, exported through the
// runner.js facade and marker-free.
//
// Every other angle this bead's acceptance criteria name (suites green,
// PR-skip marker, resolver memoisation, golden transcripts, token-leak in the
// PR-raise flow) already has a pinned, currently-green assertion elsewhere in
// this suite -- see test/vcs-auth-extraction-facade.test.mjs,
// test/mock-sprint-abort-pr.test.mjs and test/golden-transcript*.test.mjs.
// This file exists to close the two gaps nothing else pins: the retired
// pair's actual absence from source, and the absence of prose-shaped control
// flow in the two consumer modules that used to branch on it.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const FLEET_SPRINT_DIR = path.join(SE_DIR, 'fleet-sprint');

const VCS_AUTH_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'vcs-auth.mjs'), 'utf8');
const RUNNER_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'runner.js'), 'utf8');
const MEMBER_PROVISIONING_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'member-provisioning.mjs'), 'utf8');
const COORDINATION_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'coordination.mjs'), 'utf8');
const FACADE_TEST_SRC = fs.readFileSync(path.join(__dirname, 'vcs-auth-extraction-facade.test.mjs'), 'utf8');
const LEAF_FACADE_TEST_SRC = fs.readFileSync(path.join(__dirname, 'phase1-leaf-facade-completeness.test.mjs'), 'utf8');

// Every .mjs/.js file anywhere under fleet-sprint/, recursively (including
// phases/ and vcs-providers/), skipping docs/ and skills/ which hold prose
// and skill markdown/config, not orchestrator source. A non-recursive scan
// would miss production modules under phases/ and vcs-providers/ that could
// reintroduce either retired symbol or a production call site of
// buildCredentialReadCommand without this file noticing.
const SKIP_DIR_NAMES = new Set(['docs', 'skills']);

function collectSourceFiles(dir, baseDir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) continue;
            results.push(...collectSourceFiles(path.join(dir, entry.name), baseDir));
            continue;
        }
        if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js')) continue;
        const fullPath = path.join(dir, entry.name);
        results.push({ name: path.relative(baseDir, fullPath), src: fs.readFileSync(fullPath, 'utf8') });
    }
    return results;
}

const FLEET_SPRINT_SOURCE_FILES = collectSourceFiles(FLEET_SPRINT_DIR, FLEET_SPRINT_DIR);

const RETIRED_NAMES = ['readMemberVcsCredentialToken', 'parseExpiresAtFromProvisionText'];

describe('(1) the retired prose-parsing pair is completely gone from fleet-sprint source', () => {
    for (const name of RETIRED_NAMES) {
        test(`${name}: zero occurrences anywhere under fleet-sprint/`, () => {
            const offenders = FLEET_SPRINT_SOURCE_FILES.filter((f) => f.src.includes(name)).map((f) => f.name);
            assert.deepEqual(
                offenders,
                [],
                `${name} must have been fully deleted (declaration and every call site) from fleet-sprint/, but it still appears in: ${offenders.join(', ')}`,
            );
        });

        test(`${name}: not part of the runner.js public facade`, () => {
            assert.equal(
                Object.prototype.hasOwnProperty.call(runner, name),
                false,
                `runner.js must not re-export ${name}`,
            );
        });

        test(`${name}: not pinned in either facade-completeness baseline`, () => {
            // These two files intentionally hard-code their baselines as
            // literal arrays (see their own file comments) so this check
            // must read the literal text, not re-derive the arrays.
            assert.equal(
                FACADE_TEST_SRC.includes(`'${name}'`),
                false,
                `${name} must not appear as a quoted symbol literal in vcs-auth-extraction-facade.test.mjs (MOVED_PUBLIC_SYMBOLS or MOVED_PRIVATE_SYMBOLS)`,
            );
            assert.equal(
                LEAF_FACADE_TEST_SRC.includes(`'${name}'`),
                false,
                `${name} must not appear as a quoted symbol literal in phase1-leaf-facade-completeness.test.mjs (PRE_PHASE1_LEAF_EXPORT_SET)`,
            );
        });
    }
});

describe('(2) buildCredentialReadCommand is KEPT, positively -- declared, facade-exported, marker-free, zero production call sites', () => {
    test('still declared and exported in vcs-auth.mjs', () => {
        assert.match(
            VCS_AUTH_SRC,
            /export function buildCredentialReadCommand\(/,
            'buildCredentialReadCommand must still be declared and exported from vcs-auth.mjs',
        );
    });

    test('still re-exported through the runner.js facade (import + re-export)', () => {
        assert.match(RUNNER_SRC, /export \{[\s\S]*?\bbuildCredentialReadCommand\b[\s\S]*?\};/, 'runner.js must re-export buildCredentialReadCommand in its facade export block');
        assert.notEqual(runner.buildCredentialReadCommand, undefined, 'runner.buildCredentialReadCommand must be a live export');
        assert.equal(typeof runner.buildCredentialReadCommand, 'function');
    });

    test('carries no deprecation marker', () => {
        const declIdx = VCS_AUTH_SRC.indexOf('export function buildCredentialReadCommand(');
        assert.ok(declIdx > -1, 'declaration must be found to check the marker preceding it');
        // Look at the JSDoc block immediately above the declaration (the
        // nearest preceding /** ... */), which is where a @deprecated tag
        // would live per the vcs-auth.mjs precedent this bead's siblings use.
        const jsdocStart = VCS_AUTH_SRC.lastIndexOf('/**', declIdx);
        const jsdocBlock = jsdocStart > -1 ? VCS_AUTH_SRC.slice(jsdocStart, declIdx) : '';
        assert.equal(jsdocBlock.includes('@deprecated'), false, 'buildCredentialReadCommand must carry NO @deprecated marker');
    });

    test('has zero production call sites left in fleet-sprint/ (its only caller was the now-deleted readMemberVcsCredentialToken)', () => {
        // Import/re-export lines (runner.js) list the bare identifier with no
        // trailing "(" -- `buildCredentialReadCommand, PR_SKIPPED_NO_MCP_CLIENT,`
        // -- and the declaration line itself is
        // `export function buildCredentialReadCommand(`. A genuine call site
        // is any OTHER line containing `buildCredentialReadCommand(`.
        const offenders = [];
        for (const f of FLEET_SPRINT_SOURCE_FILES) {
            const invocationLines = f.src
                .split('\n')
                .filter((line) => {
                    const trimmed = line.trim();
                    if (!trimmed.includes('buildCredentialReadCommand(')) return false;
                    if (trimmed.includes('export function buildCredentialReadCommand(')) return false;
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
                    return true;
                });
            if (invocationLines.length > 0) offenders.push({ file: f.name, lines: invocationLines });
        }
        assert.deepEqual(
            offenders,
            [],
            `buildCredentialReadCommand must have zero production call sites in fleet-sprint/, found: ${JSON.stringify(offenders)}`,
        );
    });
});

describe('(3) no prose-shaped branching drives control flow in the two consumer modules', () => {
    // The check exists to keep this true, per the bead description: a
    // human-readable provision/reservation result summary must never be
    // inspected with includes()/match()/toLowerCase() to decide what to do
    // next in either module.
    //
    // This pattern deliberately bans EVERY includes()/match()/toLowerCase()
    // call in these two files, not just ones inspecting a result/summary
    // value -- both files are zero-hit today and are small, focused
    // consumer modules with no legitimate reason to reach for those methods
    // on anything else. If a future change needs a genuine non-prose use
    // (e.g. Array.prototype.includes membership test) in either file, that
    // is a signal to revisit this blanket ban rather than to weaken it
    // silently; narrow it then, with the concrete case in hand, instead of
    // guessing at a narrower pattern now.
    const PROSE_BRANCH_PATTERN = /\.includes\(|\.match\(|\.toLowerCase\(\)/;

    test('member-provisioning.mjs has zero prose-branching call sites', () => {
        const offenders = MEMBER_PROVISIONING_SRC
            .split('\n')
            .map((line, i) => ({ line, i: i + 1 }))
            .filter(({ line }) => PROSE_BRANCH_PATTERN.test(line));
        assert.deepEqual(
            offenders,
            [],
            `member-provisioning.mjs must not branch on prose (includes/match/toLowerCase), found: ${JSON.stringify(offenders)}`,
        );
    });

    test('coordination.mjs has zero prose-branching call sites', () => {
        const offenders = COORDINATION_SRC
            .split('\n')
            .map((line, i) => ({ line, i: i + 1 }))
            .filter(({ line }) => PROSE_BRANCH_PATTERN.test(line));
        assert.deepEqual(
            offenders,
            [],
            `coordination.mjs must not branch on prose (includes/match/toLowerCase), found: ${JSON.stringify(offenders)}`,
        );
    });
});
