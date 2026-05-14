import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initBlindfold, getConfig } from '../config.js';
import { cleanupAuthSocket } from '../auth-socket.js';
import { purgeExpiredCredentials } from '../credential-store.js';

import { credentialSetSchema, credentialSetHandler } from './tools/credential-set.js';
import { credentialListSchema, credentialListHandler } from './tools/credential-list.js';
import { credentialDeleteSchema, credentialDeleteHandler } from './tools/credential-delete.js';
import { credentialUpdateSchema, credentialUpdateHandler } from './tools/credential-update.js';
import { resolveSecureSchema, resolveSecureHandler } from './tools/resolve-secure.js';

const PURGE_INTERVAL_MS = 60_000;

export async function startMcpServer(): Promise<void> {
  initBlindfold();

  const config = getConfig();
  const version = '0.1.0';

  const server = new McpServer(
    { name: config.productName, version },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'credential_store_set',
    {
      description: 'Collect a secret from the user out-of-band and store it securely. Returns a {{secure.NAME}} handle for use in other tool parameters.',
      inputSchema: credentialSetSchema,
    },
    async (input) => ({ content: [{ type: 'text', text: await credentialSetHandler(input as any) }] }),
  );

  server.registerTool(
    'credential_store_list',
    {
      description: 'List all stored credentials (metadata only — values are never exposed).',
      inputSchema: credentialListSchema,
    },
    async () => ({ content: [{ type: 'text', text: await credentialListHandler() }] }),
  );

  server.registerTool(
    'credential_store_delete',
    {
      description: 'Delete a stored credential by name.',
      inputSchema: credentialDeleteSchema,
    },
    async (input) => ({ content: [{ type: 'text', text: await credentialDeleteHandler(input as any) }] }),
  );

  server.registerTool(
    'credential_store_update',
    {
      description: 'Update credential metadata (member scope, TTL, or network policy).',
      inputSchema: credentialUpdateSchema,
    },
    async (input) => ({ content: [{ type: 'text', text: await credentialUpdateHandler(input as any) }] }),
  );

  server.registerTool(
    'resolve_secure',
    {
      description: 'Resolve {{secure.NAME}} tokens in text to their credential values. Returns resolved text and redaction markers.',
      inputSchema: resolveSecureSchema,
    },
    async (input) => ({ content: [{ type: 'text', text: await resolveSecureHandler(input as any) }] }),
  );

  const purgeTimer = setInterval(() => {
    purgeExpiredCredentials();
  }, PURGE_INTERVAL_MS);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    clearInterval(purgeTimer);
    await cleanupAuthSocket();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
