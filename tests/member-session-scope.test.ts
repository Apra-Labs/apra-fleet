import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// End-to-end member session tool scoping over real HTTP: the real
// createHttpTransport, the real registerAllTools per session, and a real MCP
// SDK client. The registry is the isolated test registry (tests/setup.ts points
// APRA_FLEET_DATA_DIR at a temp dir; backupAndResetRegistry/restoreRegistry
// leave it as found). Tool lists are asserted per session KIND:
//   - registered ?member=, no channel cap  -> MEMBER_ALLOWED_TOOLS
//   - registered ?member=, claude/channel  -> MEMBER_ALLOWED_TOOLS + MEMBER_CHANNEL_TOOLS
//   - valid member JWT, no ?member=        -> MEMBER_ALLOWED_TOOLS (not full)
//   - no identity                          -> every registered tool
//   - unregistered ?member=                -> HTTP 403 at initialize
//
// kbQuery is mocked only so the kb_query call opens no KB; it records the
// session member id the real registry handed it.

const seenMemberIds = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../src/tools/kb-query.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/kb-query.js')>();
  const { getSessionMemberId } = await import('../src/services/tool-scope.js');
  return {
    ...actual,
    kbQuery: vi.fn(async () => {
      seenMemberIds.push(getSessionMemberId());
      return '{"results":[]}';
    }),
  };
});

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { getTokenIssuer, localWorkspaceId } from '../src/services/token-issuer.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { registerPending, __clearAllPending } from '../src/services/pending-responses.js';
import { addAgent } from '../src/services/registry.js';
import { sendMessage } from '../src/tools/send-message.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_CHANNEL_TOOLS, MEMBER_MAINTAINER_TOOLS, REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretHeaders, memberSecretRequestInit } from './test-helpers.js';
import { SqliteProvider } from '../src/services/knowledge/sqlite-provider.js';
import * as kbProvidersModule from '../src/services/knowledge/kb-providers.js';
import { computeHeadFileHashBatch } from '../src/services/knowledge/file-hash.js';
import type { KBEntryInput } from '../src/services/knowledge/types.js';
import { commitWorkTree } from './helpers/commit-work-tree.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];
let memberId: string;

beforeEach(() => {
  backupAndResetRegistry();
  const agent = makeTestAgent({ friendlyName: 'scope-e2e-member', workFolder: '/tmp/scope-e2e-work' });
  addAgent(agent);
  memberId = agent.id;
  seenMemberIds.length = 0;
});

afterEach(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) { try { await h.close(); } catch { /* ignore */ } }
  fleetEvents.removeAllListeners();
  sessionRegistry.unregister(localWorkspaceId(), memberId);
  sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
  __clearAllPending();
  restoreRegistry();
});

async function startServer(): Promise<HttpTransportHandle> {
  const handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  handles.push(handle);
  return handle;
}

async function connect(
  port: number,
  opts: { member?: string; channel?: boolean; bearer?: string; params?: Record<string, string> } = {},
): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (opts.member) url.searchParams.set('member', opts.member);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const client = new Client(
    { name: 'scope-e2e-client', version: '1.0.0' },
    { capabilities: opts.channel ? { experimental: { 'claude/channel': {} } } : {} },
  );
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, {
    reconnectionOptions: RECONNECT,
    requestInit: opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : memberSecretRequestInit(),
  }));
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(t => t.name).sort();
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Call a tool and report whether it failed as an unknown tool. */
async function callFailsAsUnknownTool(client: Client, name: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as Array<{ text?: string }>)?.[0]?.text ?? '');
    return result.isError === true && /not found|unknown tool/i.test(text);
  } catch (err) {
    return /not found|unknown tool/i.test(String((err as Error).message));
  }
}

function postInitializeRaw(port: number, member: string): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: `/mcp?member=${encodeURIComponent(member)}`,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...memberSecretHeaders() },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

describe('member session tool scope over HTTP', { timeout: 30000 }, () => {
  it('a registered ?member= session without the channel capability lists exactly the member allowlist', async () => {
    const handle = await startServer();
    const names = await toolNames(await connect(handle.port, { member: memberId }));
    expect(names).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
  });

  it('an excluded tool is unknown on a member session but listed on a full session', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await callFailsAsUnknownTool(member, 'execute_command', { member_id: memberId, command: 'echo hi' })).toBe(true);

    const full = await connect(handle.port);
    expect(await toolNames(full)).toContain('execute_command');
  });

  it('refuses an unregistered ?member= uuid with HTTP 403 at initialize', async () => {
    const handle = await startServer();
    expect(await postInitializeRaw(handle.port, '00000000-0000-4000-8000-000000000000')).toBe(403);
    expect(handle.sessions.size).toBe(0);
  });

  it('a session with no ?member= and no JWT lists every registered tool', async () => {
    const handle = await startServer();
    expect(await toolNames(await connect(handle.port))).toEqual(sorted(REGISTERED_TOOL_NAMES));
  });

  it('a kb_* handler observes the calling session member id', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    const result = await member.callTool({ name: 'kb_query', arguments: { query: 'anything' } });
    expect(result.isError).toBeFalsy();
    expect(seenMemberIds).toEqual([memberId]);
  });

  it('a channel-capable member session lists the allowlist plus MEMBER_CHANNEL_TOOLS and can call respond_to_message', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId, channel: true });
    expect(await toolNames(member)).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_CHANNEL_TOOLS]));

    const pending = registerPending('scope-e2e-msg', 10_000);
    const result = await member.callTool({ name: 'respond_to_message', arguments: { reply_to: 'scope-e2e-msg', content: 'pong' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ ok: true });
    await expect(pending).resolves.toBe('pong');
  });

  it('a member session without the channel capability gets an unknown-tool error for respond_to_message', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await callFailsAsUnknownTool(member, 'respond_to_message', { reply_to: 'x', content: 'y' })).toBe(true);
  });

  it('a valid member JWT session without ?member= is member-scoped, not full', async () => {
    const handle = await startServer();
    const token = getTokenIssuer().issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/scope-e2e-work' });
    const names = await toolNames(await connect(handle.port, { bearer: token }));
    expect(names).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    expect(names).not.toContain('execute_prompt');
  });
});

describe('tool-only ?member= sessions leave the session registry alone', () => {
  const PLACEHOLDER_PID = 424242;

  function registerPlaceholder(): void {
    // What register_member records at launch, before the interactive session connects back.
    sessionRegistry.register({
      member_id: memberId, workspace_id: localWorkspaceId(), role: 'doer',
      work_folder: '/tmp/scope-e2e-work', server: null, pid: PLACEHOLDER_PID, status: 'idle',
    });
  }

  /** Close the session with an HTTP DELETE, which fires the server's onsessionclosed. */
  async function terminate(client: Client, handle: HttpTransportHandle): Promise<void> {
    const before = handle.sessions.size;
    await (client.transport as StreamableHTTPClientTransport).terminateSession();
    expect(handle.sessions.size).toBe(before - 1);
  }

  it('a tool-only connect does not replace a launch placeholder, and its close does not unregister it', async () => {
    registerPlaceholder();
    const placeholder = sessionRegistry.get(localWorkspaceId(), memberId);
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    // The session works as a member session...
    expect(await toolNames(member)).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    // ...but the placeholder is untouched: still no server, same pid, no sid.
    const during = sessionRegistry.get(localWorkspaceId(), memberId);
    expect(during).toBe(placeholder);
    expect(during).toMatchObject({ server: null, pid: PLACEHOLDER_PID, status: 'idle' });
    expect(during?.sessionId).toBeUndefined();

    // send_message does not route to the tool-only session.
    const sent = JSON.parse(await sendMessage({ member_id: memberId, content: 'hello' }, localWorkspaceId()));
    expect(sent).toEqual({ error: 'member not connected or no MCP session' });

    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(placeholder);
  });

  it('a tool-only connect with no registry entry registers nothing, and its close leaves nothing', async () => {
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await toolNames(member)).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
    const sent = JSON.parse(await sendMessage({ member_id: memberId, content: 'hello' }, localWorkspaceId()));
    expect(sent).toEqual({ error: 'member not connected or no MCP session' });
    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });

  it('a channel-capable ?member= session still takes over the placeholder (keeping its pid) and unregisters on close', async () => {
    registerPlaceholder();
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId, channel: true });
    const live = sessionRegistry.get(localWorkspaceId(), memberId);
    expect(live).toMatchObject({ pid: PLACEHOLDER_PID, status: 'online', channelCapable: true });
    expect(live?.server).not.toBeNull();
    expect(handle.sessions.has(live!.sessionId!)).toBe(true);

    // A tool-only session alongside it neither displaces it nor removes it on close.
    const tool = await connect(handle.port, { member: memberId });
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(live);
    await terminate(tool, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(live);

    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });
});

describe('member KB write policy: kb_setup / kb_export never, kb_promote / kb_resolve_contradiction only with the kb_maintainer grant', () => {
  const NEVER = ['kb_setup', 'kb_export'];
  const MAINTAINER_ONLY = ['kb_promote', 'kb_resolve_contradiction', 'kb_reconcile_prefilter'];
  const ARGS: Record<string, Record<string, unknown>> = {
    kb_reconcile_prefilter: {},
    kb_setup: { provider: 'sqlite' },
    kb_export: {},
    kb_promote: { id: 'no-such-entry', reason: 'scope test: never reaches a KB entry' },
    kb_resolve_contradiction: { winnerId: 'no-such-a', loserId: 'no-such-b', evidence: 'scope test' },
  };

  it('a non-maintainer member session neither lists nor can call any of the four (unknown tool)', async () => {
    const handle = await startServer();
    for (const opts of [
      { member: memberId },
      { member: memberId, channel: true },
      // origin=engine alone is not the grant.
      { member: memberId, params: { origin: 'engine' } },
      // The grant is engine-only: kb_maintainer=1 without origin=engine is ignored.
      { member: memberId, params: { kb_maintainer: '1' } },
    ]) {
      const client = await connect(handle.port, opts);
      const names = await toolNames(client);
      for (const t of [...NEVER, ...MAINTAINER_ONLY]) {
        expect(names, `${JSON.stringify(opts)} lists ${t}`).not.toContain(t);
        expect(await callFailsAsUnknownTool(client, t, ARGS[t]), `${JSON.stringify(opts)} ${t}`).toBe(true);
      }
    }
  });

  it('the kb_maintainer member session lists and reaches kb_promote and kb_resolve_contradiction, but still not kb_setup or kb_export', async () => {
    const handle = await startServer();
    const maint = await connect(handle.port, { member: memberId, params: { origin: 'engine', kb_maintainer: '1' } });
    const names = await toolNames(maint);
    expect(names).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_MAINTAINER_TOOLS]));
    for (const t of MAINTAINER_ONLY) {
      // Reaches the real handler: it refuses at kb (self) resolution (the
      // test member has no KB identity) -- a handler error, not the SDK's
      // unknown-tool error.
      const result = await maint.callTool({ name: t, arguments: ARGS[t] });
      const text = ((result.content as Array<{ text?: string }>)?.[0]?.text ?? '');
      expect(text, t).toMatch(/^E-SELF-[A-Z-]+: /);
      expect(text, t).not.toMatch(/Tool \S+ not found/);
    }
    for (const t of NEVER) {
      expect(names).not.toContain(t);
      expect(await callFailsAsUnknownTool(maint, t, ARGS[t]), t).toBe(true);
    }
  });

  it('a FULL session still lists all four', async () => {
    const handle = await startServer();
    const names = await toolNames(await connect(handle.port));
    for (const t of [...NEVER, ...MAINTAINER_ONLY]) expect(names).toContain(t);
  });
});

/**
 * Per-test KB fixture for the kb_maintainer-grant suites: a member whose work
 * folder is a temp git repo with an origin remote, and a temp SqliteProvider
 * the getKbProviders spy hands to every kb_* handler. Registers its own
 * beforeEach/afterEach in the calling describe; one temp root, removed after.
 */
function useKbMemberRepo() {
  const fx = {
    root: '', clone: '', memberId: '',
    provider: undefined as unknown as SqliteProvider,
    writeSrc(rel: string, body: string): void {
      fs.mkdirSync(path.dirname(path.join(fx.clone, rel)), { recursive: true });
      fs.writeFileSync(path.join(fx.clone, rel), body);
    },
    input(overrides: Partial<KBEntryInput>): KBEntryInput {
      return {
        type: 'knowledge', title: 'placeholder', summary: 'placeholder summary', content: 'placeholder content',
        source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
        flagged_for_review: false, author: 'test-agent', source: 'session', confidence: 'INFERRED',
        ...overrides,
      };
    },
    row(id: string) {
      return (fx.provider as any).getDb()
        .prepare('SELECT confidence, superseded_at, content_hash FROM entries WHERE id = ?').get(id) as
        { confidence: string; superseded_at: string | null; content_hash: string } | undefined;
    },
    confirmedCount(): number {
      return ((fx.provider as any).getDb()
        .prepare("SELECT COUNT(*) AS n FROM entries WHERE confidence = 'CONFIRMED'").get() as { n: number }).n;
    },
    /**
     * Stand-in for a maintainer-side publish of the CURRENTLY committed
     * .fleet/kb-canonical.json: records its HEAD blob id in the hub-side KB
     * (what kb_bible_commit / a kb_maintainer kb_import record), which a
     * no-grant kb_import requires before trusting a committed bible.
     */
    trustCommittedBible(): void {
      const blobId = execFileSync('git', ['rev-parse', 'HEAD:./.fleet/kb-canonical.json'], { cwd: fx.clone, encoding: 'utf-8' }).trim();
      fx.provider.recordTrustedBibleBlob(blobId, 'kb_bible_commit');
    },
    bibleIds(): string[] {
      const p = path.join(fx.clone, '.fleet', 'kb-canonical.json');
      if (!fs.existsSync(p)) return [];
      return (JSON.parse(fs.readFileSync(p, 'utf-8')).entries as Array<{ id: string }>).map(e => e.id).sort();
    },
  };

  beforeEach(async () => {
    fx.root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-maintainer-gate-'));
    fx.clone = path.join(fx.root, 'clone');
    fs.mkdirSync(fx.clone);
    const git = (args: string[]) => execFileSync('git', args, { cwd: fx.clone, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['remote', 'add', 'origin', `https://example.invalid/kb-maintainer-gate-${path.basename(fx.root)}.git`]);
    fx.writeSrc('README.md', 'seed\n');
    commitWorkTree(fx.clone, 'seed');
    fx.provider = new SqliteProvider(path.join(fx.root, 'kb.sqlite'), fx.clone);
    await fx.provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project: fx.provider, global: fx.provider, projectSlug: 'kb-maintainer-gate' } as any);
    const agent = makeTestLocalAgent({ friendlyName: 'kb-gate-member', workFolder: fx.clone });
    addAgent(agent);
    fx.memberId = agent.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fx.provider.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  return fx;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return { text: ((result.content as Array<{ text?: string }>)?.[0]?.text ?? ''), isError: result.isError === true };
}

const MAINTAINER_PARAMS = { origin: 'engine', kb_maintainer: '1' };

// The kb_maintainer grant also gates the two member-reachable paths that could
// otherwise mint CONFIRMED: kb_reconcile_prefilter (resolves pairs through the
// kb_resolve_contradiction write path) and kb_import with an explicit path (it
// keeps the named bible's confidence and carried basis). Real HTTP sessions on a
// member whose work folder is a temp git repo with an origin remote; the KB is a
// temp SqliteProvider handed out by a getKbProviders spy. Everything lives under
// one temp root removed in afterEach.
//
// FALSIFICATION: putting kb_reconcile_prefilter back in MEMBER_BASE_TOOLS fails
// the first test (the plain session lists it); dropping the explicit-path guard
// in src/tools/kb-import.ts fails the kb_import test (the hand-made bible's
// entry lands CONFIRMED in the member's DB).
describe('kb_maintainer grant gates CONFIRMED minting via kb_reconcile_prefilter and kb_import with a path', () => {
  const fx = useKbMemberRepo();

  /** A genuine AUDN contradiction pair whose challenger alone still matches the worktree. */
  async function pairWithOneMatchingSide(): Promise<{ originalId: string; challengerId: string }> {
    fx.writeSrc('src/original.ts', 'export const original = true;\n');
    fx.writeSrc('src/challenger.ts', 'export const challenger = true;\n');
    const original = await fx.provider.capture(fx.input({
      title: 'gateSym is broken report', summary: 'gateSym fails under load',
      content: 'gateSym is broken when called concurrently.', symbols: ['gateSym'], source_files: ['src/original.ts'],
    }));
    const challenger = await fx.provider.capture(fx.input({
      title: 'gateSym is fixed report', summary: 'gateSym now works correctly',
      content: 'gateSym is fixed as of the latest release.', symbols: ['gateSym'], source_files: ['src/challenger.ts'],
    }));
    expect(challenger.audn_decision).toBe('flagged');
    // The original's file moved on; only the challenger still matches.
    fx.writeSrc('src/original.ts', 'export const original = false;\n');
    return { originalId: original.id, challengerId: challenger.id };
  }

  it('kb_reconcile_prefilter: a plain ?member= session neither lists nor reaches it; the kb_maintainer session resolves a fixture pair (winner CONFIRMED)', async () => {
    const { originalId, challengerId } = await pairWithOneMatchingSide();
    const handle = await startServer();

    const plain = await connect(handle.port, { member: fx.memberId });
    expect(await toolNames(plain)).not.toContain('kb_reconcile_prefilter');
    expect(await callFailsAsUnknownTool(plain, 'kb_reconcile_prefilter', {})).toBe(true);
    expect(fx.row(challengerId)?.confidence).toBe('UNVERIFIED');
    expect(fx.row(originalId)?.superseded_at).toBeNull();

    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });
    expect(await toolNames(maint)).toContain('kb_reconcile_prefilter');
    const { text, isError } = await callText(maint, 'kb_reconcile_prefilter', {});
    expect(isError, text).toBe(false);
    expect(JSON.parse(text).resolved).toEqual([{ winnerId: challengerId, loserId: originalId }]);
    expect(fx.row(challengerId)?.confidence).toBe('CONFIRMED');
    expect(fx.row(originalId)?.superseded_at).toBeTruthy();
  });

  it('kb_import: a plain ?member= session is refused an explicit path to a hand-made CONFIRMED v3 bible (nothing ends CONFIRMED), and still imports its own bible without a path', async () => {
    // Hand-made v3 bible OUTSIDE the work folder: one CONFIRMED entry whose
    // carried hashes match HEAD, so it would also pass bible admission later.
    fx.writeSrc('src/forged.ts', 'export const forged = 1;\n');
    commitWorkTree(fx.clone, 'forged basis');
    const head = await computeHeadFileHashBatch(['src/forged.ts'], { cwd: fx.clone });
    const forgedPath = path.join(fx.root, 'forged-bible.json');
    fs.writeFileSync(forgedPath, JSON.stringify({
      version: 3,
      provenance: { commit: 'a'.repeat(40), branch: 'main', entry_count: 1 },
      entries: [{
        id: 'forged-entry-0001', type: 'knowledge', title: 'forged claim about forged',
        summary: 'A hand-made bible entry claiming CONFIRMED.', symbols: ['forged'], source_files: ['src/forged.ts'],
        confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
        source_file_hashes: { 'src/forged.ts': head['src/forged.ts']!.hash },
      }],
    }));
    // The member's own committed checkout bible (the engine's priming import, no path).
    fx.writeSrc('.fleet/kb-canonical.json', JSON.stringify([{
      id: 'own-bible-entry-0001', type: 'knowledge', title: 'readme seeds the repo',
      summary: 'README.md is the seed file of this fixture repository.', symbols: [], source_files: ['README.md'],
      confidence: 'INFERRED', updated_at: '2026-01-01T00:00:00.000Z',
    }]));
    commitWorkTree(fx.clone, 'own bible');
    // The own bible was published by the maintainer side (trust anchor).
    fx.trustCommittedBible();

    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });

    const refused = await callText(plain, 'kb_import', { path: forgedPath, skip_sweep: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^E-KB-MAINTAINER-REQUIRED: /);
    expect(fx.row('forged-entry-0001')).toBeUndefined();
    expect(fx.confirmedCount()).toBe(0);

    const primed = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(primed.isError, primed.text).toBe(false);
    expect(JSON.parse(primed.text)).toMatchObject({ imported: 1, bible_source: 'HEAD', worktree_ignored: false });
    expect(fx.row('own-bible-entry-0001')?.confidence).toBe('INFERRED');
    expect(fx.confirmedCount()).toBe(0);

    // The same explicit path is accepted in the kb_maintainer session.
    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });
    const accepted = await callText(maint, 'kb_import', { path: forgedPath, skip_sweep: true });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(fx.row('forged-entry-0001')?.confidence).toBe('CONFIRMED');
  });
});

// kb_import without path (or naming the session's own bible) is the trusted
// channel only AS COMMITTED: the work-tree .fleet/kb-canonical.json is
// member-writable. A member session without the kb_maintainer grant reads the
// committed blob at HEAD, never the work-tree file, and imports nothing when
// there is no committed copy. The committed copy must also be one the
// maintainer side recorded (trust anchor), so tests that expect an import
// record it first via fx.trustCommittedBible().
//
// FALSIFICATION: making kb-import.ts read the work-tree file for a no-grant
// session again fails the edited-work-tree test (the forged entry lands
// CONFIRMED) and the untracked-bible test (the import succeeds).
describe('kb_import in a member session without the grant imports only the committed bible', () => {
  const fx = useKbMemberRepo();

  async function forgedConfirmedBible(): Promise<string> {
    fx.writeSrc('src/forged.ts', 'export const forged = 1;\n');
    commitWorkTree(fx.clone, 'forged basis');
    const head = await computeHeadFileHashBatch(['src/forged.ts'], { cwd: fx.clone });
    return JSON.stringify({
      version: 3,
      provenance: { commit: 'a'.repeat(40), branch: 'main', entry_count: 1 },
      entries: [{
        id: 'forged-entry-0002', type: 'knowledge', title: 'forged claim about forged',
        summary: 'A hand-edited work-tree bible entry claiming CONFIRMED.', symbols: ['forged'], source_files: ['src/forged.ts'],
        confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
        source_file_hashes: { 'src/forged.ts': head['src/forged.ts']!.hash },
      }],
    });
  }

  const committedBible = JSON.stringify([{
    id: 'committed-entry-0001', type: 'knowledge', title: 'readme seeds the repo',
    summary: 'README.md is the seed file of this fixture repository.', symbols: [], source_files: ['README.md'],
    confidence: 'INFERRED', updated_at: '2026-01-01T00:00:00.000Z',
  }]);

  it('edited work tree: the hand-edited CONFIRMED bible is ignored (no path and own path); the committed copy is imported', async () => {
    fx.writeSrc('.fleet/kb-canonical.json', committedBible);
    commitWorkTree(fx.clone, 'committed bible');
    fx.trustCommittedBible();
    fx.writeSrc('.fleet/kb-canonical.json', await forgedConfirmedBible());

    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    for (const args of [{ skip_sweep: true }, { path: path.join(fx.clone, '.fleet', 'kb-canonical.json'), skip_sweep: true }]) {
      const r = await callText(plain, 'kb_import', args);
      expect(r.isError, r.text).toBe(false);
      expect(JSON.parse(r.text)).toMatchObject({ bible_source: 'HEAD', worktree_ignored: true });
    }
    expect(fx.row('forged-entry-0002')).toBeUndefined();
    expect(fx.row('committed-entry-0001')?.confidence).toBe('INFERRED');
    expect(fx.confirmedCount()).toBe(0);

    // The kb_maintainer session still reads the work-tree file (unchanged).
    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });
    const m = JSON.parse((await callText(maint, 'kb_import', { skip_sweep: true })).text);
    expect(m.bible_source).toBeUndefined();
    expect(fx.row('forged-entry-0002')?.confidence).toBe('CONFIRMED');
  });

  it('clean tree: imports the committed bible and reports worktree_ignored false', async () => {
    fx.writeSrc('.fleet/kb-canonical.json', committedBible);
    commitWorkTree(fx.clone, 'committed bible');
    fx.trustCommittedBible();
    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    const r = JSON.parse((await callText(plain, 'kb_import', { skip_sweep: true })).text);
    expect(r).toMatchObject({ imported: 1, bible_source: 'HEAD', worktree_ignored: false });
  });

  it('no committed copy (untracked bible): E-KB-MAINTAINER-REQUIRED and nothing is imported', async () => {
    fx.writeSrc('.fleet/kb-canonical.json', await forgedConfirmedBible());
    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    const r = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^E-KB-MAINTAINER-REQUIRED: .*no committed copy/);
    expect(fx.row('forged-entry-0002')).toBeUndefined();
    expect(fx.confirmedCount()).toBe(0);
  });

  it('no bible anywhere: the plain bible-not-found error, not a grant refusal', async () => {
    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    const r = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/kb_import: bible file not found: /);
    expect(r.text).not.toMatch(/E-KB-MAINTAINER-REQUIRED/);
  });

  it('committed bible deleted from the work tree: still imports the committed copy', async () => {
    fx.writeSrc('.fleet/kb-canonical.json', committedBible);
    commitWorkTree(fx.clone, 'committed bible');
    fx.trustCommittedBible();
    fs.rmSync(path.join(fx.clone, '.fleet', 'kb-canonical.json'));
    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    const r = JSON.parse((await callText(plain, 'kb_import', { skip_sweep: true })).text);
    expect(r).toMatchObject({ imported: 1, bible_source: 'HEAD', worktree_ignored: true });
  });
});

// The kb_import TRUST ANCHOR. Committed alone is not trusted: the member
// controls its own .git, so a session without the kb_maintainer grant could
// commit a hand-made bible locally, import it, and reset the commit away. A
// no-grant import therefore succeeds only for a committed bible whose git blob
// id the maintainer side recorded in the hub-side per-repo KB DB
// (kb_bible_commit, or kb_import from the kb_maintainer or a FULL session).
// Real HTTP sessions, real handlers, real temp git repos under fx.root.
//
// Case 5 (worktree_ignored / no committed copy / no bible) is covered by the
// describe block above, which now records the committed bible first.
//
// FALSIFICATION: removing the isTrustedBibleBlob check in src/tools/kb-import.ts
// fails the attack test (the hand-made entry lands CONFIRMED and the import
// does not error), the maintainer flow's and the seeding test's "refused
// first" assertions; dropping the recordTrustedBibleBlob call in
// kb-bible-commit.ts fails the maintainer and fresh-clone tests, and dropping
// it in kb-import.ts fails the seeding and FULL-session tests (the no-grant
// import is refused).
describe('kb_import trust anchor: a no-grant import needs a bible the maintainer side recorded', () => {
  const fx = useKbMemberRepo();
  const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
  const BIBLE_REL = '.fleet/kb-canonical.json';

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A v3 bible entry claiming CONFIRMED, citing a committed file with its HEAD hash. */
  async function carriedEntry(cwd: string, id: string, rel: string): Promise<Record<string, unknown>> {
    const head = await computeHeadFileHashBatch([rel], { cwd });
    return {
      id, type: 'knowledge', title: `carried claim ${id}`,
      summary: `A CONFIRMED bible entry ${id} with a carried basis.`, symbols: [], source_files: [rel],
      confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
      source_file_hashes: { [rel]: head[rel]!.hash },
    };
  }

  function v3(entries: Record<string, unknown>[]): string {
    return JSON.stringify({ version: 3, provenance: { commit: 'b'.repeat(40), branch: 'main', entry_count: entries.length }, entries });
  }

  /** Commit a source file plus a bible holding one carried CONFIRMED entry (plain git, not the maintainer). */
  async function commitCarriedBible(id: string, rel: string): Promise<void> {
    fx.writeSrc(rel, `export const v = '${id}';\n`);
    commitWorkTree(fx.clone, 'basis for ' + id);
    fx.writeSrc(BIBLE_REL, v3([await carriedEntry(fx.clone, id, rel)]));
    commitWorkTree(fx.clone, 'bible holding ' + id);
  }

  /** A CONFIRMED entry in the KB, then the kb_maintainer's kb_bible_commit of it. */
  async function maintainerPublishes(maint: Client, title: string): Promise<string> {
    const file = `src/${title.toLowerCase()}.ts`;
    fx.writeSrc(file, `export const ${title.toLowerCase()} = 1;\n`);
    const { id } = await fx.provider.capture(fx.input({
      title, summary: `Summary of ${title}`, content: `Content of ${title}.`, symbols: [`sym${title}`], source_files: [file],
    }));
    await fx.provider.promote(id, 'test fixture: verified');
    await fx.provider.promote(id, 'test fixture: verified');
    commitWorkTree(fx.clone, 'basis for ' + title);
    const r = await callText(maint, 'kb_bible_commit', { ids: [id], ...BASE });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ merged: [id], committed: true });
    return id;
  }

  function trustedBlobCount(): number {
    return ((fx.provider as any).getDb().prepare('SELECT COUNT(*) AS n FROM trusted_bible_blobs').get() as { n: number }).n;
  }

  /** A second local member on a fresh clone of the member's checkout (same KB: the provider spy). */
  async function freshCloneMember(port: number): Promise<{ dir: string; plain: Client }> {
    const dir = path.join(fx.root, 'fresh-clone');
    execFileSync('git', ['clone', '--quiet', fx.clone, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    git(dir, ['remote', 'set-url', 'origin', git(fx.clone, ['remote', 'get-url', 'origin'])]);
    const agent = makeTestLocalAgent({ friendlyName: 'kb-gate-fresh-clone', workFolder: dir });
    addAgent(agent);
    return { dir, plain: await connect(port, { member: agent.id }) };
  }

  it('attack: a hand-made CONFIRMED bible committed only in the checkout is refused, and after a reset nothing of it remains', async () => {
    const prior = git(fx.clone, ['rev-parse', 'HEAD']);
    await commitCarriedBible('forged-entry-0003', 'src/forged.ts');
    const blob = git(fx.clone, ['rev-parse', 'HEAD:./' + BIBLE_REL]);

    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    for (const args of [{ skip_sweep: true }, {}, { path: path.join(fx.clone, BIBLE_REL) }]) {
      const r = await callText(plain, 'kb_import', args);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toMatch(/^E-KB-MAINTAINER-REQUIRED: .*never recorded/);
      expect(r.text).toContain(blob);
    }
    git(fx.clone, ['reset', '--hard', '--quiet', prior]);

    expect(fx.row('forged-entry-0003')).toBeUndefined();
    expect(fx.confirmedCount()).toBe(0);
    expect(fx.provider.isTrustedBibleBlob(blob)).toBe(false);
    expect(trustedBlobCount()).toBe(0);
  });

  it('maintainer flow: kb_bible_commit records its bible, and a no-grant import of that committed bible lands CONFIRMED with bible_source HEAD', async () => {
    // Another clone's published entry already sits in the committed bible (not in this KB).
    await commitCarriedBible('carried-entry-0001', 'src/carried.ts');
    const handle = await startServer();
    const plain = await connect(handle.port, { member: fx.memberId });
    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });

    const before = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(before.isError).toBe(true);
    expect(before.text).toMatch(/never recorded/);

    const published = await maintainerPublishes(maint, 'Epsilon');
    const blob = git(fx.clone, ['rev-parse', 'HEAD:./' + BIBLE_REL]);
    expect(fx.provider.isTrustedBibleBlob(blob)).toBe(true);
    expect(fx.bibleIds()).toEqual(['carried-entry-0001', published].sort());

    const r = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ imported: 1, bible_source: 'HEAD', worktree_ignored: false });
    expect(fx.row('carried-entry-0001')?.confidence).toBe('CONFIRMED');
  });

  it('fresh clone of a maintainer-published bible: the engine-style import (no path, skip_sweep) lands it CONFIRMED', async () => {
    await commitCarriedBible('carried-entry-0002', 'src/carried2.ts');
    const handle = await startServer();
    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });
    await maintainerPublishes(maint, 'Zeta');

    const { dir, plain } = await freshCloneMember(handle.port);
    expect(git(dir, ['rev-parse', 'HEAD:./' + BIBLE_REL])).toBe(git(fx.clone, ['rev-parse', 'HEAD:./' + BIBLE_REL]));
    const r = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ imported: 1, bible_source: 'HEAD', worktree_ignored: false });
    expect(fx.row('carried-entry-0002')?.confidence).toBe('CONFIRMED');
  });

  it('seeding: a bible this hub never saw is refused for a fresh clone until the kb_maintainer priming import records it', async () => {
    // Committed with plain git (e.g. merged from elsewhere): never recorded here.
    await commitCarriedBible('carried-entry-0003', 'src/carried3.ts');
    const handle = await startServer();
    const { plain } = await freshCloneMember(handle.port);

    const refused = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^E-KB-MAINTAINER-REQUIRED: .*never recorded/);
    expect(fx.row('carried-entry-0003')).toBeUndefined();

    // The engine's sprint-start priming import: no path, skip_sweep, with the grant.
    const maint = await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS });
    const seeded = await callText(maint, 'kb_import', { skip_sweep: true });
    expect(seeded.isError, seeded.text).toBe(false);
    expect(JSON.parse(seeded.text)).toMatchObject({ imported: 1 });
    expect(fx.row('carried-entry-0003')?.confidence).toBe('CONFIRMED');
    expect(fx.provider.isTrustedBibleBlob(git(fx.clone, ['rev-parse', 'HEAD:./' + BIBLE_REL]))).toBe(true);

    const accepted = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(JSON.parse(accepted.text)).toMatchObject({ imported: 0, skipped: 1, bible_source: 'HEAD' });
  });

  it('FULL session: an explicit-path import keeps bible confidence and records the bible', async () => {
    fx.writeSrc('src/full.ts', 'export const full = 1;\n');
    commitWorkTree(fx.clone, 'basis for full');
    const body = v3([await carriedEntry(fx.clone, 'full-entry-0001', 'src/full.ts')]);
    const outside = path.join(fx.root, 'reviewed-bible.json');
    fs.writeFileSync(outside, body);

    const handle = await startServer();
    const full = await connect(handle.port);
    // A FULL session's own folder is the server working folder: point it at the checkout.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fx.clone);
    let r: { text: string; isError: boolean };
    try {
      r = await callText(full, 'kb_import', { path: outside, skip_sweep: true });
    } finally {
      cwd.mockRestore();
    }
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ imported: 1 });
    expect(JSON.parse(r.text).bible_source).toBeUndefined();
    expect(fx.row('full-entry-0001')?.confidence).toBe('CONFIRMED');

    // The same bytes committed as the checkout bible are now trusted for a no-grant session.
    fx.writeSrc(BIBLE_REL, body);
    commitWorkTree(fx.clone, 'bible from the reviewed file');
    const plain = await connect(handle.port, { member: fx.memberId });
    const p = await callText(plain, 'kb_import', { skip_sweep: true });
    expect(p.isError, p.text).toBe(false);
    expect(JSON.parse(p.text)).toMatchObject({ imported: 0, skipped: 1, bible_source: 'HEAD' });
  });
});

// kb_invalidate retires entries and kb_bible_commit removes retired entries
// from the bible, so a member session WITHOUT the kb_maintainer grant must not
// retire a CONFIRMED entry by either form -- not even one tagged with its own
// member id (the entry an agent session on the maintainer member would see as
// "own"). Real HTTP sessions, real handlers, real bible commits in a temp repo.
//
// FALSIFICATION: dropping keepConfirmed in src/tools/kb-invalidate.ts (passing
// it as false) fails "a plain ?member= session cannot retire a CONFIRMED bible
// entry by id" (the entry is discarded and the next bible commit removes it)
// and the {files} test.
describe('kb_invalidate needs the kb_maintainer grant to retire a CONFIRMED bible entry', () => {
  const fx = useKbMemberRepo();
  const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

  /** A CONFIRMED entry tagged member:<member>, committed into the checkout bible. */
  async function confirmedInBible(client: Client, title: string, type: KBEntryInput['type'] = 'knowledge'): Promise<string> {
    const file = `src/${title.toLowerCase()}.ts`;
    fx.writeSrc(file, `export const ${title.toLowerCase()} = 1;\n`);
    const { id } = await fx.provider.capture(fx.input({
      type, title, summary: `Summary of ${title}`, content: `Content of ${title}.`,
      symbols: [`sym${title}`], source_files: [file], tags: [`member:${fx.memberId}`],
    }));
    await fx.provider.promote(id, 'test fixture: verified');
    await fx.provider.promote(id, 'test fixture: verified');
    expect(fx.row(id)?.confidence).toBe('CONFIRMED');
    commitWorkTree(fx.clone);
    const r = await callText(client, 'kb_bible_commit', { ids: [id], ...BASE });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text).merged).toEqual([id]);
    expect(fx.bibleIds()).toContain(id);
    return id;
  }

  async function sessions() {
    const handle = await startServer();
    return {
      plain: await connect(handle.port, { member: fx.memberId }),
      maint: await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS }),
    };
  }

  it('a plain ?member= session cannot retire a CONFIRMED bible entry by id; the next maintainer bible commit keeps it', async () => {
    const { plain, maint } = await sessions();
    const id = await confirmedInBible(maint, 'Alpha');

    const r = await callText(plain, 'kb_invalidate', { ids: [id] });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ discarded: [], not_found: [], already_discarded: [], refused: [id] });
    expect(fx.row(id)?.superseded_at).toBeNull();

    const commit = JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text);
    expect(commit.removed).toEqual([]);
    expect(fx.bibleIds()).toContain(id);
  });

  it('the kb_maintainer session discards the same entry and the next bible commit removes it', async () => {
    const { maint } = await sessions();
    const id = await confirmedInBible(maint, 'Beta');

    const r = JSON.parse((await callText(maint, 'kb_invalidate', { ids: [id] })).text);
    expect(r.discarded).toEqual([id]);
    expect(r.refused).toBeUndefined();

    const commit = JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text);
    expect(commit.removed).toEqual([{ id, reason: 'invalidated' }]);
    expect(fx.bibleIds()).not.toContain(id);
  });

  it('a plain ?member= session still discards its own INFERRED entry (no over-blocking)', async () => {
    const { plain } = await sessions();
    fx.writeSrc('src/gamma.ts', 'export const gamma = 1;\n');
    const { id } = await fx.provider.capture(fx.input({
      title: 'Gamma', summary: 'Summary of Gamma', content: 'Content of Gamma.', symbols: ['symGamma'],
      source_files: ['src/gamma.ts'], tags: [`member:${fx.memberId}`],
    }));
    expect(fx.row(id)?.confidence).toBe('INFERRED');

    const r = JSON.parse((await callText(plain, 'kb_invalidate', { ids: [id] })).text);
    expect(r).toEqual({ discarded: [id], not_found: [], already_discarded: [], refused: [] });
    expect(fx.row(id)?.superseded_at).toBeTruthy();
  });

  it('{files}: a plain ?member= session cannot invalidate a CONFIRMED context-cache bible entry; the maintainer session can', async () => {
    const { plain, maint } = await sessions();
    const id = await confirmedInBible(maint, 'Delta', 'context-cache');

    const r = JSON.parse((await callText(plain, 'kb_invalidate', { files: ['src/delta.ts'] })).text);
    expect(r).toEqual({ invalidated: 0, files: ['src/delta.ts'], refused: [id] });
    expect(fx.row(id)?.content_hash).not.toBe('invalidated');
    expect(JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text).removed).toEqual([]);
    expect(fx.bibleIds()).toContain(id);

    const m = JSON.parse((await callText(maint, 'kb_invalidate', { files: ['src/delta.ts'] })).text);
    expect(m.invalidated).toBe(1);
    expect(JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text).removed).toEqual([{ id, reason: 'invalidated' }]);
    expect(fx.bibleIds()).not.toContain(id);
  });
});

// kb_capture with supersedes retires the matched entry, and kb_bible_commit
// removes a superseded entry from the bible. AUDN matches candidates across the
// whole per-repo DB, so without a guard any member session could retire any
// CONFIRMED entry, whoever owns it. Without the kb_maintainer grant a CONFIRMED
// target stays live: the capture links to it (refines) and reports it in
// refused. A non-CONFIRMED target, and every target in the maintainer session,
// is still retired.
//
// FALSIFICATION: dropping the keepConfirmed option in src/tools/kb-capture.ts
// fails the two plain-session CONFIRMED tests (the target is superseded and the
// next bible commit removes it).
describe('kb_capture supersedes needs the kb_maintainer grant to retire a CONFIRMED entry', () => {
  const fx = useKbMemberRepo();
  const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

  /** A CONFIRMED entry with the given tags, committed into the checkout bible. */
  async function confirmedInBible(maint: Client, name: string, tags: string[]): Promise<{ id: string; file: string }> {
    const file = `src/${name.toLowerCase()}.ts`;
    fx.writeSrc(file, `export const ${name.toLowerCase()} = 1;\n`);
    const { id } = await fx.provider.capture(fx.input({
      title: `${name} handler notes`, summary: `Summary of ${name}`, content: `Content of ${name}.`,
      symbols: [`sym${name}`], source_files: [file], tags,
    }));
    await fx.provider.promote(id, 'test fixture: verified');
    await fx.provider.promote(id, 'test fixture: verified');
    expect(fx.row(id)?.confidence).toBe('CONFIRMED');
    commitWorkTree(fx.clone);
    const r = await callText(maint, 'kb_bible_commit', { ids: [id], ...BASE });
    expect(JSON.parse(r.text).merged).toEqual([id]);
    return { id, file };
  }

  function supersede(name: string, file: string, target: string) {
    return {
      type: 'knowledge', title: `${name} handler notes`, summary: `Revised summary of ${name}`,
      content: `Revised content of ${name}, replacing the earlier note.`, symbols: [`sym${name}`],
      source_files: [file], supersedes: target,
    };
  }

  function refinesLink(fromId: string, toId: string): boolean {
    return (fx.provider as any).getDb()
      .prepare("SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND link_type = 'refines'").get(fromId, toId) !== undefined;
  }

  async function sessions() {
    const handle = await startServer();
    return {
      plain: await connect(handle.port, { member: fx.memberId }),
      maint: await connect(handle.port, { member: fx.memberId, params: MAINTAINER_PARAMS }),
    };
  }

  for (const [name, ownTag] of [['Cross', false], ['Own', true]] as const) {
    it(`a plain ?member= session cannot retire a CONFIRMED entry (${ownTag ? 'its own member tag' : 'another owner'}) via supersedes; both stay live and the bible keeps it`, async () => {
      const { plain, maint } = await sessions();
      const tags = [ownTag ? `member:${fx.memberId}` : 'member:00000000-0000-0000-0000-000000000000'];
      const { id, file } = await confirmedInBible(maint, name, tags);

      const r = await callText(plain, 'kb_capture', supersede(name, file, id));
      expect(r.isError, r.text).toBe(false);
      const body = JSON.parse(r.text);
      expect(body.audn_decision).toBe('update');
      expect(body.refused).toEqual([id]);
      expect(fx.row(id)?.superseded_at).toBeNull();
      expect(fx.row(id)?.confidence).toBe('CONFIRMED');
      expect(fx.row(body.id)).toBeDefined();
      expect(refinesLink(body.id, id)).toBe(true);

      const commit = JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text);
      expect(commit.removed).toEqual([]);
      expect(fx.bibleIds()).toContain(id);
    });
  }

  it('a plain ?member= session still supersedes a non-CONFIRMED entry (no over-blocking)', async () => {
    const { plain } = await sessions();
    fx.writeSrc('src/inferred.ts', 'export const inferred = 1;\n');
    const { id } = await fx.provider.capture(fx.input({
      title: 'Inferred handler notes', summary: 'Summary of Inferred', content: 'Content of Inferred.',
      symbols: ['symInferred'], source_files: ['src/inferred.ts'],
    }));
    const body = JSON.parse((await callText(plain, 'kb_capture', supersede('Inferred', 'src/inferred.ts', id))).text);
    expect(body.refused).toEqual([]);
    expect(fx.row(id)?.superseded_at).toBeTruthy();
  });

  it('the kb_maintainer session supersedes the CONFIRMED entry and the next bible commit removes it', async () => {
    const { maint } = await sessions();
    const { id, file } = await confirmedInBible(maint, 'Maint', []);

    const body = JSON.parse((await callText(maint, 'kb_capture', supersede('Maint', file, id))).text);
    expect(body.refused).toBeUndefined();
    expect(fx.row(id)?.superseded_at).toBeTruthy();

    const commit = JSON.parse((await callText(maint, 'kb_bible_commit', { ids: [], ...BASE })).text);
    expect(commit.removed).toEqual([{ id, reason: 'superseded' }]);
    expect(fx.bibleIds()).not.toContain(id);
  });
});
