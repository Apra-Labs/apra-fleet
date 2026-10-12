/**
 * Upgrade from 0.4.3 with a header-less Claude LOCAL-scope apra-fleet entry
 * (`claude mcp add apra-fleet <url>` without --scope, which the 0.4.3 install
 * doc told users to run). Claude resolves that entry before the user-scope
 * one, so after the access-secret gate it got 401 and reported "Dynamic
 * Client Registration rejected (HTTP 404)".
 *
 * Chain: 0.4.3-shaped ~/.claude.json -> the install's local-scope refresh ->
 * the headers of the entry Claude resolves for that project -> the real /mcp
 * gate answers MCP initialize with 200 (and 401 for the pre-upgrade entry).
 * Stands in for an upgrade-leg check in the nightly fresh-install harness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpTransport, type HttpTransportHandle } from '../../src/services/http-transport.js';
import { refreshClaudeLocalScopeEntries } from '../../src/services/mcp-registration-audit.js';
import { MEMBER_SECRET_HEADER } from '../../src/services/member-access-secret.js';

const handles: HttpTransportHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) { try { await h.close(); } catch { /* ignore */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function noop(_server: McpServer): void { /* no tools */ }

async function initialize(port: number, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'upgrade-shadow', version: '1' } } }),
  });
  await res.text();
  return res.status;
}

describe('0.4.3 local-scope apra-fleet entry after upgrade', () => {
  it('is rewritten with the access secret and then passes the /mcp gate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-upgrade-shadow-'));
    dirs.push(dir);
    const secretPath = path.join(dir, 'member-access.key');
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0, memberSecretPath: secretPath });
    handles.push(handle);
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    const fleetUrl = `http://localhost:${handle.port}/mcp`;

    // The sandboxed config file (never the real ~/.claude.json).
    const configFile = path.join(dir, '.claude.json');
    const project = '/home/u/repo';
    fs.writeFileSync(configFile, JSON.stringify({
      mcpServers: { 'apra-fleet': { type: 'http', url: fleetUrl, headers: { [MEMBER_SECRET_HEADER]: secret } } },
      projects: { [project]: { mcpServers: { 'apra-fleet': { type: 'http', url: fleetUrl } } } },
    }));
    const resolved = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).projects[project].mcpServers['apra-fleet'];

    // Before: the local-scope entry wins and carries no secret -> 401.
    expect(await initialize(handle.port, resolved().headers ?? {})).toBe(401);

    refreshClaudeLocalScopeEntries(configFile, fleetUrl, { [MEMBER_SECRET_HEADER]: secret });

    // After: the entry Claude resolves for the project carries the secret -> 200.
    expect(await initialize(handle.port, resolved().headers)).toBe(200);
  });
});
