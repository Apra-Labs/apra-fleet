import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// code_status / code_reindex honour the member's code-intel provider, over
// REAL HTTP (real createHttpTransport + registerAllTools + MCP SDK client,
// member session via ?member=<uuid>):
//   none            -> E-CODE-INTEL-DISABLED, nothing spawned
//   codebase-memory -> typed provider-not-supported result, never gitnexus readiness
//   gitnexus        -> unchanged readiness payload (regression guard)
//
// Isolation: APRA_FLEET_DATA_DIR is a sandbox (set before any import via
// vi.hoisted), a fake `npx` first on PATH records any spawn to a marker file
// (so a regressed gate is observable without a real analyze ever running),
// the registry is the isolated test registry, recordUsage is mocked, and
// everything lives under one scratch dir removed in afterAll.

const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-gate-')));
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(data);
  fs.mkdirSync(bin);
  const marker = path.join(root, 'npx-was-spawned');
  if (process.platform !== 'win32') {
    const npx = path.join(bin, 'npx');
    fs.writeFileSync(npx, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    fs.chmodSync(npx, 0o755);
  }
  process.env.APRA_FLEET_DATA_DIR = data;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  return { root, data, marker };
});

vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: vi.fn() }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const TOOLS = ['code_status', 'code_reindex'] as const;

let handle: HttpTransportHandle;
const clients: Client[] = [];
const members: Record<string, string> = {};
const tmpLeft = (): string[] => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('code-intel-gate-') && n !== path.basename(sandbox.root));
const tmpBefore = tmpLeft();

function gitRepo(name: string): string {
  const dir = path.join(sandbox.root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function register(key: string, provider: string): void {
  const agent = makeTestLocalAgent({ friendlyName: `gate-${key}`, workFolder: gitRepo(key), codeIntelProvider: provider as never });
  addAgent(agent);
  members[key] = agent.id;
}

async function call(member: string, name: string): Promise<{ isError: boolean; text: string }> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  url.searchParams.set('member', member);
  const client = new Client({ name: 'provider-gate', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT }));
  const result = await client.callTool({ name, arguments: {} });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

/** Nothing spawned and nothing written by an analyze: no marker, no code-index dir. */
function expectNothingSpawned(): void {
  expect(fs.existsSync(sandbox.marker)).toBe(false);
  expect(fs.existsSync(path.join(sandbox.data, 'code-index'))).toBe(false);
}

beforeAll(async () => {
  backupAndResetRegistry();
  register('off', 'none');
  register('cbm', 'codebase-memory');
  register('gitnexus', 'gitnexus');
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
}, 30_000);

afterAll(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  try { await handle?.close(); } catch { /* ignore */ }
  restoreRegistry();
  fs.rmSync(sandbox.root, { recursive: true, force: true });
  expect(tmpLeft()).toEqual(tmpBefore);
  expect(fs.existsSync(sandbox.root)).toBe(false);
});

describe('code_status / code_reindex honour the member code-intel provider (real HTTP)', () => {
  it.each(TOOLS)('%s on provider none: E-CODE-INTEL-DISABLED error, nothing spawned', async (tool) => {
    const out = await call(members.off, tool);
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toContain('E-CODE-INTEL-DISABLED');
    expect(out.text).toContain(tool);
    expectNothingSpawned();
  });

  it.each(TOOLS)('%s on codebase-memory: typed provider-not-supported, never gitnexus readiness', async (tool) => {
    const out = await call(members.cbm, tool);
    expect(out.isError, out.text).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: 'not-started', reason: 'provider-not-supported', provider: 'codebase-memory', indexedCommit: null });
    expect(body).not.toHaveProperty('readiness');
    expect(body).not.toHaveProperty('ready');
    expect(body).not.toHaveProperty('logPath');
    expectNothingSpawned();
  });

  it('code_status on gitnexus: readiness payload unchanged (regression guard)', async () => {
    const out = await call(members.gitnexus, 'code_status');
    expect(out.isError, out.text).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    expect(body).toMatchObject({ readiness: 'missing', ready: false, indexedCommit: null });
    expect(body).not.toHaveProperty('reason');
  });
});
