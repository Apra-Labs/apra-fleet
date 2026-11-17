// Regression coverage for memory-contract/v1/tests/postprocess-2020-12.mjs
// edge cases that the generator bake-off probe (probe-generator-2020-12.mjs)
// never exercises against the real 23-tool surface: nested `definitions`
// $ref pointers, a node carrying both `definitions` and `$defs`, and an
// explicit draft-04 `exclusiveMinimum: false`.
//
// This file lives under the repo's top-level tests/ (not
// memory-contract/v1/tests/) because vitest.config.ts only discovers
// tests/**/*.test.ts and packages/*/tests/**/*.test.ts -- a *.test.ts placed
// alongside the probe would never run.
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { postprocessTo2020_12, DIALECT_2020_12 } from '../memory-contract/v1/tests/postprocess-2020-12.mjs';

const ajv = new Ajv2020({ strict: false, validateSchema: true });

function conforms(doc: unknown) {
  const ok = ajv.validateSchema(doc as object);
  return { ok, errors: ok ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) };
}

describe('postprocessTo2020_12 edge cases (fixes 2 and 3)', () => {
  it('fix 2: repoints EVERY /definitions/ segment of a nested $ref pointer, not just the first', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: {
        a: {
          definitions: {
            b: { type: 'string' },
          },
        },
      },
      $ref: '#/definitions/a/definitions/b',
    };

    const out = postprocessTo2020_12(input) as any;

    // Both segments repointed -- a non-global replace would leave the second
    // '/definitions/' untouched.
    expect(out.$ref).toBe('#/$defs/a/$defs/b');
    expect(out.$defs.a.$defs.b).toEqual({ type: 'string' });
    expect(out.definitions).toBeUndefined();
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 2: merges definitions into an existing $defs instead of clobbering it', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $defs: { fromDefs: { type: 'string' } },
      definitions: { fromDefinitions: { type: 'number' } },
      properties: {
        x: { $ref: '#/$defs/fromDefs' },
        y: { $ref: '#/definitions/fromDefinitions' },
      },
    };

    const out = postprocessTo2020_12(input) as any;

    // Neither entry is lost, regardless of which key the input listed first.
    expect(out.$defs.fromDefs).toEqual({ type: 'string' });
    expect(out.$defs.fromDefinitions).toEqual({ type: 'number' });
    expect(out.definitions).toBeUndefined();
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 2: a native $defs entry wins over a same-named definitions entry on collision', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $defs: { shared: { type: 'string' } },
      definitions: { shared: { type: 'number' } },
    };

    const out = postprocessTo2020_12(input) as any;

    expect(out.$defs.shared).toEqual({ type: 'string' });
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 3: drops an explicit draft-04 exclusiveMinimum: false (inclusive form) instead of leaving an invalid boolean', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
      minimum: 0,
      exclusiveMinimum: false,
    };

    // Confirm the metaschema really does reject the untouched boolean form,
    // so this test would fail if the fix were removed.
    expect(conforms({ ...input, $schema: DIALECT_2020_12 }).ok).toBe(false);

    const out = postprocessTo2020_12(input) as any;

    expect(out.exclusiveMinimum).toBeUndefined();
    expect(out.minimum).toBe(0);
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 3: drops an explicit draft-04 exclusiveMaximum: false the same way', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
      maximum: 100,
      exclusiveMaximum: false,
    };

    const out = postprocessTo2020_12(input) as any;

    expect(out.exclusiveMaximum).toBeUndefined();
    expect(out.maximum).toBe(100);
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 2: a property named "definitions" is left alone -- only container positions are renamed', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        definitions: {
          type: 'object',
          properties: { x: { type: 'string' } },
        },
        ref: { $ref: '#/properties/definitions/properties/x' },
      },
    };

    const out = postprocessTo2020_12(input) as any;

    // The property named "definitions" keeps its name and is NOT folded into
    // $defs -- it is data, not a schema keyword, at this position.
    expect(out.properties.definitions).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
    expect(out.$defs).toBeUndefined();
    // The pointer through it is untouched for the same reason: the
    // "definitions" segment here names a property, not the $defs container.
    expect(out.properties.ref.$ref).toBe('#/properties/definitions/properties/x');
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 2: a $defs entry named "definitions" is preserved as a definition, not treated as a nested container', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: {
        definitions: { type: 'string' },
      },
      $ref: '#/definitions/definitions',
    };

    const out = postprocessTo2020_12(input) as any;

    expect(out.$defs.definitions).toEqual({ type: 'string' });
    expect(out.$ref).toBe('#/$defs/definitions');
    expect(conforms(out).ok).toBe(true);
  });

  it('fix 3: still converts a true draft-04 exclusive bound to the numeric 2020-12 form (no regression)', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
      minimum: 0,
      exclusiveMinimum: true,
    };

    const out = postprocessTo2020_12(input) as any;

    expect(out.exclusiveMinimum).toBe(0);
    expect(out.minimum).toBeUndefined();
    expect(conforms(out).ok).toBe(true);
  });
});
