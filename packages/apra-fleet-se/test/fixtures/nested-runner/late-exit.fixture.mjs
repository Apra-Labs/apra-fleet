// Fixture for nested-runner-late-exit.test.mjs. NOT a real suite: it lives
// under test/fixtures/ (outside the 'test/*.test.mjs' glob run-tests.mjs
// uses) and does not end in .test.mjs. Its only test passes; the process
// then writes a marker line to stderr and exits non-zero after the test
// resolved, the shape of a post-test failure.
//
// ASCII only.
import { test } from 'node:test';

test('the only test passes', () => {});

process.on('exit', () => {
    process.stderr.write('LATE-EXIT-MARKER: written after the test resolved\n');
    process.exitCode = 1;
});
