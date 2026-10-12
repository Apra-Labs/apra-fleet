// apra-fleet-hap8.2 -- a REAL sprint child resolves and runs `bd` when the
// recorded node and the recorded bd live in DIFFERENT directories and neither
// is on the PATH the child would otherwise inherit.
//
// Real child spawn => registered in test/helpers/serial-process-suites.mjs.
// POSIX only: the stub bd is a `#!/usr/bin/env node` script (the npm shape);
// the win32 equivalent (a bd.cmd next to the recorded path) is covered by the
// unit-level PATH assertions in test/spawner.test.mjs, so this case is skipped
// there with that reason.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSpawner } from '../src/supervisor/spawner.mjs';
import { buildRecordedNode } from './helpers/recorded-node-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'fixtures/spawner/run-bd-version.mjs');
const isWin = process.platform === 'win32';

const tmpDirs = [];
const pids = new Set();
after(() => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function waitForLog(logPath, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let text = '';
        try { text = fs.readFileSync(logPath, 'utf-8'); } catch { /* not created yet */ }
        if (/BD (OK|FAILED)/.test(text)) return text;
        if (Date.now() > deadline) throw new Error(`timed out waiting for the child's bd result; log so far: ${JSON.stringify(text)}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe('apra-fleet-hap8: sprint child resolves bd from the recorded bd directory', () => {
    test('node in dir A, bd in dir B, neither on the inherited PATH: the child runs bd --version', { skip: isWin ? 'POSIX real-process case (stub bd is a node-shebang script); win32 PATH composition is asserted in test/spawner.test.mjs' : false }, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hap8-'));
        tmpDirs.push(root);
        // dir A: a runnable node literally named `node` (what bd's shebang looks up).
        const nodeDir = path.join(root, 'node-dir');
        fs.mkdirSync(nodeDir);
        const recordedNode = buildRecordedNode(nodeDir, { name: 'node' });
        // dir B: the stub bd, a node-shebang script, in a DIFFERENT directory.
        const bdDir = path.join(root, 'npm-prefix', 'bin');
        fs.mkdirSync(bdDir, { recursive: true });
        const bdPath = path.join(bdDir, 'bd');
        fs.writeFileSync(bdPath, '#!/usr/bin/env node\nconsole.log("bd version 9.9.9 (stub)");\n', { mode: 0o755 });
        assert.notEqual(path.dirname(recordedNode), path.dirname(bdPath));

        const dataDir = path.join(root, 'data');
        fs.mkdirSync(dataDir);
        const spawner = createSpawner({
            command: recordedNode,
            cliPath: CHILD,
            configuredNodePath: recordedNode,
            configuredBdPath: bdPath,
            // A PATH holding neither directory (only a dir that has `env`'s
            // absolute /usr/bin/env reachable via the shebang's own path).
            env: { PATH: path.join(root, 'empty') },
            basePort: 19500 + Math.floor(Math.random() * 200),
            dataDir,
            logger: { log() {}, error() {} },
        });
        const { pid, logPath } = await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });
        pids.add(pid);

        const log = await waitForLog(logPath);
        assert.match(log, /BD OK bd version 9\.9\.9 \(stub\)/, `the child could not run bd: ${log}`);
    });
});
