// P4a KB enrichment for code_context (T3.3, design D4). The gitnexus
// provider file (code-intelligence-gitnexus.ts) must NOT import the KB
// service -- that would create a src/tools <-> src/services cycle. This
// helper is imported ONLY by the code_context handler in src/index.ts: the
// handler calls the provider, then this helper, then merges the two results.
import { getKbProviders } from '../services/knowledge/kb-providers.js';

const SUMMARY_TRUNCATE_LEN = 120;

function isErrorResult(result: unknown): boolean {
  return !!(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
}

// Append a plain text content block to an MCP tool response, preserving the
// existing content array shape -- mirrors appendFreshnessNote() in
// code-intelligence-gitnexus.ts. If the result does not look like a
// content-array response, return it unchanged rather than risk corrupting an
// unexpected shape.
function appendTextBlock(result: unknown, text: string): unknown {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const { content, ...rest } = result as { content: unknown[] } & Record<string, unknown>;
    return { ...rest, content: [...content, { type: 'text', text }] };
  }
  return result;
}

// After a successful (non-error) code_context call for `name`, query the
// project KB for CONFIRMED entries whose `symbols` array contains `name`
// (exact match) and append a compact block listing them. Zero matches -> the
// result is returned unchanged (no block at all). Any KB read error is
// swallowed -- this never fails the call, and error results from the
// provider are passed through untouched (do not enrich error results).
export async function enrichContextWithKb(name: string, result: unknown): Promise<unknown> {
  if (isErrorResult(result)) return result;

  try {
    const providers = await getKbProviders();
    const kbResult = await providers.project.query({
      query: name,
      l1_only: true,
      include_stale: false,
    });

    const matches = kbResult.results.filter(
      (entry) =>
        entry.confidence === 'CONFIRMED' &&
        Array.isArray(entry.symbols) &&
        entry.symbols.includes(name),
    );

    if (matches.length === 0) return result;

    const lines = matches.map((entry) => {
      const summary =
        entry.summary.length > SUMMARY_TRUNCATE_LEN
          ? entry.summary.slice(0, SUMMARY_TRUNCATE_LEN)
          : entry.summary;
      return `- ${entry.title} -- ${summary}`;
    });
    const block = `[knowledge-bank] ${matches.length} confirmed entries for ${name}:\n${lines.join('\n')}`;

    return appendTextBlock(result, block);
  } catch {
    return result;
  }
}
