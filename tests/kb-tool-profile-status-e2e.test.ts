import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { kbHealthCompactLines, type KbHealth } from '../src/tools/check-status.js';
import { FLEET_DIR } from '../src/paths.js';
import { REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import { addAgent } from '../src/services/registry.js';
import { backupAndResetRegistry, restoreRegistry, makeTestLocalAgent, memberSecretRequestInit } from './test-helpers.js';

// A bad KB tool profile fails safe (every kb_* tool, the server stays up) AND
// loud (fleet_status says so). A real server, a real MCP client, a real
// fleet_status call and a config file in the sandboxed FLEET_DIR
// (scripts/test-sandbox.mjs). Nothing is mocked. Most cases register no member,
// the short fleet_status form a solo install gets; one case registers a local
// member for the full form.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

// Part of the file a JSON parser's message could quote back.
const CANARY = 'zq-canary-token-ref';
const MALFORMED = `{"provider":"http","url":"https://kb.example.test","token_ref":"{{secret.${CANARY}}}",}`;

const sorted = (xs: Iterable<string>) => [...xs].sort();

let handle: HttpTransportHandle;
let client: Client | undefined;
let savedConfig: string | null;

beforeAll(() => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
});

beforeEach(async () => {
  backupAndResetRegistry();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
});

afterEach(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  client = undefined;
  await handle.close();
  fleetEvents.removeAllListeners();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  restoreRegistry();
});

async function connect(): Promise<Client> {
  const c = new Client({ name: 'kb-profile-status-e2e', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
    reconnectionOptions: RECONNECT,
    requestInit: memberSecretRequestInit(),
  }));
  client = c;
  return c;
}

async function status(c: Client): Promise<{ compact: string; warning: string | undefined; health: Record<string, unknown> | undefined }> {
  const text = async (format: string) => {
    const result = await c.callTool({ name: 'fleet_status', arguments: { format } });
    expect(result.isError).toBeFalsy();
    return (result.content as Array<{ text?: string }>).map(b => b.text ?? '').join('\n');
  };
  const compact = await text('compact');
  const payload = JSON.parse((await text('json')).split('\n').find(l => l.startsWith('{'))!);
  return { compact, warning: payload.kbHealth?.toolProfileWarning, health: payload.kbHealth };
}

const toolLine = (compact: string) => compact.split('\n').find(l => l.includes('KB tool profile not applied'));

describe('an invalid KB tool profile through a real fleet_status', { timeout: 60000 }, () => {
  it('hand-typed "Developer": every tool stays listed, and status names the value and the fix', async () => {
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'sqlite', tool_profile: 'Developer' }));
    const c = await connect();
    expect(sorted((await c.listTools()).tools.map(t => t.name))).toEqual(sorted(REGISTERED_TOOL_NAMES));

    const { compact, warning } = await status(c);
    const line = toolLine(compact);
    expect(line, compact).toBeDefined();
    expect(line).toContain('"Developer"');
    expect(line).toContain(KB_CONFIG_PATH);
    expect(line).toMatch(/serving every kb_\* tool/);
    expect(line).toMatch(/apra-fleet kb profile <full \| developer \| custom tool1,tool2>/);
    expect(warning).toBe(line!.trim());
  });

  it('a custom list with an unknown name: status names that name', async () => {
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_nope'] }));
    const { compact, warning } = await status(await connect());
    expect(toolLine(compact)).toContain('kb_nope');
    expect(warning).toContain('kb_nope');
  });

  it('malformed JSON: status says to fix the file by hand, repeats none of it, and the file is untouched', async () => {
    fs.writeFileSync(KB_CONFIG_PATH, MALFORMED);
    const c = await connect();
    expect(sorted((await c.listTools()).tools.map(t => t.name))).toEqual(sorted(REGISTERED_TOOL_NAMES));

    const { compact, warning } = await status(c);
    const line = toolLine(compact);
    expect(line, compact).toBeDefined();
    expect(line).toContain(KB_CONFIG_PATH);
    expect(line).toMatch(/not valid JSON/);
    expect(line).toMatch(/by hand/);
    expect(line).not.toMatch(/apra-fleet kb profile/);
    expect(warning).toBe(line!.trim());
    expect(compact).not.toContain(CANARY);
    expect(JSON.stringify(warning)).not.toContain(CANARY);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).toBe(MALFORMED);
  });

  it('a valid profile or no config: no line and no field', async () => {
    const c = await connect();
    const absent = await status(c);
    expect(toolLine(absent.compact)).toBeUndefined();
    expect(absent.warning).toBeUndefined();
    expect(absent.compact).not.toMatch(/KB tool profile/);

    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ tool_profile: 'developer' }));
    const developer = await status(c);
    expect(toolLine(developer.compact)).toBeUndefined();
    expect(developer.warning).toBeUndefined();
  });

  it('with a member registered: the full status form carries the line, and a well-formed kbHealth', async () => {
    addAgent(makeTestLocalAgent({ friendlyName: 'kb-profile-status-member', workFolder: os.tmpdir() }));
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ tool_profile: 'Developer' }));
    const { compact, warning, health } = await status(await connect());
    expect(compact).toContain('kb-profile-status-member');
    expect(toolLine(compact)).toContain('"Developer"');
    expect(warning).toContain('"Developer"');
    expect(health).toMatchObject({ projectProvider: 'sqlite', errors: [] });
  });

  it('the line also shows when KB scopes exist, not only in the empty-server form', () => {
    const scope = {
      scope: 'some-repo',
      totals: { by_confidence: { CONFIRMED: 1 }, by_type: {}, total: 1 },
      stale: 0, flagged: 0, superseded: 0,
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
      promote_ratio: null,
      bible: { computable: false as const, reason: 'x' },
    };
    const health: KbHealth = { projectProvider: 'sqlite', toolProfileWarning: 'BAD PROFILE LINE', scopes: [scope], global: null, errors: [], totalEntries: 1 };
    expect(kbHealthCompactLines(health).split('\n')).toContain('  BAD PROFILE LINE');
  });

  it('the built CLI refuses to rewrite malformed JSON, and a server still starts sessions on it', async () => {
    fs.writeFileSync(KB_CONFIG_PATH, MALFORMED);
    const r = spawnSync(process.execPath, [DIST_INDEX, 'kb', 'profile', 'full'], { encoding: 'utf-8', env: process.env, timeout: 30000 });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(KB_CONFIG_PATH);
    expect(r.stderr).toMatch(/by hand/);
    expect(r.stderr).not.toContain(CANARY);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).toBe(MALFORMED);
    expect((await (await connect()).listTools()).tools.length).toBe(REGISTERED_TOOL_NAMES.length);
  });
});
