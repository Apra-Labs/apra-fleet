import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// The dashboard viewer binds loopback unless the caller opts in with `host`.
describe('createDashboardViewer bind address', () => {
    let cwdOriginal;
    let cwdTemp;
    beforeEach(() => {
        cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-loopback-bind-'));
        cwdOriginal = process.cwd();
        process.chdir(cwdTemp);
    });
    afterEach(() => {
        process.chdir(cwdOriginal);
        fs.rmSync(cwdTemp, { recursive: true, force: true });
    });

    async function boundAddress(opts) {
        const wf = new FleetWorkflow({ async executePrompt() { return { content: [{ text: 'ok' }] }; } });
        const server = createDashboardViewer(wf, { port: 0, name: 'Loopback Test', ...opts });
        if (!server.listening) await once(server, 'listening');
        try {
            return server.address().address;
        } finally {
            await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        }
    }

    test('binds 127.0.0.1 by default', async () => {
        assert.equal(await boundAddress({}), '127.0.0.1');
    });

    test('an explicit host option is honoured', async () => {
        assert.equal(await boundAddress({ host: '0.0.0.0' }), '0.0.0.0');
    });
});
