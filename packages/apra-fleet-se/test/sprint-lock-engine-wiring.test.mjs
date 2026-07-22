import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { acquireSprintLock, SprintLockHeldError } from '../auto-sprint/sprint-lock.mjs';

// apra-fleet-eft.75.2: proves the REAL wiring in runner.js's main() -- not
// just the standalone pidfile module (see sprint-lock.test.mjs) -- actually
// acquires the machine-local sprint lock (keyed on the run's own
// branch+members, derived via validateArgs()) before any dispatch, holds it
// for the duration of the run, and releases it once the run settles. Uses
// APRA_FLEET_SPRINT_LOCK_DIR to point the lock at an isolated throwaway
// directory so this test can neither collide with, nor be affected by, a
// real sprint's lock files or any other test in this suite.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_SCRIPT_PATH = path.join(__dirname, '../auto-sprint/runner.js');

function mockCmdResult(code, stdout, stderr = '') {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    const output = parts.join('\n') || '(no output)';
    return {
        content: [{ text: `Exit code: ${code}\n${output}` }],
        structuredContent: { exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' },
    };
}

/**
 * A minimal fleetApi that drives a full (single-cycle, no-op-work) sprint to
 * completion, with an optional `onFirstCommand` hook fired exactly once, on
 * the very FIRST executeCommand call -- i.e. the earliest observable
 * dispatch, which happens strictly AFTER main()'s sprint-lock acquisition
 * (the lock is acquired before any dispatch at all). Awaiting a
 * caller-controlled gate there lets a test pause the run mid-flight to
 * prove the lock is held for its whole duration.
 */
function buildGatedFleetApi({ onFirstCommand } = {}) {
    let fired = false;
    const commandLog = [];
    const ONE_BEAD_JSON = '[{"id":"bd-1-child","parent":"bd-1","status":"open","title":"Task"}]';
    return {
        executeCommand: async (opts) => {
            commandLog.push(opts.command);
            if (!fired) {
                fired = true;
                if (onFirstCommand) await onFirstCommand();
            }
            if (/^bd list --all --limit 0 --json$/.test(opts.command)) {
                return mockCmdResult(0, ONE_BEAD_JSON);
            }
            if (/^bd list .*--ready/.test(opts.command)) {
                // apra-fleet-eft.6.7 (mirrored from runner-arg-contract.test.mjs's
                // spy): the first TWO ready-list calls return one bead so the
                // sprint can proceed past pre-sprint validation; later calls
                // return none so the develop/cycle loops terminate immediately.
                const readyCallsSoFar = commandLog.filter((c) => /^bd list .*--ready/.test(c)).length;
                return mockCmdResult(0, readyCallsSoFar > 2 ? '[]' : ONE_BEAD_JSON);
            }
            if (/^bd list --json --limit 0$/.test(opts.command)) {
                return mockCmdResult(0, ONE_BEAD_JSON);
            }
            if (/^bd list /.test(opts.command)) {
                return mockCmdResult(0, '[]');
            }
            if (/^git remote get-url origin\b/.test(opts.command)) {
                return mockCmdResult(0, 'https://github.com/mock-org/mock-repo.git');
            }
            return mockCmdResult(0, '');
        },
        // Schema-valid canned verdicts per agent role (mirrored from
        // runner-arg-contract.test.mjs's buildSpyFleetApi) -- a plain 'ok'
        // string is not valid plan-reviewer/reviewer JSON and would reject
        // the plan / stall the cycle loop, which is irrelevant noise for
        // what this test actually verifies (the lock's acquire/hold/release
        // lifecycle around the run).
        executePrompt: async (opts) => {
            if (opts.agent === 'plan-reviewer') {
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', taskAssignments: [] }) }] };
            }
            if (opts.agent === 'reviewer') {
                if (opts.prompt.startsWith('Final review for sprint scope issue id(s):')) {
                    return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Looks good.' }) }] };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] };
            }
            if (opts.agent === 'harvester') {
                return { content: [{ text: JSON.stringify({ status: 'OK', notes: 'Harvested.' }) }] };
            }
            return { content: [{ text: 'ok' }] };
        },
    };
}

async function runGatedSprint({ branch, members, lockDir, onFirstCommand }) {
    const priorLockDir = process.env.APRA_FLEET_SPRINT_LOCK_DIR;
    process.env.APRA_FLEET_SPRINT_LOCK_DIR = lockDir;
    try {
        const fleetApi = buildGatedFleetApi({ onFirstCommand });
        const workflow = new FleetWorkflow(fleetApi);
        const engine = new WorkflowEngine(workflow);
        return await engine.executeFile(RUNNER_SCRIPT_PATH, {
            target_issue: 'bd-1',
            members,
            branch,
            base_branch: 'main',
            max_cycles: 1,
        }, true);
    } finally {
        if (priorLockDir === undefined) delete process.env.APRA_FLEET_SPRINT_LOCK_DIR;
        else process.env.APRA_FLEET_SPRINT_LOCK_DIR = priorLockDir;
    }
}

describe('runner.js main(): sprint-lock wiring (apra-fleet-eft.75.2)', () => {
    test('a duplicate engine start for the SAME branch+members while the first is still running fails fast with SprintLockHeldError, and the lock is released once the first run settles', async () => {
        const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-wiring-'));
        const branch = 'auto-sprint/lock-wiring-dup';
        const members = ['local'];

        let releaseGate;
        const gate = new Promise((resolve) => { releaseGate = resolve; });

        const firstRunPromise = runGatedSprint({
            branch, members, lockDir,
            onFirstCommand: () => gate,
        });

        // Poll for the lock file to appear -- proves main() acquired it
        // before/at the very first dispatch, exactly as designed (the lock
        // acquire call precedes runSprintCycle() entirely).
        const files = () => fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
        const deadline = Date.now() + 5000;
        while (files().length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(files().length, 1, 'expected exactly one lock file while the first run is in flight');

        // A second acquire attempt for the EXACT same (branch, members),
        // against the same lockDir, while the first run still holds it:
        // must fail fast with the distinct named error, never silently
        // proceed.
        assert.throws(
            () => acquireSprintLock({ branch, members, lockDir }),
            (err) => err instanceof SprintLockHeldError && err.code === 'SPRINT_LOCK_HELD',
        );

        // Let the first (gated) run proceed and finish.
        releaseGate();
        await firstRunPromise;

        // The lock must be released now that the run has settled -- a fresh
        // acquire for the identical (branch, members) succeeds cleanly, with
        // no false block left behind.
        assert.equal(files().length, 0, 'expected the lock file to be removed once the first run completed');
        const postLock = acquireSprintLock({ branch, members, lockDir });
        postLock.release();
    });

    test('an invalid branch name is rejected before any lock is ever created (zero dispatches, zero lock files)', async () => {
        const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-wiring-invalid-'));
        const priorLockDir = process.env.APRA_FLEET_SPRINT_LOCK_DIR;
        process.env.APRA_FLEET_SPRINT_LOCK_DIR = lockDir;
        try {
            const fleetApi = buildGatedFleetApi();
            const workflow = new FleetWorkflow(fleetApi);
            const engine = new WorkflowEngine(workflow);
            await assert.rejects(
                () => engine.executeFile(RUNNER_SCRIPT_PATH, {
                    target_issue: 'bd-1',
                    members: ['local'],
                    branch: 'sprint; rm -rf ~',
                    base_branch: 'main',
                }, true),
                /Invalid branch/,
            );
        } finally {
            if (priorLockDir === undefined) delete process.env.APRA_FLEET_SPRINT_LOCK_DIR;
            else process.env.APRA_FLEET_SPRINT_LOCK_DIR = priorLockDir;
        }
        assert.equal(fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock')).length, 0);
    });
});
