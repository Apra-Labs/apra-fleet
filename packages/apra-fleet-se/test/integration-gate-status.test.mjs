// =============================================================================
// integration-gate-status.test.mjs -- unit coverage for the fleet-integrator
// merge gate's read-only status feed (scripts/integration-gate-status.mjs).
//
// Covers the pure decision function decideForPr() against recorded gh JSON
// fixtures (test/fixtures/integration-gate/*.json), one fixture per policy
// branch, plus a CLI --input case that asserts the whole process prints one
// parseable JSON line per PR. No live gh call anywhere in this suite.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decideForPr } from '../scripts/integration-gate-status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'integration-gate');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'integration-gate-status.mjs');

const OPTS = { titlePrefix: 'Auto-sprint [PASS]: ', requiredChecks: ['check-a', 'check-b'] };

function loadFixture(name) {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8');
    return JSON.parse(raw);
}

function onePr(name) {
    const prs = loadFixture(name);
    assert.strictEqual(prs.length, 1, `fixture ${name} must contain exactly one PR`);
    return prs[0];
}

test('CLEAN all green -> merge', () => {
    const { decision, reason } = decideForPr(onePr('clean-all-green'), OPTS);
    assert.strictEqual(decision, 'merge');
    assert.strictEqual(reason, 'merge-state-clean');
});

test('BEHIND all green -> merge (BEHIND is mergeable under squash with the ruleset)', () => {
    const { decision, reason } = decideForPr(onePr('behind-all-green'), OPTS);
    assert.strictEqual(decision, 'merge');
    assert.strictEqual(reason, 'merge-state-behind');
});

test('DIRTY -> repair, regardless of check state', () => {
    const { decision, reason } = decideForPr(onePr('dirty'), OPTS);
    assert.strictEqual(decision, 'repair');
    assert.strictEqual(reason, 'merge-state-dirty');
});

test('one required check pending -> wait', () => {
    const { decision, reason } = decideForPr(onePr('check-pending'), OPTS);
    assert.strictEqual(decision, 'wait');
    assert.match(reason, /^checks-pending:/);
});

test('title with [FAIL] -> skip', () => {
    const { decision, reason } = decideForPr(onePr('title-fail'), OPTS);
    assert.strictEqual(decision, 'skip');
    assert.strictEqual(reason, 'title-fail');
});

test('required check missing from rollup -> wait', () => {
    const { decision, reason } = decideForPr(onePr('check-missing'), OPTS);
    assert.strictEqual(decision, 'wait');
    assert.match(reason, /^checks-missing:/);
});

test('a required check FAILURE -> skip checks-failed', () => {
    const { decision, reason } = decideForPr(onePr('check-failed'), OPTS);
    assert.strictEqual(decision, 'skip');
    assert.match(reason, /^checks-failed:/);
});

test('draft -> skip', () => {
    const { decision, reason } = decideForPr(onePr('draft'), OPTS);
    assert.strictEqual(decision, 'skip');
    assert.strictEqual(reason, 'draft-pr');
});

test('title lacking the configured prefix -> skip missing-title-prefix', () => {
    const pr = { ...onePr('clean-all-green'), title: 'Some other PR title' };
    const { decision, reason } = decideForPr(pr, OPTS);
    assert.strictEqual(decision, 'skip');
    assert.strictEqual(reason, 'missing-title-prefix');
});

test('CLI --input produces one parseable JSON line per PR with number, decision, reason', () => {
    const result = spawnSync(
        process.execPath,
        [
            SCRIPT,
            '--repo',
            'example-owner/example-repo',
            '--base',
            'integration',
            '--title-prefix',
            'Auto-sprint [PASS]: ',
            '--required-checks',
            'check-a,check-b',
            '--input',
            path.join(FIXTURES_DIR, 'cli-input.json'),
        ],
        { encoding: 'utf8' },
    );
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3, 'expected one JSON line per PR in the fixture');
    const parsed = lines.map((l) => JSON.parse(l));
    for (const line of parsed) {
        assert.strictEqual(typeof line.number, 'number');
        assert.strictEqual(typeof line.decision, 'string');
        assert.strictEqual(typeof line.reason, 'string');
    }
    const byNumber = new Map(parsed.map((l) => [l.number, l]));
    assert.strictEqual(byNumber.get(201).decision, 'merge');
    assert.strictEqual(byNumber.get(202).decision, 'repair');
    assert.strictEqual(byNumber.get(203).decision, 'skip');
});

test('CLI exits 1 on invalid arguments (missing required flags)', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--repo', 'example-owner/example-repo'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
});

// Source-level pin for the win32 main-guard regression: on Windows
// process.argv[1] is a backslash drive path (D:\a\...\x.mjs) while
// import.meta.url is a file:///D:/a/... URL, so the old template-literal guard
// `file://` + argv[1] never matched, main() never ran, and the process printed
// nothing and exited 0 -- which is exactly how the two spawn-based CLI cases
// above fail on the windows-latest leg. Those two cases are the behavioural
// proof on Windows; this pin fails on EVERY platform if the malformed guard
// is ever restored. A win32 argv shape cannot be simulated on POSIX (node
// resolves argv[1] itself), hence the text-level check.
test('main-guard uses pathToFileURL(process.argv[1]) rather than the malformed file:// template literal', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const malformed = 'file://${process.argv[1]}';
    assert.ok(
        !source.includes(malformed),
        `script must not guard main() with the literal ${malformed} comparison (breaks on win32)`,
    );
    assert.ok(
        source.includes('pathToFileURL(process.argv[1])'),
        'script must guard main() with import.meta.url === pathToFileURL(process.argv[1]).href',
    );
});
