import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CodeIntelligenceProvider } from './code-intelligence.js';

let sharedClient: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

async function getGitNexusClient(): Promise<Client> {
  if (sharedClient) return sharedClient;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'gitnexus', 'mcp'],
      stderr: 'pipe',
    });

    const client = new Client(
      { name: 'apra-fleet', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    sharedClient = client;
    return client;
  })();

  return connectionPromise;
}

export class GitNexusProvider implements CodeIntelligenceProvider {
  async graph(params: Record<string, unknown>): Promise<unknown> {
    const client = await getGitNexusClient();
    return client.callTool({ name: 'call_graph', arguments: params });
  }

  async impact(params: Record<string, unknown>): Promise<unknown> {
    const client = await getGitNexusClient();
    return client.callTool({ name: 'impact', arguments: params });
  }

  async query(params: Record<string, unknown>): Promise<unknown> {
    const client = await getGitNexusClient();
    return client.callTool({ name: 'query', arguments: params });
  }

  async context(params: Record<string, unknown>): Promise<unknown> {
    const client = await getGitNexusClient();
    return client.callTool({ name: 'context', arguments: params });
  }
}
