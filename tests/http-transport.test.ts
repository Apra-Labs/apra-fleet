import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { fleetEvents } from '../src/services/event-bus.js';

function noop(_server: McpServer): void {
  // no tools registered in these tests
}

function makeClient(port: number): Client {
  return new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
}

function makeTransport(port: number): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } }
  );
}

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

// ---------------------------------------------------------------------------
// (a) Server binds to 127.0.0.1 only
// ---------------------------------------------------------------------------
describe('(a) server binds to 127.0.0.1', () => {
  it('address is 127.0.0.1', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('url reflects 127.0.0.1', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

// ---------------------------------------------------------------------------
// (b) Two clients connect concurrently with separate sessions
// ---------------------------------------------------------------------------
describe('(b) two concurrent clients get separate sessions', () => {
  it('sessions map has two entries after both clients connect', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const c1 = makeClient(handle.port);
    const c2 = makeClient(handle.port);
    clients.push(c1, c2);

    await Promise.all([
      c1.connect(makeTransport(handle.port)),
      c2.connect(makeTransport(handle.port)),
    ]);

    expect(handle.sessions.size).toBe(2);
    const ids = [...handle.sessions.keys()];
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// (c) Event bus emit reaches BOTH connected clients as logging notifications
// ---------------------------------------------------------------------------
describe('(c) event bus broadcasts to all sessions', () => {
  it('credential:stored reaches both clients', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    // Track GET /mcp requests (standalone SSE streams from clients)
    let sseGetCount = 0;
    handle.httpServer.on('request', (req) => {
      if (req.method === 'GET' && req.url === '/mcp') sseGetCount++;
    });

    const c1 = makeClient(handle.port);
    const c2 = makeClient(handle.port);
    clients.push(c1, c2);

    const received1: unknown[] = [];
    const received2: unknown[] = [];

    c1.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received1.push(n.params.data);
    });
    c2.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received2.push(n.params.data);
    });

    await Promise.all([
      c1.connect(makeTransport(handle.port)),
      c2.connect(makeTransport(handle.port)),
    ]);

    // Wait for both standalone GET SSE streams to be established
    const deadline = Date.now() + 3000;
    while (sseGetCount < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(sseGetCount).toBeGreaterThanOrEqual(2);

    fleetEvents.emit('credential:stored', { name: 'my-cred' });

    // Allow notification to propagate
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect((received1[0] as { event: string }).event).toBe('credential:stored');
    expect((received2[0] as { event: string }).event).toBe('credential:stored');
  });
});

// ---------------------------------------------------------------------------
// (d) Client disconnect removes session from the map
// ---------------------------------------------------------------------------
describe('(d) disconnect removes session', () => {
  it('session is removed when client terminates the session', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const c1 = makeClient(handle.port);
    clients.push(c1);
    const transport = makeTransport(handle.port);

    await c1.connect(transport);
    expect(handle.sessions.size).toBe(1);

    // Terminate the session via DELETE
    await transport.terminateSession();

    // Allow cleanup to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(handle.sessions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) Port fallback: when preferred port is busy, starts on random port
// ---------------------------------------------------------------------------
describe('(e) port fallback when preferred port is busy', () => {
  it('starts on OS-assigned port when preferred port is in use', async () => {
    // Occupy a port to force the fallback
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as net.AddressInfo).port;

    try {
      const handle = await createHttpTransport({ registerTools: noop, preferredPort: busyPort });
      handles.push(handle);

      expect(handle.port).not.toBe(busyPort);
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});
