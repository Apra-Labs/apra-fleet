import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FULL-session (self) scope from MCP client roots (src/services/session-roots.ts,
// src/services/knowledge/kb-self.ts selectFullSessionFolder):
//
//   - the first offered root inside a git repository with an origin remote
//     wins, as that repository's top level, for BOTH kb_* and code_* (one
//     session never scopes to two repos);
//   - extension for code_* only: roots offered, none with an origin -> code_*
//     uses the first offered git repository, kb_* fails with E-SELF-NO-REMOTE;
//   - no roots offered (no capability / empty list) -> the server working
//     folder, exactly as before; roots offered and none usable never fall back
//     to it;
//   - neither usable -> an E-SELF-* error naming the missing piece;
//   - a MEMBER session ignores roots.
//
// The server working folder (process.cwd(), spied) is a NON-repo temp dir in
// every roots case, or a usable repo where the case is that it must NOT be used,
// so a pass cannot come from the cwd fallback.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir,
// so every kb.sqlite lands there and the real user profile is never touched;
// the registry is the isolated test registry (backupAndResetRegistry /
// restoreRegistry); the global code-intel config read is intercepted (never
// the real home config); recordUsage is mocked (no telemetry written). Every
// temp folder lives under one scratch dir removed in afterAll, and the suite
// asserts nothing is left behind in the system temp dir.

const recordUsageSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: recordUsageSpy }));
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('code-intelligence/config.json')) {
      return JSON.stringify({ provider: 'fake-roots-index' });
    }
    return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { runWithSessionMember } from '../src/services/tool-scope.js';
import { ROOTS_RETRY_AFTER_FAILURE_MS, SessionRootsCache, toSessionRoots } from '../src/services/session-roots.js';
import { resolveSelfAnchor, resolveSelfSession, KbSelfError, validateSelfFolder } from '../src/services/knowledge/kb-self.js';
import { resolveCodeSelf, PROVIDERS, type CodeIntelligenceProvider } from '../src/tools/code-intelligence.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from './test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const INDEX_FILE = '.fake-code-index.json';
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
const TMP_PREFIX = 'kb-code-scope-roots-';

async function answerFromIndex(params: Record<string, unknown>): Promise<unknown> {
  const index = JSON.parse(fs.readFileSync(path.join(String(params.repo), INDEX_FILE), 'utf-8')) as { owner: string };
  return { content: [{ type: 'text', text: JSON.stringify({ answeredFrom: index.owner }) }] };
}
const fakeIndexProvider = Object.fromEntries(
  ['graph', 'impact', 'query', 'context', 'map', 'flow', 'tests'].map(m => [m, answerFromIndex]),
) as unknown as CodeIntelligenceProvider;

let scratch: string;
let tmpBaseline: string[];
let handle: HttpTransportHandle;
const clients: Client[] = [];
const dirs: Record<string, string> = {};
let memberId = '';

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(TMP_PREFIX));
}

function plainDir(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitRepo(name: string, withOrigin: boolean): string {
  const dir = plainDir(name);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (withOrigin) execFileSync('git', ['remote', 'add', 'origin', `https://example.test/roots-${name}-${RUN}.git`], { cwd: dir });
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({ owner: name }));
  return dir;
}

const uri = (dir: string) => pathToFileURL(dir).href;
const rootsOf = (...folders: string[]) => toSessionRoots(folders.map(f => ({ uri: uri(f) })));

/** Run fn as a FULL session tool call that sees the given roots. */
function asFull<T>(roots: ReturnType<typeof rootsOf> | undefined, fn: () => T): T {
  return runWithSessionMember(undefined, fn, { roots });
}

function selfError(fn: () => unknown): KbSelfError {
  try {
    fn();
  } catch (e) {
    if (e instanceof KbSelfError) return e;
    throw e;
  }
  throw new Error('expected a KbSelfError');
}

/** An MCP SDK client that declares the roots capability and answers roots/list from `roots`. */
async function connectWithRoots(roots: { current: string[] }, member?: string): Promise<{ client: Client; listCalls: () => number }> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const client = new Client({ name: 'kb-code-scope-roots', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  let calls = 0;
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    calls++;
    return { roots: roots.current.map(d => ({ uri: d.includes('://') ? d : uri(d), name: path.basename(d) })) };
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return { client, listCalls: () => calls };
}

async function connectPlain(): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  const client = new Client({ name: 'kb-code-scope-roots-plain', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

function answeredFrom(text: string): string {
  const providerResult = JSON.parse(text) as { content: Array<{ text: string }> };
  return (JSON.parse(providerResult.content[0].text) as { answeredFrom: string }).answeredFrom;
}

beforeAll(async () => {
  tmpBaseline = tmpEntries();
  backupAndResetRegistry();
  PROVIDERS['fake-roots-index'] = fakeIndexProvider;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)));
  dirs.cwdPlain = plainDir('server-cwd-plain');
  dirs.cwdRepo = gitRepo('server-cwd-repo', true);
  dirs.plain = plainDir('root-plain');
  dirs.plain2 = plainDir('root-plain-2');
  dirs.noOrigin = gitRepo('root-no-origin', false);
  dirs.noOrigin2 = gitRepo('root-no-origin-2', false);
  dirs.withOrigin = gitRepo('root-with-origin', true);
  dirs.withOrigin2 = gitRepo('root-with-origin-2', true);
  dirs.member = gitRepo('member-work', true);
  const agent = makeTestLocalAgent({ friendlyName: `roots-member-${RUN}`, workFolder: dirs.member, codeIntelProvider: 'fake-roots-index' as never });
  addAgent(agent);
  memberId = agent.id;
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  try { await handle?.close(); } catch { /* ignore */ }
  delete PROVIDERS['fake-roots-index'];
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
  expect(tmpEntries()).toEqual(tmpBaseline);
});

describe('FULL session scope from client roots (resolver)', () => {
  it('kb and code both resolve to the first root that is a git repo WITH an origin, past a non-repo root and a repo without origin, with a non-repo server cwd', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const roots = rootsOf(dirs.plain, dirs.noOrigin, dirs.withOrigin, dirs.withOrigin2);
    const { kb, code } = asFull(roots, () => ({ kb: resolveSelfAnchor(), code: resolveCodeSelf() }));
    expect(kb.folder).toBe(dirs.withOrigin);
    expect(code.repo).toBe(dirs.withOrigin);
    expect(code.memberId).toBeUndefined();
  });

  it('a root in a subfolder of a repo resolves to the repo top level, for kb and code alike', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const sub = path.join(dirs.withOrigin, 'packages', 'foo');
    fs.mkdirSync(sub, { recursive: true });
    const { kb, code } = asFull(rootsOf(sub), () => ({ kb: resolveSelfAnchor(), code: resolveCodeSelf() }));
    const top = fs.realpathSync.native(dirs.withOrigin);
    expect(fs.realpathSync.native(kb.folder)).toBe(top);
    expect(fs.realpathSync.native(code.repo)).toBe(top);
    expect(kb.folder).toBe(code.repo);
  });

  it('a root at the top level keeps its spelling; a subfolder of a repo without origin is the code-only extension', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    expect(asFull(rootsOf(dirs.withOrigin), () => resolveSelfAnchor()).folder).toBe(dirs.withOrigin);
    const sub = path.join(dirs.noOrigin, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const roots = rootsOf(sub);
    expect(fs.realpathSync.native(asFull(roots, () => resolveCodeSelf()).repo)).toBe(fs.realpathSync.native(dirs.noOrigin));
    expect(asFull(roots, () => selfError(() => resolveSelfAnchor())).code).toBe('E-SELF-NO-REMOTE');
  });

  it('server started in the repo, client in a subfolder of it: same repo as the server folder (as before roots)', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    const sub = path.join(dirs.cwdRepo, 'packages', 'foo');
    fs.mkdirSync(sub, { recursive: true });
    const top = fs.realpathSync.native(dirs.cwdRepo);
    expect(fs.realpathSync.native(asFull(rootsOf(sub), () => resolveSelfAnchor()).folder)).toBe(top);
    expect(asFull(undefined, () => resolveSelfAnchor()).folder).toBe(dirs.cwdRepo);
  });

  it('a server folder that is itself a repo subfolder stays refused without roots (ceiling unchanged)', () => {
    const sub = path.join(dirs.cwdRepo, 'packages', 'bar');
    fs.mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    expect(asFull(undefined, () => selfError(() => resolveSelfAnchor())).code).toBe('E-SELF-NOT-A-REPO');
  });

  it('a temp folder inside a repo that is NOT a root stays refused as a member work folder (ceiling unchanged)', () => {
    const sub = path.join(dirs.withOrigin, 'not-a-repo-itself');
    fs.mkdirSync(sub, { recursive: true });
    expect(selfError(() => validateSelfFolder(sub, 'm')).code).toBe('E-SELF-NOT-A-REPO');
  });

  it('roots that cannot carry a KB fall through to the next root, never to the server folder', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    const next = asFull(rootsOf(dirs.plain, dirs.noOrigin, dirs.withOrigin), () => resolveSelfAnchor());
    expect(next.folder).toBe(dirs.withOrigin);
  });

  it('roots offered, none with an origin: code uses the first offered git repo; kb fails with E-SELF-NO-REMOTE naming that no root has an origin', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo); // a usable cwd must NOT be used: roots were offered
    const roots = rootsOf(dirs.plain, dirs.noOrigin, dirs.noOrigin2);
    expect(asFull(roots, () => resolveCodeSelf()).repo).toBe(dirs.noOrigin);
    const err = asFull(roots, () => selfError(() => resolveSelfAnchor()));
    expect(err.code).toBe('E-SELF-NO-REMOTE');
    expect(err.message).toContain("none of the client's MCP roots");
    expect(err.message).toContain('is in a git repository with an origin remote');
    expect(err.message).toContain('open the client in a repository that has an origin remote');
    expect(err.message).toContain(`'${dirs.noOrigin}'`);
    expect(err.message.split('Remediation:').length - 1).toBe(1);
  });

  it('no roots (undefined, or an empty roots list) falls back to the server working folder exactly as before', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    for (const roots of [undefined, toSessionRoots([])]) {
      const { kb, code } = asFull(roots, () => ({ kb: resolveSelfAnchor(), code: resolveCodeSelf() }));
      expect(kb.folder).toBe(dirs.cwdRepo);
      expect(code.repo).toBe(dirs.cwdRepo);
    }
  });

  it('roots that are not folders on this host count as no roots offered (server folder), and the cwd error says so', () => {
    const remoteOnly = toSessionRoots([{ uri: uri(path.join(scratch, 'does-not-exist-here')) }, { uri: 'https://example.test/not-a-file-root' }]);
    expect(remoteOnly.offered).toHaveLength(2);
    expect(remoteOnly.folders).toEqual([]);
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    expect(asFull(remoteOnly, () => resolveSelfAnchor()).folder).toBe(dirs.cwdRepo);
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const err = asFull(remoteOnly, () => selfError(() => resolveSelfAnchor()));
    expect(err.code).toBe('E-SELF-NOT-A-REPO');
    expect(err.message).toContain('is a folder on this host');
  });

  it('no roots and a non-repo server cwd: E-SELF-NOT-A-REPO naming that the client offered no roots', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    for (const resolve of [() => resolveSelfAnchor(), () => resolveCodeSelf()]) {
      const err = asFull(undefined, () => selfError(resolve));
      expect(err.code).toBe('E-SELF-NOT-A-REPO');
      expect(err.message).toContain('the client offered no MCP roots');
      expect(err.message).toContain(`'${dirs.cwdPlain}' is not a git repository`);
      expect(err.message).toContain('Open the client in the repository');
    }
  });

  it('no roots and a server cwd without origin: kb E-SELF-NO-REMOTE naming that no roots were offered', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.noOrigin);
    const err = asFull(undefined, () => selfError(() => resolveSelfAnchor()));
    expect(err.code).toBe('E-SELF-NO-REMOTE');
    expect(err.message).toContain('the client offered no MCP roots');
    expect(err.message).toContain('has no origin remote');
  });

  it('roots offered but none in a git repository: E-SELF-NOT-A-REPO naming that and the fix, with a usable server folder NOT used (kb and code alike)', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    const roots = rootsOf(dirs.plain, dirs.plain2);
    for (const resolve of [() => resolveSelfAnchor(), () => resolveCodeSelf()]) {
      const err = asFull(roots, () => selfError(resolve));
      expect(err.code).toBe('E-SELF-NOT-A-REPO');
      expect(err.message).toContain('the client offered MCP roots, but none of them');
      expect(err.message).toContain(`'${dirs.plain}'`);
      expect(err.message).toContain(`'${dirs.plain2}'`);
      expect(err.message).toContain('Open the client in a git repository with an origin remote');
      expect(err.message).not.toContain(dirs.cwdRepo);
      expect(err.message.split('Remediation:').length - 1).toBe(1);
    }
  });

  it('a MEMBER session ignores roots and keeps its registered work folder', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const roots = rootsOf(dirs.withOrigin);
    const { self, kb, code } = runWithSessionMember(memberId, () => ({
      self: resolveSelfSession(), kb: resolveSelfAnchor(), code: resolveCodeSelf(),
    }), { roots });
    expect(self.folder).toBe(dirs.member);
    expect(self.roots).toBeUndefined();
    expect(kb.folder).toBe(dirs.member);
    expect(code.repo).toBe(dirs.member);
  });

  it('one call probes the roots once: kb and code inside the same call share the memoized selection', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const roots = rootsOf(dirs.noOrigin, dirs.withOrigin);
    const [a, b] = asFull(roots, () => [resolveSelfSession(), resolveSelfSession()]);
    expect(a).toBe(b);
    expect(a.folder).toBe(dirs.withOrigin);
  });
});

describe('SessionRootsCache', () => {
  const answer = (folders: string[]) => vi.fn(async () => ({ roots: folders.map(f => ({ uri: uri(f) })) }));

  it('asks nothing when the client lacks the roots capability', async () => {
    const send = answer([dirs.withOrigin]);
    expect(await new SessionRootsCache(() => false).get(send)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('an empty roots list is "no roots offered"', async () => {
    expect(await new SessionRootsCache(() => true).get(answer([]))).toBeUndefined();
  });

  it('fetches once, caches, and refetches after invalidate (roots/list_changed)', async () => {
    const cache = new SessionRootsCache(() => true);
    const first = answer([dirs.withOrigin]);
    expect((await cache.get(first))?.folders).toEqual([dirs.withOrigin]);
    expect((await cache.get(first))?.folders).toEqual([dirs.withOrigin]);
    expect(first).toHaveBeenCalledTimes(1);
    cache.invalidate();
    const second = answer([dirs.withOrigin2]);
    expect((await cache.get(second))?.folders).toEqual([dirs.withOrigin2]);
  });

  it('a failed fetch counts as no roots for a while, then the next call asks again', async () => {
    const cache = new SessionRootsCache(() => true);
    const failing = vi.fn(async () => { throw new Error('request timed out'); });
    expect(await cache.get(failing as never)).toBeUndefined();
    expect(await cache.get(failing as never)).toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    const later = Date.now() + ROOTS_RETRY_AFTER_FAILURE_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const recovered = answer([dirs.withOrigin]);
    expect((await cache.get(recovered))?.folders).toEqual([dirs.withOrigin]);
    expect(recovered).toHaveBeenCalledTimes(1);
    // A good answer stays cached.
    vi.spyOn(Date, 'now').mockReturnValue(later + 10 * ROOTS_RETRY_AFTER_FAILURE_MS);
    expect((await cache.get(recovered))?.folders).toEqual([dirs.withOrigin]);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe('FULL session scope from client roots over the real MCP transport', () => {
  it('a client declaring roots: code_query and kb_* both resolve to the first root with an origin, while the server cwd is not a repo', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const roots = { current: [dirs.plain, dirs.noOrigin, dirs.withOrigin] };
    const { client, listCalls } = await connectWithRoots(roots);

    const code = await call(client, 'code_query', { query: 'widget' });
    expect(code.isError, code.text).toBe(false);
    expect(answeredFrom(code.text)).toBe('root-with-origin');

    const capture = await call(client, 'kb_capture', {
      type: 'knowledge', title: `Roots scoped capture ${RUN}`, summary: 'A capture made through a roots-scoped FULL session.',
      content: 'Stored in the KB of the first client root that is a git repository with an origin remote.',
      source_files: [INDEX_FILE],
    });
    expect(capture.isError, capture.text).toBe(false);
    const captured = JSON.parse(capture.text) as { id: string };

    // The same capture is visible from a session scoped to that repo by
    // another route (a client offering ONLY that root) -- proving the KB the
    // roots session wrote is the root's KB, not some other folder's.
    const other = await connectWithRoots({ current: [dirs.withOrigin] });
    const hits = await call(other.client, 'kb_query', { query: 'Roots scoped capture', confidence: ALL_TIERS });
    expect(hits.isError, hits.text).toBe(false);
    expect((JSON.parse(hits.text) as { l1_results: Array<{ id: string }> }).l1_results.map(e => e.id)).toContain(captured.id);

    // Roots are fetched once per session, not once per call.
    expect(listCalls()).toBe(1);
  });

  it('roots/list_changed: the next call refetches and follows the new first qualifying root', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const roots = { current: [dirs.withOrigin] };
    const { client, listCalls } = await connectWithRoots(roots);
    expect(answeredFrom((await call(client, 'code_query', { query: 'w' })).text)).toBe('root-with-origin');
    roots.current = [dirs.withOrigin2];
    await client.sendRootsListChanged();
    // The notification is processed asynchronously; poll briefly for the switch.
    let owner = '';
    for (let i = 0; i < 20 && owner !== 'root-with-origin-2'; i++) {
      owner = answeredFrom((await call(client, 'code_query', { query: 'w' })).text);
      if (owner !== 'root-with-origin-2') await new Promise(r => setTimeout(r, 50));
    }
    expect(owner).toBe('root-with-origin-2');
    expect(listCalls()).toBeGreaterThanOrEqual(2);
  });

  it('a client opened in a repo subfolder: code_query and kb_stats answer for the repo', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const sub = path.join(dirs.withOrigin, 'packages', 'over-http');
    fs.mkdirSync(sub, { recursive: true });
    const { client } = await connectWithRoots({ current: [sub] });
    const code = await call(client, 'code_query', { query: 'w' });
    expect(code.isError, code.text).toBe(false);
    expect(answeredFrom(code.text)).toBe('root-with-origin');
    const kb = await call(client, 'kb_stats');
    expect(kb.isError, kb.text).toBe(false);
  });

  it('one non-file root does not drop the file roots in the same list', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const { client } = await connectWithRoots({ current: ['https://example.test/not-a-file-root', dirs.withOrigin] });
    const code = await call(client, 'code_query', { query: 'w' });
    expect(code.isError, code.text).toBe(false);
    expect(answeredFrom(code.text)).toBe('root-with-origin');
  });

  it('roots offered, none with an origin: code_query uses the first git repo, kb_stats fails with E-SELF-NO-REMOTE', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    const { client } = await connectWithRoots({ current: [dirs.plain, dirs.noOrigin] });
    expect(answeredFrom((await call(client, 'code_query', { query: 'w' })).text)).toBe('root-no-origin');
    const kb = await call(client, 'kb_stats');
    expect(kb.isError).toBe(true);
    expect(kb.text).toContain('E-SELF-NO-REMOTE');
    expect(kb.text).toContain("none of the client's MCP roots");
  });

  it('a client without the roots capability keeps the server working folder', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdRepo);
    const out = await call(await connectPlain(), 'code_query', { query: 'w' });
    expect(out.isError, out.text).toBe(false);
    expect(answeredFrom(out.text)).toBe('server-cwd-repo');
  });

  it('a MEMBER session over HTTP never asks for roots and answers from its registered work folder', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwdPlain);
    const { client, listCalls } = await connectWithRoots({ current: [dirs.withOrigin] }, memberId);
    const out = await call(client, 'code_query', { query: 'w' });
    expect(out.isError, out.text).toBe(false);
    expect(answeredFrom(out.text)).toBe('member-work');
    expect(listCalls()).toBe(0);
  });
});
