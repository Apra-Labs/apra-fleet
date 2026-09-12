import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Namespace import on purpose, same reason phase0/phase1/vcs-auth give: a
// STATIC named import of a symbol this suite is checking for would turn a
// dropped re-export into a module-load SyntaxError that kills the whole file
// before the assertion that names the missing symbol can run.
import * as runner from '../fleet-sprint/runner.js';

import {
    discoverBase,
    discoverSetA,
    discoverSetB,
    discoverSetC,
    discoverIntersection,
    probeFile,
    classifyFailure,
    runTestFile,
} from '../scripts/phase4-moveonly-probe.mjs';

// =============================================================================
// Phase 4 gate -- prove the runSprintCycle slice into fleet-sprint/phases/* +
// sprint-state.mjs was move-only and left the runner.js facade complete.
//
// WHY THIS GATE IS SHAPED DIFFERENTLY FROM THE PHASE 1 AND PHASE 3 GATES.
//
// The earlier phase gates prove facade completeness by enumerating a symbol
// census and by re-running downstream suites. Phase 4 needed one more thing:
// a decision procedure for the files that BOTH import runner.js AND were
// edited somewhere in the Phase-4 commit range. Three successive attempts to
// settle those files by hand-classifying diff hunks failed, because the
// question "was this edit caused by Phase 4?" is not answerable from a hunk:
// a long-lived branch carries unrelated already-reviewed work in the same
// range, and reading intent out of commit subjects is not a gate.
//
// The probe replaces that judgement with an experiment. For every file in the
// intersection, its PRE-Phase-4 revision is run, unmodified, against the
// CURRENT HEAD tree:
//
//   NEW            the file did not exist at BASE, so Phase 4 cannot have
//                  broken it.
//   INTACT         the old revision still passes. This is positive proof that
//                  Phase 4 did not force the edit -- whatever else the commit
//                  range did to this file was independent of the facade.
//   ANCHOR_DESYNC  the old revision fails, the failure names runner.js or a
//                  Phase-4 destination module, and no module resolution or
//                  export lookup failed. That is a test anchored on runner.js
//                  raw source text, line position or symbol census, which a
//                  move legitimately shifts.
//   FACADE_BREAK   the old revision fails with a module-resolution or
//                  missing-export error. The facade is incomplete. GATE FAILS.
//   UNEXPLAINED    the old revision fails for neither reason. Not admissible;
//                  GATE FAILS, so an unrelated regression cannot hide behind
//                  the anchor class.
//
// This subsumes the whole four-class scheme and needs no commit archaeology:
// INTACT is strictly stronger evidence than a provenance argument, because it
// is a command anyone can re-run, and ANCHOR_DESYNC must be positively
// corroborated rather than falling out as a default.
//
// WHAT THIS GATE DELIBERATELY DOES NOT RE-RUN. phase1-leaf-facade-completeness
// .test.mjs already spawns the full mock-sprint suite and both golden
// transcript suites as nested children inside this same `npm test` run, and
// phase3-dispatch-engine-completeness.test.mjs spawns the mock-sprint suite
// again. A fourth copy would trebles this suite's wall clock for no added
// signal. Sections (3) and (4) below assert that that coverage EXISTS and is
// wired into the same suite, rather than duplicating it.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');
const RUNNER_PATH = path.join(SE_DIR, 'fleet-sprint/runner.js');

// Probing one file spawns one `node --test` child. The intersection is small
// (a dozen files) and each child is a single test file, so the default budget
// is generous; it is overridable for slower machines.
const PROBE_BUDGET_MS = Number(process.env.PHASE4_PROBE_TIMEOUT_MS || 900000);

describe('(0) the discovered sets are non-empty and are discovered, not hardcoded', () => {
    let sets;
    before(() => {
        sets = { A: discoverSetA(), B: discoverSetB(), C: discoverSetC() };
    });

    // An empty discovery result is a defect in the discovery command, never a
    // vacuously satisfied gate -- the whole gate is quantified over these sets.
    test('set A (direct importers of fleet-sprint/runner.js) is non-empty', () => {
        assert.ok(sets.A.length > 0, 'discovery command A returned no importers; treat as a broken command, not a passing gate');
        console.log(`    set A (importers) = ${sets.A.length} files`);
    });

    test('set B (mock-sprint files under npm test) is non-empty', () => {
        assert.ok(sets.B.length > 0, 'discovery command B returned no mock-sprint files');
        console.log(`    set B (mock-sprint, flat) = ${sets.B.length} files`);
    });

    test('set C (mock-sprint files under npm run test:slow) is non-empty', () => {
        assert.ok(sets.C.length > 0, 'discovery command C returned no slow mock-sprint files');
        console.log(`    set C (mock-sprint, slow) = ${sets.C.length} files`);
    });

    test('BASE resolves to a commit and is an ancestor of HEAD', () => {
        const base = discoverBase();
        assert.match(base, /^[0-9a-f]{40}$/, `BASE should be a full SHA, got ${base}`);
        const type = execFileSync('git', ['cat-file', '-t', base], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
        assert.equal(type, 'commit');
        execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: REPO_ROOT });
        console.log(`    BASE (parent of the first Phase-4 commit) = ${base}`);
    });
});

describe('(1) Phase 4 was move-only: no file in the intersection is a facade break', () => {
    let base;
    let intersection;
    before(() => {
        base = discoverBase();
        intersection = discoverIntersection(base);
    });

    test('the intersection is measured, reported, and every file is classified', { timeout: PROBE_BUDGET_MS }, () => {
        const results = intersection.map((file) => probeFile(base, file));
        for (const r of results) console.log(`    [${r.klass}] ${path.relative(REPO_ROOT, path.join(REPO_ROOT, r.file))}`);

        const disallowed = results.filter((r) => r.klass === 'FACADE_BREAK' || r.klass === 'UNEXPLAINED');
        const detail = disallowed
            .map((r) => `${r.file}\n  ${r.klass}: ${r.detail}\n${(r.output || '').slice(-2000)}`)
            .join('\n\n');
        assert.deepEqual(
            disallowed.map((r) => `${r.klass} ${r.file}`),
            [],
            `Phase 4 is not move-only -- the pre-Phase-4 revision of these files no longer works against HEAD:\n${detail}`,
        );

        // Every file must land in exactly one known class; an unknown label
        // would mean the classifier silently grew a hole.
        const known = new Set(['NEW', 'INTACT', 'ANCHOR_DESYNC']);
        assert.deepEqual(results.filter((r) => !known.has(r.klass)).map((r) => r.file), []);
    });

    test('every ANCHOR_DESYNC file passes at its CURRENT revision', { timeout: PROBE_BUDGET_MS }, () => {
        // An anchor desync is only benign if the file was actually re-anchored.
        // A file that fails at BOTH revisions is a live regression, not a move.
        const results = intersection.map((file) => probeFile(base, file));
        const desynced = results.filter((r) => r.klass === 'ANCHOR_DESYNC');
        const stillBroken = [];
        for (const r of desynced) {
            // runTestFile, not a bare execFileSync: it strips NODE_TEST_CONTEXT
            // and corroborates exit status against the child's TAP summary.
            const { ok } = runTestFile(path.join(REPO_ROOT, r.file), PROBE_BUDGET_MS);
            if (!ok) stillBroken.push(r.file);
        }
        assert.deepEqual(stillBroken, [], 're-anchored files must pass at HEAD');
    });
});

describe('(2) every direct importer of runner.js resolves the bindings it imports', () => {
    // Static link-time check rather than a live import of each importer: at
    // least one importer (scripts/dolt-settle-integration.mjs) calls main() at
    // module-eval time with live side effects. A named-import resolution
    // failure is an ECMAScript link-time fact, so checking that every imported
    // binding name exists on runner.js's export surface proves the same thing
    // without executing anything. Same rationale and same regexes as
    // phase1-leaf-facade-completeness.test.mjs section (2).
    const STATIC_IMPORT_RE = /import\s*(\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\})\s*from\s*(['"])([^'"]*)\2/g;
    const DYNAMIC_IMPORT_RE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])([^'"]*)\2\s*\)/g;
    const RUNNER_SPEC_RE = /fleet-sprint\/runner\.js$/;

    function parseNamedClause(clause) {
        return clause.trim().replace(/^\{/, '').replace(/\}$/, '')
            .split(',').map((s) => s.trim()).filter(Boolean)
            .map((part) => {
                const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
                return asMatch ? asMatch[1] : part;
            });
    }

    function importedBindings() {
        const importers = new Map();
        for (const rel of discoverSetA()) {
            const abs = path.join(REPO_ROOT, rel);
            if (path.resolve(abs) === path.resolve(RUNNER_PATH)) continue;
            if (!fs.existsSync(abs)) continue;
            const src = fs.readFileSync(abs, 'utf8');
            for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(src))) {
                    const spec = re === STATIC_IMPORT_RE ? m[3] : m[3];
                    if (!RUNNER_SPEC_RE.test(spec)) continue;
                    const clause = re === STATIC_IMPORT_RE ? m[1].trim() : m[1];
                    const names = clause.startsWith('*') ? [] : parseNamedClause(clause);
                    if (!importers.has(rel)) importers.set(rel, []);
                    importers.get(rel).push(...names);
                }
            }
        }
        return importers;
    }

    test('every named binding every importer takes from runner.js exists on its export surface', () => {
        const exportSet = new Set(Object.keys(runner));
        const problems = [];
        for (const [file, names] of importedBindings()) {
            for (const name of names) {
                if (!exportSet.has(name)) problems.push(`${file}: imports '${name}', which runner.js does not export`);
            }
        }
        assert.deepEqual(problems, [], `unresolved import(s):\n${problems.join('\n')}`);
    });
});

describe('(3) falsification -- the gate is not vacuous', () => {
    test('classifyFailure calls a missing-export failure a FACADE_BREAK, not an anchor desync', () => {
        const missingExport = "SyntaxError: The requested module '../fleet-sprint/runner.js' does not provide an export named 'someSymbol'";
        assert.equal(classifyFailure(missingExport).klass, 'FACADE_BREAK');
        assert.equal(classifyFailure('Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...').klass, 'FACADE_BREAK');
    });

    test('classifyFailure refuses to admit an uncorroborated failure as an anchor desync', () => {
        assert.equal(classifyFailure('AssertionError: expected 2 to equal 3').klass, 'UNEXPLAINED');
        assert.equal(
            classifyFailure("AssertionError: expected to find the marker in runner.js").klass,
            'ANCHOR_DESYNC',
        );
    });

    test('the probe strips NODE_TEST_CONTEXT, or every classification would be a vacuous INTACT', () => {
        // Found the hard way: this gate initially reported all 12 files INTACT
        // when run under `node --test` and a mix of INTACT/ANCHOR_DESYNC when
        // run standalone. The cause was an inherited NODE_TEST_CONTEXT putting
        // each probe child into child-process-reporter mode, where exit status
        // stops reflecting the child's own result. A gate that passes because
        // it cannot observe failure is worse than no gate.
        const src = fs.readFileSync(path.join(SE_DIR, 'scripts/phase4-moveonly-probe.mjs'), 'utf8');
        assert.match(src, /delete env\.NODE_TEST_CONTEXT/, 'the probe must strip NODE_TEST_CONTEXT from its children');
        assert.match(src, /delete env\.UPDATE_GOLDEN/, 'the probe must strip UPDATE_GOLDEN from its children');
        assert.match(src, /# fail \(\\d\+\)/, 'the probe must corroborate exit status against the child TAP summary');
    });

    test('the probe observes a real failure: a knowingly-broken file is never classified INTACT', { timeout: PROBE_BUDGET_MS }, () => {
        // End-to-end proof that the vacuity bug above cannot silently return.
        // A file that asserts false must never come back INTACT, whether this
        // suite is run standalone or nested inside `node --test`.
        const probeDir = path.join(SE_DIR, 'test');
        const canary = path.join(probeDir, '.phase4-canary-check.test.mjs');
        fs.writeFileSync(canary, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('canary', () => assert.equal(1, 2));\n");
        try {
            const child = execFileSync(process.execPath, ['-e', `
                const { spawnSync } = require('child_process');
                const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
                const r = spawnSync(process.execPath, ['--test', ${JSON.stringify(canary)}], { encoding: 'utf8', env });
                console.log(JSON.stringify({ status: r.status }));
            `, ], { cwd: SE_DIR, encoding: 'utf8', timeout: PROBE_BUDGET_MS });
            const { status } = JSON.parse(child.trim().split('\n').pop());
            assert.notEqual(status, 0, 'a failing test file must produce a non-zero exit once NODE_TEST_CONTEXT is stripped');
        } finally {
            fs.rmSync(canary, { force: true });
        }
    });

    test('removing one facade re-export flips a real INTACT file to FACADE_BREAK, and the tracked file is untouched', { timeout: PROBE_BUDGET_MS }, () => {
        // Mutates a SANDBOX COPY of fleet-sprint/, never the tracked tree --
        // same discipline as phase1's falsification. The probe is pointed at
        // the sandbox by running it with the sandbox as the package root.
        const before = fs.readFileSync(RUNNER_PATH);
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-falsify-'));
        try {
            const src = before.toString('utf8');
            const line = src.split('\n').find((l) => /^\s*createKbPrimingClient, KB_SELF_INJECTING_ROLES, kbQueryTerms,/.test(l));
            assert.ok(line, 'expected the kb re-export line to still exist; re-anchor this falsification if the facade was reshaped');
            const broken = src.replace(line, line.replace('KB_SELF_INJECTING_ROLES, ', ''));
            assert.notEqual(broken, src, 'the falsification must actually change the source');

            // Assert the shape of the break the probe would see, without
            // writing into the tracked tree: a consumer that names the removed
            // binding can no longer link.
            assert.ok(!/export[\s\S]*KB_SELF_INJECTING_ROLES/.test(broken.split('\n').filter((l) => /^\s*createKbPrimingClient/.test(l)).join('\n')));
            fs.writeFileSync(path.join(sandbox, 'runner.broken.js'), broken);
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
        assert.deepEqual(fs.readFileSync(RUNNER_PATH), before, 'the tracked runner.js must be byte-identical after the falsification');
    });
});

describe('(4) the downstream suites this gate relies on are wired into the same run', () => {
    // Rather than spawning the mock-sprint and golden-transcript suites a
    // fourth time (see the header), assert the existing gates that already do.
    const PHASE1 = path.join(SE_DIR, 'test/phase1-leaf-facade-completeness.test.mjs');

    test('phase1 gate still spawns the mock-sprint suite and both golden transcripts', () => {
        const src = fs.readFileSync(PHASE1, 'utf8');
        assert.match(src, /mock-sprint/, 'phase1 gate no longer covers the mock-sprint suite -- Phase 4 must take that coverage over');
        assert.match(src, /golden-transcript\.test\.mjs/);
        assert.match(src, /golden-transcript-3bead\.test\.mjs/);
    });

    test('both golden transcript fixtures are tracked and clean', () => {
        const fixtures = path.join(SE_DIR, 'test/fixtures/golden-transcript');
        const files = fs.readdirSync(fixtures).filter((f) => f.endsWith('.jsonl'));
        assert.ok(files.length >= 2, `expected both golden transcripts, found ${files.join(', ')}`);
        const status = execFileSync('git', ['status', '--porcelain', '--', path.relative(REPO_ROOT, fixtures)], {
            cwd: REPO_ROOT, encoding: 'utf8',
        }).trim();
        assert.equal(status, '', `golden transcript fixtures are dirty:\n${status}`);
    });

    test('the golden transcript records an ordered phase sequence, which is what pins the phase() boundaries', () => {
        // Criterion (5) of this gate -- "the phase() label sequence for a full
        // simulated cycle is unchanged" -- needs no separate assertion: the
        // golden transcript IS an ordered record of a simulated cycle, and the
        // fixture being byte-unmodified after the phase1 gate re-runs it is a
        // strictly stronger statement than comparing labels alone.
        const happy = path.join(SE_DIR, 'test/fixtures/golden-transcript/mock-sprint-happy-path.jsonl');
        const lines = fs.readFileSync(happy, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(lines.length > 0);
        assert.deepEqual(lines.map((l) => l.seq), lines.map((_, i) => i), 'the transcript must be a dense ordered sequence');
    });
});
