// apra-fleet-i9ag.15.16.3: prove the response-conformance enforcement added in
// apra-fleet-i9ag.15.16.2 actually catches the class of drift that shipped, and
// assert (rather than write up) the fixture-coverage hole that hid it.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// -------------------------------------
// tests/memory-contract-roundtrip.test.ts owns the LIVE lane: it drives all 23
// real handlers once and asserts the lane's coverage report over those live
// payloads. This file is the lane's own falsifiability proof, and it needs no
// live dispatch at all -- it feeds the SAME lane synthetic observations built
// from scratch copies of committed fixtures, so each failure mode can be
// triggered on demand in milliseconds.
//
// NOTHING COMMITTED IS EVER MUTATED HERE
// --------------------------------------
// Every mutation below is applied to a structuredClone of a decoded fixture,
// never to the fixture file, never to a generated schema, and never to the
// object the loader handed back. A test that edits the corpus to prove a point
// about the corpus proves nothing and corrupts the evidence for everyone else.
//
// WHY THE AUDIT AT THE BOTTOM EXISTS
// -----------------------------------
// The kb_stats degraded-field drift shipped because the recorded corpus was
// thin: nothing anywhere asserted that a tool's fixture actually REACHES the
// nested `parsed` object its schema types, so a tool could sit in the corpus
// contributing zero coverage of its own body. The audit makes that structural,
// enumerating every tool and failing on any tool that is neither covered nor
// explicitly allow-listed with a reason -- so the corpus cannot quietly
// regress to that state again.
import { describe, it, expect } from 'vitest';

import {
  listFixtureKeys,
  loadFixture,
  decodeEnvelope,
} from '../memory-contract/v1/tests/roundtrip-harness.mjs';
import {
  createResponseConformanceRecorder,
  validateToolResponse,
  schemaDeclaresParsedBody,
} from '../memory-contract/v1/tests/response-conformance.mjs';
import { KB_MODULES, CODE_EXPORTS } from '../memory-contract/v1/generate-contract.mjs';

/** The inventoried roster, read from the generator's own exported data (never hand-copied). */
const ROSTER: string[] = [
  ...(KB_MODULES as [string, string, string][]).map(([name]) => name),
  ...(CODE_EXPORTS as [string, string][]).map(([name]) => name),
];

type Decoded = { parsed: Record<string, unknown> } & Record<string, unknown>;

/** A scratch, mutable copy of a committed fixture's decoded response. */
function scratchDecodedFixture(tool: string, caseName: string): Decoded {
  const fixture = loadFixture(tool, caseName);
  if (!fixture.response) throw new Error(`${tool}/${caseName} records no response`);
  return structuredClone(decodeEnvelope(fixture.response)) as Decoded;
}

/** Drive the real lane with one synthetic observation and return the failures naming `tool`. */
function laneFailuresFor(tool: string, caseName: string, decoded: unknown): string[] {
  const recorder = createResponseConformanceRecorder({ roster: ROSTER });
  recorder.onLiveResponse({ tool, case: caseName, decoded });
  return recorder.report().failures.filter((f: string) => f.startsWith(`${tool}/`) || f.startsWith(`${tool}:`));
}

// kb_capture is the deliberate subject of the mutation probes: its `parsed`
// body is a fully-typed, additionalProperties:false object with a
// non-nullable `id`. The 7 code_* tools and kb_query declare `parsed` as an
// unconstrained schema (their zod shape is z.unknown()), so mutating one of
// those would make every probe below pass by accident -- vacuous for exactly
// the wrong reason.
const SUBJECT_TOOL = 'kb_capture';
const SUBJECT_CASE = 'happy';

describe('apra-fleet-i9ag.15.16.3: contract drift fails the response-conformance lane', () => {
  it('POSITIVE CONTROL: the unmutated scratch payload passes, so the failures below are attributable to the mutation', () => {
    const clean = scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE);
    expect(validateToolResponse(SUBJECT_TOOL, clean).valid).toBe(true);
    expect(laneFailuresFor(SUBJECT_TOOL, SUBJECT_CASE, clean)).toEqual([]);
  });

  it('an UNDECLARED FIELD fails the lane, and the failure names both the tool and the field', () => {
    const mutated = scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE);
    mutated.parsed.undeclared_drift_field = 'a handler grew a field without a schema change';

    const result = validateToolResponse(SUBJECT_TOOL, mutated);
    expect(result.valid).toBe(false);
    // ajv reports the undeclared key ONLY in params.additionalProperty -- it is
    // absent from both instancePath and message ("must NOT have additional
    // properties"), so drift reported without it is unactionable. This is the
    // assertion that pins formatResponseErrors surfacing it.
    expect(result.errors).toContain('undeclared_drift_field');

    const failures = laneFailuresFor(SUBJECT_TOOL, SUBJECT_CASE, mutated);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(SUBJECT_TOOL);
    expect(failures[0]).toContain('undeclared_drift_field');
    expect(failures[0]).toContain('schemas/kb_capture.response.json');
  });

  it('NULLABILITY drift on a declared field fails the lane', () => {
    // kb_capture.parsed.id is declared `string` with no null member, unlike
    // kb_stats.parsed.promote_ratio which IS ["number","null"]. A handler that
    // started answering null here is drift the schema must reject.
    const mutated = scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE);
    mutated.parsed.id = null;

    const result = validateToolResponse(SUBJECT_TOOL, mutated);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('/parsed/id');
    expect(result.errors).toContain('must be string');

    const failures = laneFailuresFor(SUBJECT_TOOL, SUBJECT_CASE, mutated);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('/parsed/id');
  });

  it('a REMOVED required field fails the lane, naming the missing property', () => {
    const mutated = scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE);
    delete mutated.parsed.audn_decision;
    const result = validateToolResponse(SUBJECT_TOOL, mutated);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('audn_decision');
  });
});

describe('apra-fleet-i9ag.15.16.3: the lane cannot be left silently green', () => {
  it('a tool that is never driven and never skipped FAILS as uncovered', () => {
    const recorder = createResponseConformanceRecorder({ roster: ROSTER });
    recorder.onLiveResponse({
      tool: SUBJECT_TOOL,
      case: SUBJECT_CASE,
      decoded: scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE),
    });
    const report = recorder.report();

    expect(report.uncovered).toContain('kb_stats');
    expect(report.uncovered).not.toContain(SUBJECT_TOOL);
    expect(report.failures.some((f: string) => f.startsWith('kb_stats:') && f.includes('not on the explicit live-service skip list'))).toBe(true);
  });

  it('a tool whose TYPED parsed body is never populated FAILS, even though the envelope itself validates', () => {
    // The exact shape of the kb_stats blind spot: a response that validates
    // (parsed is optional in the schema) while proving nothing about the body.
    const envelopeOnly = { content: [{ type: 'text', text: '{}' }] };
    expect(validateToolResponse(SUBJECT_TOOL, envelopeOnly).valid).toBe(true);

    const recorder = createResponseConformanceRecorder({ roster: ROSTER });
    recorder.onLiveResponse({ tool: SUBJECT_TOOL, case: 'empty-parsed', decoded: { ...envelopeOnly, parsed: {} } });
    const failures = recorder
      .report()
      .failures.filter((f: string) => f.startsWith(`${SUBJECT_TOOL}:`));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('typed parsed body but no live response reached it');
  });

  it('an UNEXPLAINED skip is itself a failure, and an explained one is reported with its reason', () => {
    const unexplained = createResponseConformanceRecorder({ roster: ROSTER, skips: { kb_stats: '   ' } }).report();
    expect(unexplained.failures.some((f: string) => f.startsWith('kb_stats:') && f.includes('no reason'))).toBe(true);

    const explained = createResponseConformanceRecorder({
      roster: ROSTER,
      skips: { kb_stats: 'needs a live HTTP KB remote' },
    }).report();
    expect(explained.skipped).toContainEqual({ tool: 'kb_stats', reason: 'needs a live HTTP KB remote' });
    expect(explained.uncovered).not.toContain('kb_stats');
    // The skip explains kb_stats and nothing else: every OTHER roster tool is
    // still reported uncovered, so a skip can never launder the whole roster.
    expect(explained.uncovered).toHaveLength(ROSTER.length - 1);
  });

  it('a STALE skip -- a tool listed as skipped that was in fact driven live -- FAILS', () => {
    const recorder = createResponseConformanceRecorder({
      roster: ROSTER,
      skips: { [SUBJECT_TOOL]: 'needs a live service (stale claim)' },
    });
    recorder.onLiveResponse({
      tool: SUBJECT_TOOL,
      case: SUBJECT_CASE,
      decoded: scratchDecodedFixture(SUBJECT_TOOL, SUBJECT_CASE),
    });
    expect(
      recorder.report().failures.some((f: string) => f.startsWith(`${SUBJECT_TOOL}:`) && f.includes('remove the stale skip')),
    ).toBe(true);
  });
});

/**
 * Tools exempt from the "a committed fixture must reach the nested parsed
 * object" audit below, each with the reason. EMPTY as of
 * apra-fleet-i9ag.15.16.3: every tool whose schema declares a typed `parsed`
 * body has at least one committed fixture that decodes to a populated body,
 * including kb_stats (both happy.json and edge-empty-promote-ratio-null.json).
 *
 * The mechanism is kept because the corpus is not frozen. If a future tool
 * lands without such a fixture, it belongs HERE with a dated, per-tool reason
 * and a follow-up bead -- a visibly temporary entry -- rather than having this
 * assertion weakened.
 */
const FIXTURE_PARSED_REACH_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

describe('apra-fleet-i9ag.15.16.3: fixture-coverage audit (every tool reaches its nested parsed object)', () => {
  /** tool -> the decoded parsed bodies of its committed response fixtures. */
  const parsedByTool = new Map<string, unknown[]>();
  for (const key of listFixtureKeys()) {
    const [tool, caseName] = key.split('/');
    const fixture = loadFixture(tool, caseName);
    if (!fixture.response) continue; // an `error` fixture records a refusal, not a body
    const bucket = parsedByTool.get(tool) ?? [];
    bucket.push(decodeEnvelope(fixture.response).parsed);
    parsedByTool.set(tool, bucket);
  }

  it('every inventoried tool has at least one committed response fixture', () => {
    const missing = ROSTER.filter((tool) => !parsedByTool.has(tool) && !(tool in FIXTURE_PARSED_REACH_ALLOWLIST));
    expect(missing).toEqual([]);
    // Non-vacuity: the audit really did enumerate the whole roster, not an
    // empty set that trivially satisfies every filter below.
    expect(ROSTER.length).toBe(23);
    expect(parsedByTool.size).toBe(23);
  });

  it('every tool whose schema declares a TYPED parsed body has a fixture that actually reaches it', () => {
    const failures: string[] = [];
    for (const tool of ROSTER) {
      if (!schemaDeclaresParsedBody(tool)) continue; // z.unknown() body: reaching it proves nothing
      if (tool in FIXTURE_PARSED_REACH_ALLOWLIST) continue;
      const bodies = parsedByTool.get(tool) ?? [];
      const reached = bodies.some(
        (p) => p !== null && typeof p === 'object' && Object.keys(p as object).length > 0,
      );
      if (!reached) {
        failures.push(
          `${tool}: schema declares a typed parsed body but no committed fixture decodes to a populated one ` +
            '-- add a fixture, or allow-list it with a dated reason and a follow-up bead',
        );
      }
    }
    expect(failures).toEqual([]);
    // 15 of 23 tools carry a typed parsed body; the other 8 are the 7 code_*
    // tools plus kb_query.
    expect(ROSTER.filter((tool) => schemaDeclaresParsedBody(tool))).toHaveLength(15);
  });

  it('the allow-list is empty, and any entry on it must name a real tool and a reason', () => {
    // Asserted rather than assumed: an allow-list that silently grew would put
    // the corpus straight back into the state this audit exists to prevent.
    expect(Object.keys(FIXTURE_PARSED_REACH_ALLOWLIST)).toEqual([]);
    for (const [tool, reason] of Object.entries(FIXTURE_PARSED_REACH_ALLOWLIST)) {
      expect(ROSTER).toContain(tool);
      expect(String(reason).trim().length).toBeGreaterThan(0);
    }
  });

  it('the audit is NOT vacuous: a tool whose fixtures all decode to an empty body is reported', () => {
    // Same computation as the audit above, run over a scratch corpus in which
    // kb_stats contributes only empty bodies. If the audit's `reached` test
    // were a no-op, this would come back clean.
    const scratch = new Map(parsedByTool);
    scratch.set('kb_stats', [{}]);
    const failures = ROSTER.filter((tool) => {
      if (!schemaDeclaresParsedBody(tool)) return false;
      const bodies = scratch.get(tool) ?? [];
      return !bodies.some((p) => p !== null && typeof p === 'object' && Object.keys(p as object).length > 0);
    });
    expect(failures).toEqual(['kb_stats']);
  });
});
