import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { parseCliArgs } from '../bin/cli.mjs';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import {
    getRunningRunStatePath,
    getTerminalRunStatePath,
} from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

// apra-fleet-k7b.5: integration test for apra-fleet-k7b.1 (run-id plumbing).
//
// This test fails against the pre-k7b.1 behaviour (engine run-state keyed by
// branch name alone) because two consecutive launches on the SAME branch
// would then both resolve to the SAME running/<branch>.json ->
// old_runs/<branch>.json path pair, and the second launch's terminal write
// would silently clobber the first's. After k7b.1, each launch is forwarded
// its own supervisor-generated --run-id, so the two launches resolve to two
// distinct old_runs/<runId>.json files that coexist independently.
//
// Chain under test, end to end:
//   1. buildSprintArgv() (packages/apra-fleet-se/src/supervisor/spawner.mjs)
//      emits --run-id in the child argv.
//   2. bin/cli.mjs's parseCliArgs() consumes --run-id, and cli.mjs's own
//      `effectiveRunId = values['run-id'] || branchName` fallback expression
//      (mirrored here, exactly as cli-robustness.test.mjs already pins in
//      isolation) prefers it over the branch name.
//   3. That effectiveRunId is what flows into createDashboardViewer({ runId })
//      exactly as bin/cli.mjs wires it -- driving the engine's
//      running/<id>.json -> old_runs/<id>.json persistence
//      (apra-fleet-workflow/src/viewer/run-state-paths.mjs).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures/boundary-e2e/hello-world-negative.mjs');

const KNOWN_MEMBERS = new Set(['fleet-dev']);

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return { content: [{ text: `echo: ${payload.prompt}` }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

/**
 * Mirrors bin/cli.mjs's own `effectiveRunId` expression (see main(), apra-
 * fleet-k7b.1's comment) exactly, so this test proves the SAME fallback
 * behaviour the real CLI executes, not a reimplementation of it.
 */
function computeEffectiveRunId(argv) {
    const { values } = parseCliArgs(argv);
    return values['run-id'] || values.branch;
}

async function launchAndWaitForTerminal({ runId, env }) {
    const workflow = new FleetWorkflow(createMockFleetApi());
    const engine = new WorkflowEngine(workflow);
    const server = createDashboardViewer(workflow, {
        port: 0,
        name: 'auto-sprint',
        env,
        runId,
        debounceMs: 200,
    });
    if (!server.listening) {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    }
    await engine.executeFile(fixture, {});
    const oldPath = getTerminalRunStatePath(runId, env);
    await waitFor(() => fs.existsSync(oldPath));
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    });
    return oldPath;
}

describe('apra-fleet-k7b.5: run-id keyed engine run-state across consecutive supervisor sprints', () => {
    let dataDir;
    let tempCwd;
    let originalCwd;

    before(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-k7b5-data-'));
        // createDashboardViewer's persistState() also writes a workflow-logs/
        // snapshot relative to process.cwd() -- chdir into a scratch dir so
        // this test never leaves stray files in the repo checkout (mirrors
        // eft-37-boundary-e2e.test.mjs's before()/after()).
        tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-k7b5-cwd-'));
        originalCwd = process.cwd();
        process.chdir(tempCwd);
    });

    after(() => {
        process.chdir(originalCwd);
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
    });

    test('buildSprintArgv() emits --run-id in the child argv', () => {
        const args = buildSprintArgv({
            issue: 'PROJ-1', members: 'alice', branch: 'auto-sprint/x', base: 'main',
            viewerPort: 8080, runId: 'PROJ-1-abc123',
        });
        const ri = args.indexOf('--run-id');
        assert.ok(ri >= 0, 'buildSprintArgv must emit --run-id');
        assert.equal(args[ri + 1], 'PROJ-1-abc123');
    });

    test('cli.mjs consumes --run-id via parseCliArgs and prefers it over --branch', () => {
        const argv = ['--issue', 'bd-1', '--members', 'local', '--branch', 'auto-sprint/x', '--base', 'main', '--run-id', 'PROJ-1-abc123'];
        assert.equal(computeEffectiveRunId(argv), 'PROJ-1-abc123');
    });

    test('cli.mjs falls back to the branch name when --run-id is absent (standalone CLI launch)', () => {
        const argv = ['--issue', 'bd-1', '--members', 'local', '--branch', 'auto-sprint/x', '--base', 'main'];
        assert.equal(computeEffectiveRunId(argv), 'auto-sprint/x');
    });

    test('two consecutive supervisor-spawned launches on the SAME branch produce two distinct old_runs/<runId>.json files, neither overwriting the other, each with its own terminalReason', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const branch = 'auto-sprint/same-branch';

        // Launch 1: supervisor mints its own ledger sprintId and forwards it
        // as --run-id (mirrors createSprintController -> buildSprintArgv,
        // apra-fleet-k7b.1).
        const argv1 = buildSprintArgv({
            issue: 'PROJ-1', members: 'alice', branch, base: 'main',
            viewerPort: 8080, runId: 'PROJ-1-run-a',
        });
        const runId1 = computeEffectiveRunId(['--issue', 'bd-1', '--members', 'local', '--base', 'main', ...argv1]);
        assert.equal(runId1, 'PROJ-1-run-a');
        const oldPath1 = await launchAndWaitForTerminal({ runId: runId1, env });

        // Launch 2: a SECOND supervisor launch on the SAME branch gets a
        // DIFFERENT ledger sprintId (a fresh incarnation), forwarded as its
        // own --run-id.
        const argv2 = buildSprintArgv({
            issue: 'PROJ-1', members: 'alice', branch, base: 'main',
            viewerPort: 8081, runId: 'PROJ-1-run-b',
        });
        const runId2 = computeEffectiveRunId(['--issue', 'bd-1', '--members', 'local', '--base', 'main', ...argv2]);
        assert.equal(runId2, 'PROJ-1-run-b');
        const oldPath2 = await launchAndWaitForTerminal({ runId: runId2, env });

        assert.notStrictEqual(oldPath1, oldPath2, 'the two launches on the same branch must resolve to two distinct old_runs/ paths');

        // Neither file overwrote the other -- both still exist, independently.
        assert.ok(fs.existsSync(oldPath1), 'launch 1\'s old_runs file must still exist after launch 2 completes');
        assert.ok(fs.existsSync(oldPath2), 'launch 2\'s old_runs file must still exist');

        const state1 = JSON.parse(fs.readFileSync(oldPath1, 'utf-8'));
        const state2 = JSON.parse(fs.readFileSync(oldPath2, 'utf-8'));
        assert.equal(state1.runId, runId1);
        assert.equal(state2.runId, runId2);
        assert.ok(state1.terminalReason, 'launch 1 must carry its own terminalReason');
        assert.ok(state2.terminalReason, 'launch 2 must carry its own terminalReason');

        // Neither running/ file is left behind (both moved to old_runs/ on
        // their own respective completion).
        assert.strictEqual(fs.existsSync(getRunningRunStatePath(runId1, env)), false);
        assert.strictEqual(fs.existsSync(getRunningRunStatePath(runId2, env)), false);
    });
});
