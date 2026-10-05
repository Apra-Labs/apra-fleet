import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { findGitWorkingTreeRoot } from '../src/viewer/debounced-writer.mjs';

// Regression coverage for my-beads-db-qy8.9.4: the crash-net snapshot in
// src/viewer/index.mjs (persistState(), default `workflow-logs` dir,
// resolved under process.cwd() when opts.stateSnapshotDir is not given)
// once wrote an untracked file straight into this package's own checkout
// (packages/apra-fleet-workflow/workflow-logs/run_194229.json, swept into a
// commit by a broad `git add`). These tests pin the product-level fix
// (persistState() refuses the DEFAULT path when it resolves inside a git
// working tree) rather than relying only on every test file remembering to
// chdir away -- a regression here must fail loudly instead of silently
// reintroducing the leak.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

async function withServer(server, fn) {
    if (!server.listening) {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    }
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
}

describe('my-beads-db-qy8.9.4: findGitWorkingTreeRoot()', () => {
    test('returns null for a fresh scratch directory with no .git ancestor', () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-git-guard-scratch-'));
        try {
            // os.tmpdir() must itself not be inside a git working tree for this
            // assertion to be meaningful -- true on every CI/dev box this suite
            // targets (tmp is never a repo checkout).
            assert.strictEqual(findGitWorkingTreeRoot(scratch), null);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('finds a `.git` directory ancestor several levels up', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-git-guard-root-'));
        try {
            fs.mkdirSync(path.join(root, '.git'));
            const nested = path.join(root, 'a', 'b', 'c');
            fs.mkdirSync(nested, { recursive: true });
            assert.strictEqual(findGitWorkingTreeRoot(nested), root);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('finds a `.git` FILE ancestor (linked worktree layout)', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-git-guard-worktree-'));
        try {
            fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/else\n');
            const nested = path.join(root, 'sub');
            fs.mkdirSync(nested);
            assert.strictEqual(findGitWorkingTreeRoot(nested), root);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('my-beads-db-qy8.9.4: persistState() refuses the default snapshot path inside a git working tree', () => {
    test('a fake repo checkout as cwd: no workflow-logs/ file is written, and an explicit override still works', async () => {
        const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-git-guard-fakerepo-'));
        const originalCwd = process.cwd();
        try {
            fs.mkdirSync(path.join(fakeRepo, '.git'));
            process.chdir(fakeRepo);

            // Default path (no opts.stateSnapshotDir): must be refused.
            const wf1 = new FleetWorkflow(createMockFleetApi());
            const engine1 = new WorkflowEngine(wf1);
            const server1 = createDashboardViewer(wf1, { port: 0, name: 'Git Guard Default Test', debounceMs: 200 });
            await withServer(server1, async () => {
                await engine1.executeFile(fixture('test-end-event-success.mjs'), {});
            });
            assert.strictEqual(
                fs.existsSync(path.join(fakeRepo, 'workflow-logs')),
                false,
                'the default workflow-logs/ snapshot dir must never be created inside a git working tree'
            );

            // Explicit override: still a deliberate choice, must still work,
            // even though cwd resolves inside the same fake repo -- this is
            // exactly apra-fleet-se's real production `sprint-logs` usage,
            // which intentionally writes into the user's own target repo.
            const wf2 = new FleetWorkflow(createMockFleetApi());
            const engine2 = new WorkflowEngine(wf2);
            const server2 = createDashboardViewer(wf2, {
                port: 0,
                name: 'Git Guard Override Test',
                debounceMs: 200,
                stateSnapshotDir: 'sprint-logs',
                stateSnapshotPrefix: 'sprint_'
            });
            await withServer(server2, async () => {
                await engine2.executeFile(fixture('test-end-event-success.mjs'), {});
            });
            const overrideDir = path.join(fakeRepo, 'sprint-logs');
            const files = fs.existsSync(overrideDir)
                ? fs.readdirSync(overrideDir).filter((f) => /^sprint_\d{6}\.json$/.test(f))
                : [];
            assert.strictEqual(files.length, 1, 'an explicit stateSnapshotDir must still be honored inside a git working tree');
        } finally {
            process.chdir(originalCwd);
            fs.rmSync(fakeRepo, { recursive: true, force: true });
        }
    });
});

describe('my-beads-db-qy8.9.4: this package\'s own checkout is never written to', () => {
    test('ending a run with cwd still at this package\'s own root leaves <root>/workflow-logs/ untouched', async () => {
        // No chdir here at all -- process.cwd() is whatever `node --test`
        // started with, which for this package (run directly or via the
        // root npm test -> npm test --workspace=... chain) is this
        // package's own directory, itself inside the apra-fleet git working
        // tree. This is the literal failure mode the leaked
        // workflow-logs/run_194229.json came from: reproduce it exactly,
        // with no test-side chdir to save us, and assert the product-level
        // guard (not test hygiene) is what prevents the write.
        const leakDir = path.join(process.cwd(), 'workflow-logs');
        const before = fs.existsSync(leakDir) ? fs.readdirSync(leakDir) : null;

        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, { port: 0, name: 'Own Checkout Guard Test', debounceMs: 200 });
        await withServer(server, async () => {
            await engine.executeFile(fixture('test-end-event-success.mjs'), {});
        });

        const after = fs.existsSync(leakDir) ? fs.readdirSync(leakDir) : null;
        assert.deepStrictEqual(
            after,
            before,
            `no new file may appear under ${leakDir} -- it must not have been created/modified by this run`
        );
    });
});
