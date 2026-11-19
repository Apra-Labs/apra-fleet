import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleNestedSuiteSpawnResult, extractLateExitFailures } from './helpers/nested-suite-spawn.mjs';

// =============================================================================
// The nested-suite failure summary for a FILE-level failure whose subtests all
// passed (the process exited non-zero after the test resolved): it must say
// `exited <code> after N passing subtests` and quote the stderr tail, while
// real assertion failures and module-load crashes keep their old summaries.
// Unit cases over TAP text, plus an end-to-end spawn of a late-exiting fixture
// through the same handleNestedSuiteSpawnResult path the real suites use.
//
// ASCII only.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'nested-runner', 'late-exit.fixture.mjs');

const LATE_TAP = [
    'TAP version 13',
    '# Subtest: one',
    'ok 1 - one',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    '# Subtest: two',
    'ok 2 - two',
    '# some stderr line',
    '# MARKER stderr tail',
    '# Subtest: /repo/test/x.test.mjs',
    'not ok 53 - /repo/test/x.test.mjs',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  exitCode: 1',
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
    '1..1',
].join('\n');

/** The parent runner's NODE_TEST_CONTEXT makes a nested `node --test` skip its files. */
function childEnv() {
    const { NODE_TEST_CONTEXT: _ctx, ...rest } = process.env;
    return rest;
}

function summaryFor(stdout, stderr = '') {
    const err = Object.assign(new Error('Command failed'), { status: 1, stdout, stderr });
    try {
        handleNestedSuiteSpawnResult('suite', err, 1000, 'test', 'X_MS');
    } catch (e) {
        return e.message;
    }
    throw new Error('expected a throw');
}

describe('late-exit summary', () => {
    test('all subtests ok + file-level not ok with a non-zero exit renders the exit code, passing count and stderr tail', () => {
        const f = extractLateExitFailures(LATE_TAP);
        assert.equal(f.length, 1);
        assert.equal(f[0].exitCode, '1');
        assert.equal(f[0].passing, 2);
        assert.equal(f[0].tailSource, 'stderr');
        const msg = summaryFor(LATE_TAP);
        assert.match(msg, /\/repo\/test\/x\.test\.mjs exited 1 after 2 passing subtests/);
        assert.match(msg, /MARKER stderr tail/);
    });

    test('with no stderr the stdout tail is quoted instead', () => {
        const tap = ['ok 1 - a', 'plain stdout line', 'not ok 2 - /r/y.test.mjs', '  ---', '  exitCode: 3', '  ...'].join('\n');
        const f = extractLateExitFailures(tap);
        assert.equal(f[0].tailSource, 'stdout');
        assert.deepEqual(f[0].tail, ['plain stdout line']);
        assert.match(summaryFor(tap), /exited 3 after 1 passing subtests/);
    });

    test('a real assertion failure keeps its old summary (no late-exit line)', () => {
        const tap = ['not ok 1 - broken', '  ---', "  error: 'boom'", '  ...', 'not ok 2 - /r/z.test.mjs', '  ---', '  exitCode: 1', '  ...'].join('\n');
        assert.deepEqual(extractLateExitFailures(tap), []);
        assert.doesNotMatch(summaryFor(tap), /passing subtests/);
    });

    test('a module-load crash (no passing subtest) keeps its old summary', () => {
        const tap = ['not ok 1 - /r/crash.test.mjs', '  ---', '  exitCode: 1', '  ...'].join('\n');
        assert.deepEqual(extractLateExitFailures(tap), []);
        const msg = summaryFor(tap);
        assert.doesNotMatch(msg, /passing subtests/);
        assert.match(msg, /child failing TAP entries/);
    });

    test('empty or malformed input yields nothing and never throws', () => {
        assert.deepEqual(extractLateExitFailures(undefined), []);
        assert.deepEqual(extractLateExitFailures('garbage\nnot ok - -'), []);
    });
});

describe('nested run of a late-exiting fixture', () => {
    test('the failure summary names exited 1 after 1 passing subtests and the marker stderr line', () => {
        const r = spawnSync(process.execPath, ['--test', FIXTURE], { encoding: 'utf8', env: childEnv() });
        assert.equal(r.status, 1, `fixture should exit 1, got ${r.status}: ${r.stderr}`);
        const err = Object.assign(new Error('Command failed'), { status: r.status, stdout: r.stdout, stderr: r.stderr });
        let msg = '';
        try {
            handleNestedSuiteSpawnResult('late-exit fixture', err, 60000, 'test', 'X_MS');
        } catch (e) {
            msg = e.message;
        }
        assert.match(msg, /exited 1 after 1 passing subtests/, msg);
        assert.match(msg, /LATE-EXIT-MARKER: written after the test resolved/, msg);
    });

    test('the fixture is outside the real-suite glob', () => {
        assert.ok(!FIXTURE.endsWith('.test.mjs'));
        assert.ok(path.relative(here, FIXTURE).includes(path.sep), 'it lives in a subdirectory, which test/*.test.mjs does not match');
    });
});
