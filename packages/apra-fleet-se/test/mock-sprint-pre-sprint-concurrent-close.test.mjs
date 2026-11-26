import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { FULL_DB_BRIEF_FETCH_CMD } from '../fleet-sprint/beads-scope.mjs';

// =============================================================================
// apra-fleet-pel2: two sprints share one parent. The other sprint closes the
// last open children AFTER this run cached its full-DB snapshot but BEFORE its
// fresh pre-sprint readiness reads. The fresh reads then show "nothing ready,
// only the parent is not done" while the cached snapshot still shows open
// children, so the parent was not routed to verify and the run threw a
// DEADLOCKED pre-sprint refusal naming only the parent. Another process's
// `bd close` never invalidates this run's snapshot, so the gate must re-read
// it before calling the scope deadlocked. The close is forced deterministically
// from the command hook, at the exact point the race hits.
// =============================================================================

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const APPROVE = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const isReadyRead = (c) => /^bd list\b.*--ready\b/.test(c);

test('pre-sprint gate: children closed by another process after the snapshot route the parent to verify, not DEADLOCKED', async () => {
    await withScenarioMarkers('presprintconcurrentclose (out-of-band close between snapshot and --ready)', async () => {
        let tempDirRef = null;
        let taskIds = [];
        let snapshotSeen = false;
        let closedOutOfBand = false;
        const res = await runDevelopLoopScenario('presprintconcurrentclose', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: A' }, { title: 'Task: B' }],
            maxCycles: 1,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                tempDirRef = td;
                taskIds = ts.map((t) => t.id);
            },
            onCommand: async ({ command }) => {
                if (command === FULL_DB_BRIEF_FETCH_CMD) snapshotSeen = true;
                if (!closedOutOfBand && snapshotSeen && isReadyRead(command)) {
                    closedOutOfBand = true;
                    for (const id of taskIds) await runCmd(`bd close ${id}`, tempDirRef);
                }
                return undefined;
            },
        });
        assert.ok(closedOutOfBand, 'the hook must have closed the children between the snapshot and the --ready read');
        const reason = res.error && res.error.details ? res.error.details.reason : res.error && res.error.reason;
        assert.ok(
            !(res.error && /deadlocked/i.test(`${res.error.message} ${reason || ''}`)),
            `the pre-sprint gate must not report a deadlock: ${res.error ? res.error.message : ''}`,
        );
        assert.ok(
            res.logs.some((m) => m.startsWith('Pre-sprint validation: no ready leaf beads') && m.includes('routed to verify')),
            `expected the parent routed to verify, logs: ${JSON.stringify(res.logs.filter((l) => /pre-sprint/i.test(l)))}`,
        );
    });
});
