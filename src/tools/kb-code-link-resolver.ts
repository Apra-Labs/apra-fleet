// Tool-layer CodeLinkResolver for the KB (design D2a anchors): resolves a KB
// entry's symbols and files to code-index nodes through the active
// code-intelligence provider.
//
// Why it lives here and is INJECTED into SqliteProvider: the provider is in
// src/services and must not import src/tools/code-intelligence.ts (src/tools
// already imports the KB service; see the header of
// code-intelligence-kb-enrich.ts). The kb_capture and kb_freshness_sweep
// handlers attach the resolver to the project SqliteProvider before they call
// it.
//
// Resolution:
//   file    resolved when it exists under the repo folder (no index lookup
//           needed; the hybrid search intersects on the path).
//   symbol  code_context on the provider; resolved when the index finds it,
//           neighbours = the names of its one-hop callers and callees.
// No usable code index (provider none, E-CODE-INTEL-DISABLED,
// E-CODE-INDEX-NOT-READY, or no provider configured) -> null, which the KB
// records as a skip. Readiness is checked FIRST with the side-effect-free
// codeIndexReadiness: a KB capture must never spawn a code-intelligence child
// for a missing index or start an index build (the code_* tools' pre-flight
// heals a missing index; this path deliberately does not). A per-symbol
// failure of any other kind marks that symbol unresolved; it never fails the
// capture.

import fs from 'node:fs';
import path from 'node:path';
import type { CodeLinkItem, CodeLinkResolver, ResolvedCodeLink } from '../services/knowledge/code-links.js';
import { SqliteProvider } from '../services/knowledge/sqlite-provider.js';
// Type-only at module load: code-intelligence.js (and its registry imports) is
// loaded lazily on the first resolve, so kb_capture's module graph stays light.
import type { CodeIntelligenceProvider } from './code-intelligence.js';

/** Error codes that mean "no usable code index here" (skip, keep existing links). */
const NO_INDEX_CODES = new Set(['E-CODE-INDEX-NOT-READY', 'E-CODE-INTEL-DISABLED']);

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The JSON payload of an MCP text result (the gitnexus hint suffix stripped). */
function payloadOf(result: unknown): Record<string, unknown> | null {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = (content[0] as { text?: unknown })?.text;
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text.split('\n\n---\n')[0]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function namesOf(list: unknown, self: string): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { name, uid } = item as { name?: unknown; uid?: unknown };
    // File-level callers (a test file calling the symbol) are not symbols.
    if (typeof uid === 'string' && uid.startsWith('File:')) continue;
    if (typeof name === 'string' && name !== '' && name !== self) out.push(name);
  }
  return out;
}

/** Interpret a code_context result for symbol `name`. Exported for tests. */
export function interpretContextResult(name: string, result: unknown): ResolvedCodeLink {
  const base = { kind: 'symbol' as const, ref: name };
  if ((result as { isError?: unknown })?.isError === true) return { ...base, resolved: false };
  const p = payloadOf(result);
  if (!p) return { ...base, resolved: false };
  const status = p.status;
  if (typeof status === 'string' && status !== 'found') return { ...base, resolved: false };
  const incoming = p.incoming as Record<string, unknown> | undefined;
  const outgoing = p.outgoing as Record<string, unknown> | undefined;
  const neighbours = [
    ...namesOf(incoming?.calls, name),
    ...namesOf(outgoing?.calls, name),
    ...namesOf(p.callers, name),
    ...namesOf(p.callees, name),
  ];
  return { ...base, resolved: true, neighbours: [...new Set(neighbours)] };
}

export interface KbCodeLinkResolverOptions {
  /** Provider seam (tests); default the member's / global configured provider. */
  provider?: () => Promise<CodeIntelligenceProvider>;
  /** Readiness seam (tests); default codeIndexReadiness for the configured provider key. */
  indexReady?: () => Promise<boolean>;
}

async function defaultIndexReady(ci: typeof import('./code-intelligence.js'), memberId: string | undefined, root: string): Promise<boolean> {
  const key = await ci.resolveProviderKey(memberId);
  if (key !== 'gitnexus' && key !== 'codebase-memory') return false;
  const { codeIndexReadiness } = await import('./code-intelligence-readiness.js');
  return codeIndexReadiness(key, root).ready;
}

/** A resolver bound to one local repo folder (and the member whose provider applies). */
export function kbCodeLinkResolverFor(repo: string, memberId?: string, opts: KbCodeLinkResolverOptions = {}): CodeLinkResolver {
  const root = path.resolve(repo);
  return async (items: CodeLinkItem[]) => {
    let provider: CodeIntelligenceProvider;
    let ci: typeof import('./code-intelligence.js');
    try {
      ci = await import('./code-intelligence.js');
      if (opts.provider) {
        provider = await opts.provider();
      } else {
        const key = await ci.resolveProviderKey(memberId);
        if (key === 'none') return null;
        provider = ci.PROVIDERS[key];
      }
      if (provider instanceof ci.NullProvider) return null;
      const ready = opts.indexReady
        ? await opts.indexReady()
        : opts.provider !== undefined || await defaultIndexReady(ci, memberId, root);
      if (!ready) return null;
    } catch {
      return null; // no provider configured here, or readiness unknown
    }
    const out: ResolvedCodeLink[] = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const abs = path.resolve(root, it.ref);
        const inside = abs === root || abs.startsWith(root + path.sep);
        out.push({ ...it, resolved: inside && fs.existsSync(abs) });
        continue;
      }
      try {
        out.push(interpretContextResult(it.ref, await provider.context({ name: it.ref, repo: root })));
      } catch (err) {
        if (NO_INDEX_CODES.has(errorCode(err) ?? '')) return null;
        out.push({ ...it, resolved: false });
      }
    }
    return out;
  };
}

/**
 * Attach a resolver to `provider` when it is a SqliteProvider anchored at a
 * folder that exists on this host and has none yet. Skipped for the global KB
 * (no anchor), a remote member's folder (not on this host: its code index is
 * not here either) and any non-sqlite provider. Never throws.
 */
export function ensureKbCodeLinkResolver(provider: unknown, memberId?: string): void {
  try {
    if (!(provider instanceof SqliteProvider) || provider.hasCodeResolver) return;
    const repo = provider.repoPath;
    if (!repo || !fs.existsSync(repo)) return;
    provider.attachCodeResolver(kbCodeLinkResolverFor(repo, memberId));
  } catch {
    // Code links are an optional aid; never let them fail the KB call.
  }
}
