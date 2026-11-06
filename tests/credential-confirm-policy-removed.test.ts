/**
 * The confirm network policy was removed. Records written by a version that had
 * it live in a raw credentials.json here, so these tests read what an upgrading
 * user has on disk. The MCP tests go through a real server and client, because the
 * SDK validates arguments before a handler runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { mockExecCommand, mockCollectApiKey, mockLogLine } = vi.hoisted(() => ({
  mockExecCommand: vi.fn(),
  mockCollectApiKey: vi.fn(),
  mockLogLine: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn().mockResolvedValue({ ok: true }) }),
}));

vi.mock('../src/services/auth-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth-socket.js')>()),
  collectOobApiKey: mockCollectApiKey,
}));

vi.mock('../src/utils/log-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/log-helpers.js')>()),
  logLine: mockLogLine,
}));

import { cleanupAuthSocket } from '../src/services/auth-socket.js';
import { credentialList, credentialResolve, credentialUpdate, listLiveSecrets, lookupLiveSecret } from '../src/services/credential-store.js';
import { resetLiveTokenCache } from '../src/services/live-secret-cache.js';
import { resolveSecret } from '../src/providers/email/index.js';
import { credentialStoreSet, credentialStoreSetSchema } from '../src/tools/credential-store-set.js';
import { credentialStoreUpdate, credentialStoreUpdateSchema } from '../src/tools/credential-store-update.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { addAgent } from '../src/services/registry.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { backupAndResetRegistry, makeTestLocalAgent, restoreRegistry, resultText } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let dataDir: string;
let credPath: string;
const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

function policyLogLines(name: string): unknown[][] {
  return mockLogLine.mock.calls.filter((c) => String(c[1]).includes(`'${name}'`) && String(c[1]).includes('confirm'));
}

function writeOldRecords(records: Record<string, unknown>): Buffer {
  fs.writeFileSync(credPath, JSON.stringify({ version: '1.0', credentials: records }, null, 2));
  return fs.readFileSync(credPath);
}

function oldStatic(name: string): Record<string, unknown> {
  return { name, network_policy: 'confirm', created_at: '2026-01-01T00:00:00.000Z', encryptedValue: encryptPassword('old-value'), allowedMembers: '*' };
}

function oldLive(name: string, script: string): Record<string, unknown> {
  return { kind: 'live', name, program: process.execPath, args: [script], bindings: [], network_policy: 'confirm', allowedMembers: '*', created_at: '2026-01-01T00:00:00.000Z' };
}

async function mcpClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0' });
  server.tool('credential_store_set', 'set', credentialStoreSetSchema.shape, async (input) => ({ content: [{ type: 'text' as const, text: await credentialStoreSet(input as never) }] }));
  server.tool('credential_store_update', 'update', credentialStoreUpdateSchema.shape, async (input) => ({ content: [{ type: 'text' as const, text: await credentialStoreUpdate(input as never) }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(b);
  return client;
}

/** The text a caller reads back, whether the SDK answers with an error result or rejects. */
async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as Array<{ text: string }>).map((c) => c.text).join(' ');
  } catch (err) {
    return (err as Error).message;
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-confirm-removed-'));
  process.env.APRA_FLEET_DATA_DIR = dataDir;
  credPath = path.join(dataDir, 'credentials.json');
  backupAndResetRegistry();
  resetLiveTokenCache();
  mockExecCommand.mockReset();
  mockExecCommand.mockResolvedValue({ stdout: 'ran', stderr: '', code: 0 });
  mockCollectApiKey.mockReset();
  mockLogLine.mockReset();
});

afterEach(() => {
  restoreRegistry();
  if (originalDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('a stored record with network_policy confirm', () => {
  it('reads as allow from every reader, and reading does not rewrite the file', () => {
    const s = `st_${RUN}_a`;
    const l = `li_${RUN}_a`;
    const before = writeOldRecords({ [s]: oldStatic(s), [l]: oldLive(l, 'unused.js') });

    expect(credentialResolve(s)).toMatchObject({ plaintext: 'old-value', meta: { network_policy: 'allow' } });
    expect(lookupLiveSecret(l)).toMatchObject({ network_policy: 'allow' });
    expect(listLiveSecrets().map((r) => r.network_policy)).toEqual(['allow']);
    expect(credentialList().map((c) => c.network_policy)).toEqual(['allow', 'allow']);

    expect(fs.readFileSync(credPath).equals(before)).toBe(true);
  });

  it('logs one line naming the secret, however many times it is read', () => {
    const s = `st_${RUN}_b`;
    writeOldRecords({ [s]: oldStatic(s) });
    credentialResolve(s);
    credentialResolve(s);
    credentialList();
    const lines = policyLogLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe('credential_store');
    expect(String(lines[0][1])).toContain('treating it as allow');
  });

  it('a later save of that record stores allow', () => {
    const s = `st_${RUN}_c`;
    writeOldRecords({ [s]: oldStatic(s) });
    expect(credentialUpdate(s, { members: 'a' })).toMatchObject({ network_policy: 'allow', members: 'a' });
    expect(JSON.parse(fs.readFileSync(credPath, 'utf-8')).credentials[s].network_policy).toBe('allow');
  });

  it('a save for an unrelated secret also stores allow for it', () => {
    const s = `st_${RUN}_j`;
    const other = `st_${RUN}_k`;
    writeOldRecords({ [s]: oldStatic(s), [other]: { ...oldStatic(other), network_policy: 'allow' } });
    credentialUpdate(other, { members: 'a' });
    expect(JSON.parse(fs.readFileSync(credPath, 'utf-8')).credentials[s].network_policy).toBe('allow');
  });

  it('a record with deny or allow is left as it is, with no log line', () => {
    const d = `st_${RUN}_d`;
    const a = `st_${RUN}_e`;
    writeOldRecords({ [d]: { ...oldStatic(d), network_policy: 'deny' }, [a]: { ...oldStatic(a), network_policy: 'allow' } });
    expect(credentialResolve(d)).toMatchObject({ meta: { network_policy: 'deny' } });
    expect(credentialResolve(a)).toMatchObject({ meta: { network_policy: 'allow' } });
    expect(policyLogLines(d)).toHaveLength(0);
    expect(policyLogLines(a)).toHaveLength(0);
  });
});

describe('using an old confirm record', () => {
  let member: ReturnType<typeof makeTestLocalAgent>;
  // Every out-of-band request starts by opening the auth socket, on any platform,
  // whether or not a terminal can be launched.
  let authSocketOpened: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    member = makeTestLocalAgent({ friendlyName: `confirm-removed-${RUN}`, workFolder: dataDir });
    addAgent(member);
    authSocketOpened = vi.spyOn(net, 'createServer');
  });

  afterEach(async () => {
    authSocketOpened.mockRestore();
    await cleanupAuthSocket(); // an open socket is reused, which would hide the next test's request
  });

  const run = async (command: string): Promise<string> => resultText(await executeCommand({
    member_id: member.id, command, timeout_s: 30, long_running: false, max_retries: 0,
  } as never));

  it('execute_command runs a network command with a static one, and asks nothing out of band', async () => {
    const s = `st_${RUN}_f`;
    writeOldRecords({ [s]: oldStatic(s) });
    const out = await run(`curl https://example.test -H {{secret.${s}}}`);
    expect(out).toContain('ran');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    expect(authSocketOpened).not.toHaveBeenCalled();
  });

  it('execute_command runs a network command with a live one, minting it once, and asks nothing out of band', async () => {
    const l = `li_${RUN}_g`;
    const counter = path.join(dataDir, 'runs');
    const script = path.join(dataDir, 'mint.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');
      process.stdout.write(JSON.stringify({ token: 'minted-token-value', expires_at: new Date(Date.now() + 3600000).toISOString() }));`);
    writeOldRecords({ [l]: oldLive(l, script) });
    const out = await run(`curl https://example.test -H {{secret.${l}}}`);
    expect(out).toContain('ran');
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');
    expect(authSocketOpened).not.toHaveBeenCalled();
  });

  it('send_email gets the value with no prompt', async () => {
    const s = `st_${RUN}_h`;
    writeOldRecords({ [s]: oldStatic(s) });
    await expect(resolveSecret(s, '*')).resolves.toBe('old-value');
    expect(authSocketOpened).not.toHaveBeenCalled();
  });
});

describe('a caller still passing network_policy confirm', () => {
  const removed = /network_policy confirm was removed\. Use allow or deny\./;

  it('credential_store_set is refused with the reason, and no value is asked for', async () => {
    const client = await mcpClient();
    const text = await callText(client, 'credential_store_set', { name: `set_${RUN}`, prompt: 'x', network_policy: 'confirm' });
    expect(text).toMatch(removed);
    expect(mockCollectApiKey).not.toHaveBeenCalled();
    expect(fs.existsSync(credPath)).toBe(false);
  });

  it('credential_store_update is refused with the reason, and the record is unchanged', async () => {
    const s = `st_${RUN}_i`;
    const before = writeOldRecords({ [s]: { ...oldStatic(s), network_policy: 'deny' } });
    const client = await mcpClient();
    const text = await callText(client, 'credential_store_update', { name: s, network_policy: 'confirm' });
    expect(text).toMatch(removed);
    expect(fs.readFileSync(credPath).equals(before)).toBe(true);
  });

  it('a value that was never a policy keeps the plain enum error', async () => {
    const client = await mcpClient();
    const text = await callText(client, 'credential_store_set', { name: `set_${RUN}`, prompt: 'x', network_policy: 'bogus' });
    expect(text).not.toMatch(removed);
    expect(text).toContain('allow');
    expect(mockCollectApiKey).not.toHaveBeenCalled();
  });

  it('the advertised schema offers only allow and deny, and an omitted call stores with the new defaults', async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const policy = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).network_policy;
      expect(policy.enum).toEqual(['allow', 'deny']);
    }
    mockCollectApiKey.mockResolvedValue({ password: encryptPassword('v') });
    const name = `set_${RUN}_default`;
    expect(await callText(client, 'credential_store_set', { name, prompt: 'x' })).toContain(`${name} stored [persistent]`);
    expect(credentialResolve(name)).toMatchObject({ meta: { network_policy: 'allow', allowedMembers: '*' } });
  });
});
