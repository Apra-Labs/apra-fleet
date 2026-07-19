import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    getRunningSprintStatePath,
    getOldSprintStatePath
} from '../src/viewer/sprint-state-paths.mjs';

// Tests for apra-fleet-eft.2.4: continuous persistence must survive a real
// hard kill (SIGKILL, not a graceful SIGINT/SIGTERM and not a mocked
// process.exit), and running/ vs old_sprints/ directory membership must be
// the sole authority on "is this sprint still alive" -- never a stale field
// on the state object itself.
//
// Unlike every other suite in this directory (apra-fleet-workflow-viewer-
// lifecycle.test.mjs, apra-fleet-workflow-sprint-state.test.mjs,
// apra-fleet-workflow-debounced-writer.test.mjs), these tests run the
// workflow + viewer + debounced writer wiring in a REAL CHILD PROCESS
// (test/fixtures/sigkill-harness.mjs) rather than in-process. Killing your
// own test-runner process to simulate a hard kill would kill the assertions
// along with it -- an out-of-process SIGKILL is the only way to genuinely
// exercise "the process is gone with no chance to run any exit handler",
// which is exactly the gap SIGINT/SIGTERM handling (apra-fleet-eft.2.1,
// src/viewer/index.mjs's handleSigint/handleSigterm) cannot cover.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessPath = path.join(__dirname, 'fixtures', 'sigkill-harness.mjs');

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Spawns the sigkill-harness child process and resolves once it has printed
 * its "ready" line (server listening, all persistence wiring set up) --
 * never races sending a signal against a child that hasn't started yet.
 */
function spawnHarness({ cwd, env, sprintId, iterations, agentDelayMs, debounceMs }) {
    const child = spawn(process.execPath, [harnessPath], {
        cwd,
        env: {
            ...env,
            SPRINT_ID: sprintId,
            ITERATIONS: String(iterations),
            AGENT_DELAY_MS: String(agentDelayMs),
            DEBOUNCE_MS: String(debounceMs)
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const ready = new Promise((resolve, reject) => {
        const check = () => {
            if (stdout.includes('[sigkill-harness] ready')) resolve();
        };
        child.stdout.on('data', check);
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (!stdout.includes('[sigkill-harness] ready')) {
                reject(new Error(`harness exited before becoming ready (code=${code} signal=${signal}); stderr:\n${stderr}`));
            }
        });
        check();
    });

    return { child, ready, getStdout: () => stdout, getStderr: () => stderr };
}

function waitForExit(child) {
    return new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

let tempCwd;
let originalCwd;
let dataDir;
beforeEach(() => {
    tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-hard-kill-cwd-'));
    originalCwd = process.cwd();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-hard-kill-data-'));
});
afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('apra-fleet-eft.2.4: continuous persistence survives a real SIGKILL', () => {
    test('a SIGKILL mid-run leaves running/<sprintId>.json in place, reflecting progress within one debounce window of the kill', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const sprintId = `sprint-hard-kill-${randomUUID()}`;
        const iterations = 30;
        const agentDelayMs = 300;
        const debounceMs = 200; // MIN_DEBOUNCE_MS -- tightest possible bound to assert against

        const runningPath = getRunningSprintStatePath(sprintId, env);
        const oldPath = getOldSprintStatePath(sprintId, env);

        const { child, ready, getStderr } = spawnHarness({
            cwd: tempCwd, env, sprintId, iterations, agentDelayMs, debounceMs
        });
        await ready;

        try {
            // Let a handful of iterations complete so the kill lands genuinely
            // mid-run (not at the very first activity, and nowhere near the
            // last of 30) -- if the debounced writer had been reverted to
            // end-only persistence (the regression this test guards against),
            // this file would simply never appear and the waitFor below would
            // time out.
            await waitFor(() => {
                if (!fs.existsSync(runningPath)) return false;
                const state = readJson(runningPath);
                return state.stats.activitiesCount >= 3;
            });

            const preKillState = readJson(runningPath);
            assert.strictEqual(preKillState.status, 'running', 'must genuinely still be mid-run, not already terminal');
            assert.ok(preKillState.stats.activitiesCount < iterations, 'sanity: kill must land before all iterations complete');

            const killRequestedAt = Date.now();
            child.kill('SIGKILL');
            const { signal } = await waitForExit(child);
            assert.strictEqual(signal, 'SIGKILL', `harness must have been terminated by SIGKILL itself; stderr:\n${getStderr()}`);

            // (b) running/old_sprints membership is authoritative: a hard-killed
            // process gets NO chance to run any exit handler (unlike SIGINT/
            // SIGTERM, src/viewer/index.mjs's handleSigint/handleSigterm), so
            // the file must still be sitting in running/ and must NEVER have
            // been moved to old_sprints/.
            assert.ok(fs.existsSync(runningPath), 'running/<sprintId>.json must survive the hard kill in place');
            assert.strictEqual(fs.existsSync(oldPath), false, 'old_sprints/<sprintId>.json must not exist -- nothing moved it there');

            const finalState = readJson(runningPath);
            assert.strictEqual(finalState.status, 'running', 'status must still read "running" -- no graceful terminal transition ever ran');
            assert.strictEqual(finalState.sprintId, sprintId);
            assert.strictEqual(finalState.endedAt, null, 'endedAt must still be null -- the end/signal handlers never got to run');
            assert.strictEqual(finalState.terminalReason, null);

            // (c) enriched fields (apra-fleet-eft.2.2) must be present even in
            // this last-persisted-before-death snapshot, not just on a normal
            // terminal write.
            assert.ok(Array.isArray(finalState.args), 'args must be present');
            assert.ok(finalState.startedAt, 'startedAt must be present');
            assert.ok(finalState.updatedAt, 'updatedAt must be present');

            // (a) the core bound: the on-disk file must reflect progress from
            // AT MOST one debounce window before the kill, not some much
            // older, effectively-frozen snapshot (which is what "reverted to
            // end-only persistence" or "writer stopped scheduling" would look
            // like -- an unboundedly stale updatedAt).
            const lastWriteAgeMs = killRequestedAt - new Date(finalState.updatedAt).getTime();
            const debounceWindowToleranceMs = debounceMs + 500; // schedule/spawn/signal-delivery slack
            assert.ok(
                lastWriteAgeMs >= -50 && lastWriteAgeMs <= debounceWindowToleranceMs,
                `last persisted updatedAt must be within one debounce window (~${debounceMs}ms, allowing ${debounceWindowToleranceMs}ms slack) of the kill; ` +
                `measured age was ${lastWriteAgeMs}ms`
            );

            // Progress must have kept advancing right up to (near) the kill --
            // not stalled at the very first write. Re-confirms the writer was
            // still actively scheduling writes on every activity, not just once.
            assert.ok(
                finalState.stats.activitiesCount >= preKillState.stats.activitiesCount,
                'activitiesCount at the time of the kill must be at least what we observed just before killing'
            );
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
            }
        }
    });

    test('a normally-completed sprint has no file in running/ and exactly one in old_sprints/, and sprint-logs/ output is unchanged', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const sprintId = `sprint-hard-kill-clean-${randomUUID()}`;
        const iterations = 2;
        const agentDelayMs = 20;
        const debounceMs = 200;

        const runningPath = getRunningSprintStatePath(sprintId, env);
        const oldPath = getOldSprintStatePath(sprintId, env);

        const { child, ready, getStderr } = spawnHarness({
            cwd: tempCwd, env, sprintId, iterations, agentDelayMs, debounceMs
        });
        await ready;

        const { code, signal } = await waitForExit(child);
        assert.strictEqual(code, 0, `harness must exit cleanly; signal=${signal} stderr:\n${getStderr()}`);

        // (b) running/old_sprints membership, completion case: the live file
        // must be MOVED (not copied, not left behind), so directory
        // membership alone tells you the sprint is done.
        assert.strictEqual(fs.existsSync(runningPath), false, 'running/<sprintId>.json must be gone after a normal completion');
        assert.ok(fs.existsSync(oldPath), 'old_sprints/<sprintId>.json must exist after a normal completion');

        const oldSprintsDir = path.dirname(oldPath);
        const oldFiles = fs.readdirSync(oldSprintsDir).filter((f) => f === `${sprintId}.json`);
        assert.strictEqual(oldFiles.length, 1, 'exactly one old_sprints/ file for this sprintId');

        // (c) enriched fields on the terminal snapshot.
        const finalState = readJson(oldPath);
        assert.strictEqual(finalState.sprintId, sprintId);
        assert.strictEqual(finalState.status, 'success');
        assert.strictEqual(finalState.verdict, 'MERGED');
        assert.strictEqual(finalState.prUrl, 'https://github.com/example/repo/pull/99');
        assert.ok(finalState.endedAt, 'endedAt must be populated on a normal completion');
        assert.strictEqual(finalState.terminalReason, 'success');

        // (d) sprint-logs/ crash-safety net must be entirely unaffected by
        // this feature (same regression check as apra-fleet-workflow-sprint-
        // state.test.mjs's "sprint-logs/ still lands in the repo checkout as
        // before" and apra-fleet-workflow-debounced-writer.test.mjs's
        // byte-for-byte comparison): exactly one sprint_HHMMSS.json, 2-space
        // indented, whose content matches the same enriched state object.
        const sprintLogsDir = path.join(tempCwd, 'sprint-logs');
        const logFiles = fs.readdirSync(sprintLogsDir).filter((f) => /^sprint_\d{6}\.json$/.test(f));
        assert.strictEqual(logFiles.length, 1, `expected exactly one sprint_HHMMSS.json file, found: ${JSON.stringify(logFiles)}`);
        const savedContent = fs.readFileSync(path.join(sprintLogsDir, logFiles[0]), 'utf-8');
        assert.deepStrictEqual(JSON.parse(savedContent), finalState, 'sprint-logs/ snapshot must match the same terminal state written to old_sprints/');
        assert.ok(savedContent.includes('\n  "workflowName"'), 'sprint-logs/ formatting must remain 2-space indented JSON, unchanged from before this feature');
    });
});
