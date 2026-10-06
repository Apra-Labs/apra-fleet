// Windows CreateProcess "Not enough memory resources" during a bd/dolt git
// spawn must be surfaced as what it is -- the Windows process-creation limit
// -- and not with the credential hint dolt appends to it. Pure functions;
// runs on every OS.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    surfaceDoltFailureText,
    classifyDoltFailure,
    isSpawnOutageFailure,
} from '../fleet-sprint/dolt-sync.mjs';

// The live incident text (same shape as test/dolt-remote-unreachable.test.mjs).
const INCIDENT = `Pushing to Dolt remote...

Error: push to origin/main: Error 1105: failed to get remote db; the remote: origin 'git+https://example.com/org/repo.git' could not be accessed; git command failed
command: git cat-file -s b28c97545eadb482c7981d3d9ff2def7d565d4f4
output:
(no output)
error: fork/exec C:\\Program Files\\Git\\mingw64\\bin\\git.exe: Not enough memory resources are available to process this command.
hint: dolt does not support interactive credential prompts
`;

describe('surfaceDoltFailureText', () => {
    test('names the Windows process-creation limit and drops the credential hint', () => {
        const out = surfaceDoltFailureText(INCIDENT);
        assert.match(out, /Windows process-creation resource limit/);
        assert.match(out, /CreateProcess ERROR_NOT_ENOUGH_MEMORY/);
        assert.doesNotMatch(out, /hint:/i);
        assert.doesNotMatch(out, /interactive credential prompts/);
        // The real spawn line is kept for diagnosis.
        assert.match(out, /fork\/exec .*git\.exe: Not enough memory resources/);
    });

    test('keeps the verdict: surfaced text classifies exactly like the raw text', () => {
        const out = surfaceDoltFailureText(INCIDENT);
        assert.strictEqual(classifyDoltFailure(INCIDENT), 'transient');
        assert.strictEqual(classifyDoltFailure(out), 'transient');
        assert.strictEqual(isSpawnOutageFailure(out), true);
    });

    test('is the identity for every other failure text, hint lines included', () => {
        for (const t of [
            'connection reset by peer',
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\nhint: check credentials",
            '',
        ]) {
            assert.strictEqual(surfaceDoltFailureText(t), t);
        }
        assert.strictEqual(surfaceDoltFailureText(undefined), '');
    });
});
