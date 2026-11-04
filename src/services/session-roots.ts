// Per-session MCP client roots for FULL (non-member) sessions.
//
// A FULL session's kb_* and code_* scope comes from the client's roots
// (MCP roots/list): the first offered root that is a git repository with an
// origin remote wins (src/services/knowledge/kb-self.ts). The server's working
// folder is used only when the client offers no roots.
//
// Scope resolution is synchronous and runs inside many handlers, so the async
// roots/list round trip happens here, once per session, and the result is
// cached:
//
//   - fetched lazily on the first kb_*/code_* call of the session, through
//     that call's own request context (extra.sendRequest), so the server ->
//     client request rides the call's response stream -- an HTTP client need
//     not hold a standalone GET stream open for it;
//   - only when the client declared the roots capability at initialize;
//   - invalidated on notifications/roots/list_changed (next call refetches);
//   - a failed or timed-out fetch is logged and cached as "no roots" until the
//     client reports a change, so a client that never answers costs one
//     timeout per session, not one per call.
//
// Roots are file:// URIs. Each is converted with fileURLToPath; a root that is
// not a file URI or does not name an existing directory on THIS host (a remote
// HTTP client's roots are paths on its own machine) is kept in `offered` but
// left out of `folders`.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ListRootsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SessionRoots } from './tool-scope.js';
import { logLine } from '../utils/log-helpers.js';

export type { SessionRoots } from './tool-scope.js';

/** Bound on one roots/list round trip. */
export const ROOTS_FETCH_TIMEOUT_MS = 5000;

/** The extra.sendRequest a tool handler receives from the MCP SDK. */
export type RootsSendRequest = (
  request: { method: 'roots/list'; params?: Record<string, unknown> },
  schema: typeof ListRootsResultSchema,
  options?: { timeout?: number },
) => Promise<{ roots: Array<{ uri: string; name?: string }> }>;

/** Convert a roots/list answer into offered URIs plus the local folders among them. */
export function toSessionRoots(roots: ReadonlyArray<{ uri: string }>): SessionRoots {
  const offered: string[] = [];
  const folders: string[] = [];
  for (const r of roots) {
    if (!r || typeof r.uri !== 'string') continue;
    offered.push(r.uri);
    let p: string;
    try {
      if (!r.uri.startsWith('file:')) continue;
      p = fileURLToPath(r.uri);
    } catch {
      continue;
    }
    try {
      if (fs.statSync(p).isDirectory()) folders.push(p);
    } catch {
      // not on this host
    }
  }
  return { offered, folders };
}

export class SessionRootsCache {
  private snapshot: SessionRoots | undefined;
  private fetched = false;
  private generation = 0;
  private inflight: Promise<SessionRoots | undefined> | null = null;

  constructor(
    /** True when the client declared the roots capability at initialize. */
    private readonly clientDeclaresRoots: () => boolean,
    private readonly timeoutMs: number = ROOTS_FETCH_TIMEOUT_MS,
  ) {}

  /** notifications/roots/list_changed: the next get() refetches. */
  invalidate(): void {
    this.generation++;
    this.fetched = false;
    this.snapshot = undefined;
  }

  /**
   * The session's roots: undefined when the client lacks the roots capability,
   * returned an empty list, could not be asked (no sendRequest), or the fetch
   * failed. An empty roots list is reported as undefined -- "no roots offered".
   */
  async get(sendRequest: RootsSendRequest | undefined): Promise<SessionRoots | undefined> {
    if (!this.clientDeclaresRoots()) return undefined;
    if (this.fetched) return this.snapshot;
    if (typeof sendRequest !== 'function') return undefined;
    if (!this.inflight) {
      const gen = this.generation;
      this.inflight = (async () => {
        let snap: SessionRoots | undefined;
        try {
          const res = await sendRequest({ method: 'roots/list' }, ListRootsResultSchema, { timeout: this.timeoutMs });
          const s = toSessionRoots(res?.roots ?? []);
          snap = s.offered.length > 0 ? s : undefined;
        } catch (e) {
          logLine('session', `roots/list failed, using the server working folder: ${e instanceof Error ? e.message : String(e)}`);
          snap = undefined;
        }
        if (gen === this.generation) {
          this.snapshot = snap;
          this.fetched = true;
        }
        return snap;
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }
}
