import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { mapAccessLevel } from '../src/services/github-app.js';
import { provisionVcsAuthSchema, GIT_ACCESS_ACTIONS, gitAccessGrants } from '../src/tools/provision-vcs-auth.js';

// An agent searching its tools for "create pull requests" or "dispatch
// workflows" must find provision_vcs_auth, and must be able to read what each
// git_access level grants. Read through a real MCP client: this is the text an
// agent's tool search sees. Grants are compared with mapAccessLevel, the code
// that requests them.

const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close();
});

async function listed(): Promise<{ description: string; gitAccess: string }> {
  const server = new McpServer({ name: 'description-test', version: '0.0.0' }, { capabilities: { logging: {} } });
  await registerAllTools(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'description-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientSide);
  clients.push(client);
  const tool = (await client.listTools()).tools.find((t) => t.name === 'provision_vcs_auth');
  expect(tool).toBeTruthy();
  const props = tool!.inputSchema.properties as Record<string, { description: string }>;
  return { description: tool!.description ?? '', gitAccess: props.git_access.description };
}

describe('provision_vcs_auth text', () => {
  const levels = provisionVcsAuthSchema.shape.git_access.unwrap().options as readonly string[];

  it('the tool description names the actions in plain words', async () => {
    const { description } = await listed();
    for (const action of ['create pull requests', 'dispatch workflows', 're-run CI jobs', 'push']) {
      expect(description).toContain(action);
    }
    expect(description).toContain('git_access');
    expect(description).toContain('GitHub');
  });

  it('git_access says it is GitHub-specific and states every level with its real grants', async () => {
    const { gitAccess } = await listed();
    expect(gitAccess).toContain('GitHub App mode only');
    expect(Object.keys(GIT_ACCESS_ACTIONS).sort()).toEqual([...levels].sort());
    for (const level of levels) {
      const permissions = mapAccessLevel(level);
      const grants = gitAccessGrants(level);
      for (const [name, value] of Object.entries(permissions)) {
        expect(grants, `${level}: ${name}`).toContain(value === 'write' ? 'write:' : 'read:');
        expect(grants, `${level}: ${name}`).toContain(name);
      }
      expect(gitAccess).toContain(`${level} (${grants})`);
    }
  });

  it('only the levels with the matching permission claim the action', () => {
    for (const [level, text] of Object.entries(GIT_ACCESS_ACTIONS)) {
      const permissions = mapAccessLevel(level);
      expect(/\bcreate pull requests\b/.test(text) && !/\bcannot\b.*create pull requests/.test(text), level).toBe(permissions.pull_requests === 'write');
      expect(/\bdispatch workflows\b/.test(text) && !/\bcannot\b.*dispatch workflows/.test(text), level).toBe(permissions.actions === 'write');
    }
  });

  it('carries no bead id', async () => {
    const { description, gitAccess } = await listed();
    expect(`${description} ${gitAccess}`).not.toMatch(/apra-fleet-[a-z0-9]{3,}/);
  });

  it('the client docs list the same levels and name the actions', () => {
    const docs = fs.readFileSync(path.resolve(__dirname, '..', 'packages', 'apra-fleet-client', 'docs', 'api-reference.md'), 'utf-8');
    for (const level of levels) expect(docs).toContain(`\`${level}\` (${gitAccessGrants(level)})`);
    expect(docs).toContain('create pull requests');
    expect(docs).toContain('dispatch workflows');
  });
});
