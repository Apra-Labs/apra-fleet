import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Guard against reintroducing undici's default ~300s idle bodyTimeout on
// the streamable-HTTP transport. MCP SSE response streams sit silent for
// the full duration of a long dispatch (observed live: a 675s planner run
// whose POST response stream was idle-killed at ~300s, losing a 16k-token
// result and forcing a full duplicate dispatch -- see
// apra-fleet-se/auto-sprint/docs/stabilization-log.md, Issue 8).
//
// A behavioral test would need to hold a real SSE stream silent for >300s,
// which is not practical in a unit suite; instead this asserts the source
// wiring directly (same approach as apra-fleet-se's dispatch-safety-guard):
// every fetch in StreamableHttpTransport must be undici's own fetch and
// must pass the shared dispatcher whose headers/body timeouts are disabled.
test('StreamableHttpTransport disables undici idle timeouts on every fetch', async () => {
    const srcPath = fileURLToPath(new URL('../src/client/transport.mjs', import.meta.url));
    const src = await readFile(srcPath, 'utf8');

    assert.match(
        src,
        /import\s*\{\s*fetch as undiciFetch\s*,\s*Agent as UndiciAgent\s*\}\s*from\s*'undici'/,
        'transport.mjs must import fetch and Agent from the explicit undici dependency'
    );
    assert.match(
        src,
        /headersTimeout:\s*0/,
        'the shared dispatcher must disable headersTimeout'
    );
    assert.match(
        src,
        /bodyTimeout:\s*0/,
        'the shared dispatcher must disable bodyTimeout (the ~300s idle killer)'
    );

    // No bare global fetch( calls may remain in this file: each one would
    // silently reintroduce the default idle timeouts.
    const bareFetchCalls = src.match(/(?<![\w.])fetch\(/g) || [];
    assert.equal(
        bareFetchCalls.length,
        0,
        `transport.mjs must not call bare global fetch(); found ${bareFetchCalls.length} call(s) -- use undiciFetch with the sseDispatcher`
    );

    const undiciFetchCalls = src.match(/undiciFetch\(/g) || [];
    const dispatcherArgs = src.match(/dispatcher:\s*sseDispatcher/g) || [];
    assert.equal(
        undiciFetchCalls.length,
        dispatcherArgs.length,
        `every undiciFetch call must pass dispatcher: sseDispatcher (${undiciFetchCalls.length} fetches vs ${dispatcherArgs.length} dispatcher args)`
    );
    assert.ok(undiciFetchCalls.length >= 3, 'expected the init POST, persistent GET, and send POST to all use undiciFetch');
});
