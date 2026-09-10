import { test, describe } from 'node:test';
import assert from 'node:assert';

import { classifyDoltFailure, extractDoltRemoteUrl } from '../fleet-sprint/runner.js';

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

// apra-fleet-ka1u: a live Windows failure where Dolt's git subprocess spawn
// itself was refused by the OS (a transient CreateProcess resource error,
// NOT a real remote problem), but Dolt wraps that in the SAME generic
// "failed to get remote db"/"could not be accessed" phrasing the run-24
// incident above uses for a genuinely dead remote. Without the fork/exec
// guard, this misclassified as remote-unreachable ("retrying cannot
// succeed") even though the remote (a real, correctly-configured GitHub
// URL) was fully reachable -- confirmed live: an unmodified retry of the
// identical command against the identical remote succeeded outright,
// repeatedly. This must classify as transient so it reaches the existing
// bounded-retry-with-backoff path instead of hard-aborting the sprint.
const FORKEXEC_PUSH_STDERR = `Pushing to Dolt remote...

Error: push to origin/main: Error 1105: failed to get remote db; the remote: origin 'git+https://github.com/Apra-Labs/apra-fleet.git' could not be accessed; git command failed
command: git cat-file -s b28c97545eadb482c7981d3d9ff2def7d565d4f4
output:
(no output)
error: fork/exec C:\\Program Files\\Git\\mingw64\\bin\\git.exe: Not enough memory resources are available to process this command.
hint: dolt does not support interactive credential prompts
`;

describe('classifyDoltFailure: remote-unreachable (run-24 abort regression pin)', () => {
    test('run-24 D-push stderr classifies as remote-unreachable, not unknown', () => {
        assert.strictEqual(classifyDoltFailure(RUN24_PUSH_STDERR), 'remote-unreachable');
    });

    test('run-24 D-pull stderr classifies as remote-unreachable, not unknown', () => {
        assert.strictEqual(classifyDoltFailure(RUN24_PULL_STDERR), 'remote-unreachable');
    });

    // apra-fleet-7h6n.3: the "existing classes are unaffected" sanity check
    // that used to live here (diverged/transient/unknown samples) duplicated
    // dolt-sync-brackets.test.mjs's own classifyDoltFailure coverage
    // ("classifyDoltFailure: conflict / non-fast-forward outputs classify as
    // diverged" / "... network / lock outputs classify as transient" / "...
    // unclassifiable output is unknown") -- removed here, still covered
    // there.
});

describe('classifyDoltFailure: fork/exec spawn failure classifies as transient, not remote-unreachable (apra-fleet-ka1u)', () => {
    test('a real GitHub remote whose git.exe spawn was OS-refused classifies as transient', () => {
        assert.strictEqual(classifyDoltFailure(FORKEXEC_PUSH_STDERR), 'transient');
    });

    test('the run-24 genuinely-dead-remote cases above are unaffected by the fork/exec guard', () => {
        assert.strictEqual(classifyDoltFailure(RUN24_PUSH_STDERR), 'remote-unreachable');
        assert.strictEqual(classifyDoltFailure(RUN24_PULL_STDERR), 'remote-unreachable');
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
