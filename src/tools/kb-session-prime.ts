import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { getProvider } from './code-intelligence.js';
import type { KBEntry } from '../services/knowledge/types.js';
import { FLEET_DIR } from '../paths.js';

export const kbSessionPrimeSchema = z.object({
  session_files: z.array(z.string()).optional().describe('Files the agent expects to touch this session'),
  hint_symbols: z.array(z.string()).optional().describe('Symbols likely to be relevant'),
  hint_modules: z.array(z.string()).optional().describe('Module names likely to be relevant'),
  // F4 (T1.6): repo path resolution precedence for the canonical-bible
  // cold-seed below -- (1) this explicit repo_path input, validated (must
  // exist and be a directory); (2) validated session context -- this
  // process's own working directory, used ONLY when repo_path is omitted,
  // put through the exact same existence + isDirectory check, never trusted
  // blindly; (3) neither validates -- the cold-seed block is skipped
  // silently (the existing non-fatal hard-skip contract: prime must never
  // fail because the repo root could not be validated). There is no bare
  // process.cwd() fallback: the fallback tier is validated the same way
  // explicit input is.
  repo_path: z.string().optional().describe('Repo root for the canonical-bible cold-seed (.fleet/kb-canonical.json). Precedence: this explicit input, when given and valid, wins; otherwise falls back to the validated session working directory; if neither validates, the cold-seed merge is skipped silently.'),
});

export type KbSessionPrimeInput = z.infer<typeof kbSessionPrimeSchema>;

// Graph-neighbor expansion caps (T1.3 P4b, design D4). Exported for tests.
// NEIGHBOR_CAP: max distinct neighbor symbols carried into the extra KB query.
export const NEIGHBOR_CAP = 10;
// ADDED_ENTRY_CAP: max neighbor-derived KB entries appended to top_entries.
export const ADDED_ENTRY_CAP = 5;

// T3.5 (F8c, D8): fewer than this many top_entries after ALL merges above
// (direct hits + global-append + graph-neighbor) counts as a cold local KB,
// triggering the canonical-bible cold-seed below. Exported for tests.
export const COLD_KB_MAX = 3;

// Shape written by kb_export (T3.4) to <repo>/.fleet/kb-canonical.json.
// Validated field-by-field below rather than trusted -- the file is
// external input (hand-edited, stale from an older kb_export version, or
// simply absent) and a bad shape must degrade to today's output, never throw
// past the try/catch that wraps the whole cold-seed block.
interface CanonicalBibleEntry {
  id: string;
  type: string;
  title: string;
  summary: string;
  symbols: string[];
  source_files: string[];
  confidence?: string;
  updated_at?: string;
}

function isCanonicalBibleEntry(value: unknown): value is CanonicalBibleEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.title === 'string' &&
    typeof e.summary === 'string' &&
    Array.isArray(e.symbols) &&
    Array.isArray(e.source_files)
  );
}

// Prefer canonical entries whose symbols overlap hint_symbols, or whose
// source_files contain a hint_module as a substring (canonical entries carry
// no separate "module" field -- hint_modules in practice are path-like
// strings, e.g. "src/tools", that match against source_files directly).
function canonicalMatchesHints(
  entry: CanonicalBibleEntry,
  hintSymbols: string[],
  hintModules: string[],
): boolean {
  if (hintSymbols.length > 0 && entry.symbols.some(s => hintSymbols.includes(s))) return true;
  if (hintModules.length > 0 && entry.source_files.some(f => hintModules.some(m => f.includes(m)))) return true;
  return false;
}

// F4 (T1.6): shared validation for both precedence tiers -- an explicit
// repo_path (tier 1) and the session working directory fallback (tier 2, used
// only when repo_path is omitted) go through the identical existence +
// isDirectory check. Neither tier is ever trusted without it. Returns null
// (rather than throwing) when nothing validates, so the caller can hard-skip
// per the existing non-fatal cold-seed contract.
function resolveRepoPath(explicit?: string): string | null {
  const candidate = explicit || process.cwd();
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return null;
  return candidate;
}

// T3.5 (F9c, D8): `via` param added, defaulting to 'canonical-bible' so the
// existing project-bible call site below is byte-for-byte unchanged. The new
// global-bible cold-seed block passes via='canonical-bible-global' so those
// entries are distinguishable in top_entries (D8's via marker requirement).
function toCanonicalKBEntry(e: CanonicalBibleEntry, via: string = 'canonical-bible'): KBEntry & { via: string } {
  return {
    id: e.id,
    type: e.type as KBEntry['type'],
    title: e.title,
    summary: e.summary,
    content: '',
    source_files: e.source_files,
    symbols: e.symbols,
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: via,
    source: 'promotion',
    confidence: (e.confidence as KBEntry['confidence']) ?? 'CONFIRMED',
    created_at: e.updated_at ?? '',
    use_count: 0,
    via,
  };
}

// Pull neighbor symbol names out of a code-intelligence `context` result.
// The provider returns a normal MCP result object -- a `content` array of text
// blocks plus an optional `isError` flag -- whose text block (when the symbol
// is found) is a JSON string of shape:
//   { status, symbol, incoming: { calls: [{ name }] }, outgoing: { calls: [...] } }
// (see docs/code-intelligence-child-surface.md). Parse defensively: isError,
// missing/!array content, no text block, unparseable JSON, or an ambiguous
// candidate response (no incoming/outgoing) all mean "no neighbors".
function parseContextNeighbors(result: unknown): string[] {
  try {
    if (!result || typeof result !== 'object') return [];
    const r = result as { isError?: boolean; content?: unknown };
    if (r.isError) return [];
    if (!Array.isArray(r.content)) return [];
    const textBlock = r.content.find(
      (c): c is { type: string; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string',
    );
    if (!textBlock) return [];
    const parsed = JSON.parse(textBlock.text) as {
      incoming?: { calls?: unknown };
      outgoing?: { calls?: unknown };
    };
    const names: string[] = [];
    for (const group of [parsed.incoming?.calls, parsed.outgoing?.calls]) {
      if (!Array.isArray(group)) continue;
      for (const call of group) {
        const name = (call as { name?: unknown })?.name;
        if (typeof name === 'string' && name.length > 0) names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

export async function kbSessionPrime(input: KbSessionPrimeInput): Promise<string> {
  if (input.session_files?.length) validateFilePaths(input.session_files);

  const providers = await getKbProviders();

  const result = await providers.project.prime({
    session_files: input.session_files,
    hint_symbols: input.hint_symbols,
    hint_modules: input.hint_modules,
  });

  // Append up to 3 global knowledge entries. D4 (T2.1): pass raw terms (a raw
  // session file path or a hint symbol) via fts_terms -- query() sanitizes
  // each term through ftsSafeTerm and OR-joins them centrally, so FTS-hostile
  // characters in a raw file path ('/', '.') cannot throw into the catch
  // below, and multiple terms surface entries matching ANY of them instead of
  // requiring ALL of them (implicit AND, KB finding 83726d75 / feedback.md
  // finding 3).
  const searchTerms = input.session_files?.length ? input.session_files : (input.hint_symbols ?? []);
  if (searchTerms.length) {
    try {
      const globalResult = await providers.global.query({
        fts_terms: searchTerms,
        l1_only: true,
        limit: 10,
        include_stale: false,
      });
      const globalEntries = globalResult.results
        .filter(e => e.type === 'knowledge')
        .slice(0, 3);
      if (globalEntries.length > 0) {
        result.top_entries = [...(result.top_entries ?? []), ...globalEntries];
      }
    } catch {}
  }

  // Graph-neighbor expansion (T1.3 P4b, design D4). Join the code-intelligence
  // graph one layer up so it works for both KB providers without touching
  // SqliteProvider.prime / HttpKbProvider.prime. For each hint symbol, ask the
  // CI provider for its neighbors (callers/callees via `context`), run ONE extra
  // KB query batch over the collected neighbors, and append the resulting
  // entries BELOW all direct hits. The ENTIRE block is a hard-skip: any failure
  // (graph offline, no index, unparseable response, KB query error) leaves
  // `result` exactly as prime returned it -- no throw, no error text. Also
  // skipped when hint_symbols is empty/absent.
  if (input.hint_symbols?.length) {
    try {
      const provider = await getProvider();

      // Collect distinct neighbor names not already in hint_symbols, capped at
      // NEIGHBOR_CAP. A per-symbol try/catch keeps one bad symbol from aborting
      // the sweep.
      const seen = new Set(input.hint_symbols);
      const neighbors: string[] = [];
      for (const symbol of input.hint_symbols) {
        if (neighbors.length >= NEIGHBOR_CAP) break;
        let ctxResult: unknown;
        try {
          ctxResult = await provider.context({ name: symbol });
        } catch {
          continue;
        }
        for (const name of parseContextNeighbors(ctxResult)) {
          if (neighbors.length >= NEIGHBOR_CAP) break;
          if (seen.has(name)) continue;
          seen.add(name);
          neighbors.push(name);
        }
      }

      if (neighbors.length > 0) {
        // D4 (T2.1): pass raw neighbor names via fts_terms -- query()
        // sanitizes per-neighbor (a single FTS-hostile name degrades to
        // skipping that neighbor rather than killing the whole batch query)
        // AND OR-joins across neighbors so an entry matching ANY neighbor
        // surfaces instead of requiring ALL of them (implicit AND).
        const neighborResult = await providers.project.query({
          fts_terms: neighbors,
          l1_only: true,
          limit: 10,
          include_stale: false,
        });

        // Merge below direct hits: skip ids already present (direct + global),
        // mark each addition via "graph-neighbor", cap at ADDED_ENTRY_CAP.
        const existingIds = new Set((result.top_entries ?? []).map(e => e.id));
        const additions: Array<KBEntry & { via: string }> = [];
        for (const entry of neighborResult.results) {
          if (additions.length >= ADDED_ENTRY_CAP) break;
          if (existingIds.has(entry.id)) continue;
          existingIds.add(entry.id);
          additions.push({ ...entry, via: 'graph-neighbor' });
        }
        if (additions.length > 0) {
          result.top_entries = [...(result.top_entries ?? []), ...additions];
        }
      }
    } catch {
      // Hard skip: leave `result` exactly as prime returned it.
    }
  }

  // T3.5 (F8c, D8): cold-KB seed from the canonical git bible -- LAST
  // sequenced merge, after direct hits + global-append + graph-neighbor
  // above. When the local KB still returns few top_entries (COLD_KB_MAX),
  // fall back to <repo>/.fleet/kb-canonical.json (written by kb_export after
  // promotion) so a fresh clone or cold project still gets team knowledge.
  // Entries are marked via:'canonical-bible' and always appended BELOW every
  // live-KB hit gathered above. Non-fatal: the entire block is a hard skip --
  // missing file, unreadable/malformed JSON, or a bad shape leaves `result`
  // exactly as built above (same contract as the neighbor block).
  if ((result.top_entries ?? []).length < COLD_KB_MAX) {
    try {
      const repoRoot = resolveRepoPath(input.repo_path);
      const canonicalPath = repoRoot ? path.join(repoRoot, '.fleet', 'kb-canonical.json') : null;
      if (canonicalPath && fs.existsSync(canonicalPath)) {
        const raw = fs.readFileSync(canonicalPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;

        if (Array.isArray(parsed)) {
          const existingIds = new Set((result.top_entries ?? []).map(e => e.id));
          const hintSymbols = input.hint_symbols ?? [];
          const hintModules = input.hint_modules ?? [];

          const valid = parsed
            .filter(isCanonicalBibleEntry)
            .filter(e => !existingIds.has(e.id));

          let ordered = valid;
          if (hintSymbols.length > 0 || hintModules.length > 0) {
            const matched = valid.filter(e => canonicalMatchesHints(e, hintSymbols, hintModules));
            const matchedIds = new Set(matched.map(e => e.id));
            const rest = valid.filter(e => !matchedIds.has(e.id));
            ordered = [...matched, ...rest];
          }

          const additions: Array<KBEntry & { via: string }> = [];
          for (const e of ordered) {
            if (additions.length >= ADDED_ENTRY_CAP) break;
            additions.push(toCanonicalKBEntry(e));
          }

          if (additions.length > 0) {
            result.top_entries = [...(result.top_entries ?? []), ...additions];
          }
        }
      }
    } catch {
      // Hard skip: leave `result` exactly as built above.
    }
  }

  // T3.5 (F9c, D8): global-bible cold-seed -- APPENDED AFTER the existing
  // project-bible cold-seed block above (design Phasing note: F9 appends
  // after the existing cold-seed block; this is deliberately the LAST merge
  // in the whole function). Reads the INSTALLED global bible at
  // FLEET_DIR/knowledge/global/kb-canonical-global.json -- the homedir-based
  // machine-wide copy the T3.4 installer step places there (NOT anything
  // under the session's repo root, unlike the project bible above). Entries
  // are marked via:'canonical-bible-global' and ordered BELOW every
  // project-bible entry (this block only ever appends, after the project
  // block has already run). Re-checks the SAME shared COLD_KB_MAX threshold
  // against top_entries as built by every merge above (direct hits + global-
  // KB append + graph-neighbor + project-bible), so this runs only when the
  // session is still cold after all of that. Same dedupe-by-id, same
  // ADDED_ENTRY_CAP, and the identical hard-skip non-fatal contract as the
  // project-bible block: missing file, unreadable/malformed JSON, or a bad
  // shape leaves `result` exactly as built above -- warm sessions (>=
  // COLD_KB_MAX) never reach this block at all.
  if ((result.top_entries ?? []).length < COLD_KB_MAX) {
    try {
      const globalBiblePath = path.join(FLEET_DIR, 'knowledge', 'global', 'kb-canonical-global.json');
      if (fs.existsSync(globalBiblePath)) {
        const raw = fs.readFileSync(globalBiblePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;

        if (Array.isArray(parsed)) {
          const existingIds = new Set((result.top_entries ?? []).map(e => e.id));
          const hintSymbols = input.hint_symbols ?? [];
          const hintModules = input.hint_modules ?? [];

          const valid = parsed
            .filter(isCanonicalBibleEntry)
            .filter(e => !existingIds.has(e.id));

          let ordered = valid;
          if (hintSymbols.length > 0 || hintModules.length > 0) {
            const matched = valid.filter(e => canonicalMatchesHints(e, hintSymbols, hintModules));
            const matchedIds = new Set(matched.map(e => e.id));
            const rest = valid.filter(e => !matchedIds.has(e.id));
            ordered = [...matched, ...rest];
          }

          const additions: Array<KBEntry & { via: string }> = [];
          for (const e of ordered) {
            if (additions.length >= ADDED_ENTRY_CAP) break;
            additions.push(toCanonicalKBEntry(e, 'canonical-bible-global'));
          }

          if (additions.length > 0) {
            result.top_entries = [...(result.top_entries ?? []), ...additions];
          }
        }
      }
    } catch {
      // Hard skip: leave `result` exactly as built above.
    }
  }

  return JSON.stringify(result);
}
