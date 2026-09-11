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
 *   2. `definitions` is renamed to `$defs` (merged in, never clobbering a
 *      `$defs` the node already carries), and every `/definitions/` segment
 *      of a `$ref` pointer is repointed at `/$defs/`, including nested ones.
 *      Both halves are container-aware: a `definitions`/`$defs` key (or
 *      pointer segment) is only treated as the container keyword at a schema
 *      position -- never when it is a property name, pattern, or definition
 *      entry name that merely happens to be spelled "definitions".
 *   3. Draft-04 boolean exclusive bounds are converted to the numeric 2020-12
 *      form: {minimum: N, exclusiveMinimum: true} -> {exclusiveMinimum: N}
 *      (same for the maximum pair). A bound that is already numeric is left
 *      alone. An explicit draft-04 `exclusiveMinimum/Maximum: false` (the
 *      inclusive form) is dropped rather than left as an invalid 2020-12
 *      boolean, since the plain minimum/maximum keyword already means
 *      inclusive on its own.
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

// Keys whose OWN VALUE is a map of opaque identifiers -> schema, not a schema
// keyword object: iterating that value's keys as if they were keywords is
// exactly the container-blindness bug this fix removes (a property, pattern,
// or $defs/definitions entry can itself be named "definitions").
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties']);

function normaliseNode(node) {
  if (Array.isArray(node)) return node.map(normaliseNode);
  if (!isPlainObject(node)) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions') {
      // Fix 2: draft-07 `definitions` -> 2020-12 `$defs`, but ONLY when
      // `definitions` appears at a schema position (here: as a keyword of
      // this schema node). The container's own entries are names, not
      // keywords -- normalised via normaliseSchemaMap so an entry literally
      // named "definitions" is never mistaken for a nested container.
      // Merge rather than overwrite: a node can carry BOTH keys (e.g. a
      // native $defs plus a stray definitions container), and a plain
      // assignment here would silently drop whichever one is processed
      // first. A native $defs entry wins on key collision, since it is
      // already in the target dialect.
      const entries = isPlainObject(value) ? normaliseSchemaMap(value) : normaliseNode(value);
      out.$defs = { ...entries, ...out.$defs };
      continue;
    }
    if (key === '$defs') {
      const entries = isPlainObject(value) ? normaliseSchemaMap(value) : normaliseNode(value);
      out.$defs = { ...out.$defs, ...entries };
      continue;
    }
    if (key === '$ref' && typeof value === 'string') {
      out.$ref = rewriteDefinitionsPointer(value);
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      // `properties` / `patternProperties`: the KEYS here are user-chosen
      // property names or regex patterns, never schema keywords, so a key
      // literally called "definitions" must pass through unrenamed. Each
      // VALUE is still a full schema and is normalised as one.
      out[key] = normaliseSchemaMap(value);
      continue;
    }
    out[key] = normaliseNode(value);
  }

  convertExclusiveBound(out, 'minimum', 'exclusiveMinimum');
  convertExclusiveBound(out, 'maximum', 'exclusiveMaximum');
  convertTupleItems(out);
  return out;
}

// Normalises a "map" node -- the value of `properties`, `patternProperties`,
// `$defs` or `definitions` -- whose keys are opaque identifiers (property
// names, regex patterns, or definition names) rather than schema keywords.
// Keys are passed through untouched; each value is a normal schema node.
function normaliseSchemaMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = normaliseNode(value);
  }
  return out;
}

// Fix 2 (pointer half). Repoints every `/definitions/` SEGMENT of a $ref that
// is actually a container reference, by walking the pointer's JSON-Pointer
// segments with the same container knowledge as normaliseNode above -- never
// by a blind string replace, which cannot tell a container segment (e.g.
// '#/definitions/Foo') from a same-named property/definition segment (e.g.
// '#/properties/definitions/properties/x', where "definitions" is a data
// name one level below `properties` and must NOT be rewritten).
//
// State machine over the pointer's segments:
//   'schema'  -- expecting a schema keyword next (the initial/default state).
//                A `definitions` segment here is a container keyword and is
//                rewritten to `$defs`; a `$defs`/`properties`/
//                `patternProperties` segment here is also a container
//                keyword (left as-is) and both put the NEXT segment into
//                'mapName' state. Any other segment is passed through
//                unchanged and the state stays 'schema'.
//   'mapName' -- the segment is an opaque name (property name, pattern, or
//                $defs/definitions entry name) belonging to the container
//                just entered. Passed through unchanged regardless of its
//                literal value, then the state returns to 'schema' for that
//                entry's own nested keys.
function rewriteDefinitionsPointer(ref) {
  const hashIndex = ref.indexOf('#');
  if (hashIndex === -1) return ref; // no fragment to walk
  const fragment = ref.slice(hashIndex + 1);
  if (!fragment.startsWith('/')) return ref; // not a JSON Pointer fragment

  const segments = fragment.split('/').slice(1);
  let state = 'schema';
  const rewritten = segments.map((segment) => {
    if (state === 'mapName') {
      state = 'schema';
      return segment;
    }
    if (segment === 'definitions') {
      state = 'mapName';
      return '$defs';
    }
    if (segment === '$defs' || SCHEMA_MAP_KEYWORDS.has(segment)) {
      state = 'mapName';
      return segment;
    }
    return segment;
  });

  return `${ref.slice(0, hashIndex)}#/${rewritten.join('/')}`;
}

// Fix 3. The draft-04 form spells an exclusive bound as an inclusive bound plus
// a boolean flag; 2020-12 requires the keyword itself to carry the number.
function convertExclusiveBound(node, inclusiveKey, exclusiveKey) {
  if (typeof node[exclusiveKey] !== 'boolean') return;
  if (node[exclusiveKey] === false) {
    // Draft-04's explicit inclusive form. 2020-12 has no boolean flag at all:
    // the plain minimum/maximum keyword already means "inclusive" on its own,
    // so the flag carries no information and must be dropped rather than
    // left as a boolean (which the 2020-12 metaschema rejects outright).
    delete node[exclusiveKey];
    return;
  }
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
