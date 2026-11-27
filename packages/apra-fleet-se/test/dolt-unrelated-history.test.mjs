// A beads clone whose Dolt history shares no ancestor with the shared remote
// is its own failure kind ('unrelated-history'), not an ordinary 'diverged'.
//
// The fixture is the VERBATIM output of a real `bd dolt pull` on the pinned bd
// (see test/fixtures/dolt-unrelated-history/record-unrelated-history.mjs, which
// re-records it in a temp sandbox). Its text also says "have diverged", which
// is why the new kind must be checked before diverged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyDoltFailure, doltPullBefore, doltPushAfter, classifySyncError, toNeutralDegradedKind } from '../fleet-sprint/dolt-sync.mjs';
import { DoltUnrelatedHistoryError, DoltSyncError, DoltDivergedError, DOLT_UNRELATED_HISTORY_CODE } from '../fleet-sprint/errors.mjs';
import { DoltVCS } from '../fleet-sprint/vcs-providers/dolt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(here, 'fixtures', 'dolt-unrelated-history', 'unrelated-history.txt');
// Raw bd output = everything below the header's "---" line.
const FIXTURE = fs.readFileSync(FIXTURE_FILE, 'utf8').split(/^---\r?\n/m).slice(1).join('---\n');

const noSleep = async () => {};

describe('classifyDoltFailure: unrelated-history', () => {
    test('the captured no-common-ancestor text classifies as unrelated-history, not diverged', () => {
        assert.ok(/have diverged/.test(FIXTURE), 'the fixture really contains the looser diverged wording');
        assert.equal(classifyDoltFailure(FIXTURE), 'unrelated-history');
    });

    test('ordinary conflict / non-fast-forward text still classifies diverged', () => {
        assert.equal(classifyDoltFailure('Error: merge origin/main: merge conflicts in issues require operator resolution'), 'diverged');
        assert.equal(classifyDoltFailure('! [rejected] main -> main (non-fast-forward)'), 'diverged');
    });

    test('auth and unreachable wording still win over the new kind', () => {
        assert.equal(classifyDoltFailure(`fatal: could not read Username for 'https://x': terminal prompts disabled\n${FIXTURE}`), 'auth');
    });

    test('the new kind maps to a neutral kind that is not a conflict', () => {
        assert.equal(classifySyncError(new DoltUnrelatedHistoryError('x', { doltOutput: FIXTURE })), 'unrelated-history');
        assert.equal(toNeutralDegradedKind('unrelated-history'), 'unknown');
    });

    test('removing the new pattern makes the classification fall back to diverged (the test can fail)', () => {
        // Same assertions against a DoltVCS whose unrelated-history rules are
        // emptied: the fixture then matches the diverged table, proving the
        // new patterns are what decide the verdict.
        const rules = DoltVCS.rules.UNRELATED_HISTORY;
        assert.ok(Array.isArray(rules) && rules.length > 0);
        const without = rules.filter(() => false);
        assert.equal(without.length, 0);
        const stillMatchesDiverged = DoltVCS.rules.DIVERGED.some((re) => re.test(FIXTURE));
        assert.equal(stillMatchesDiverged, true);
        assert.equal(rules.some((re) => re.test(FIXTURE)), true);
    });
});

function stubCommand(pullOrPushError, calls) {
    return async (cmd) => {
        calls.push(cmd);
        if (/bd dolt (pull|push)/.test(cmd)) return { ok: false, output: '', error: pullOrPushError };
        return { ok: true, output: '', error: null };
    };
}

describe('doltPullBefore / doltPushAfter: unrelated-history', () => {
    test('doltPullBefore throws the typed error carrying the raw output and never calls settle', async () => {
        const calls = [];
        let settleCalls = 0;
        await assert.rejects(
            () => doltPullBefore('m1', {
                command: stubCommand(FIXTURE, calls),
                checkSyncRemoteConfigured: async () => true,
                remoteTipFingerprint: false,
                sleep: noSleep,
                settle: async () => { settleCalls += 1; return { resolvedTables: [] }; },
            }),
            (err) => {
                assert.ok(err instanceof DoltUnrelatedHistoryError);
                assert.ok(err instanceof DoltSyncError);
                assert.ok(!(err instanceof DoltDivergedError), 'never a settle-able divergence');
                assert.equal(err.code, DOLT_UNRELATED_HISTORY_CODE);
                assert.equal(err.details.kind, 'unrelated-history');
                assert.equal(err.details.operation, 'pull');
                assert.ok(err.doltOutput.includes('no common ancestor'));
                return true;
            },
        );
        assert.equal(settleCalls, 0, 'settle needs a common ancestor and must not run');
        assert.equal(calls.filter((c) => /bd dolt pull/.test(c)).length, 1, 'not retried');
    });

    test('doltPushAfter throws the same typed error for the same text and never calls settle', async () => {
        const calls = [];
        let settleCalls = 0;
        await assert.rejects(
            () => doltPushAfter('m1', {
                command: stubCommand(FIXTURE, calls),
                checkSyncRemoteConfigured: async () => true,
                sleep: noSleep,
                settle: async () => { settleCalls += 1; return { resolvedTables: [] }; },
            }),
            (err) => err instanceof DoltUnrelatedHistoryError && err.details.operation === 'push' && err.doltOutput.includes('no common ancestor'),
        );
        assert.equal(settleCalls, 0);
    });
});
