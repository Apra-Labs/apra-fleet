import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HiddenStdioClientTransport, createStdioClientTransport } from '../src/tools/hidden-stdio-transport.js';

// The MCP server child (npx gitnexus mcp / codebase-memory-mcp) must not open a
// console window on Windows; every other platform must keep the SDK's exact
// transport.

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  return child;
}

const PARAMS = { command: 'npx', args: ['-y', 'gitnexus', 'mcp'], stderr: 'pipe' as const };

afterEach(() => vi.restoreAllMocks());

describe('createStdioClientTransport', () => {
  it.each(['linux', 'darwin'] as const)('%s: returns the SDK StdioClientTransport itself (behaviour unchanged)', (platform) => {
    const t = createStdioClientTransport(PARAMS, platform);
    expect(Object.getPrototypeOf(t)).toBe(StdioClientTransport.prototype);
  });

  it('win32: returns the hidden variant', () => {
    expect(createStdioClientTransport(PARAMS, 'win32')).toBeInstanceOf(HiddenStdioClientTransport);
  });
});

describe('HiddenStdioClientTransport', () => {
  it('win32: spawns the server child with windowsHide and the SDK spawn options, and wires stdio', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const t = new HiddenStdioClientTransport(PARAMS, { platform: 'win32', spawn: spawn as never });
    const messages: unknown[] = [];
    let closed = false;
    t.onmessage = (m) => messages.push(m);
    t.onclose = () => { closed = true; };

    const started = t.start();
    child.emit('spawn');
    await started;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('npx');
    expect(args).toEqual(['-y', 'gitnexus', 'mcp']);
    expect(opts).toMatchObject({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(t.pid).toBe(4242);

    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);

    const written: string[] = [];
    child.stdin.on('data', (c) => written.push(String(c)));
    await t.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(written.join('')).toBe('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');

    child.emit('close', 0);
    expect(closed).toBe(true);
  });

  it('win32: a spawn error rejects start()', async () => {
    const child = fakeChild();
    const t = new HiddenStdioClientTransport(PARAMS, { platform: 'win32', spawn: (() => child) as never });
    const started = t.start();
    child.emit('error', new Error('spawn npx ENOENT'));
    await expect(started).rejects.toThrow('ENOENT');
  });

  it.each(['linux', 'darwin'] as const)('%s: start() is the SDK start(), the injected spawn is never used', async (platform) => {
    const sdkStart = vi.spyOn(StdioClientTransport.prototype, 'start').mockResolvedValue(undefined);
    const spawn = vi.fn();
    const t = new HiddenStdioClientTransport(PARAMS, { platform, spawn: spawn as never });
    await t.start();
    expect(sdkStart).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });
});
