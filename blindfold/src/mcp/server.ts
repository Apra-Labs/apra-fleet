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

  server.tool(
    'credential_store_set',
    'Collect a secret from the user out-of-band and store it securely. Returns a {{secure.NAME}} handle for use in other tool parameters.',
    credentialSetSchema.shape,
    async (input) => ({ content: [{ type: 'text', text: await credentialSetHandler(input as any) }] }),
  );

  server.tool(
    'credential_store_list',
    'List all stored credentials (metadata only — values are never exposed).',
    credentialListSchema.shape,
    async () => ({ content: [{ type: 'text', text: await credentialListHandler() }] }),
  );

  server.tool(
    'credential_store_delete',
    'Delete a stored credential by name.',
    credentialDeleteSchema.shape,
    async (input) => ({ content: [{ type: 'text', text: await credentialDeleteHandler(input as any) }] }),
  );

  server.tool(
    'credential_store_update',
    'Update credential metadata (member scope, TTL, or network policy).',
    credentialUpdateSchema.shape,
    async (input) => ({ content: [{ type: 'text', text: await credentialUpdateHandler(input as any) }] }),
  );

  server.tool(
    'resolve_secure',
    'Resolve {{secure.NAME}} tokens in text to their credential values. Returns resolved text and redaction patterns.',
    resolveSecureSchema.shape,
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
