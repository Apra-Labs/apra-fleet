import { describe, it, expect, vi, beforeEach } from 'vitest';

// A gitnexus child that dies during connect (a crash-on-start gitnexus build)
// is retired before any call can use it. acquireGitNexusEntry skips retired
// children; without a bound it re-spawned npx forever and the code_* call
// never returned. It now gives up after a few attempts and the call fails
// loudly with the offline result.
//
// FALSIFICATION: removing the attempt bound in acquireGitNexusEntry makes the
// first test hang until the vitest timeout (children spawn without end).
//
// Isolation: the MCP Client and stdio transport are mocks (no process is
// spawned) and index readiness is injected, so nothing touches disk.

const h = vi.hoisted(() => ({ spawned: 0, closed: 0, dieOnConnect: true }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    onclose?: () => void;
    onerror?: () => void;
    constructor() { h.spawned += 1; }
    connect = vi.fn(async () => {
      // The child writes to stderr (delivered on a later tick) and exits right
      // after the handshake: the client reports close.
      await new Promise((resolve) => setImmediate(resolve));
      if (h.dieOnConnect) this.onclose?.();
    });
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'answer' }] }));
    close = vi.fn(async () => { h.closed += 1; });
  }
  return { Client: MockClient };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { PassThrough } = await import('node:stream');
  class MockTransport {
    onclose?: () => void;
    onerror?: () => void;
    stderr = new PassThrough();
    constructor() { this.stderr.write('gitnexus crashed on start: spawn npx ENOENT in C:\\cache\\_npx\\4f55926e'); }
  }
  return { StdioClientTransport: MockTransport };
});
vi.mock('../src/utils/find-on-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/find-on-path.js')>();
  return { ...actual, npxUnavailableReason: () => null };
});

import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';
import { missingOnServerPathMessage } from '../src/utils/find-on-path.js';

describe('acquireGitNexusEntry is bounded when every child dies on start', () => {
  beforeEach(() => {
    h.spawned = 0;
    h.closed = 0;
  });

  it('gives up after 3 retired children and returns the offline result naming the cause', async () => {
    h.dieOnConnect = true;
    const provider = new GitNexusProvider();
    const result = await provider.query({ query: 'x' }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Code intelligence is offline/);
    expect(result.content[0].text).toMatch(/retired 3 times in a row/);
    expect(result.content[0].text).toMatch(/child stderr: gitnexus crashed on start/);
    // ENOENT and an _npx path in child stderr do not mean npx is missing from PATH.
    expect(result.content[0].text).not.toContain(missingOnServerPathMessage('npx'));
    expect(h.spawned).toBe(3);
    expect(h.closed).toBe(3);
  });

  it('a healthy child after the failures is used normally', async () => {
    h.dieOnConnect = false;
    const provider = new GitNexusProvider();
    const result = await provider.query({ query: 'x' }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('answer');
  });
});
