// Per-session MCP client roots for FULL (non-member) sessions.
//
// A FULL session's kb_* and code_* scope comes from the client's roots
// (MCP roots/list): the first offered root inside a git repository with an
// origin remote wins (src/services/knowledge/kb-self.ts). The server's working
// folder is used only when the client offers no roots: it lacks the capability
// or returns an empty list.
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
//   - a failed or timed-out fetch is its own state, not "no roots": it is logged,
//     never cached, and the call is refused (kb-self.ts), so unknown roots can
//     never answer from, or write to, the server's working folder. The next call
//     asks again, so a client that never answers costs one timeout per call.
//
// Roots are file:// URIs. Each is converted with fileURLToPath; a root that is
// not a file URI or does not name an existing directory on THIS host (a remote
// HTTP client's roots are paths on its own machine, or a path was deleted) is
// kept in `offered` but left out of `folders`: an unusable root, refused when
// nothing else is usable.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SessionRoots } from './tool-scope.js';
import { logLine } from '../utils/log-helpers.js';

export type { SessionRoots } from './tool-scope.js';

/** Bound on one roots/list round trip. */
export const ROOTS_FETCH_TIMEOUT_MS = 5000;
// Deliberately looser than the SDK's ListRootsResultSchema, which requires every
// uri to be file:// and so would reject the whole list over one other root.
// toSessionRoots skips what is not a local folder.
export const LenientListRootsResultSchema = z.object({
  roots: z.array(z.object({ uri: z.string() }).passthrough()),
}).passthrough();

/** The extra.sendRequest a tool handler receives from the MCP SDK. */
export type RootsSendRequest = (
  request: { method: 'roots/list'; params?: Record<string, unknown> },
  schema: typeof LenientListRootsResultSchema,
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

function rootsFetchFailed(fetchError: string): SessionRoots {
  return { offered: [], folders: [], fetchError };
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
   * The session's roots: undefined when the client lacks the roots capability
   * or returned an empty list ("no roots offered"); `fetchError` set when it
   * declared the capability but could not be asked or the fetch failed.
   */
  async get(sendRequest: RootsSendRequest | undefined): Promise<SessionRoots | undefined> {
    if (!this.clientDeclaresRoots()) return undefined;
    if (this.fetched) return this.snapshot;
    if (typeof sendRequest !== 'function') return rootsFetchFailed('the call has no way to ask the client');
    if (!this.inflight) {
      const gen = this.generation;
      this.inflight = (async () => {
        let snap: SessionRoots | undefined;
        try {
          const res = await sendRequest({ method: 'roots/list' }, LenientListRootsResultSchema, { timeout: this.timeoutMs });
          const s = toSessionRoots(res?.roots ?? []);
          snap = s.offered.length > 0 ? s : undefined;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logLine('session', `roots/list failed, refusing this call: ${message}`);
          return rootsFetchFailed(message);
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
