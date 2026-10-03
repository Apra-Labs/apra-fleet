import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFleetServerConnection, FleetServerUnreachableError } from '../bin/cli.mjs';

// apra-fleet-eft.7.1 -- Plan Part 2.1 TRANSPORT decision: cli.mjs is now the
// supervisor's internal execution vehicle and must never stand up its own
// per-invocation stdio MCP transport. It always attaches to the ALREADY-
// RUNNING fleet singleton over streamable HTTP via resolveFleetServerConnection,
// and fails fast with a typed error when no reachable server is configured
// (never self-spawning as a fallback). See main()'s precondition-validations
// block (bin/cli.mjs) for the wiring these tests pin down.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliSource = fs.readFileSync(path.join(__dirname, '../bin/cli.mjs'), 'utf8');

describe('cli.mjs no longer constructs a StdioTransport (apra-fleet-eft.7.1)', () => {
    test('the module never imports StdioTransport from the client transport module', () => {
        assert.doesNotMatch(cliSource, /import\s*\{[^}]*\bStdioTransport\b[^}]*\}\s*from\s*['"]@apralabs\/apra-fleet-client\/transport['"]/);
    });

    test('the module never constructs `new StdioTransport(...)`', () => {
        assert.doesNotMatch(cliSource, /new\s+StdioTransport\s*\(/);
    });

    // GitHub #585 recovery: the HTTP attach goes through the reconnecting
    // transport, so a server that dies mid-run is re-probed/auto-started.
    test('the module attaches over HTTP through the shared reconnecting transport', () => {
        assert.match(cliSource, /import\s*\{[^}]*\bcreateFleetHttpTransport\b[^}]*\}\s*from\s*['"]@apralabs\/apra-fleet-client\/server-resolution['"]/);
        assert.match(cliSource, /createFleetHttpTransport\s*\(\s*connection\b/);
    });

    test("main()'s precondition block resolves the connection and rejects non-http modes before touching any transport", () => {
        assert.match(cliSource, /resolveFleetServerConnection\(\)/);
        assert.match(cliSource, /connection\.mode !== 'http'/);
    });
});

describe('resolveFleetServerConnection (cli.mjs re-export)', () => {
    test('reports mode "http" and the singleton URL when a healthy fleet server is already running', async () => {
        const result = await resolveFleetServerConnection({
            env: {},
            checkRunningInstance: async () => ({ running: true, url: 'http://127.0.0.1:9451/mcp', pid: 4242 }),
        });
        assert.strictEqual(result.mode, 'http');
        assert.strictEqual(result.url, 'http://127.0.0.1:9451/mcp');
        assert.match(result.reason, /attached to HTTP singleton/);
    });

    // GitHub #585 recovery: a GONE singleton is started (shared, user-level)
    // and attached over HTTP -- never a private stdio server.
    test('gone singleton + no override -> the shared HTTP server is started and attached (never a private stdio server)', async () => {
        let autoStarts = 0;
        const result = await resolveFleetServerConnection({
            env: {},
            dirname: 'anywhere',
            exists: (candidate) => candidate === path.join('anywhere', 'index.js'),
            checkRunningInstance: async () => ({ running: false, state: 'gone' }),
            autoStartFleetServer: async () => { autoStarts++; return { running: true, url: 'http://127.0.0.1:9451/mcp', pid: 77, started: true }; },
        });
        assert.strictEqual(autoStarts, 1);
        assert.strictEqual(result.mode, 'http');
        assert.strictEqual(result.url, 'http://127.0.0.1:9451/mcp');
        assert.match(result.reason, /started it and attached/);
    });

    test('gone singleton + auto-start failure -> the error propagates (no stdio fallback)', async () => {
        await assert.rejects(
            () => resolveFleetServerConnection({
                env: {},
                dirname: 'anywhere',
                exists: () => true,
                checkRunningInstance: async () => ({ running: false, state: 'gone' }),
                autoStartFleetServer: async () => { throw new Error('auto-start limit reached; see fleet-1.log'); },
            }),
            /auto-start limit reached/,
        );
    });

    test('APRA_FLEET_TRANSPORT=http with no reachable singleton throws an explicit, actionable error (no silent stdio fallback)', async () => {
        await assert.rejects(
            () => resolveFleetServerConnection({
                env: { APRA_FLEET_TRANSPORT: 'http' },
                checkRunningInstance: async () => ({ running: false }),
            }),
            (err) => {
                assert.match(err.message, /no healthy apra-fleet HTTP singleton was found/i);
                return true;
            },
        );
    });
});

describe('FleetServerUnreachableError (apra-fleet-eft.7.1 typed error)', () => {
    test('defaults to code FLEET_SERVER_UNREACHABLE and carries details', () => {
        const err = new FleetServerUnreachableError('no reachable server', {
            details: { reason: 'no healthy singleton', mode: 'stdio' },
        });
        assert.strictEqual(err.name, 'FleetServerUnreachableError');
        assert.strictEqual(err.code, 'FLEET_SERVER_UNREACHABLE');
        assert.deepStrictEqual(err.details, { reason: 'no healthy singleton', mode: 'stdio' });
        assert.ok(err instanceof Error);
    });

    test('an explicit code overrides the default', () => {
        const err = new FleetServerUnreachableError('custom', { code: 'CUSTOM_CODE' });
        assert.strictEqual(err.code, 'CUSTOM_CODE');
    });
});
