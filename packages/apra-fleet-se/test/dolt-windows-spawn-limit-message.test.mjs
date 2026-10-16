// Windows CreateProcess "Not enough memory resources" during a bd/dolt git
// spawn must be surfaced as what it is -- the Windows process-creation limit
// -- and not with the credential hint dolt appends to it -- while staying
// retryable exactly as before. No Windows host needed; runs on every OS.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
    surfaceDoltFailureText,
    classifyDoltFailure,
    isSpawnOutageFailure,
    doltPullBefore,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    DOLT_GENERIC_TRANSIENT_MAX_RETRIES,
    DOLT_SPAWN_OUTAGE_BUDGET_MS,
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

describe('D-pull hitting the Windows spawn limit (end to end through runDoltStep)', () => {
    beforeEach(() => {
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
    });

    test('is still retried as a spawn outage, never self-healed as auth, and the terminal error names the real cause', async () => {
        let clock = 0;
        let pulls = 0;
        const command = async (cmd) => {
            if (cmd.includes('bd config get sync.remote')) {
                return { ok: true, output: JSON.stringify({ value: 'git+https://example.com/org/repo.git' }), error: null };
            }
            if (cmd.includes('bd dolt pull')) {
                pulls += 1;
                return { ok: false, output: '', error: INCIDENT };
            }
            return { ok: true, output: '', error: null };
        };
        const logs = [];
        let healCalls = 0;
        const err = await doltPullBefore('win-member', {
            command,
            remoteTipFingerprint: false,
            log: (line) => logs.push(line),
            onAuthFailure: async () => { healCalls += 1; },
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
        }).then(() => null, (e) => e);

        assert.ok(err, 'an outage that outlasts the budget must still fail the D-pull');
        // Retryable exactly as today: the spawn-outage wall-clock ladder ran
        // past the generic count bound, and no credential self-heal fired.
        assert.ok(pulls > DOLT_GENERIC_TRANSIENT_MAX_RETRIES + 1, `expected the spawn-outage ladder, saw ${pulls} attempts`);
        assert.ok(clock >= DOLT_SPAWN_OUTAGE_BUDGET_MS);
        assert.strictEqual(healCalls, 0);
        assert.ok(logs.some((l) => /transient SPAWN-OUTAGE failure/.test(l)));

        // The surfaced error names the Windows limit and carries no GCM/credential hint.
        assert.match(err.message, /Windows process-creation resource limit/);
        assert.doesNotMatch(err.message, /hint:|interactive credential prompts|VCS CREDENTIALS|provision_vcs_auth/);
        for (const line of logs.filter((l) => /Not enough memory resources/.test(l))) {
            assert.match(line, /Windows process-creation resource limit/);
            assert.doesNotMatch(line, /hint:|interactive credential prompts/);
        }
    });
});
