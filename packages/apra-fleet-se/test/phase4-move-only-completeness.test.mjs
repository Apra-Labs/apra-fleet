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
// gate's history. It never probed anything: it asserts that the downstream
// coverage this gate deliberately did NOT duplicate (the mock-sprint suite and
// both golden transcripts, spawned by the phase1 gate) is still wired into the
// same `npm test` run, and that the golden fixtures are tracked and clean.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');

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
