import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface GbrainClientOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

const DEFAULT_COMMAND = 'gbrain';
const DEFAULT_ARGS = ['serve'];

let instance: GbrainClient | null = null;

export class GbrainClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private availableTools: string[] = [];
  private connected = false;
  private options: Required<GbrainClientOptions>;

  constructor(options: GbrainClientOptions = {}) {
    this.options = {
      command: options.command ?? process.env.GBRAIN_COMMAND ?? DEFAULT_COMMAND,
      args: options.args ?? (process.env.GBRAIN_ARGS ? process.env.GBRAIN_ARGS.split(' ') : DEFAULT_ARGS),
      env: options.env ?? {},
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: { ...process.env, ...this.options.env } as Record<string, string>,
    });

    this.client = new Client({ name: 'apra-fleet', version: '1.0.0' });

    await this.client.connect(this.transport);
    this.connected = true;

    // Validate connection by listing available tools
    const result = await this.client.listTools();
    this.availableTools = result.tools.map((t) => t.name);
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) return;

    try {
      await this.client.close();
    } catch {
      // Ignore close errors — process may already be dead
    }
    this.client = null;
    this.transport = null;
    this.availableTools = [];
    this.connected = false;
  }

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    // Lazy reconnect on stale connection
    if (!this.connected || !this.client) {
      try {
        await this.connect();
      } catch (err) {
        throw new Error(
          `gbrain is not available — is the process running? Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    try {
      const result = await this.client!.callTool({ name: toolName, arguments: args });
      // Extract text content from MCP result
      if (result.isError) {
        const text = Array.isArray(result.content)
          ? result.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n')
          : String(result.content);
        throw new Error(`gbrain tool '${toolName}' returned error: ${text}`);
      }
      if (Array.isArray(result.content)) {
        return result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
      }
      return String(result.content ?? '');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('gbrain tool')) throw err;
      // Connection may have dropped — mark as disconnected for lazy reconnect
      this.connected = false;
      this.client = null;
      this.transport = null;
      throw new Error(
        `gbrain call failed for '${toolName}' — connection may have dropped. Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAvailableTools(): string[] {
    return [...this.availableTools];
  }
}

/** Get or create the singleton gbrain client instance. */
export function getGbrainClient(options?: GbrainClientOptions): GbrainClient {
  if (!instance) {
    instance = new GbrainClient(options);
  }
  return instance;
}

/** Reset the singleton (for testing). */
export function _resetGbrainClient(): void {
  instance = null;
}
