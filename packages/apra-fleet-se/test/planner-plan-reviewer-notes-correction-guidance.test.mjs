import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

// apra-fleet-bkax: planner.md and plan-reviewer.md must carry generic
// guidance so that decomposition/review treats a bead's later NOTES
// corrections as authoritative over stale DESCRIPTION text, and so a child
// that contradicts a parent's recorded NOTES correction is flagged
// CHANGES_NEEDED. These tests read the shipped prompt files directly (not a
// paraphrase) so they go RED the moment the guidance regresses or is
// removed, and they run the generic-boundary guard so neither addition
// introduced apra-fleet-specific wording.

const readPrompt = (name) => fs.readFileSync(path.join(PACKAGE_ROOT, 'apra-pm/agents', name), 'utf8');
// Markdown prose wraps mid-sentence, so multi-word phrase checks match
// against whitespace-normalized text (newlines/indentation collapsed to a
// single space) rather than the raw file.
const norm = (s) => s.replace(/\s+/g, ' ');

// The correction-marker vocabulary both prompts must share.
const CORRECTION_MARKERS = ['CORRECTION', 'AMENDMENT', 'SUPERSEDES', 'REVISED'];

describe('planner.md: read-NOTES-first guidance (apra-fleet-bkax)', () => {
    const planner = readPrompt('planner.md');
    const plannerN = norm(planner);

    test('instructs reading a bead\'s NOTES in full before decomposing it', () => {
        assert.match(
            plannerN,
            /read\s+NOTES\s+in\s+full/i,
            'planner.md must explicitly instruct reading NOTES in full before decomposing'
        );
        assert.match(
            plannerN,
            /[Bb]efore\s+decomposing/,
            'planner.md must tie the NOTES read to the decomposition step'
        );
    });

    test('names the correction-marker vocabulary and the explicit "do X, not Y" form', () => {
        for (const marker of CORRECTION_MARKERS) {
            assert.ok(
                planner.includes(marker),
                `planner.md is missing the correction marker "${marker}"`
            );
        }
        assert.match(
            plannerN,
            /do X,?\s*not Y/i,
            'planner.md must name the explicit "do X, not Y" correction form'
        );
    });

    test('treats a NOTES correction as authoritative over the DESCRIPTION text it contradicts', () => {
        assert.match(
            plannerN,
            /authoritative over/i,
            'planner.md must say a NOTES correction is authoritative over contradicted DESCRIPTION text'
        );
    });
});

describe('plan-reviewer.md: NOTES-vs-child contradiction check (apra-fleet-bkax)', () => {
    const planReviewer = readPrompt('plan-reviewer.md');
    const planReviewerN = norm(planReviewer);

    test('carries an additive criterion checking a child against parent NOTES corrections', () => {
        assert.match(
            planReviewerN,
            /NOTES-vs-child contradiction/i,
            'plan-reviewer.md is missing the NOTES-vs-child contradiction criterion heading'
        );
    });

    test('names the correction-marker vocabulary shared with planner.md', () => {
        for (const marker of CORRECTION_MARKERS) {
            assert.ok(
                planReviewer.includes(marker),
                `plan-reviewer.md is missing the correction marker "${marker}"`
            );
        }
        assert.match(
            planReviewerN,
            /do X,?\s*not Y/i,
            'plan-reviewer.md must name the explicit "do X, not Y" correction form'
        );
    });

    test('requires quoting the conflicting text from BOTH the parent correction and the child', () => {
        assert.match(
            planReviewerN,
            /quote the exact conflicting text/i,
            'plan-reviewer.md must require quoting the exact conflicting text'
        );
        assert.match(
            planReviewerN,
            /parent'?s correction/i,
            'plan-reviewer.md must require quoting from the parent\'s correction'
        );
        assert.match(
            planReviewerN,
            /child'?s contradicting passage/i,
            'plan-reviewer.md must require quoting from the child\'s contradicting passage'
        );
    });

    test('a vague finding without quotes is explicitly called out as insufficient', () => {
        assert.match(
            planReviewerN,
            /not sufficient/i,
            'plan-reviewer.md must state that a vague, non-quoting finding is not sufficient'
        );
    });
});

describe('mutation self-check: the assertions above are actually falsifiable', () => {
    test('stripping the correction-marker vocabulary from a copy of planner.md fails the same assertion', () => {
        const planner = readPrompt('planner.md');
        const stripped = planner.replace(/CORRECTION/g, 'xxxxxxxxxx');
        assert.throws(() => assert.ok(stripped.includes('CORRECTION'), 'boom'));
    });

    test('stripping the NOTES-vs-child heading from a copy of plan-reviewer.md fails the same assertion', () => {
        const planReviewer = readPrompt('plan-reviewer.md');
        const stripped = planReviewer.replace(/NOTES-vs-child contradiction/gi, 'unrelated text');
        assert.throws(() => assert.match(stripped, /NOTES-vs-child contradiction/i));
    });
});

test('generic-boundary guard exits 0 (no apra-fleet-specific wording in either prompt)', () => {
    const scriptPath = path.join(PACKAGE_ROOT, 'scripts/check-generic-boundary.mjs');
    // Throws (non-zero exit) if the guard fails; execFileSync surfaces stdout/stderr in the error.
    const out = execFileSync('node', [scriptPath], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
    assert.match(out, /OK: no apra-fleet-specific assumptions/);
});
