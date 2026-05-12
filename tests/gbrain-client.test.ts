import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GbrainClient, _resetGbrainClient, getGbrainClient } from '../src/services/gbrain-client.js';

// Mock the MCP SDK modules
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      { name: 'brain_query' },
      { name: 'brain_write' },
      { name: 'code_callers' },
    ],
  }),
  callTool: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'mock result' }],
  }),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  // Use a class so `new Client(...)` works
  class MockClientClass {
    connect = mockClient.connect;
    close = mockClient.close;
    listTools = mockClient.listTools;
    callTool = mockClient.callTool;
  }
  return { Client: MockClientClass };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransportClass {}
  return { StdioClientTransport: MockTransportClass };
});

describe('GbrainClient', () => {
  let client: GbrainClient;

  beforeEach(() => {
    _resetGbrainClient();
    client = new GbrainClient({ command: 'echo', args: ['test'] });
    // Reset mock implementations to defaults
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.close.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        { name: 'brain_query' },
        { name: 'brain_write' },
        { name: 'code_callers' },
      ],
    });
    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'mock result' }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts disconnected', () => {
    expect(client.isConnected()).toBe(false);
    expect(client.getAvailableTools()).toEqual([]);
  });

  it('connects and lists available tools', async () => {
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(client.getAvailableTools()).toEqual(['brain_query', 'brain_write', 'code_callers']);
  });

  it('does not reconnect if already connected', async () => {
    await client.connect();
    await client.connect(); // second call should be a no-op
    // Each connect() creates a new Client instance, but the second call is a no-op
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects cleanly', async () => {
    await client.connect();
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(client.getAvailableTools()).toEqual([]);
  });

  it('disconnect is a no-op when not connected', async () => {
    await client.disconnect();
    expect(mockClient.close).not.toHaveBeenCalled();
  });

  it('callTool returns text content', async () => {
    await client.connect();
    const result = await client.callTool('brain_query', { query: 'test' });
    expect(result).toBe('mock result');
  });

  it('callTool lazy-connects if not connected', async () => {
    // Don't call connect() — callTool should do it
    const result = await client.callTool('brain_query', { query: 'test' });
    expect(result).toBe('mock result');
    expect(client.isConnected()).toBe(true);
  });

  it('callTool throws on gbrain error result', async () => {
    mockClient.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'something went wrong' }],
    });
    await client.connect();
    await expect(client.callTool('brain_query', {})).rejects.toThrow(
      "gbrain tool 'brain_query' returned error: something went wrong"
    );
  });

  it('callTool marks connection as stale on unexpected error', async () => {
    mockClient.callTool.mockRejectedValueOnce(new Error('connection reset'));
    await client.connect();
    await expect(client.callTool('brain_query', {})).rejects.toThrow('connection may have dropped');
    expect(client.isConnected()).toBe(false);
  });

  it('callTool throws clear error when connect fails', async () => {
    mockClient.connect.mockRejectedValueOnce(new Error('spawn ENOENT'));
    const freshClient = new GbrainClient({ command: 'nonexistent' });
    await expect(freshClient.callTool('brain_query', {})).rejects.toThrow(
      'gbrain is not available'
    );
  });

  it('getAvailableTools returns a copy', async () => {
    await client.connect();
    const tools = client.getAvailableTools();
    tools.push('hacked');
    expect(client.getAvailableTools()).not.toContain('hacked');
  });
});

describe('getGbrainClient singleton', () => {
  beforeEach(() => _resetGbrainClient());

  it('returns the same instance on repeated calls', () => {
    const a = getGbrainClient();
    const b = getGbrainClient();
    expect(a).toBe(b);
  });

  it('returns a new instance after reset', () => {
    const a = getGbrainClient();
    _resetGbrainClient();
    const b = getGbrainClient();
    expect(a).not.toBe(b);
  });
});
