import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// =============================================================================
// What is left of the Phase 4 gate, and why.
//
// This file used to carry a dynamic "move-only" probe: for every file that both
// imported runner.js and was edited inside the Phase-4 commit range, it ran that
// file's PRE-Phase-4 revision against the current HEAD tree and classified the
// outcome (NEW / INTACT / FACADE_BREAK / ANCHOR_DESYNC / UNEXPLAINED), backed by
// the machinery in scripts/phase4-moveonly-probe.mjs. Both are now deleted.
//
// The probe was a ONE-TIME migration gate. It answered "did slicing
// runSprintCycle into fleet-sprint/phases/* + sprint-state.mjs leave the
// runner.js facade complete?" -- a question about a commit range that is long
// since settled and that no future edit can re-open. Its ongoing cost was not
// one-time: it re-ran a superseded revision of every changed runner.js importer
// on every `npm test`, so a comment-only edit to an unrelated operator script
// under scripts/ was enough to turn the suite red, and a third of its runtime
// went on re-running old revisions of tests that already pass at HEAD.
//
// The GENERAL property the probe leaned on -- every direct importer of
// fleet-sprint/runner.js resolves the named bindings it imports, the bin/ and
// scripts/ entrypoints (which the dynamic probe skipped as unsafe to execute)
// included -- is facade completeness, not Phase-4 history. That check lives in
// section (2) of phase1-leaf-facade-completeness.test.mjs, which already ran the
// identical static assertion over an identically-discovered importer set, and
// which now also pins that those entrypoint classes stay inside the set it
// checks. Nothing that survived the probe's deletion is unowned.
//
// Section (4) below keeps its original number so it stays greppable against this
// gate's history. It never probed anything. It used to also assert, from
// phase1-leaf-facade-completeness.test.mjs's SOURCE TEXT, that the mock-sprint
// suite was still spawned by that gate; that meta-check and the spawn it
// described are both gone (apra-fleet-j918.3.1/.3.2), and the surviving
// question -- how many nested mock-sprint runs this package has -- is owned by
// test/nested-mock-sprint-run-census.test.mjs, which counts real spawn sites.
// What remains here is what this gate can check first-hand: the golden
// fixtures are tracked, clean, and well-formed.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');
const __filename_self = fileURLToPath(import.meta.url);

// apra-fleet-wzmv.2: capture the wall-clock the instant this module starts
// evaluating, so a final test below can assert a CONCRETE ceiling on this
// file's own total runtime rather than merely recording a number. Reference
// point: the trimmed 79-line gate (no probe left, no bd interaction at all)
// measures ~130ms standalone under both mock and real bd. DURATION_BUDGET_MS
// leaves roughly 20x headroom over that measurement while still failing
// loudly if a spawning probe is ever reintroduced -- a single `node --test`
// child process costs at least several hundred ms of interpreter startup
// alone, and the deleted probe (scripts/phase4-moveonly-probe.mjs) used to
// spawn one such child per changed runner.js importer (65+ candidates), so
// even ONE reintroduced spawn blows well past this budget.
const FILE_START_MS = Date.now();
const DURATION_BUDGET_MS = 3000;

describe('(4) the downstream suites this gate relies on are wired into the same run', () => {
    // apra-fleet-j918.3.1 deleted the meta-check that used to live here -- it
    // read phase1-leaf-facade-completeness.test.mjs's SOURCE TEXT to assert
    // that phase1 still spawned the mock-sprint suite. apra-fleet-j918.3.2
    // then deleted the spawn it was asserting about. Neither the check nor the
    // file handle it needed survives; test/nested-mock-sprint-run-census
    // .test.mjs now owns the "how many nested mock-sprint runs exist" question
    // by counting real spawn sites instead of reading one gate's prose.
    //
    // What is left below asserts only what this gate can check first-hand: the
    // golden fixtures it depends on are tracked, clean, and well-formed.

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

// =============================================================================
// (5) REINTRODUCTION GUARD (apra-fleet-wzmv.2): this gate's whole raison
// d'etre now is proving the deleted move-only probe (scripts/phase4-
// moveonly-probe.mjs) stays deleted. Nothing above would catch it coming
// back -- both tests below are the tripwire.
// =============================================================================
describe('(5) reintroduction guard: this gate must never regain a per-revision probe', () => {
    test('this file spawns no child process other than `git` (no node --test probe of another revision)', () => {
        // Static self-scan, not a runtime spy: the probe pattern is "spawn
        // node --test over some OTHER revision of a changed file", and the
        // only child process this gate is allowed to launch is the `git
        // status` calls above (against the golden-fixture directory). Any
        // OTHER spawn target appearing in this file's own source is exactly
        // the reintroduced pattern.
        const ownSource = fs.readFileSync(__filename_self, 'utf8');
        const spawnCalls = [...ownSource.matchAll(/\b(?:execFileSync|execSync|spawnSync|spawn|execFile|fork)\(\s*([^,)]+)/g)];
        assert.ok(spawnCalls.length > 0, 'sanity check failed: expected to find at least the `git status` calls above -- the scan pattern itself is broken');
        const offenders = spawnCalls
            .map(([, arg]) => arg.trim())
            .filter((arg) => !/^['"]git['"]$/.test(arg));
        assert.deepEqual(
            offenders,
            [],
            `this gate may only ever spawn \`git\`; found (a) spawn call target(s) of: ${offenders.join(', ')} -- `
            + 'that is the reintroduced per-revision move-only probe pattern (scripts/phase4-moveonly-probe.mjs, deleted apra-fleet-j918.2.3).',
        );
    });

    test('this file completes within its stated time budget (no reintroduced probe subprocess ballooning runtime)', () => {
        const elapsedMs = Date.now() - FILE_START_MS;
        assert.ok(
            elapsedMs < DURATION_BUDGET_MS,
            `this file took ${elapsedMs}ms, at or over its ${DURATION_BUDGET_MS}ms budget -- `
            + 'the trimmed gate (no probe, no bd interaction) measures ~130ms standalone; a duration '
            + 'anywhere near this budget means a subprocess (node --test over another revision) crept back in.',
        );
    });
});
