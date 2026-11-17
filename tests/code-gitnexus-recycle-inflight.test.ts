import { describe, it, expect, vi, beforeEach } from 'vitest';

// Concurrent code_* calls for different repos survive a gitnexus child recycle.
//
// ONE gitnexus child serves every repo. When repo A's index generation
// changes, the next call for A recycles that child. Before reference-counted
// recycling, the recycle closed the child immediately, so a call for repo B
// already running on it died with a transport error. This file pins the fix:
// B's in-flight call completes on the old child, the old child is closed
// exactly once AFTER B's call resolves, and A's call runs on a fresh child.
//
// FALSIFICATION: making recycleConnection() close the old child immediately
// (the pre-fix behaviour) fails the first test -- the fake child rejects its
// in-flight calls on close(), exactly as a real stdio child does when its
// transport goes away, so B's call comes back as the offline isError result.
//
// Isolation: the MCP Client and stdio transport are mocks (no process is
// spawned), and the index readiness/generation are injected, so nothing is
// read from or written to disk.

interface Deferred { resolve: (v: unknown) => void; reject: (e: Error) => void }
interface FakeChild {
  id: number;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  pending: Set<Deferred>;
}

const h = vi.hoisted(() => ({
  children: [] as FakeChild[],
  events: [] as string[],
  generation: new Map<string, string>(),
  /** repo -> true when that repo's next callTool should block until released. */
  slow: new Map<string, Deferred & { started: boolean }>(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    child: FakeChild;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
      const id = h.children.length + 1;
      const pending = new Set<Deferred>();
      const child: FakeChild = {
        id,
        pending,
        callTool: vi.fn(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
          const repo = String(args.repo);
          h.events.push(`call:${id}:${repo}`);
          const gate = h.slow.get(repo);
          if (gate && !gate.started) {
            gate.started = true;
            await new Promise((resolve, reject) => {
              const d: Deferred = { resolve, reject };
              pending.add(d);
              gate.resolve = (v) => { pending.delete(d); resolve(v); };
            });
          }
          h.events.push(`done:${id}:${repo}`);
          return { content: [{ type: 'text', text: `${name} answer for ${repo} from child ${id}` }] };
        }),
        // Like a real stdio child: closing it kills every call still running on it.
        close: vi.fn(async () => {
          h.events.push(`close:${id}`);
          for (const d of pending) d.reject(new Error('MCP error -32000: Connection closed'));
          pending.clear();
        }),
      };
      this.child = child;
      h.children.push(child);
    }
    connect = vi.fn(async () => undefined);
    callTool(args: unknown) { return this.child.callTool(args); }
    close() { return this.child.close(); }
  }
  return { Client: MockClient };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransport { onclose?: () => void; onerror?: () => void }
  return { StdioClientTransport: MockTransport };
});
vi.mock('../src/utils/find-on-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/find-on-path.js')>();
  return { ...actual, npxUnavailableReason: () => null };
});
vi.mock('../src/tools/code-intelligence-readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence-readiness.js')>();
  return { ...actual, codeIndexReadiness: () => ({ ready: true }), ensureGitNexusIndexReady: () => undefined };
});
vi.mock('../src/tools/code-index-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/code-index-state.js')>();
  return {
    ...actual,
    readGitNexusIndexState: (repo: string) => ({ repo }),
    indexGeneration: (state: { repo: string }) => h.generation.get(state.repo) ?? '',
  };
});

import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';

// Paths that do not exist: the freshness note degrades to "no note".
const REPO_A = '/nonexistent/gitnexus-recycle/repo-a';
const REPO_B = '/nonexistent/gitnexus-recycle/repo-b';

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]).text;
}

async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!fn()) throw new Error('condition never became true');
}

describe('gitnexus child recycle with calls in flight for other repos', () => {
  beforeEach(() => {
    h.events.length = 0;
    h.slow.clear();
  });

  it('B completes on the old child, which closes exactly once after B resolves; A runs on a fresh child', async () => {
    const provider = new GitNexusProvider();
    const base = h.children.length;
    h.generation.set(REPO_A, 'gen-a-1');
    h.generation.set(REPO_B, 'gen-b-1');

    // A is served once, so the shared child records A's generation.
    expect(textOf(await provider.query({ query: 'x', repo: REPO_A }))).toContain(`child ${base + 1}`);
    const old = h.children[base];

    // A slow call for B starts on that same child.
    const gate = { started: false, resolve: (_v: unknown) => {}, reject: (_e: Error) => {} };
    h.slow.set(REPO_B, gate);
    const bCall = provider.query({ query: 'y', repo: REPO_B });
    await until(() => gate.started);

    // A's index generation changes: the next A call recycles the child.
    h.generation.set(REPO_A, 'gen-a-2');
    const aResult = await provider.query({ query: 'z', repo: REPO_A });
    expect(h.children.length).toBe(base + 2);
    const fresh = h.children[base + 1];
    expect(textOf(aResult)).toContain(`child ${fresh.id}`);
    expect(fresh.callTool).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    const bResult = await bCall;
    // B's in-flight call completed on the old child -- not the offline
    // isError result a transport death would produce.
    expect(textOf(bResult)).toBe(`query answer for ${REPO_B} from child ${old.id}`);
    expect((bResult as { isError?: boolean }).isError).toBeUndefined();

    // The old child was retired, not closed, while B ran on it: its one
    // close() comes after B's call finished.

    expect(old.close).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf(`close:${old.id}`)).toBeGreaterThan(h.events.indexOf(`done:${old.id}:${REPO_B}`));
    expect(fresh.close).not.toHaveBeenCalled();

    // Later calls for either repo stay on the fresh child; no third child.
    await provider.query({ query: 'w', repo: REPO_B });
    await provider.query({ query: 'v', repo: REPO_A });
    expect(h.children.length).toBe(base + 2);
    expect(old.callTool).toHaveBeenCalledTimes(2);
    expect(old.close).toHaveBeenCalledTimes(1);
  });

  it('a recycle with nothing in flight closes the old child immediately', async () => {
    const provider = new GitNexusProvider();
    h.generation.set(REPO_A, 'gen-a-10');
    await provider.query({ query: 'x', repo: REPO_A });
    const current = h.children[h.children.length - 1];
    h.generation.set(REPO_A, 'gen-a-11');
    await provider.query({ query: 'x', repo: REPO_A });
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(h.children[h.children.length - 1]).not.toBe(current);
  });
});
