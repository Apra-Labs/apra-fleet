// bd my-beads-db-27m.50: normalise volatile fields when comparing recorded
// fixtures, and prove the corpus is genuinely not byte-stable.
//
// EVIDENCE (real, not hypothetical): memory-contract/v1/fixtures/kb_list/
// happy.json was recorded twice, in commits f230c530 (T1.4.1, landed) and
// 8d6a5e00 (a later, unrelated fix). Both recordings exercise the exact same
// scenario (list the two entries a scratch repo-A capture produced) and both
// report `total: 2`, but:
//   - every entry `id` is a fresh UUID (different in each recording);
//   - the two entries' ORDER is flipped (knowledge-then-context-cache in
//     f230c530, context-cache-then-knowledge in 8d6a5e00).
// The two payloads below are copied VERBATIM from those two commits
// (`git show f230c530:memory-contract/v1/fixtures/kb_list/happy.json` /
// `git show 8d6a5e00:...`), not fabricated -- embedded as literals here
// (rather than shelled out to `git show` at test time) so this test stays
// hermetic under a shallow clone, per CI's `npm test` (.github/workflows/
// ci.yml) not being guaranteed to have either commit in its object store.
//
// normalizeVolatileFixtureFields (memory-contract/v1/tests/
// roundtrip-harness.mjs) fixes exactly this: id -> '<UUID>', an ISO-8601
// timestamp -> '<TIMESTAMP>', and every array re-sorted by its own
// (already-normalised) canonical JSON string, so order stops mattering once
// content is otherwise identical.
import { describe, it, expect } from 'vitest';
import { decodeEnvelope, normalizeVolatileFixtureFields } from '../memory-contract/v1/tests/roundtrip-harness.mjs';

// Copied verbatim from commit f230c530.
const RECORDING_F230C530 = {
  content: [
    {
      type: 'text',
      text: '{"results":[{"id":"b113a2da-391b-49ce-8551-8d17dc95628b","type":"knowledge","confidence":"INFERRED","title":"exampleFn returns x + 1","summary":"exampleFn in src/example.ts is a trivial increment helper used by the fixture corpus.","symbols":["exampleFn"],"source_files":["src/example.ts"]},{"id":"b3baa30c-0892-4102-af65-7c90695d1db9","type":"context-cache","confidence":"INFERRED","title":"src/example.ts summary","summary":"File summary cache entry for src/example.ts.","symbols":["exampleFn"],"source_files":["src/example.ts"]}],"total":2}',
    },
  ],
};

// Copied verbatim from commit 8d6a5e00 -- same scenario, fresh ids, flipped order.
const RECORDING_8D6A5E00 = {
  content: [
    {
      type: 'text',
      text: '{"results":[{"id":"87e80521-1da1-4a7c-b427-b26497ed598d","type":"context-cache","confidence":"INFERRED","title":"src/example.ts summary","summary":"File summary cache entry for src/example.ts.","symbols":["exampleFn"],"source_files":["src/example.ts"]},{"id":"e12c88e9-0a56-44dd-b1ee-c522b3559a3e","type":"knowledge","confidence":"INFERRED","title":"exampleFn returns x + 1","summary":"exampleFn in src/example.ts is a trivial increment helper used by the fixture corpus.","symbols":["exampleFn"],"source_files":["src/example.ts"]}],"total":2}',
    },
  ],
};

describe('memory-contract/v1 fixture corpus is not byte-stable, and normalizeVolatileFixtureFields fixes semantic comparison (my-beads-db-27m.50)', () => {
  it('two real recordings of the same kb_list/happy scenario have different raw ids and a flipped result order (proves the volatility is real, not hypothetical)', () => {
    const oldParsed = decodeEnvelope(RECORDING_F230C530).parsed;
    const newParsed = decodeEnvelope(RECORDING_8D6A5E00).parsed;

    expect(JSON.stringify(oldParsed)).not.toBe(JSON.stringify(newParsed));
    expect(oldParsed.results.map((r: { id: string }) => r.id)).not.toEqual(newParsed.results.map((r: { id: string }) => r.id));
    expect(oldParsed.results.map((r: { type: string }) => r.type)).toEqual(['knowledge', 'context-cache']);
    expect(newParsed.results.map((r: { type: string }) => r.type)).toEqual(['context-cache', 'knowledge']);
    // The thing that stayed constant across both recordings.
    expect(oldParsed.total).toBe(2);
    expect(newParsed.total).toBe(2);
  });

  it('normalizeVolatileFixtureFields makes the two recordings deep-equal (ids and order stop mattering)', () => {
    const oldParsed = decodeEnvelope(RECORDING_F230C530).parsed;
    const newParsed = decodeEnvelope(RECORDING_8D6A5E00).parsed;

    const oldNormalized = normalizeVolatileFixtureFields(oldParsed);
    const newNormalized = normalizeVolatileFixtureFields(newParsed);

    expect(oldNormalized).toEqual(newNormalized);
    // Non-vacuous: ids were genuinely replaced, not just coincidentally equal.
    for (const entry of (oldNormalized as { results: { id: string }[] }).results) {
      expect(entry.id).toBe('<UUID>');
    }
  });

  it('normalizeVolatileFixtureFields still distinguishes genuinely different content (not a blanket pass)', () => {
    const oldParsed = decodeEnvelope(RECORDING_F230C530).parsed;
    const mutated = JSON.parse(JSON.stringify(oldParsed));
    mutated.total = 3; // a real content change, not a volatile field

    expect(normalizeVolatileFixtureFields(oldParsed)).not.toEqual(normalizeVolatileFixtureFields(mutated));
  });

  it('normalizes a bare ISO-8601 created_at timestamp, matching the volatility this bead also names', () => {
    const withTimestamp = { id: 'e12c88e9-0a56-44dd-b1ee-c522b3559a3e', created_at: '2026-08-24T16:41:56.866Z' };
    expect(normalizeVolatileFixtureFields(withTimestamp)).toEqual({ id: '<UUID>', created_at: '<TIMESTAMP>' });
  });

  it('the normaliser must be applied to the decoded parsed body, never to the whole envelope (content[].text stays a raw JSON string)', () => {
    // Documents the gotcha this bead's own implementation hit: normalising
    // the WHOLE decoded envelope (envelope.content included) leaves the two
    // recordings unequal, because the volatile ids/order live inside
    // content[].text as an opaque JSON string a structural walk cannot see
    // through.
    const oldDecoded = decodeEnvelope(RECORDING_F230C530);
    const newDecoded = decodeEnvelope(RECORDING_8D6A5E00);

    expect(normalizeVolatileFixtureFields(oldDecoded)).not.toEqual(normalizeVolatileFixtureFields(newDecoded));
    // The correct target -- .parsed only -- is what the tests above use, and
    // it does normalise equal.
    expect(normalizeVolatileFixtureFields(oldDecoded.parsed)).toEqual(normalizeVolatileFixtureFields(newDecoded.parsed));
  });
});
