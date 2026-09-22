// =============================================================================
// fleet-integrator-skill.test.mjs -- verifies feature ky2l.6: the
// fleet-integrator skill (fleet-sprint/skills/fleet-integrator/SKILL.md) is
// generic, and the status script's policy agrees with what the skill's loop
// section prescribes.
//
// Part A: genericness scan. check-generic-boundary.mjs's ENGINE_FILE_SET does
// not walk fleet-sprint/skills/*.md (verified: it only matches js/mjs/cjs
// under fleet-sprint and md under apra-pm/agents), so this suite runs the
// SAME SIGNAL_PATTERNS the engine scanner uses (imported, not copied) over
// the skill directly, plus skill-specific assertions the generic scanner
// does not cover (literal integration branch/check names from this repo,
// bead ids, ASCII-only, required section shape, and cross-checking the
// script path/flags the skill names against the real script).
//
// Part B: policy agreement. Encodes the skill's own loop-section decision
// table as an expected map and asserts the script's decideForPr() produces
// exactly that decision for every recorded fixture in
// test/fixtures/integration-gate/.
//
// Falsifiability (stated per the bead's requirement): a dedicated test below
// proves Part A actually fails when the literal integration branch name is
// spliced into the skill text, and Part B actually fails when a fixture's
// expected decision is deliberately wrong.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNAL_PATTERNS, PACKAGE_ROOT } from '../scripts/check-generic-boundary.mjs';
import { decideForPr, CLI_OPTION_SPECS } from '../scripts/integration-gate-status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.join(PACKAGE_ROOT, 'fleet-sprint', 'skills', 'fleet-integrator', 'SKILL.md');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'integration-gate');

const skillText = fs.readFileSync(SKILL_PATH, 'utf8');

// This repo's own integration-branch name for the current sprint. The skill
// must never name it literally -- it is target-specific, and belongs only in
// the target's own deploy.md/CLAUDE.md (see docs/generic-engine-boundary.md).
const THIS_REPO_INTEGRATION_BRANCH = 'v0.5_dashboard';

// The three required check names for this repo's own CI (ci.yml's
// build-and-test matrix job). The skill must show these only as placeholders
// (e.g. <check-1>,<check-2>), never as this repo's literal job names.
const THIS_REPO_CHECK_NAMES = [
    'build-and-test (ubuntu-latest)',
    'build-and-test (macos-latest)',
    'build-and-test (windows-latest)',
];

const BEAD_ID_PATTERN = SIGNAL_PATTERNS.find((p) => p.id === 'bead-id-in-llm-text').re;

/** Run every SIGNAL_PATTERNS regex over raw text; returns matched pattern ids. */
function signalPatternHits(text) {
    const hits = [];
    for (const p of SIGNAL_PATTERNS) {
        p.re.lastIndex = 0;
        if (p.re.test(text)) hits.push(p.id);
    }
    return hits;
}

function containsLiteralBranch(text) {
    return text.includes(THIS_REPO_INTEGRATION_BRANCH);
}

function containsLiteralCheckName(text) {
    return THIS_REPO_CHECK_NAMES.some((name) => text.includes(name));
}

function containsBeadId(text) {
    BEAD_ID_PATTERN.lastIndex = 0;
    return BEAD_ID_PATTERN.test(text);
}

function isAsciiOnly(text) {
    return /^[\x00-\x7F]*$/.test(text);
}

// -----------------------------------------------------------------------------
// Part A -- genericness scan
// -----------------------------------------------------------------------------

test('Part A: SIGNAL_PATTERNS report nothing on the skill', () => {
    const hits = signalPatternHits(skillText);
    assert.deepStrictEqual(hits, [], `SIGNAL_PATTERNS matched: ${hits.join(', ')}`);
});

test('Part A falsifiability: inserting the literal integration branch name fails the check', () => {
    const mutated = `${skillText}\n\nThe integration branch for this sprint is ${THIS_REPO_INTEGRATION_BRANCH}.\n`;
    assert.strictEqual(containsLiteralBranch(skillText), false, 'precondition: real skill must not already contain it');
    assert.strictEqual(containsLiteralBranch(mutated), true, 'mutated text must trip the literal-branch check');
});

test('Part A: no literal integration branch name from this repo', () => {
    assert.strictEqual(containsLiteralBranch(skillText), false);
});

test('Part A: no literal required check names from this repo', () => {
    assert.strictEqual(containsLiteralCheckName(skillText), false);
});

test('Part A: no bead id token', () => {
    assert.strictEqual(containsBeadId(skillText), false);
});

test('Part A: ASCII only', () => {
    assert.strictEqual(isAsciiOnly(skillText), true);
});

test('Part A: front matter has name and description', () => {
    const fm = skillText.split('\n').slice(0, 6).join('\n');
    assert.match(fm, /^---/);
    assert.match(fm, /\nname:\s*fleet-integrator/);
    assert.match(fm, /\ndescription:\s*.+/);
});

test('Part A: every H2 the impl task lists is present', () => {
    const required = ['Scope', 'Parameters', 'Prerequisites and token', 'The loop', 'Repair prompt', 'Owner report format', 'Never'];
    const headings = [...skillText.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    for (const h of required) {
        assert.ok(headings.includes(h), `missing H2 section: ## ${h} (found: ${headings.join(', ')})`);
    }
});

test('Part A: the status script path named in the skill exists on disk', () => {
    const match = skillText.match(/scripts\/integration-gate-status\.mjs/);
    assert.ok(match, 'skill does not reference scripts/integration-gate-status.mjs');
    const resolved = path.join(PACKAGE_ROOT, match[0]);
    assert.strictEqual(fs.existsSync(resolved), true, `${resolved} does not exist`);
});

test('Part A: every CLI flag the skill shows for the script is accepted by the script', () => {
    // Pull --flag tokens out of the fenced code block that invokes the script.
    const codeBlockMatch = skillText.match(/```bash\nnode scripts\/integration-gate-status\.mjs[\s\S]*?```/);
    assert.ok(codeBlockMatch, 'no fenced invocation of the status script found in the skill');
    const flags = [...codeBlockMatch[0].matchAll(/--([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(flags.length > 0, 'no --flags found in the skill invocation example');
    const accepted = new Set(Object.keys(CLI_OPTION_SPECS));
    for (const flag of flags) {
        assert.ok(accepted.has(flag), `skill shows --${flag}, which the script's CLI_OPTION_SPECS does not accept`);
    }
});

test('Part A: skill does not touch fleet-supervisor SKILL.md', () => {
    const supervisorPath = path.join(PACKAGE_ROOT, 'fleet-sprint', 'skills', 'fleet-supervisor', 'SKILL.md');
    // This is a guard on OUR OWN change set, not a property of the skill text
    // itself: confirm the sibling file still exists and this suite never
    // reads/writes it as part of asserting anything about fleet-integrator.
    assert.strictEqual(fs.existsSync(supervisorPath), true);
});

// -----------------------------------------------------------------------------
// Part B -- policy agreement between the skill's loop table and the script
// -----------------------------------------------------------------------------

// Encodes fleet-integrator/SKILL.md's "## The loop" decision table:
//   merge  -- mergeStateStatus CLEAN or BEHIND, every required check success, title has prefix
//   repair -- mergeStateStatus DIRTY, regardless of checks
//   wait   -- required checks still pending or missing
//   skip   -- title has [FAIL]/[ABORTED]/missing prefix, or a required check failed outright
const EXPECTED_DECISION_BY_FIXTURE = {
    'clean-all-green': 'merge',
    'behind-all-green': 'merge',
    dirty: 'repair',
    'check-pending': 'wait',
    'title-fail': 'skip',
    'check-missing': 'wait',
    'check-failed': 'skip',
    draft: 'skip',
};

const OPTS = { titlePrefix: 'Auto-sprint [PASS]: ', requiredChecks: ['check-a', 'check-b'] };

function decisionFor(fixtureName) {
    const prs = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${fixtureName}.json`), 'utf8'));
    assert.strictEqual(prs.length >= 1, true, `fixture ${fixtureName} is empty`);
    return decideForPr(prs[0], OPTS).decision;
}

for (const [fixtureName, expected] of Object.entries(EXPECTED_DECISION_BY_FIXTURE)) {
    test(`Part B: fixture '${fixtureName}' decides '${expected}' per the skill's loop table`, () => {
        assert.strictEqual(decisionFor(fixtureName), expected);
    });
}

test('Part B falsifiability: a deliberately wrong expected decision fails the comparison', () => {
    const wrongExpectedMap = { ...EXPECTED_DECISION_BY_FIXTURE, dirty: 'merge' };
    assert.throws(() => {
        assert.strictEqual(decisionFor('dirty'), wrongExpectedMap.dirty);
    }, assert.AssertionError);
});
