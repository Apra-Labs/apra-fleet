import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import timestampedReporter from './helpers/timestamped-reporter.mjs';

// =============================================================================
// Regression guard for the reporter's FAIL rendering.
//
// node:test reports a test FILE whose child process died without any failing
// subtest as a single ERR_TEST_FAILURE with `stack: undefined` and
// `message: 'test failed'`. Everything that identifies the failure --
// failureType, exitCode, signal, code, cause -- lives in sibling properties.
// The reporter used to print only `stack || message`, which rendered exactly
// that failure mode as a bare, anonymous `test failed` line: a CI log would
// say `# fail 1` and carry no exit status at all, which is unfalsifiable.
//
// The shapes asserted below were captured from a real
// `node --test` run on Node 22 (a test file whose only statement is
// `process.exit(7)`), not invented.
// =============================================================================

async function collect(events) {
    async function* source() {
        for (const event of events) yield event;
    }
    let out = '';
    for await (const chunk of timestampedReporter(source())) out += chunk;
    return out;
}

function fileLevelExitFailure({ exitCode = 7, signal = null } = {}) {
    const error = new Error('test failed');
    error.code = 'ERR_TEST_FAILURE';
    error.failureType = 'testCodeFailure';
    error.cause = 'test failed';
    error.exitCode = exitCode;
    error.signal = signal;
    // node:test genuinely delivers this one with no stack at all.
    error.stack = undefined;
    return {
        type: 'test:fail',
        data: {
            file: 'D:\\a\\repo\\packages\\pkg\\test\\thing.test.mjs',
            name: 'test\\thing.test.mjs',
            details: { duration_ms: 572.7, error },
        },
    };
}

describe('timestamped-reporter -- failure rendering', () => {
    test('a stackless file-level failure still names the file, exit code and failure type', async () => {
        const out = await collect([fileLevelExitFailure()]);

        assert.match(out, /FAIL .*thing\.test\.mjs :: test\\thing\.test\.mjs \(572\.7ms\)/);
        assert.match(out, /exitCode=7/);
        assert.match(out, /failureType=testCodeFailure/);
        assert.match(out, /code=ERR_TEST_FAILURE/);
    });

    test('a kill-signal file-level failure reports the signal', async () => {
        const out = await collect([
            fileLevelExitFailure({ exitCode: null, signal: 'SIGKILL' }),
        ]);

        assert.match(out, /signal=SIGKILL/);
        assert.doesNotMatch(out, /exitCode=/, 'a null exitCode is omitted rather than printed as "null"');
    });

    test('a string cause that merely echoes the message is not printed twice', async () => {
        const out = await collect([fileLevelExitFailure()]);

        assert.doesNotMatch(out, /caused by/);
        assert.equal(
            out.match(/test failed/g).length,
            1,
            'the identical `cause` string must not be echoed as a second block',
        );
    });

    test('an ordinary assertion failure still prints the full stack AND its underlying cause', async () => {
        const cause = new Error('1 == 2');
        cause.code = 'ERR_ASSERTION';
        cause.stack = 'AssertionError [ERR_ASSERTION]: 1 == 2\n    at TestContext.<anonymous> (file:///x/y.test.mjs:4:10)';
        const error = new Error('1 == 2');
        error.code = 'ERR_TEST_FAILURE';
        error.failureType = 'testCodeFailure';
        error.stack = 'Error [ERR_TEST_FAILURE]: 1 == 2\n    at Test.run (node:internal/test_runner/test:1047:25)';
        error.cause = cause;

        const out = await collect([
            {
                type: 'test:fail',
                data: {
                    file: '/x/y.test.mjs',
                    name: 'some human sentence',
                    details: { duration_ms: 2.5, error },
                },
            },
        ]);

        assert.match(out, /Error \[ERR_TEST_FAILURE\]: 1 == 2/);
        assert.match(out, /caused by:/);
        assert.match(out, /AssertionError \[ERR_ASSERTION\]: 1 == 2/);
        assert.match(out, /at TestContext\.<anonymous> \(file:\/\/\/x\/y\.test\.mjs:4:10\)/);
    });

    test('a self-referential cause chain terminates instead of wedging the reporter', async () => {
        const error = new Error('loop');
        error.stack = undefined;
        error.cause = error;

        const out = await collect([
            {
                type: 'test:fail',
                data: { file: 'f.mjs', name: 'f.mjs', details: { duration_ms: 1, error } },
            },
        ]);

        assert.match(out, /FAIL f\.mjs/);
        assert.equal(out.match(/loop/g).length, 1);
    });

    test('pass/diagnostic/stderr rendering and the trailing SUMMARY are unchanged', async () => {
        const out = await collect([
            { type: 'test:pass', data: { file: 'a.mjs', name: 'green', details: { duration_ms: 1.25 } } },
            fileLevelExitFailure(),
            { type: 'test:diagnostic', data: { message: 'tests 2' } },
            { type: 'test:stderr', data: { file: 'a.mjs', message: 'a warning\n' } },
            { type: 'test:coverage', data: {} },
        ]);

        assert.match(out, /PASS a\.mjs :: green \(1\.3ms\)/);
        assert.match(out, /# tests 2/);
        assert.match(out, /STDERR a\.mjs a warning/);
        assert.match(out, /SUMMARY pass=1 fail=1/);
    });
});
