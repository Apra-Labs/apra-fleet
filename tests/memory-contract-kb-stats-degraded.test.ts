// apra-fleet-i9ag.15.17: pins the two kb_stats contract fixes earlier in the
// kb-stats-contract streak, both of which edit the SAME generated schema
// (memory-contract/v1/schemas/kb_stats.response.json):
//   - apra-fleet-i9ag.15.13.1: declared the four HttpKbProvider degraded
//     fields (degraded/degraded_reason/degraded_since/remote_url).
//   - apra-fleet-i9ag.15.15: widened parsed.promote_ratio from `number` to
//     `[number, null]`, since HttpKbProvider.stats() always returns null
//     (D4, kb_stats is not supported over the remote provider) and
//     SqliteProvider.stats() returns null whenever there are zero CONFIRMED
//     entries (sqlite-provider.ts: `confirmedRow.c > 0 ? ... : null`).
//
// Before either fix landed, a real provider=http kb_stats response carried
// four keys parsed.additionalProperties:false forbade, AND a null
// promote_ratio (the ONLY value HttpKbProvider ever produces for that field)
// failed schema validation outright -- see the "record the failure" test
// below, which reproduces both defects against a scratch copy of the
// pre-fix schema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadFixture, decodeEnvelope } from '../memory-contract/v1/tests/roundtrip-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'memory-contract', 'v1', 'schemas', 'kb_stats.response.json');

function loadSchema(): unknown {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(schema as Record<string, unknown>);
}

/**
 * The schema as it stood before apra-fleet-i9ag.15.13.1/.15.15: no degraded
 * fields declared, and promote_ratio is a plain `number` (not nullable).
 * Reconstructed here rather than checked out from git history, so this test
 * has no dependency on repo history staying intact.
 */
function preFixSchema(): unknown {
  const schema = JSON.parse(JSON.stringify(loadSchema())) as {
    $defs: { 'v1-kb_stats-response': { properties: { parsed: { properties: Record<string, unknown> } } } };
  };
  const parsedProps = schema.$defs['v1-kb_stats-response'].properties.parsed.properties;
  delete parsedProps.degraded;
  delete parsedProps.degraded_reason;
  delete parsedProps.degraded_since;
  delete parsedProps.remote_url;
  parsedProps.promote_ratio = { type: 'number' };
  return schema;
}

/** A representative decoded provider=http kb_stats envelope. */
function httpEnvelope(promoteRatio: number | null): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: 'stats' }],
    parsed: {
      degraded: true,
      degraded_reason: 'connect ECONNREFUSED 127.0.0.1:17777',
      degraded_since: '2026-09-28T14:00:00.000Z',
      remote_url: 'http://kb.example.internal:7878',
      totals: { by_confidence: { CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 }, by_type: {}, total: 0 },
      stale: 0,
      flagged: 0,
      superseded: 0,
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
      promote_ratio: promoteRatio,
    },
  };
}

describe('memory-contract/v1 kb_stats: degraded fields + nullable promote_ratio (apra-fleet-i9ag.15.13.1, .15.15, .17)', () => {
  it('fails on the PRE-FIX schema: degraded fields rejected as additionalProperties, promote_ratio:null rejected as not-a-number', () => {
    const validate = compile(preFixSchema());

    const degradedResult = validate(httpEnvelope(0.5));
    expect(degradedResult).toBe(false);
    expect((validate.errors ?? []).some((e) => /must NOT have additional properties/.test(e.message ?? ''))).toBe(true);

    const nullResult = validate(httpEnvelope(null));
    expect(nullResult).toBe(false);
    expect((validate.errors ?? []).some((e) => e.instancePath === '/parsed/promote_ratio' && /must be number/.test(e.message ?? ''))).toBe(true);
  });

  it('PASSES on the current (post-fix) schema: degraded fields + promote_ratio:null both validate', () => {
    const validate = compile(loadSchema());
    expect(validate(httpEnvelope(null))).toBe(true);
  });

  it('a payload with a numeric promote_ratio still validates -- nullability was widened, not swapped', () => {
    const validate = compile(loadSchema());
    expect(validate(httpEnvelope(0.75))).toBe(true);
  });

  it('non-vacuity: an undeclared parsed key still fails validation, proving additionalProperties:false is genuinely enforced', () => {
    const validate = compile(loadSchema());
    const envelope = httpEnvelope(null);
    const mutated = JSON.parse(JSON.stringify(envelope));
    mutated.parsed.unexpected_key = 'nope';
    expect(validate(mutated)).toBe(false);
    expect((validate.errors ?? []).some((e) => /must NOT have additional properties/.test(e.message ?? ''))).toBe(true);
  });

  // apra-fleet-i9ag.15.17: the committed corpus itself must carry a kb_stats
  // fixture whose parsed body reaches promote_ratio: null, so
  // tests/memory-contract-fixture-response-schema.test.ts's generic sweep
  // (which iterates EVERY committed fixture, not just this file's synthetic
  // payloads) actually exercises the nested parsed sub-schema for this case,
  // not just happy.json's non-null promote_ratio:1.
  it('the committed kb_stats/edge-empty-promote-ratio-null fixture decodes to promote_ratio:null and validates', () => {
    const fixture = loadFixture('kb_stats', 'edge-empty-promote-ratio-null');
    const decoded = decodeEnvelope(fixture.response);
    expect((decoded.parsed as { promote_ratio: unknown }).promote_ratio).toBeNull();

    const validate = compile(loadSchema());
    expect(validate(decoded)).toBe(true);
  });
});
