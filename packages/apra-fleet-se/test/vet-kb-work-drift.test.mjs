import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vetKbWork as runnerVet } from '../fleet-sprint/runner.js';
import { vetKbWork as pmVet } from '../apra-pm/lib/vet-kb-work.mjs';

// apra-fleet-4wz.9: the KB payload vetting rules exist in THREE places and no
// two of them can import each other:
//
//   1. apra-pm/.claude/workflows/auto-sprint.js -- executed by Claude's Workflow
//      tool in a VM with no filesystem and no require(), so it cannot import
//      anything at all.
//   2. apra-pm/lib/vet-kb-work.mjs -- its testable mirror (the established
//      lib/parse-sprint-args.mjs precedent).
//   3. fleet-sprint/runner.js -- a separate package with no shared module.
//
// A shared module is therefore not available, so this is the drift guard
// instead: the two IMPORTABLE copies must agree on every rule, and the third
// (the workflow script, reachable only as text) must carry the same constants.
// Modelled on apra-pm's auto-sprint-schemas-drift.test.mjs, which guards the
// inlined role schemas the same way.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_SPRINT = path.join(__dirname, '..', 'apra-pm', '.claude', 'workflows', 'auto-sprint.js');

const GOOD_CAPTURE = {
    type: 'knowledge',
    title: 'A durable claim title',
    summary: 'A summary long enough to be meaningful about the repo.',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
};
const GOOD_REASON = 'Verified against src/real.ts: the retry budget is read once at startup.';

// Every rule both copies must decide identically. Each case is (role, payload).
const CASES = [
    ['doer', { kb_captures: [GOOD_CAPTURE] }],
    ['reviewer', { kb_captures: [GOOD_CAPTURE] }],
    ['planner', { kb_captures: [GOOD_CAPTURE] }],
    ['harvester', { kb_captures: [GOOD_CAPTURE] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: undefined }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'user-directive' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'context-cache' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'nonsense' }] }],
    ['doer', { kb_captures: [{ type: 'knowledge', source_files: ['src/a.ts'] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: undefined }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }, GOOD_CAPTURE] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'ok' }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: '' }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: '   ' }] }],
    ['reviewer', { kb_promotions: [{ reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'x'.repeat(20) }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'x'.repeat(19) }] }],
    ['doer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['planner', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['harvester', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['deployer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['doer', { kb_captures: [GOOD_CAPTURE], kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['doer', {}],
    ['doer', null],
    ['doer', undefined],
    ['doer', { kb_captures: [], kb_promotions: [] }],
];

describe('vetKbWork copies do not drift (apra-fleet-4wz.9)', () => {
    for (const [role, payload] of CASES) {
        test(`${role} :: ${JSON.stringify(payload)?.slice(0, 70) ?? String(payload)}`, () => {
            const a = runnerVet(role, payload);
            const b = pmVet(role, payload);
            assert.deepEqual(a.captures, b.captures, 'captures differ between the two copies');
            assert.deepEqual(a.promotions, b.promotions, 'promotions differ between the two copies');
            // The refusal REASONS are prose and may be worded per engine, but the
            // COUNT of refusals must match -- a rule that fires in one copy and
            // not the other is exactly the drift this guards.
            assert.equal(
                (a.refused ?? a.rejected).length,
                (b.refused ?? b.rejected).length,
                'refusal count differs between the two copies',
            );
        });
    }
});

describe('the workflow copy carries the same constants', () => {
    const src = fs.readFileSync(AUTO_SPRINT, 'utf-8');

    test('auto-sprint.js restricts promotion to the reviewer', () => {
        assert.match(src, /KB_PROMOTER_ROLES\s*=\s*new Set\(\['reviewer'\]\)/);
    });

    test('auto-sprint.js uses the same minimum promote-reason length', () => {
        assert.match(src, /KB_MIN_PROMOTE_REASON\s*=\s*20/);
    });

    test('auto-sprint.js allows exactly the same capture types', () => {
        assert.match(src, /\['knowledge',\s*'learning',\s*'runbook'\]/);
    });

    test('auto-sprint.js still refuses a capture with no source files', () => {
        assert.match(src, /cites no source files/);
    });

    test('auto-sprint.js still refuses a promotion with no recorded evidence', () => {
        assert.match(src, /no recorded evidence/);
    });

    test('auto-sprint.js still refuses kb_promotions from a non-reviewer role', () => {
        assert.match(src, /promotion is reviewer-only/);
    });
});
