import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// kb (self) resolution end to end over REAL HTTP: the real createHttpTransport,
// the real registerAllTools per session, a real MCP SDK client, real kb_*
// handlers and real sqlite KBs. No kb_* request carries a scope argument; the
// KB a call reads/writes is the calling session's own
// (src/services/knowledge/kb-self.ts):
//   - MEMBER session (?member=<uuid>) -> the member's registered work folder
//   - FULL session (no identity)      -> the server's working folder
// A folder that cannot carry a KB identity is refused with a typed error that
// carries a one-line remediation.
//
// Isolation: the registry is the isolated test registry (tests/setup.ts points
// APRA_FLEET_DATA_DIR at a per-run temp dir, so every kb.sqlite lands there;
// backupAndResetRegistry/restoreRegistry leave the registry as found). The
// member work folders are temp git repos under one scratch root, removed in
// afterAll, with per-run unique origin remotes so each run gets fresh KBs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../../src/services/http-transport.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { addAgent } from '../../src/services/registry.js';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const remoteFor = (name: string) => `https://example.test/kb-self-${name}-${RUN}.git`;
const SCOPE_FIELDS = ['repo', 'repo_path', 'repo_remote_url'];
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];

let scratch: string;
let handle: HttpTransportHandle;
const clients: Client[] = [];
const members: Record<string, string> = {};
const folders: Record<string, string> = {};

function gitRepo(name: string, withRemote: boolean): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', `${name}.ts`), `export const ${name.replace(/-/g, '_')} = 1;\n`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (withRemote) execFileSync('git', ['remote', 'add', 'origin', remoteFor(name)], { cwd: dir });
  return dir;
}

function register(key: string, workFolder: string): void {
  const agent = makeTestLocalAgent({ friendlyName: `kb-self-${key}-${RUN}`, workFolder });
  addAgent(agent);
  members[key] = agent.id;
  folders[key] = workFolder;
}

function registerRemote(key: string, gitRepos: string[]): void {
  const agent = makeTestAgent({
    friendlyName: `kb-self-${key}-${RUN}`, workFolder: `/home/testuser/kb-self-${key}-${RUN}`, gitRepos,
  });
  addAgent(agent);
  members[key] = agent.id;
  folders[key] = agent.workFolder;
}

async function connect(member?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const client = new Client({ name: 'kb-self-e2e', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT }));
  return client;
}

interface CallOutcome { isError: boolean; text: string }

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const out = await call(client, name, args);
  expect(out.isError, `${name} failed: ${out.text}`).toBe(false);
  return JSON.parse(out.text);
}

function capture(key: string, title: string): Record<string, unknown> {
  return {
    type: 'knowledge',
    title,
    summary: `${title} -- a fact only the ${key} repo knows.`,
    content: `${title}. Captured by the kb self-resolution end-to-end test.`,
    source_files: [`src/${key}.ts`],
  };
}

beforeAll(async () => {
  backupAndResetRegistry();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-self-e2e-'));
  register('alpha', gitRepo('alpha', true));
  register('beta', gitRepo('beta', true));
  register('missing', path.join(scratch, 'no-such-work-folder'));
  const plain = path.join(scratch, 'plain');
  fs.mkdirSync(plain);
  register('plain', plain);
  register('noremote', gitRepo('noremote', false));
  // Remote members: the work folder is on another host (it does not exist here).
  registerRemote('remote', [remoteFor('remote')]);
  registerRemote('remotenone', []);
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  try { await handle?.close(); } catch { /* ignore */ }
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb (self): two MEMBER sessions on one server each operate on their own member folder', () => {
  it('kb_query and kb_list resolve each member\'s own KB with no scope argument; a capture by A is invisible to B', async () => {
    const alpha = await connect(members.alpha);
    const beta = await connect(members.beta);

    const captured = await callJson(alpha, 'kb_capture', capture('alpha', 'Alpha widget cache is keyed per tenant'));
    expect(typeof captured.id).toBe('string');

    const alphaHits = await callJson(alpha, 'kb_query', { query: 'widget tenant', confidence: ALL_TIERS });
    expect(alphaHits.l1_results.map((e: { id: string }) => e.id)).toContain(captured.id);

    // Cross-member isolation: member B's session resolves B's folder, so the
    // entry member A captured is not there.
    const betaHits = await callJson(beta, 'kb_query', { query: 'widget tenant', confidence: ALL_TIERS });
    expect(betaHits.l1_results.map((e: { id: string }) => e.id)).not.toContain(captured.id);

    // An explicit all-tier read is answered from each member's per-repo KB
    // (kb_stats in a member session reports the checkout bible view instead).
    const alphaList = await callJson(alpha, 'kb_list', { confidence: ALL_TIERS });
    const betaList = await callJson(beta, 'kb_list', { confidence: ALL_TIERS });
    expect(alphaList.total).toBe(1);
    expect(betaList.total).toBe(0);
  });

  it('the KB each member session opens is identified by that member folder\'s origin remote', async () => {
    const alphaProviders = await getKbProviders(folders.alpha);
    const betaProviders = await getKbProviders(folders.beta);
    expect(alphaProviders.projectSlug).toBe(resolveProjectSlug(undefined, remoteFor('alpha')));
    expect(betaProviders.projectSlug).toBe(resolveProjectSlug(undefined, remoteFor('beta')));
    expect(alphaProviders.projectSlug).not.toBe(betaProviders.projectSlug);
  });
});

describe('kb (self): typed E-SELF errors carry a one-line remediation', () => {
  it('E-SELF-NO-WORKFOLDER when the member work folder does not exist', async () => {
    const out = await call(await connect(members.missing), 'kb_query', { query: 'anything' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-SELF-NO-WORKFOLDER/);
    expect(out.text).toContain(folders.missing);
    expect(out.text).toMatch(/Remediation: Create the folder or re-register the member/);
  });

  it('E-SELF-NOT-A-REPO when the member work folder is not a git repository', async () => {
    const out = await call(await connect(members.plain), 'kb_stats');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-SELF-NOT-A-REPO/);
    expect(out.text).toMatch(/Remediation: Run 'git init'/);
  });

  it('E-SELF-NO-REMOTE when the member work folder has no origin remote', async () => {
    const out = await call(await connect(members.noremote), 'kb_list');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-SELF-NO-REMOTE/);
    expect(out.text).toMatch(/Remediation: Run 'git remote add origin <url>'/);
  });

  it('a refused session writes nothing -- the error is raised before any KB is opened', async () => {
    const out = await call(await connect(members.noremote), 'kb_capture', capture('noremote', 'Never stored anywhere'));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-SELF-NO-REMOTE/);
  });
});

describe('kb (self): a FULL session resolves the server working folder', () => {
  it('kb_capture over a FULL session lands in the KB of the server cwd repo, not in any member KB', async () => {
    const serverRepo = gitRepo('server', true);
    vi.spyOn(process, 'cwd').mockReturnValue(serverRepo);
    const full = await connect();

    const captured = await callJson(full, 'kb_capture', capture('server', 'Server repo routes jobs by queue name'));

    const fullHits = await callJson(full, 'kb_query', { query: 'routes jobs queue', confidence: ALL_TIERS });
    expect(fullHits.l1_results.map((e: { id: string }) => e.id)).toContain(captured.id);
    const serverProviders = await getKbProviders(serverRepo);
    expect(serverProviders.projectSlug).toBe(resolveProjectSlug(undefined, remoteFor('server')));

    const alphaHits = await callJson(await connect(members.alpha), 'kb_query', { query: 'routes jobs queue', confidence: ALL_TIERS });
    expect(alphaHits.l1_results.map((e: { id: string }) => e.id)).not.toContain(captured.id);
  });

  it('a FULL session whose working folder has no origin remote is refused with E-SELF-NO-REMOTE naming the cause and the fix', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.noremote);
    const out = await call(await connect(), 'kb_stats');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-SELF-NO-REMOTE: This is a FULL session \(no member identity\), so its KB is the fleet server's own working folder, not the calling client's directory; '[^']+' has no origin remote/);
    expect(out.text).toMatch(/Remediation: Restart the fleet server with its working folder set to the repository whose KB you want, or call from a member session \(\?member=<id>\)/);
    expect(out.text).toContain("git remote add origin <url>");
  });

  it('a FULL session whose working folder is not a repository is refused with E-SELF-NOT-A-REPO naming the cause and the fix', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.plain);
    const out = await call(await connect(), 'kb_query', { query: 'anything' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-SELF-NOT-A-REPO: This is a FULL session (no member identity), so its KB is the fleet server's own working folder, not the calling client's directory; '${folders.plain}' is not a git repository.`);
    expect(out.text).toMatch(/Remediation: Restart the fleet server with its working folder set to the repository whose KB you want, or call from a member session \(\?member=<id>\) of a member registered on that repository\./);
  });
});

describe('kb (self): the removed scope keys are refused, never silently stripped', () => {
  it('every kb_* tool listed over HTTP carries repo, repo_path, repo_remote_url only as REMOVED markers', async () => {
    const tools = (await (await connect()).listTools()).tools.filter(t => t.name.startsWith('kb_'));
    expect(tools.length).toBe(18);
    const offenders = tools.flatMap(t => SCOPE_FIELDS
      .filter(f => !/^REMOVED -- /.test(((t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {})[f]?.description ?? ''))
      .map(f => `${t.name}.${f}`));
    expect(offenders).toEqual([]);
  });

  it('a scope argument sent over HTTP fails with E-SCOPE-KEY-REMOVED and redirects nothing', async () => {
    const beta = await connect(members.beta);
    const out = await call(beta, 'kb_list', { confidence: ALL_TIERS, repo_path: folders.alpha, repo_remote_url: remoteFor('alpha') });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("E-SCOPE-KEY-REMOVED: kb_list no longer accepts 'repo_path', 'repo_remote_url'");
    expect(out.text).toContain('Remediation: repo_path: nothing -- drop it');
    // A write carrying one is refused before any KB is opened: alpha's KB is unchanged.
    const before = (await callJson(await connect(members.alpha), 'kb_list', { confidence: ALL_TIERS })).total;
    const refused = await call(beta, 'kb_capture', { ...capture('alpha', 'Never stored via a removed key'), repo_path: folders.alpha });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("E-SCOPE-KEY-REMOVED: kb_capture no longer accepts 'repo_path'");
    expect((await callJson(await connect(members.alpha), 'kb_list', { confidence: ALL_TIERS })).total).toBe(before);
  });

  it('kb_list accepts the legacy single-tier string over HTTP', async () => {
    const alpha = await connect(members.alpha);
    const asString = await callJson(alpha, 'kb_list', { confidence: 'INFERRED' });
    const asArray = await callJson(alpha, 'kb_list', { confidence: ['INFERRED'] });
    expect(asString.total).toBeGreaterThan(0);
    expect(asString).toEqual(asArray);
  });
});

describe('kb (self): a REMOTE member session resolves the KB from its single known origin remote', () => {
  it('a remote member with one git_repos entry reads the KB for that URL\'s slug', async () => {
    // Seed the KB for the remote's slug from a local checkout of the same
    // origin (the KB file is keyed by the slug, not the folder). The entry is
    // tagged as the remote member's own capture: an explicit all-tier member
    // read returns only those.
    const seedDir = gitRepo('remoteseed', false);
    execFileSync('git', ['remote', 'add', 'origin', remoteFor('remote')], { cwd: seedDir });
    const seedProviders = await getKbProviders(seedDir);
    const slug = resolveProjectSlug(undefined, remoteFor('remote'));
    expect(seedProviders.projectSlug).toBe(slug);
    const { id } = await seedProviders.project.capture({
      type: 'knowledge', title: 'Remote gateway retries idempotent calls',
      summary: 'Remote gateway retries idempotent calls up to three times.',
      content: 'The remote gateway retries idempotent calls.', source_files: ['src/remoteseed.ts'],
      symbols: ['remoteGateway'], tags: [`member:${members.remote}`], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'session', confidence: 'INFERRED',
    } as any);

    const remote = await connect(members.remote);
    const hits = await callJson(remote, 'kb_query', { query: 'gateway retries idempotent', confidence: ALL_TIERS });
    expect(hits.l1_results.map((e: { id: string }) => e.id)).toContain(id);
    const listed = await callJson(remote, 'kb_list', { confidence: ALL_TIERS });
    expect(listed.results.map((e: { id: string }) => e.id)).toContain(id);

    // A local member on a different origin does not see it.
    const alphaHits = await callJson(await connect(members.alpha), 'kb_query', { query: 'gateway retries idempotent', confidence: ALL_TIERS });
    expect(alphaHits.l1_results.map((e: { id: string }) => e.id)).not.toContain(id);
  });

  it('a remote member with no known origin remote gets E-SELF-NO-REMOTE with the update_member remediation', async () => {
    const out = await call(await connect(members.remotenone), 'kb_query', { query: 'anything', confidence: ALL_TIERS });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-SELF-NO-REMOTE: Member 'kb-self-remotenone-${RUN}' work folder '${folders.remotenone}' is on another host and the member has no single known origin remote, so it has no KB identity.`);
    expect(out.text).toContain('Remediation: Record the repo\'s origin URL on the member (update_member git_repos: ["<origin url>"]) or call kb tools from a session on the member\'s own host.');
  });
});
