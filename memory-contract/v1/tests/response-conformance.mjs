// apra-fleet-i9ag.15.16.2: the LIVE response-conformance lane for
// memory-contract/v1.
//
// WHY THIS EXISTS
// ---------------
// Two things already guard the contract, and neither one catches the drift
// class that shipped:
//
//   * `npm run contract:check` (memory-contract/v1/generate-contract.mjs
//     --check) only cross-checks GENERATED ARTIFACTS against EACH OTHER --
//     "23 tools, 46 schema files, 23 binding files, 1 openapi file ... all
//     match and cross-reference cleanly". It never looks at a response
//     payload, live or recorded, so a handler that grows a field the schema
//     does not declare is invisible to it.
//   * tests/memory-contract-fixture-response-schema.test.ts does validate
//     against the response schemas, but only over RECORDED fixtures. A
//     recorded corpus can only ever prove things about the scenarios someone
//     remembered to record.
//
// roundtrip-harness.mjs's runRoundTrip() does drive REAL handlers and does
// validate each live decoded envelope against schemas/<tool>.response.json --
// but it reports one aggregate `failures` array, so nothing anywhere states
// WHICH tools were actually reached, whether a tool's declared `parsed` body
// was ever populated on the wire, or which tools were left out and why. A
// tool that quietly stopped being dispatched, or one whose live `parsed` body
// never materialised, would keep the lane green while validating nothing --
// exactly the shape of blind spot that let the kb_stats degraded-field drift
// ship.
//
// This module is that missing accounting, and it is deliberately NOT a second
// driver: standing up a parallel corpus/dispatch/substitution machine next to
// roundtrip-harness.mjs would double both the maintenance surface and the
// (multi-minute) run cost, and the second copy would drift from the first.
// Instead runRoundTrip() takes an optional `onLiveResponse` observer, this
// module turns that stream of LIVE observations into a coverage report, and
// the discovered entry point (tests/memory-contract-roundtrip.test.ts) asserts
// on it and prints it.
//
// WHAT IT VALIDATES
// -----------------
// The DECODED envelope (`{...envelope, parsed: JSON.parse(payloadBlock.text)}`
// -- roundtrip-harness.mjs's decodeEnvelope()), because that is the shape a
// real consumer sees and the only shape where the response schema's
// `parsed` sub-object and its `additionalProperties: false` actually bite.
// The raw wire envelope carries the body as a JSON STRING inside
// content[].text, which no JSON Schema can see through; validating only that
// shape is what makes a body-level check vacuous.
//
// WHY THIS IS A PLAIN .mjs MODULE
// -------------------------------
// Same reason as roundtrip-harness.mjs: vitest.config.ts's include is
// ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'], so a *.test.ts
// under memory-contract/v1/tests/ is never discovered and would silently
// never run. This file is imported, never discovered. It imports nothing from
// src/ or dist/ -- only node builtins, ajv, and this contract's own artifacts
// -- so an HTTP provider can drive the same lane with no edit here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(HERE, '..', 'schemas');

/**
 * Tools that CANNOT be driven without a live external service, each with the
 * reason it is excluded. Every entry here is surfaced by name in the lane's
 * printed report -- a silent omission would recreate the exact blind spot
 * this lane exists to close, so a tool is either covered or it is listed
 * here, and a listed tool with an empty reason is itself a failure.
 *
 * As of the KB redesign (self-scoped code_* tools), the 7 index-backed code_*
 * query tools no longer answer `{supported:false, reason}` without an index:
 * a missing index is a THROWN E-CODE-INDEX-NOT-READY refusal (pinned by their
 * refusal-index-not-ready fixtures), so no ok response exists to validate
 * without a live, built code index (GitNexus / codebase-memory). They are
 * listed here, by name and reason, rather than quietly falling out of the
 * covered set. code_reindex / code_status still answer in-process
 * (provider-not-supported) and stay covered.
 * @type {Readonly<Record<string, string>>}
 */
const NEEDS_LIVE_CODE_INDEX =
  'needs a live, built code index (GitNexus / codebase-memory): without one every call is the thrown ' +
  'E-CODE-INDEX-NOT-READY refusal its refusal-index-not-ready fixture pins, so no ok response exists in-process';
export const LIVE_SERVICE_SKIPS = Object.freeze({
  code_graph: NEEDS_LIVE_CODE_INDEX,
  code_impact: NEEDS_LIVE_CODE_INDEX,
  code_query: NEEDS_LIVE_CODE_INDEX,
  code_context: NEEDS_LIVE_CODE_INDEX,
  code_map: NEEDS_LIVE_CODE_INDEX,
  code_flow: NEEDS_LIVE_CODE_INDEX,
  code_tests: NEEDS_LIVE_CODE_INDEX,
});

const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiledValidators = new Map();
const loadedSchemas = new Map();

/** The generated response schema document for `tool`. */
export function loadResponseSchema(tool) {
  let schema = loadedSchemas.get(tool);
  if (!schema) {
    schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, `${tool}.response.json`), 'utf8'));
    loadedSchemas.set(tool, schema);
  }
  return schema;
}

function responseValidatorFor(tool) {
  let validate = compiledValidators.get(tool);
  if (!validate) {
    validate = ajv.compile(loadResponseSchema(tool));
    compiledValidators.set(tool, validate);
  }
  return validate;
}

/**
 * Render ajv errors so the OFFENDING FIELD is always named, not just the
 * instance path. `additionalProperties` errors put the undeclared key in
 * `params.additionalProperty` and leave it out of both `instancePath` and
 * `message` ("must NOT have additional properties"), so a caller that only
 * printed those two would report drift without ever saying WHICH field
 * drifted -- useless for the one job this lane has.
 */
export function formatResponseErrors(errors) {
  return (errors ?? [])
    .map((e) => {
      const where = e.instancePath || '/';
      const named = e.params?.additionalProperty ?? e.params?.missingProperty;
      return `${where} ${e.message}${named ? ` (${named})` : ''}`;
    })
    .join('; ');
}

/**
 * Validate one payload against schemas/<tool>.response.json.
 * @returns {{valid: boolean, errors: string, errorList: object[]}}
 */
export function validateToolResponse(tool, payload) {
  const validate = responseValidatorFor(tool);
  const valid = Boolean(validate(payload));
  const errorList = valid ? [] : [...(validate.errors ?? [])];
  return { valid, errors: formatResponseErrors(errorList), errorList };
}

/**
 * True when the tool's response schema declares a TYPED `parsed` body -- i.e.
 * one whose own properties are spelled out, which is the only case where
 * reaching that body proves anything. The 7 code_* tools and kb_query
 * deliberately declare `parsed` as an empty (unconstrained) schema, mirroring
 * their z.unknown() zod shape; those accept any payload, so "did a live
 * response reach it" is not a meaningful coverage question for them.
 */
export function schemaDeclaresParsedBody(tool) {
  const schema = loadResponseSchema(tool);
  const root = schema.$defs?.[Object.keys(schema.$defs ?? {})[0]] ?? schema;
  const parsed = root.properties?.parsed;
  return Boolean(parsed && Object.keys(parsed.properties ?? {}).length > 0);
}

/** A decoded `parsed` body counts as REACHED only if it carries actual content. */
function parsedBodyReached(parsed) {
  if (parsed === null || typeof parsed !== 'object') return false;
  return (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length) > 0;
}

/**
 * Collects live observations from runRoundTrip()'s `onLiveResponse` hook and
 * turns them into a coverage report.
 *
 * @param {object} options
 * @param {string[]} options.roster  the inventoried tool roster (pass
 *   generate-contract.mjs's own exported roster, never a hand-copied list)
 * @param {Record<string,string>} [options.skips]  tool -> reason
 * @returns {{onLiveResponse: (observation: object) => void, report: () => object}}
 */
export function createResponseConformanceRecorder({ roster, skips = LIVE_SERVICE_SKIPS } = {}) {
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error('createResponseConformanceRecorder needs the inventoried tool roster');
  }
  /** @type {Map<string, {cases: string[], parsedReached: boolean}>} */
  const seen = new Map();
  const failures = [];

  const onLiveResponse = (observation) => {
    const { tool, case: caseName, decoded } = observation ?? {};
    if (!tool) throw new Error('onLiveResponse observation carries no tool name');
    const entry = seen.get(tool) ?? { cases: [], parsedReached: false };
    entry.cases.push(caseName ?? '<unnamed>');
    if (parsedBodyReached(decoded?.parsed)) entry.parsedReached = true;
    seen.set(tool, entry);

    // Validate HERE rather than trusting the driver's own verdict: this lane
    // must fail on its own evidence, so an upstream check that stopped
    // running cannot leave it silently green.
    const { valid, errors } = validateToolResponse(tool, decoded);
    if (!valid) {
      failures.push(
        `${tool}/${caseName ?? '<unnamed>'}: live response does not validate against ` +
          `schemas/${tool}.response.json: ${errors}`,
      );
    }
  };

  const report = () => {
    const skipEntries = Object.entries(skips ?? {});
    const skipped = skipEntries.map(([tool, reason]) => ({ tool, reason }));
    const structural = [];

    for (const { tool, reason } of skipped) {
      if (!reason || !String(reason).trim()) {
        structural.push(`${tool}: is on the skip list with no reason -- an unexplained skip is a silent blind spot`);
      }
      if (!roster.includes(tool)) {
        structural.push(`${tool}: is on the skip list but is not an inventoried tool`);
      }
      if (seen.has(tool)) {
        structural.push(`${tool}: is on the skip list but WAS driven live -- remove the stale skip`);
      }
    }

    const covered = [];
    const uncovered = [];
    for (const tool of roster) {
      const entry = seen.get(tool);
      if (!entry) {
        if (!skips?.[tool]) {
          uncovered.push(tool);
          structural.push(
            `${tool}: no live response was validated against schemas/${tool}.response.json, ` +
              'and it is not on the explicit live-service skip list',
          );
        }
        continue;
      }
      const declaresParsedBody = schemaDeclaresParsedBody(tool);
      covered.push({
        tool,
        responses: entry.cases.length,
        cases: entry.cases,
        declaresParsedBody,
        parsedReached: entry.parsedReached,
      });
      if (declaresParsedBody && !entry.parsedReached) {
        structural.push(
          `${tool}: schema declares a typed parsed body but no live response reached it -- ` +
            'that body (and its additionalProperties:false) was never actually validated',
        );
      }
    }

    return {
      covered,
      skipped,
      uncovered,
      rosterSize: roster.length,
      responsesValidated: covered.reduce((n, c) => n + c.responses, 0),
      failures: [...failures, ...structural],
    };
  };

  return { onLiveResponse, report };
}

/** Human-readable rendering of report(), printed by the lane so a run states its own coverage. */
export function formatConformanceReport(report) {
  const lines = [];
  lines.push('memory-contract/v1 LIVE response conformance lane');
  lines.push(
    `  covered: ${report.covered.length}/${report.rosterSize} tools, ` +
      `${report.responsesValidated} live responses validated against schemas/<tool>.response.json`,
  );
  for (const c of report.covered) {
    const parsedNote = c.declaresParsedBody
      ? c.parsedReached
        ? 'typed parsed body REACHED'
        : 'typed parsed body NOT reached'
      : 'parsed body unconstrained by schema (z.unknown)';
    lines.push(`    ${c.tool.padEnd(26)} ${String(c.responses).padStart(2)} response(s)  ${parsedNote}`);
  }
  lines.push(`  skipped: ${report.skipped.length} tool(s)`);
  for (const s of report.skipped) {
    lines.push(`    ${s.tool.padEnd(26)} SKIPPED: ${s.reason}`);
  }
  if (report.uncovered.length > 0) {
    lines.push(`  UNCOVERED (neither driven nor skipped): ${report.uncovered.join(', ')}`);
  }
  lines.push(`  failures: ${report.failures.length}`);
  for (const f of report.failures) lines.push(`    - ${f}`);
  return lines.join('\n');
}
