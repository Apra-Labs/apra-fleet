import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { FLEET_DIR } from '../src/paths.js';
import {
  REGISTERED_TOOL_NAMES,
  MEMBER_ALLOWED_TOOLS,
  MEMBER_MAINTAINER_TOOLS,
} from '../src/services/member-tool-allowlist.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from './test-helpers.js';

// KB tool profiles (GitHub #759) as a real MCP client sees them: the real
// createHttpTransport and registerAllTools per session, a real SDK client, and
// a knowledge/config.json written per case in the test's sandboxed FLEET_DIR
// (scripts/test-sandbox.mjs points HOME and APRA_FLEET_DATA_DIR at a per-run
// temp dir). Nothing in the registry or the profile reader is mocked. The CLI
// case runs the built `node dist/index.js kb profile` in a child process with
// the same sandboxed environment.
//
// Expected lists are derived from REGISTERED_TOOL_NAMES and the member
// allowlists, never a hard-coded snapshot, so a drift in either shows here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const DEVELOPER = ['kb_capture', 'kb_context', 'kb_feedback', 'kb_query', 'kb_session_prime'];
const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

const sorted = (xs: Iterable<string>) => [...xs].sort();
const FULL_BASELINE = sorted(REGISTERED_TOOL_NAMES);
const NON_KB = REGISTERED_TOOL_NAMES.filter(n => !n.startsWith('kb_'));

const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];
let memberId: string;
let savedConfig: string | null;
let handle: HttpTransportHandle;

beforeAll(() => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
});

beforeEach(async () => {
  backupAndResetRegistry();
  const agent = makeTestAgent({ friendlyName: 'kb-profile-e2e-member', workFolder: '/tmp/kb-profile-e2e-work' });
  addAgent(agent);
  memberId = agent.id;
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  handles.push(handle);
});

afterEach(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) { try { await h.close(); } catch { /* ignore */ } }
  fleetEvents.removeAllListeners();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  restoreRegistry();
});

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function connect(params: Record<string, string> = {}): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const client = new Client({ name: 'kb-profile-e2e', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return sorted((await client.listTools()).tools.map(t => t.name));
}

const fullSession = async () => toolNames(await connect());
const plainMember = async () => toolNames(await connect({ member: memberId }));
const maintainerMember = async () => toolNames(await connect({ member: memberId, origin: 'engine', kb_maintainer: '1' }));

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DIST_INDEX, 'kb', 'profile', ...args], {
    encoding: 'utf-8', env: process.env, timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('KB tool profile seen by a real MCP client', { timeout: 60000 }, () => {
  it('developer: a FULL session lists exactly the five developer kb tools and every non-kb tool', async () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer' });
    const names = await fullSession();
    expect(names.filter(n => n.startsWith('kb_'))).toEqual(DEVELOPER);
    expect(names).toEqual(sorted([...NON_KB, ...DEVELOPER]));
  });

  it('full and an absent setting both list the baseline every-tool set', async () => {
    expect(await fullSession()).toEqual(FULL_BASELINE);
    writeConfig({ provider: 'sqlite' });
    expect(await fullSession()).toEqual(FULL_BASELINE);
    writeConfig({ provider: 'sqlite', tool_profile: 'full' });
    expect(await fullSession()).toEqual(FULL_BASELINE);
  });

  it('custom: a FULL session lists exactly the named kb tools', async () => {
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_setup'] });
    expect(await fullSession()).toEqual(sorted([...NON_KB, 'kb_query', 'kb_setup']));
  });

  it('members: plain and kb_maintainer member sessions list the same tools with developer or custom set', async () => {
    const plainBaseline = await plainMember();
    const maintainerBaseline = await maintainerMember();
    expect(plainBaseline).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    for (const t of ['kb_promote', 'kb_resolve_contradiction', 'kb_demote']) expect(maintainerBaseline).toContain(t);
    expect(maintainerBaseline).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_MAINTAINER_TOOLS]));

    writeConfig({ tool_profile: 'developer' });
    expect(await plainMember()).toEqual(plainBaseline);
    expect(await maintainerMember()).toEqual(maintainerBaseline);

    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query'] });
    expect(await plainMember()).toEqual(plainBaseline);
    expect(await maintainerMember()).toEqual(maintainerBaseline);
  });

  it('custom with an unknown name: kb_setup over MCP fails naming it and the config is unchanged', async () => {
    // developer hides kb_setup; a custom profile that keeps it lets the client reach it.
    writeConfig({ provider: 'sqlite', tool_profile: 'custom', tool_profile_tools: ['kb_setup'] });
    const withSetup = fs.readFileSync(KB_CONFIG_PATH, 'utf-8');
    const client = await connect();
    const result = await client.callTool({ name: 'kb_setup', arguments: { tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_not_a_tool'] } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/unknown kb tool name\(s\): kb_not_a_tool/);
    expect(text).toMatch(/Valid names: /);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).toBe(withSetup);
  });

  it('custom with an unknown name: the CLI exits non-zero naming it and the config is unchanged', async () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer' });
    const before = fs.readFileSync(KB_CONFIG_PATH, 'utf-8');
    const r = cli(['custom', 'kb_query,kb_not_a_tool']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/kb_not_a_tool/);
    expect(r.stderr).toMatch(/Usage: apra-fleet kb profile/);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).toBe(before);
  });

  it('CLI: kb profile full against a developer config; a reconnecting client lists the full set', async () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer', bible: { autoCommit: false } });
    const before = await connect();
    expect((await toolNames(before)).filter(n => n.startsWith('kb_'))).toEqual(DEVELOPER);

    const shown = cli([]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toMatch(/KB tool profile: developer/);

    const r = cli(['full']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8'))).toEqual({ provider: 'sqlite', tool_profile: 'full', bible: { autoCommit: false } });

    // The open session keeps its list until it reconnects.
    expect((await toolNames(before)).filter(n => n.startsWith('kb_'))).toEqual(DEVELOPER);
    await before.close();
    expect(await fullSession()).toEqual(FULL_BASELINE);
  });
});
