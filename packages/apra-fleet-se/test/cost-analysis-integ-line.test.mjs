import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostAnalysis } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-nwh.2 -- verification for apra-fleet-nwh.1: the harvester's
// pre-computed cost-analysis block (buildCostAnalysis(), runner.js ~line
// 4185) used to have rows for doer/reviewer/overhead but NO dedicated
// integ-test-runner line, so that phase's spend -- often the single longest
// and most expensive part of a cycle (a full playbook run against a real
// sandbox) -- was silently bucketed into "overhead" and invisible to anyone
// reading the CHANGELOG. apra-fleet-nwh.1 added an explicit
// "Integ-test-runner spend: ..." line, distinct from the totals above it.
// These tests fail against the pre-fix buildCostAnalysis() (no such line
// exists at all, regardless of what integTestRunnerStats is passed) and pass
// now that the line is present and correctly reflects the three honest
// states: a real tracked figure, "never ran this sprint", and "ran but
// untrackable" (spent() unavailable).
// =============================================================================

function fakeBudget({ total = 10, spent = 1.2345, real = 1, fallback = 0 } = {}) {
    return {
        total,
        spent: () => spent,
        pricingSummary: () => ({ real, fallback }),
    };
}

test('buildCostAnalysis reports a DISTINCT integ-test-runner line (not folded into overhead) when the phase dispatched with tracked spend', () => {
    const budget = fakeBudget({ total: 10, spent: 3.5 });
    const block = buildCostAnalysis(budget, { spend: 1.25, dispatchCount: 2 });

    // The line must exist, name the phase explicitly, carry its own spend
    // figure, and name the dispatch count -- distinct from the generic
    // Tracked spend/Remaining budget lines above it.
    assert.match(
        block,
        /Integ-test-runner spend: \$1\.2500 across 2 dispatch\(es\) this sprint/,
        `Expected a distinct integ-test-runner spend line with the right figures, got:\n${block}`
    );
    // It must be reported as its own, explicitly BROKEN OUT line -- the whole
    // point of apra-fleet-nwh.1 is that this spend is no longer silently
    // folded into (i.e. indistinguishable from) "overhead".
    assert.match(
        block,
        /broken out of overhead/i,
        `Expected the integ-test-runner line to say it is broken OUT of overhead (distinct, not folded in), got:\n${block}`
    );
    // The generic "Tracked spend" line (the whole-run total) must still be
    // present and distinct from the integ-specific line.
    assert.match(block, /Tracked spend \(priced dispatches only\): \$3\.5000\./);
});

test('buildCostAnalysis states honestly that integ-test-runner never ran this sprint, rather than omitting the line', () => {
    const budget = fakeBudget({ total: 10, spent: 0 });
    const block = buildCostAnalysis(budget, { spend: 0, dispatchCount: 0 });

    assert.match(
        block,
        /Integ-test-runner spend: \$0\.0000 -- no integ-test-runner dispatch ran this sprint/,
        `Expected an honest "never ran" integ-test-runner line, got:\n${block}`
    );
});

test('buildCostAnalysis states honestly when integ-test-runner dispatched but spend was not trackable (no spent())', () => {
    const budget = { total: 10 }; // no spent()/pricingSummary -- spend genuinely untrackable
    const block = buildCostAnalysis(budget, { spend: 0, dispatchCount: 3 });

    assert.match(
        block,
        /Integ-test-runner spend: not tracked -- 3 dispatch\(es\) ran but the budget object did not expose spent\(\) for this run\./,
        `Expected an honest "not tracked" integ-test-runner line, got:\n${block}`
    );
});

test('buildCostAnalysis defaults dispatchCount to 0 when integTestRunnerStats is omitted entirely (back-compat)', () => {
    const budget = fakeBudget();
    const block = buildCostAnalysis(budget);

    assert.match(
        block,
        /Integ-test-runner spend: \$0\.0000 -- no integ-test-runner dispatch ran this sprint/,
        `Expected the omitted-argument default to read as "never ran", got:\n${block}`
    );
});
