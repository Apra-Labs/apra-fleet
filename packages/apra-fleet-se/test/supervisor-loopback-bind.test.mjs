import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSupervisor, DEFAULT_SERVICE_HOST } from '../src/supervisor/server.mjs';

// The supervisor API is unauthenticated: it binds loopback unless the operator
// explicitly opts in to another interface with the `host` option.

async function startOn(deps) {
    let server;
    const supervisor = createSupervisor({
        port: 0,
        logger: { log() {}, error() {} },
        createServer: (h) => (server = http.createServer(h)),
        ...deps,
    });
    await supervisor.start();
    return { supervisor, server };
}

test('supervisor start() binds 127.0.0.1 by default', async () => {
    const { supervisor, server } = await startOn({});
    try {
        assert.equal(DEFAULT_SERVICE_HOST, '127.0.0.1');
        assert.equal(server.address().address, '127.0.0.1');
    } finally {
        await supervisor.stop();
    }
});

test('an explicit host option is honoured', async () => {
    const { supervisor, server } = await startOn({ host: '0.0.0.0' });
    try {
        assert.equal(server.address().address, '0.0.0.0');
    } finally {
        await supervisor.stop();
    }
});
