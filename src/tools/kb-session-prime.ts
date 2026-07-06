import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { getProvider } from './code-intelligence.js';
import type { KBEntry } from '../services/knowledge/types.js';

export const kbSessionPrimeSchema = z.object({
  session_files: z.array(z.string()).optional().describe('Files the agent expects to touch this session'),
  hint_symbols: z.array(z.string()).optional().describe('Symbols likely to be relevant'),
  hint_modules: z.array(z.string()).optional().describe('Module names likely to be relevant'),
});

export type KbSessionPrimeInput = z.infer<typeof kbSessionPrimeSchema>;

// Graph-neighbor expansion caps (T1.3 P4b, design D4). Exported for tests.
// NEIGHBOR_CAP: max distinct neighbor symbols carried into the extra KB query.
export const NEIGHBOR_CAP = 10;
// ADDED_ENTRY_CAP: max neighbor-derived KB entries appended to top_entries.
export const ADDED_ENTRY_CAP = 5;

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

// Turn a single neighbor symbol name into an FTS5-safe query fragment, or null
// when nothing usable remains. Each alphanumeric/underscore token is wrapped as
// a quoted phrase so FTS-hostile characters (quotes, parens, colons, hyphens)
// and reserved operators (AND/OR/NOT/NEAR) cannot break the batch query. This
// makes a bad neighbor name degrade to "skip this neighbor" rather than kill the
// whole expansion (plan-review correctness note).
function ftsSafeTerm(name: string): string | null {
  const tokens = name.match(/[A-Za-z0-9_]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map(t => `"${t}"`).join(' ');
}

export async function kbSessionPrime(input: KbSessionPrimeInput): Promise<string> {
  if (input.session_files?.length) validateFilePaths(input.session_files);

  const providers = await getKbProviders();

  const result = await providers.project.prime({
    session_files: input.session_files,
    hint_symbols: input.hint_symbols,
    hint_modules: input.hint_modules,
  });

  // Append up to 3 global knowledge entries
  const searchTerm = input.session_files?.join(' ') ?? input.hint_symbols?.join(' ') ?? '';
  if (searchTerm) {
    try {
      const globalResult = await providers.global.query({
        query: searchTerm,
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
        // Sanitize per-neighbor so a single FTS-hostile name degrades to
        // skipping that neighbor rather than killing the whole batch query.
        const query = neighbors
          .map(ftsSafeTerm)
          .filter((t): t is string => t !== null)
          .join(' ');

        if (query) {
          const neighborResult = await providers.project.query({
            query,
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
      }
    } catch {
      // Hard skip: leave `result` exactly as prime returned it.
    }
  }

  return JSON.stringify(result);
}
