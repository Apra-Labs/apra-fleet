import { test, describe } from 'node:test';
import assert from 'node:assert';

import { classifyDoltFailure, extractDoltRemoteUrl } from '../auto-sprint/runner.js';

// Run-24 abort root cause: a smoke-test run contaminated the host repo's
// beads sync remote with a sandbox-local file:// path, then deleted the
// sandbox. The next D-push/D-pull bracket failed with a raw stat error that
// classifyDoltFailure could only call 'unknown', so the run died with a
// generic command failure instead of a named, actionable diagnosis. These
// are the EXACT stderr texts from that incident (paths generalized only in
// the negative cases).

const RUN24_PUSH_STDERR = `Pushing to Dolt remote...

Error: push to origin/main: Error 1105: failed to get remote db; the remote: origin 'file:///Users/akhil/temp/.apra-fleet-tests/.apra-fleet-toy-dolt-remote' could not be accessed; stat /Users/akhil/temp/.apra-fleet-tests/.apra-fleet-toy-dolt-remote: no such file or directory
`;

const RUN24_PULL_STDERR = `Pulling from Dolt remote...

Error: fetch from origin/main: Error 1105: stat /Users/akhil/temp/.apra-fleet-tests/.apra-fleet-toy-dolt-remote: no such file or directory
`;

describe('classifyDoltFailure: remote-unreachable (run-24 abort regression pin)', () => {
    test('run-24 D-push stderr classifies as remote-unreachable, not unknown', () => {
        assert.strictEqual(classifyDoltFailure(RUN24_PUSH_STDERR), 'remote-unreachable');
    });

    test('run-24 D-pull stderr classifies as remote-unreachable, not unknown', () => {
        assert.strictEqual(classifyDoltFailure(RUN24_PULL_STDERR), 'remote-unreachable');
    });

    test('existing classes are unaffected', () => {
        // Samples drawn from the existing pattern lists in runner.js.
        assert.strictEqual(classifyDoltFailure('hint: updates were rejected'), 'diverged');
        assert.strictEqual(classifyDoltFailure('connection refused'), 'transient');
        assert.strictEqual(classifyDoltFailure('some entirely unrelated failure text'), 'unknown');
    });
});

describe('extractDoltRemoteUrl', () => {
    test('extracts the quoted remote URL from the run-24 push stderr', () => {
        assert.strictEqual(
            extractDoltRemoteUrl(RUN24_PUSH_STDERR),
            'file:///Users/akhil/temp/.apra-fleet-tests/.apra-fleet-toy-dolt-remote',
        );
    });

    test('falls back to any scheme URL present in the text', () => {
        assert.strictEqual(
            extractDoltRemoteUrl('fetch failed against https://example.com/org/repo.git today'),
            'https://example.com/org/repo.git',
        );
    });

    test('returns null when no URL is recognizable (bare stat path, no scheme)', () => {
        assert.strictEqual(extractDoltRemoteUrl(RUN24_PULL_STDERR), null);
        assert.strictEqual(extractDoltRemoteUrl('no url here'), null);
    });
});
