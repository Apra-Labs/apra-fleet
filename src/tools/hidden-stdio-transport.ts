// MCP stdio client transport whose server child never opens a console window
// on Windows.
//
// The SDK's StdioClientTransport (1.27.x) spawns with
// `windowsHide: process.platform === 'win32' && isElectron()` -- i.e. NOT
// hidden under plain Node. When the apra-fleet server runs without a console
// (detached by `apra-fleet start`), the `npx gitnexus mcp` /
// `codebase-memory-mcp` child then gets its own visible console window that
// stays up (and can steal focus) for the client's whole lifetime.
//
// win32: start() mirrors the SDK's start() line for line (same cross-spawn,
// env, stdio, handlers) with windowsHide: true. Every other platform calls
// the SDK's own start() unchanged, and send()/close()/stderr/pid are always
// the SDK's -- so POSIX behaviour is exactly the SDK's.
import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';

type SpawnFn = typeof crossSpawn;

/** SDK internals this subclass drives (private in the .d.ts, plain fields at runtime). */
interface SdkStdioInternals {
  _process?: ChildProcess;
  _serverParams: StdioServerParameters;
  _readBuffer: { append(chunk: Buffer): void };
  _stderrStream: NodeJS.WritableStream | null;
  processReadBuffer(): void;
}

export class HiddenStdioClientTransport extends StdioClientTransport {
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;

  constructor(server: StdioServerParameters, opts: { platform?: NodeJS.Platform; spawn?: SpawnFn } = {}) {
    super(server);
    this.platform = opts.platform ?? process.platform;
    this.spawnFn = opts.spawn ?? crossSpawn;
  }

  async start(): Promise<void> {
    if (this.platform !== 'win32') return super.start();
    const self = this as unknown as SdkStdioInternals;
    if (self._process) {
      throw new Error('StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.');
    }
    const params = self._serverParams;
    return new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(params.command, params.args ?? [], {
        env: { ...getDefaultEnvironment(), ...params.env },
        stdio: ['pipe', 'pipe', params.stderr ?? 'inherit'],
        shell: false,
        windowsHide: true,
        cwd: params.cwd,
      });
      self._process = child;
      child.on('error', (error: Error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on('spawn', () => resolve());
      child.on('close', () => {
        self._process = undefined;
        this.onclose?.();
      });
      child.stdin?.on('error', (error: Error) => this.onerror?.(error));
      child.stdout?.on('data', (chunk: Buffer) => {
        self._readBuffer.append(chunk);
        self.processReadBuffer();
      });
      child.stdout?.on('error', (error: Error) => this.onerror?.(error));
      if (self._stderrStream && child.stderr) child.stderr.pipe(self._stderrStream);
    });
  }
}

/**
 * The stdio transport for an MCP server child: the SDK's own class off
 * Windows (unchanged behaviour), the hidden variant on win32.
 */
export function createStdioClientTransport(
  server: StdioServerParameters,
  platform: NodeJS.Platform = process.platform,
): StdioClientTransport {
  return platform === 'win32' ? new HiddenStdioClientTransport(server, { platform }) : new StdioClientTransport(server);
}
