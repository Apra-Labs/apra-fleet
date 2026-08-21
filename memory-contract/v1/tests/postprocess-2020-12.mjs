// Deterministic JSON Schema 2020-12 post-processing step for the v1 memory
// contract.
//
// WHY THIS FILE EXISTS
// The generator bake-off (see GENERATOR-DECISION.md in this directory) found
// that neither candidate emits clean draft-2020-12 for the v1 surface as it is
// authored today:
//   - zod's native z.toJSONSchema (zod/v4) cannot consume the surface at all,
//     because every schema in src/tools/ is authored against the zod v3 API.
//   - zod-to-json-schema@3.25.1 consumes v3 fine, but its
//     target: 'jsonSchema2020-12' mode is a net regression versus its
//     'jsonSchema7' mode: it drops the $schema dialect declaration entirely
//     and rewrites exclusive numeric bounds into the draft-04 boolean form.
// So the contract takes the documented fallback: emit with the CLOSEST output
// (target: 'jsonSchema7', definitionPath: '$defs') and normalise it to
// 2020-12 here.
//
// CONTRACT FOR CALLERS (the contract:generate wiring owned by T1.2.2)
//   import { postprocessTo2020_12, DIALECT_2020_12 } from './postprocess-2020-12.mjs';
//   const out = postprocessTo2020_12(zodToJsonSchema(schema, {
//     target: 'jsonSchema7',
//     definitionPath: '$defs',
//     name: 'v1-<TOOL>',      // optional
//   }));
//
// DETERMINISM GUARANTEES (required by this task's acceptance criteria)
//   - Pure function: no Date, no Math.random, no process/env reads, no I/O.
//   - Input is never mutated; a deep copy is returned.
//   - Key order is the input's key order. New keys are only ever appended at
//     a fixed position: $schema is written first at the root, and a converted
//     `prefixItems` replaces `items` in place.
//   - Idempotent: postprocessTo2020_12(postprocessTo2020_12(x)) deep-equals
//     postprocessTo2020_12(x).
// Together these mean the same source schema always produces byte-identical
// output, which is what makes the committed artifacts diffable and lets the
// drift guard fail on a real contract change rather than on generator noise.

/** The exact dialect the v1 contract targets. OpenAPI 3.1 binds to this URI. */
export const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Normalise one generator output object to JSON Schema draft-2020-12.
 *
 * Fixes applied, in this order:
 *   1. Root $schema is set to DIALECT_2020_12 (replacing a draft-07 or any
 *      other declaration, or injecting it when absent).
 *   2. `definitions` is renamed to `$defs`, and any `#/definitions/...` $ref
 *      pointer is repointed at `#/$defs/...`.
 *   3. Draft-04 boolean exclusive bounds are converted to the numeric 2020-12
 *      form: {minimum: N, exclusiveMinimum: true} -> {exclusiveMinimum: N}
 *      (same for the maximum pair). A bound that is already numeric is left
 *      alone.
 *   4. Draft-07 array-form `items` (a tuple) is converted to `prefixItems`,
 *      with a redundant `maxItems` equal to the tuple length dropped in favour
 *      of `items: false`.
 *
 * @param {unknown} schema Raw generator output. Non-objects are returned as-is.
 * @returns {unknown} A new object in the 2020-12 dialect.
 */
export function postprocessTo2020_12(schema) {
  if (!isPlainObject(schema)) return schema;
  const normalised = normaliseNode(schema);
  // $schema first, so the dialect declaration is the first key of the file.
  const { $schema: _dropped, ...rest } = normalised;
  return { $schema: DIALECT_2020_12, ...rest };
}

// --- internals ---------------------------------------------------------------

function normaliseNode(node) {
  if (Array.isArray(node)) return node.map(normaliseNode);
  if (!isPlainObject(node)) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions') {
      // Fix 2: draft-07 `definitions` -> 2020-12 `$defs`.
      out.$defs = normaliseNode(value);
      continue;
    }
    if (key === '$ref' && typeof value === 'string') {
      out.$ref = value.replace('#/definitions/', '#/$defs/');
      continue;
    }
    out[key] = normaliseNode(value);
  }

  convertExclusiveBound(out, 'minimum', 'exclusiveMinimum');
  convertExclusiveBound(out, 'maximum', 'exclusiveMaximum');
  convertTupleItems(out);
  return out;
}

// Fix 3. The draft-04 form spells an exclusive bound as an inclusive bound plus
// a boolean flag; 2020-12 requires the keyword itself to carry the number.
function convertExclusiveBound(node, inclusiveKey, exclusiveKey) {
  if (node[exclusiveKey] !== true) return;
  if (typeof node[inclusiveKey] !== 'number') {
    // A boolean flag with no companion bound carries no threshold at all, so
    // there is nothing to preserve. Dropping it is the only lossless-in-intent
    // option; keeping it would emit an invalid 2020-12 keyword.
    delete node[exclusiveKey];
    return;
  }
  node[exclusiveKey] = node[inclusiveKey];
  delete node[inclusiveKey];
}

// Fix 4. draft-07 encodes a tuple as `items: [ ... ]`; 2020-12 renamed that to
// `prefixItems` and reserved `items` for the rest of the array.
function convertTupleItems(node) {
  if (!Array.isArray(node.items)) return;
  const prefix = node.items;
  const rebuilt = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'items') {
      rebuilt.prefixItems = prefix;
      // A draft-07 tuple pins length with maxItems; in 2020-12 the closed form
      // is `items: false`, which is strictly clearer about intent.
      if (node.maxItems === prefix.length) rebuilt.items = false;
      continue;
    }
    if (key === 'maxItems' && value === prefix.length) continue;
    rebuilt[key] = value;
  }
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, rebuilt);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
