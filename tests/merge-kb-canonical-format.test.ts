import { describe, it, expect } from 'vitest';
import { asciiSafeStringify, compareById, BIBLE_FORMAT_VERSION } from '../src/tools/kb-export.js';
import { mergeKbCanonical, serializeDocument } from '../packages/apra-fleet-se/scripts/merge-kb-canonical.mjs';

// merge-kb-canonical must write exactly what kb_export would write for the
// same entries, so a merged bible never shows up as a diff on the next export.
function entry(id: string, title: string) {
  return { id, type: 'knowledge', title, summary: 's', content: 'c', confidence: 'CONFIRMED' };
}

describe('merge-kb-canonical output format', () => {
  it('is byte-identical to the exporter for the same entries', () => {
    const base = { version: 3, provenance: { commit: 'c0', branch: 'main', entry_count: 1 }, entries: [entry('b', 'base')] };
    // Unsorted on purpose, with a non-ASCII title and a trailing demotion.
    const ours = {
      ...base,
      entries: [entry('b', 'base'), entry('z', 'café — ours'), entry('a', 'ours-a')],
      demotions: [{ id: 'q', at: 't', reason: 'r' }, { id: 'p', at: 't', reason: 'r' }],
    };
    const theirs = { ...base, entries: [entry('b', 'base'), entry('m', 'theirs-m')] };
    const { merged } = mergeKbCanonical(base, ours, theirs);
    expect(merged).not.toBeNull();

    const expected = asciiSafeStringify({
      version: BIBLE_FORMAT_VERSION,
      provenance: { commit: 'c0', branch: 'main', entry_count: merged.entries.length },
      entries: [...merged.entries].sort(compareById),
      demotions: [...merged.demotions].sort(compareById),
    }) + '\n';
    const actual = serializeDocument(merged);
    expect(actual).toBe(expected);
    expect(JSON.parse(actual).entries.map((e: { id: string }) => e.id)).toEqual(['a', 'b', 'm', 'z']);
    expect(actual).toMatch(/\\u00e9/);
    expect(actual.endsWith('}\n')).toBe(true);
  });

  it('omits demotions when there are none', () => {
    const doc = { version: 3, provenance: { commit: null, branch: null, entry_count: 0 }, entries: [], demotions: [] };
    expect(serializeDocument(doc)).toBe(asciiSafeStringify({ version: 3, provenance: doc.provenance, entries: [] }) + '\n');
  });
});
