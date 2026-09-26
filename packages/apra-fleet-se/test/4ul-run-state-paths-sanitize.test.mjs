import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    sanitizeRunIdForFilename,
    getRunningRunStatePath,
    getTerminalRunStatePath,
    getOldRunsDir,
} from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

// =============================================================================
// apra-fleet-4ul / apra-fleet-cvb.3 -- regression coverage for
// sanitizeRunIdForFilename() and the legacy-nested read fallback in
// getTerminalRunStatePath() (run-state-paths.mjs ~lines 51-56, 107-127): a
// branch-name-shaped runId (contains '/') must never cause a write under a
// nested path, and a pre-existing legacy nested terminal record must still be
// found (read-only) so a cleanly-finished sprint with a legacy branch-name
// runId classifies FINISHED, not CRASHED -- the actual apra-fleet-4ul bug.
// =============================================================================

async function tmpDataDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function realDeadPid() {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'expected spawnSync to report a pid');
    return child.pid;
}

describe('apra-fleet-4ul / apra-fleet-cvb.3: sanitizeRunIdForFilename() and its callers', () => {
    test('a runId containing "/" sanitizes to a flat, separator-free filename component', () => {
        assert.equal(sanitizeRunIdForFilename('fix/fleet-sprint-stabilization'), 'fix_fleet-sprint-stabilization');
        assert.equal(sanitizeRunIdForFilename('feat/a/b/c'), 'feat_a_b_c');
    });

    test('a runId containing "\\\\" (backslash) also sanitizes to a flat filename component', () => {
        assert.equal(sanitizeRunIdForFilename('weird\\branch\\name'), 'weird_branch_name');
    });

    test('a separator-free runId is left unchanged by sanitize', () => {
        assert.equal(sanitizeRunIdForFilename('plain-run-id-123'), 'plain-run-id-123');
    });

    test('getRunningRunStatePath: a slash-containing runId produces a FLAT path directly under running/, never nested', async () => {
        const dataDir = await tmpDataDir('4ul-running-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = 'fix/some-branch-name';
            const runningPath = getRunningRunStatePath(runId, env);
            assert.equal(path.dirname(runningPath), path.join(dataDir, 'running'), 'must be a direct child of running/, not a nested subdirectory');
            assert.equal(path.basename(runningPath), 'fix_some-branch-name.json');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('getTerminalRunStatePath: a slash-containing runId used as a WRITE target produces a FLAT path directly under old_runs/, never nested -- no code path can write under a slash-containing key', async () => {
        const dataDir = await tmpDataDir('4ul-terminal-write-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = 'fix/some-branch-name';
            const terminalPath = getTerminalRunStatePath(runId, env);
            // Fresh runId, nothing on disk yet => canonical flat write target.
            assert.equal(path.dirname(terminalPath), getOldRunsDir(env), 'must resolve to a direct child of old_runs/, not a nested subdirectory');
            assert.equal(path.basename(terminalPath), 'fix_some-branch-name.json');

            // Actually writing to it must land flat on disk (proves no
            // caller three layers up can ever recreate the pre-4ul nested
            // write by using this path as-is).
            fs.mkdirSync(path.dirname(terminalPath), { recursive: true });
            fs.writeFileSync(terminalPath, JSON.stringify({ terminalReason: 'DONE' }));
            assert.equal(fs.existsSync(path.join(getOldRunsDir(env), 'fix', 'some-branch-name.json')), false, 'must never create a nested old_runs/fix/ directory');
            assert.equal(fs.existsSync(path.join(getOldRunsDir(env), 'fix_some-branch-name.json')), true);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('getTerminalRunStatePath: safeRunId === runId (no separators) skips the extra legacy-nested fs.existsSync check for the common case', async () => {
        const dataDir = await tmpDataDir('4ul-no-extra-check-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = 'plain-run-id-no-separators';

            const originalExistsSync = fs.existsSync;
            const checkedPaths = [];
            fs.existsSync = (p) => { checkedPaths.push(p); return originalExistsSync(p); };
            let resolved;
            try {
                resolved = getTerminalRunStatePath(runId, env);
            } finally {
                fs.existsSync = originalExistsSync;
            }

            assert.equal(resolved, path.join(getOldRunsDir(env), `${runId}.json`));
            // Exactly two existsSync checks for the separator-free case: the
            // sanitized old_runs/ path and the legacy old_sprints/ path --
            // NOT a third "legacy nested" check, since safeRunId === runId
            // means there is no distinct unsanitized path to probe.
            assert.equal(checkedPaths.length, 2, `expected exactly 2 existsSync checks for a separator-free runId, got ${checkedPaths.length}: ${JSON.stringify(checkedPaths)}`);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('getTerminalRunStatePath: a pre-existing LEGACY nested terminal record (written before sanitize existed, under a raw slash-containing key) is still found read-only', async () => {
        const dataDir = await tmpDataDir('4ul-legacy-nested-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = 'fix/legacy-branch-name';

            // Simulate a pre-sanitize write: raw, unsanitized nested path
            // built directly from runId, exactly what the old unsanitized
            // path.join used to produce.
            const legacyNestedPath = path.join(getOldRunsDir(env), `${runId}.json`);
            fs.mkdirSync(path.dirname(legacyNestedPath), { recursive: true });
            fs.writeFileSync(legacyNestedPath, JSON.stringify({ terminalReason: 'SPRINT_STALLED' }));

            // No flat, sanitized file exists at this point.
            const flatPath = path.join(getOldRunsDir(env), `${sanitizeRunIdForFilename(runId)}.json`);
            assert.equal(fs.existsSync(flatPath), false);

            const resolved = getTerminalRunStatePath(runId, env);
            assert.equal(resolved, legacyNestedPath, 'must fall back to the legacy nested path when the flat sanitized path does not exist');
            const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
            assert.equal(parsed.terminalReason, 'SPRINT_STALLED');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('end to end: a finished sprint whose terminal state was written under a legacy branch-name-shaped runId classifies FINISHED, not CRASHED', async () => {
        const dataDir = await tmpDataDir('4ul-watchdog-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const legacyRunId = 'fix/legacy-shaped-run-id';

            // Write the terminal record the OLD (pre-4ul) unsanitized code
            // path would have produced: a raw nested file under the raw
            // slash-containing runId.
            const legacyNestedPath = path.join(getOldRunsDir(env), `${legacyRunId}.json`);
            fs.mkdirSync(path.dirname(legacyNestedPath), { recursive: true });
            fs.writeFileSync(legacyNestedPath, JSON.stringify({ terminalReason: 'DONE' }));

            const deadPid = realDeadPid();
            const ledger = { list: () => [{ sprintId: legacyRunId, childPid: deadPid, branch: null }] };
            const watchdog = createWatchdog({ ledger, env });

            const [classification] = await watchdog.classifyAll();
            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED, 'a legacy branch-name-shaped runId with a real (legacy nested) terminal record must classify FINISHED, not CRASHED');
            assert.equal(classification.terminalState.terminalReason, 'DONE');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });
});
