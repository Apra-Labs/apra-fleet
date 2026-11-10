import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';
import { defaultHasTerminalState, defaultRecordFinished } from '../src/supervisor/watchdog.mjs';
import { renderResultExtrasHtml } from '../fleet-sprint/viewer-extensions.mjs';
import {
    runDevelopLoopScenario,
    withScenarioMarkers,
    defaultMockCallTool,
} from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// A PR skipped for an unrecoverable VCS auth failure must show in the final
// run result (persisted verbatim by the engine as state.result, which the
// supervisor serves for a finished run) and in the final summary log line,
// while the computed verdict stays PASS. A successful PR shows no marker.
// The terminal status is 'success-with-warnings' (never plain 'success') and
// the supervisor API read-back of the persisted terminal state exposes it.

/** Persist `result` as the sprint's terminal run-state and read it back via GET /api/sprints/:id. */
async function readBackThroughSupervisor(sprintId, result) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prskip-api-'));
    try {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dir };
        const statePath = getTerminalRunStatePath(sprintId, env);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ sprintId, status: 'success', result }));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        await ledger.claim(sprintId, { members: ['a'], issueRoots: ['R'], childPid: 42, branch: 'feat/x' });
        const controller = createSprintController({
            ledger, history, spawner: { spawnSprint: async () => { throw new Error('unused'); } }, listMembers: () => ({}), getBacklog: () => ({}),
            hasTerminalState: (id, branch) => defaultHasTerminalState(id, branch, env),
        });
        return await controller.getSprint(sprintId);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

/**
 * Steady state: the watchdog has recorded FINISHED and released the ledger
 * reservation, so GET /api/sprints/:id falls through to the history path.
 */
async function readBackAfterReservationReleased(sprintId, result) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prskip-hist-'));
    try {
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        await ledger.claim(sprintId, { members: ['a'], issueRoots: ['R'], childPid: 42, branch: 'feat/x' });
        defaultRecordFinished({ sprintId, state: { sprintId, status: 'success', result }, logger: { log() {} }, history });
        await history.stop(); // drains the async record() chain
        await ledger.release(sprintId);
        const controller = createSprintController({
            ledger, history, spawner: { spawnSprint: async () => { throw new Error('unused'); } }, listMembers: () => ({}), getBacklog: () => ({}),
            hasTerminalState: () => null,
        });
        return await controller.getSprint(sprintId);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

const callToolFactory = (executeCommand) => {
    const base = defaultMockCallTool({ executeCommand });
    return async (name, args) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${args.provider} credentials deployed on "${args.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        if (name === 'child_id_allocator') {
            return { content: [{ text: JSON.stringify(args && args.action === 'allocate' ? { childId: null, token: null } : { confirmed: true, released: true }) }] };
        }
        if (name === 'dolt_push_mutex') {
            return { content: [{ text: JSON.stringify(args && args.action === 'acquire' ? { granted: true, token: 'mock-mutex' } : { released: true }) }] };
        }
        return base(name, args);
    };
};

test('persistent 401 on PR create: result carries prSkipped, summary line says so, verdict stays PASS', { timeout: scaledTimeout(180000, { concurrency: 8 }) }, async () => {
    await withScenarioMarkers('prauthskip', async () => {
        const run = await runDevelopLoopScenario('prauthskip', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR auth-skip status fixture' }],
            maxCycles: 1,
            callToolFactory,
            prCurlResponseQueue: [{ status: 401, body: { message: 'Bad credentials' } }],
        });
        assert.ok(!run.error, `should not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS');
        assert.equal(run.result.status, 'success-with-warnings');
        assert.ok(run.result.warnings.some((w) => /PR not opened: VCS auth failure/.test(w) && /auth-failure/.test(w)), JSON.stringify(run.result.warnings));
        assert.equal(run.result.pushed, true);
        assert.equal(run.result.prSkipped.reason, 'auth-failure');
        assert.match(run.result.prSkipped.message, /PR not opened: VCS auth failure/);
        const summary = run.logs.find((l) => l.startsWith('[Sprint Summary]'));
        assert.ok(summary && summary.includes('PASS') && summary.includes('PR not opened: VCS auth failure'), JSON.stringify(run.logs.filter((l) => /Summary|Skipped/.test(l))));
        assert.ok(/^[\x20-\x7e]*$/.test(summary), 'summary line must be ASCII');

        // Supervisor API read-back of the persisted terminal state.
        const api = await readBackThroughSupervisor('s-prauthskip', run.result);
        assert.equal(api.terminal, true);
        assert.equal(api.resultStatus, 'success-with-warnings');
        assert.ok(api.warnings.some((w) => /PR not opened: VCS auth failure/.test(w) && /auth-failure/.test(w)), JSON.stringify(api));
        assert.equal(api.state.result.prSkipped.reason, 'auth-failure');

        // After the watchdog releases the reservation, the history path must still expose it.
        const hist = await readBackAfterReservationReleased('s-prauthskip-h', run.result);
        assert.equal(hist.live, false);
        assert.equal(hist.resultStatus, 'success-with-warnings');
        assert.ok(hist.warnings.some((w) => /PR not opened: VCS auth failure/.test(w) && /auth-failure/.test(w)), JSON.stringify(hist));

        // Dashboard/viewer result strip shows a warning badge, not just a PASS badge.
        assert.match(renderResultExtrasHtml(run.result), /WARNING: PR not opened: VCS auth failure/);
    });
});

test('successful PR create: no prSkipped marker and no skip summary line', { timeout: scaledTimeout(180000, { concurrency: 8 }) }, async () => {
    await withScenarioMarkers('prnoskip', async () => {
        const run = await runDevelopLoopScenario('prnoskip', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR no-skip status fixture' }],
            maxCycles: 1,
            callToolFactory,
            prCurlResponseQueue: [{ status: 201, body: { number: 7, html_url: 'https://github.com/mock-org/mock-repo/pull/7' } }],
        });
        assert.ok(!run.error, `should not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS');
        assert.equal(run.result.status, 'success');
        assert.ok(!('warnings' in run.result), JSON.stringify(run.result));
        assert.ok(!('prSkipped' in run.result), JSON.stringify(run.result));
        const api = await readBackThroughSupervisor('s-prnoskip', run.result);
        assert.equal(api.resultStatus, 'success');
        assert.ok(!('warnings' in api), JSON.stringify(api));
        const hist = await readBackAfterReservationReleased('s-prnoskip-h', run.result);
        assert.equal(hist.resultStatus, 'success');
        assert.ok(!('warnings' in hist), JSON.stringify(hist));
        assert.ok(!/WARNING/.test(renderResultExtrasHtml(run.result)));
        assert.ok(!run.logs.some((l) => l.startsWith('[Sprint Summary]')));
    });
});
