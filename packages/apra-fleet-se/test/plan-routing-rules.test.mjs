import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

// apra-fleet-mduk.4: planner.md and plan-reviewer.md must both carry the
// evidence-routing rule (a test bead whose acceptance needs CI evidence or
// live-member evidence must be routed to the test-runner roles, never left
// as plain doer work) and the permission-flagging rule (a bead that needs a
// permission/token/access level the doer does not hold must name the
// specific missing capability at planning time), and plan-reviewer.md must
// state that it checks both. A one-line prompt edit is easy to lose in a
// later rewrite, so this test reads the shipped prompt files directly (not
// a paraphrase) and goes RED the moment the guidance regresses or is
// removed. It also asserts neither addition introduced a target-specific
// literal, using the same deny-list approach as the other genericity tests.

const readPrompt = (name) => fs.readFileSync(path.join(PACKAGE_ROOT, 'apra-pm/agents', name), 'utf8');
// Markdown prose wraps mid-sentence, so multi-word phrase checks match
// against whitespace-normalized text (newlines/indentation collapsed to a
// single space) rather than the raw file.
const norm = (s) => s.replace(/\s+/g, ' ');

// Target-specific literals that must never appear in the added passages --
// the engine ships to any target project, so its LLM-facing text may name no
// target repo, CI provider, tracker, bead id, or build command. This is the
// same deny-list class the generic-boundary guard enforces mechanically;
// here we additionally assert directly on the new passages' text so the
// check is legible without re-deriving the guard's regexes.
const TARGET_SPECIFIC_LITERALS = [
    'apra-fleet',
    'GitHub Actions',
    'GitHub Actions',
    'CircleCI',
    'Jenkins',
    'npm run build',
    'npm test',
    'jira',
    'linear.app',
];

function extractPassage(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.notEqual(start, -1, `could not find start marker "${startMarker}"`);
    const end = endMarker ? text.indexOf(endMarker, start) : text.length;
    assert.notEqual(end, -1, `could not find end marker "${endMarker}" after start marker`);
    return text.slice(start, end);
}

describe('planner.md: evidence-routing and permission-flagging rules (apra-fleet-mduk.4)', () => {
    const planner = readPrompt('planner.md');
    const plannerN = norm(planner);

    test('states the evidence-routing rule: CI/live-member evidence routes to test-runner roles, never plain doer work', () => {
        assert.match(
            plannerN,
            /CI evidence.{0,40}live-member evidence/i,
            'planner.md must name both CI evidence and live-member evidence as the evidence-routing trigger'
        );
        assert.match(
            plannerN,
            /test-runner roles/i,
            'planner.md must name the test-runner roles as the routing destination'
        );
        assert.match(
            plannerN,
            /never leave it as plain doer work|never left as plain doer work/i,
            'planner.md must explicitly forbid leaving evidence-gated work as plain doer work'
        );
    });

    test('states the permission-flagging rule: name the specific missing capability at planning time', () => {
        assert.match(
            plannerN,
            /permission,\s*token,?\s*or\s*access level/i,
            'planner.md must name permission/token/access level as the gated resource'
        );
        assert.match(
            plannerN,
            /name the specific missing capability/i,
            'planner.md must require naming the specific missing capability'
        );
        assert.match(
            plannerN,
            /flag(?:ged)? (?:that )?at planning time/i,
            'planner.md must tie the permission flag to planning time, not mid-sprint discovery'
        );
    });

    test('the evidence-routing and permission-flagging passage names no target-specific literal', () => {
        const passage = extractPassage(planner, '**Evidence routing and permission gaps**', '**Model tier**');
        for (const literal of TARGET_SPECIFIC_LITERALS) {
            assert.ok(
                !passage.toLowerCase().includes(literal.toLowerCase()),
                `planner.md's evidence-routing/permission-flagging passage must not name target-specific literal "${literal}"`
            );
        }
    });
});

describe('plan-reviewer.md: checks the evidence-routing and permission-flagging rules (apra-fleet-mduk.4)', () => {
    const planReviewer = readPrompt('plan-reviewer.md');
    const planReviewerN = norm(planReviewer);

    test('carries a criterion checking evidence routing and permission flags', () => {
        assert.match(
            planReviewerN,
            /Evidence routing and permission flags/i,
            'plan-reviewer.md is missing the evidence-routing-and-permission-flags criterion heading'
        );
    });

    test('the criterion checks both the CI/live-member routing rule and the permission-naming rule', () => {
        assert.match(
            planReviewerN,
            /CI evidence.{0,60}live-member evidence/i,
            'plan-reviewer.md criterion must check both CI evidence and live-member evidence'
        );
        assert.match(
            planReviewerN,
            /test-runner roles/i,
            'plan-reviewer.md criterion must check routing to the test-runner roles'
        );
        assert.match(
            planReviewerN,
            /permission,\s*token,?\s*or\s*access level/i,
            'plan-reviewer.md criterion must check the permission/token/access level rule'
        );
        assert.match(
            planReviewerN,
            /names? the specific missing capability/i,
            'plan-reviewer.md criterion must check that the specific missing capability is named'
        );
    });

    test('the evidence-routing/permission-flags passage names no target-specific literal', () => {
        const passage = extractPassage(
            planReviewer,
            '13. **Evidence routing and permission flags**',
            '## Step 3'
        );
        for (const literal of TARGET_SPECIFIC_LITERALS) {
            assert.ok(
                !passage.toLowerCase().includes(literal.toLowerCase()),
                `plan-reviewer.md's evidence-routing/permission-flags passage must not name target-specific literal "${literal}"`
            );
        }
    });
});

describe('mutation self-check: the assertions above are actually falsifiable', () => {
    test('stripping the evidence-routing heading from a copy of planner.md fails the same assertion', () => {
        const planner = readPrompt('planner.md');
        const stripped = planner.replace(/CI evidence/gi, 'xxxxxxxxxx');
        assert.throws(() => assert.match(norm(stripped), /CI evidence.{0,40}live-member evidence/i));
    });

    test('stripping the criterion heading from a copy of plan-reviewer.md fails the same assertion', () => {
        const planReviewer = readPrompt('plan-reviewer.md');
        const stripped = planReviewer.replace(/Evidence routing and permission flags/gi, 'unrelated text');
        assert.throws(() => assert.match(norm(stripped), /Evidence routing and permission flags/i));
    });
});

test('generic-boundary guard exits 0 (no apra-fleet-specific wording in either prompt)', () => {
    const scriptPath = path.join(PACKAGE_ROOT, 'scripts/check-generic-boundary.mjs');
    // Throws (non-zero exit) if the guard fails; execFileSync surfaces stdout/stderr in the error.
    const out = execFileSync('node', [scriptPath], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
    assert.match(out, /OK: no apra-fleet-specific assumptions/);
});
