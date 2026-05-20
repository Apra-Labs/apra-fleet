/**
 * Transport integration tests (Task 9 / PLAN.md Phase 3).
 * Six end-to-end scenarios covering the full HTTP transport path and
 * Gemini client compatibility.
 *
 * Tests (a)-(e) exercise the HTTP singleton path; test (d) exercises stdio
 * via an in-process InMemoryTransport pair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { serverVersion } from '../src/version.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try { await client.close(); } catch { /* ignore */ }
  }
  fleetEvents.removeAllListeners();
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* ignore */ }
  }
});

function registerVersionTool(server: McpServer): void {
  server.tool(
    'version',
    'Returns the installed apra-fleet server version',
    z.object({}).shape,
    async () => ({
      content: [{ type: 'text' as const, text: `apra-fleet ${serverVersion}` }],
    })
  );
}

function makeHttpClient(port: number): Client {
  return new Client({ name: 'integration-test-client', version: '1.0.0' }, { capabilities: {} });
}

function makeHttpTransport(port: number): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 100,
        initialReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// (a) HTTP server with tools registered: client can call the version tool
// ---------------------------------------------------------------------------
describe('(a) HTTP server tool call end-to-end', () => {
  it('client connects via StreamableHTTP and calls the version tool', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    const client = makeHttpClient(handle.port);
    clients.push(client);
    await client.connect(makeHttpTransport(handle.port));

    const result = await client.callTool({ name: 'version', arguments: {} });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('apra-fleet');
  });
});

// ---------------------------------------------------------------------------
// (b) credential:stored event reaches connected client as notifications/message
// ---------------------------------------------------------------------------
describe('(b) event bus -> notification/message broadcast', () => {
  it('client receives notifications/message when credential:stored is emitted', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    const client = makeHttpClient(handle.port);
    clients.push(client);

    const received: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received.push(n.params.data);
    });

    await client.connect(makeHttpTransport(handle.port));

    // Wait for SSE stream to be established (GET /mcp)
    await new Promise(resolve => setTimeout(resolve, 200));

    fleetEvents.emit('credential:stored', { name: 'test-cred' });

    // Allow notification to propagate
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(received).toHaveLength(1);
    const payload = received[0] as { event: string; name: string };
    expect(payload.event).toBe('credential:stored');
    expect(payload.name).toBe('test-cred');
  });
});

// ---------------------------------------------------------------------------
// (c) Two concurrent clients both receive the notification
// ---------------------------------------------------------------------------
describe('(c) broadcast to multiple concurrent clients', () => {
  it('both clients receive notifications/message on credential:stored', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    // Track SSE GET requests so we know when both streams are open
    let sseGetCount = 0;
    handle.httpServer.on('request', (req) => {
      if (req.method === 'GET' && req.url === '/mcp') sseGetCount++;
    });

    const c1 = makeHttpClient(handle.port);
    const c2 = makeHttpClient(handle.port);
    clients.push(c1, c2);

    const received1: unknown[] = [];
    const received2: unknown[] = [];
    c1.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { received1.push(n.params.data); });
    c2.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { received2.push(n.params.data); });

    await Promise.all([
      c1.connect(makeHttpTransport(handle.port)),
      c2.connect(makeHttpTransport(handle.port)),
    ]);

    // Wait for both SSE streams to open
    const deadline = Date.now() + 3000;
    while (sseGetCount < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(sseGetCount).toBeGreaterThanOrEqual(2);

    fleetEvents.emit('credential:stored', { name: 'shared-cred' });

    await new Promise(resolve => setTimeout(resolve, 300));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect((received1[0] as { event: string }).event).toBe('credential:stored');
    expect((received2[0] as { event: string }).event).toBe('credential:stored');
  });
});

// ---------------------------------------------------------------------------
// (d) Stdio regression: tool calls work via in-process InMemoryTransport
// ---------------------------------------------------------------------------
describe('(d) stdio regression via InMemoryTransport', () => {
  it('registers tools and responds to version tool call over in-memory transport', async () => {
    const server = new McpServer(
      { name: 'apra-fleet-test', version: serverVersion },
      { capabilities: { logging: {} } }
    );
    registerVersionTool(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: 'stdio-regression-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name: 'version', arguments: {} });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('apra-fleet');

    await client.close();
    // server closes implicitly when client disconnects
  });
});

// ---------------------------------------------------------------------------
// (e) Server binds to 127.0.0.1 only (not 0.0.0.0)
// ---------------------------------------------------------------------------
describe('(e) localhost-only binding', () => {
  it('HTTP server address is 127.0.0.1', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('server URL reflects 127.0.0.1', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

// ---------------------------------------------------------------------------
// (f) Gemini client compatibility test
//
// Gemini CLI uses StreamableHTTPClientTransport from the MCP SDK to connect
// to MCP servers. This test validates that our StreamableHTTPServerTransport
// is compatible with that client transport — independent of the open Gemini
// bug google-gemini/gemini-cli#5268 (Gemini CLI may not support all
// StreamableHTTP protocol features at the CLI level, but the MCP SDK client
// transport itself is spec-compliant and should work against our server).
//
// If this test fails, it is a fleet-side issue (our server is not spec-
// compliant). If it passes but Gemini CLI still fails in production, the
// failure is Gemini-side (bug #5268 or related).
// ---------------------------------------------------------------------------
describe('(f) Gemini client compatibility', () => {
  it('StreamableHTTPClientTransport can initialize and call a tool (Gemini-compatible path)', async () => {
    const handle = await createHttpTransport({
      registerTools: registerVersionTool,
      preferredPort: 0,
    });
    handles.push(handle);

    // Use the same transport class that Gemini CLI uses
    const geminiClient = new Client(
      { name: 'gemini-compat-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    clients.push(geminiClient);

    await geminiClient.connect(makeHttpTransport(handle.port));

    const result = await geminiClient.callTool({ name: 'version', arguments: {} });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('apra-fleet');

    // Verify tool list is accessible (part of the Gemini initialization handshake)
    const tools = await geminiClient.listTools();
    expect(tools.tools.some(t => t.name === 'version')).toBe(true);
  });
});
