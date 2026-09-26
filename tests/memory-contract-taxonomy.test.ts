// Guards memory-contract/v1/taxonomy.json -- the CLOSED error-code set -- and
// its two consistency obligations:
//
//   1. it must ACCOUNT FOR every provisional name in INVENTORY.md section 5
//      (each is either a code, an explicitly code-less non-error outcome, or
//      explicitly excluded), and
//   2. spec.md's error-model prose must add no code the taxonomy does not have.
//
// The prose points at the JSON; these tests bite on the JSON. Nothing here
// re-states a code's meaning, so a taxonomy edit needs no test edit unless it
// breaks one of the structural rules.
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/)
// because vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts -- the same reason as every other
// memory-contract test at this path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const V1_DIR = fileURLToPath(new URL('../memory-contract/v1/', import.meta.url));

type RaisingMethod = {
  method_id: string;
  member: string;
  tool: string;
  position: 'provider' | 'pre-provider';
};

type CodeEntry = {
  code: string;
  meaning: string;
  raising_methods: RaisingMethod[];
  retryable: boolean;
  surfaced: 'thrown' | 'response-field' | 'silent';
  see_also?: string[];
};

type Taxonomy = {
  _meta: Record<string, unknown>;
  groups: Record<string, { definition_ref: string; codes: CodeEntry[] }>;
  non_error_outcomes: { name: string; outcome: string; where: string; reason_no_code: string }[];
  excluded_from_closed_set: { codes: { code: string; where: string; reason_excluded: string }[] };
};

type ResponseSchemaDef = {
  properties?: { parsed?: { properties?: Record<string, unknown> } };
};

type MethodEntry = {
  id: string;
  member: string;
  tools: { name: string }[];
  error_codes?: string[];
  non_error_outcomes?: string[];
};

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(V1_DIR + name, 'utf8')) as T;
}

const taxonomy = readJson<Taxonomy>('taxonomy.json');
const methodsDoc = readJson<{ methods: MethodEntry[]; code_intelligence_methods: MethodEntry[] }>('methods.json');
const specText = readFileSync(V1_DIR + 'spec.md', 'utf8');
const inventoryText = readFileSync(V1_DIR + 'INVENTORY.md', 'utf8');

const EXPECTED_GROUPS = [
  'validation',
  'admission',
  'authority',
  'governance',
  'conflict',
  'not_found',
  'provider_internal',
];

const allMethods = [...methodsDoc.methods, ...methodsDoc.code_intelligence_methods];

/** Every code entry, paired with the group it was found in. */
function codesWithGroup(): { group: string; entry: CodeEntry }[] {
  return Object.entries(taxonomy.groups).flatMap(([group, body]) =>
    body.codes.map((entry) => ({ group, entry })),
  );
}

const codeNames = new Set(codesWithGroup().map(({ entry }) => entry.code));
const nonErrorNames = new Set(taxonomy.non_error_outcomes.map((o) => o.name));
const excludedNames = new Set(taxonomy.excluded_from_closed_set.codes.map((c) => c.code));

/**
 * Pull every backticked `E-...` provisional name out of INVENTORY.md section 5
 * (the error/refusal-path section), which is the inventory this taxonomy has to
 * account for.
 */
function inventorySection5Names(): Set<string> {
  const start = inventoryText.indexOf('## 5. Error and refusal paths');
  const end = inventoryText.indexOf('## 6.', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const section = inventoryText.slice(start, end);
  return new Set([...section.matchAll(/`(E-[A-Z0-9-]+)`/g)].map((m) => m[1]));
}

/** Every code-shaped token spec.md mentions anywhere, backticked or bare. */
function specMentionedCodes(): Set<string> {
  return new Set(
    [...specText.matchAll(/\bE-[A-Z0-9-]+/g)].map((m) => m[0].replace(/-+$/, '')),
  );
}

/**
 * The `### 4.x <title>` invariant headings a see_also must resolve to. Pinned to
 * section 4 specifically: any `### \d+\.\d+` would also match the error-model
 * subsections in section 3, so a cross-reference pointing at prose instead of an
 * invariant section would slip through.
 */
function specInvariantHeadings(): Set<string> {
  return new Set([...specText.matchAll(/^### 4\.\d+ (.+)$/gm)].map((m) => m[1].trim()));
}

describe('taxonomy.json structure', () => {
  it('has exactly the seven documented groups, each non-empty', () => {
    expect(Object.keys(taxonomy.groups).sort()).toEqual([...EXPECTED_GROUPS].sort());
    for (const [group, body] of Object.entries(taxonomy.groups)) {
      expect(body.codes.length, `group ${group} is empty`).toBeGreaterThan(0);
    }
  });

  it('gives every entry all four mandated fields, non-empty', () => {
    for (const { group, entry } of codesWithGroup()) {
      const where = `${group}/${entry.code}`;
      expect(entry.code, where).toMatch(/^E-[A-Z0-9-]+$/);
      expect(entry.meaning.trim(), `${where} meaning is empty`).not.toBe('');
      expect(Array.isArray(entry.raising_methods), `${where} raising_methods`).toBe(true);
      expect(entry.raising_methods.length, `${where} has no raising method`).toBeGreaterThan(0);
      expect(typeof entry.retryable, `${where} retryable`).toBe('boolean');
      expect(['thrown', 'response-field', 'silent'], `${where} surfaced`).toContain(entry.surfaced);
    }
  });

  it('puts every code in exactly one group', () => {
    const seen = new Map<string, string>();
    for (const { group, entry } of codesWithGroup()) {
      const prior = seen.get(entry.code);
      expect(prior, `${entry.code} appears in both ${prior} and ${group}`).toBeUndefined();
      seen.set(entry.code, group);
    }
  });

  it('marks no code retryable -- the documented v1 finding', () => {
    for (const { entry } of codesWithGroup()) {
      expect(entry.retryable, `${entry.code} claims to be retryable`).toBe(false);
    }
  });

  it('explains every silent refusal, since it has no runtime signal', () => {
    const silent = codesWithGroup().filter(({ entry }) => entry.surfaced === 'silent');
    expect(silent.length).toBeGreaterThan(0);
    for (const { entry } of silent) {
      const note = (entry as CodeEntry & { note?: string }).note ?? '';
      expect(note.trim(), `${entry.code} is silent but carries no note`).not.toBe('');
    }
  });

  // Falsifiability guard for the one surfaced value that projects a refusal onto
  // the wire WITHOUT the call having failed. A code misfiled as 'response-field'
  // makes a consumer refuse an operation this kernel actually performs, and the
  // drift/parity/taxonomy guards cannot see it: they check internal consistency,
  // and a misclassification is internally consistent. So bite on the generated
  // response schema instead -- the named field must really be there.
  it('backs every response-field code with a field that exists in a raising tool\'s response schema', () => {
    const responseField = codesWithGroup().filter(({ entry }) => entry.surfaced === 'response-field');
    expect(responseField.length).toBeGreaterThan(0);

    for (const { entry } of responseField) {
      const field = (entry as CodeEntry & { response_field?: string }).response_field ?? '';
      expect(
        field.trim(),
        `${entry.code} is surfaced: 'response-field' but names no response_field`,
      ).not.toBe('');

      const tools = [...new Set(entry.raising_methods.map((r) => r.tool))];
      const carriers = tools.filter((tool) => {
        const schema = readJson<{ $defs: Record<string, ResponseSchemaDef> }>(
          `schemas/${tool}.response.json`,
        );
        const def = schema.$defs[`v1-${tool}-response`];
        return Object.hasOwn(def?.properties?.parsed?.properties ?? {}, field);
      });

      expect(
        carriers,
        `${entry.code} names response_field '${field}', absent from the parsed body of every raising tool (${tools.join(', ')})`,
      ).not.toHaveLength(0);
    }
  });
});

describe('taxonomy.json has no orphan codes', () => {
  it('resolves every raising method to a methods.json member and one of its tools', () => {
    for (const { entry } of codesWithGroup()) {
      for (const raiser of entry.raising_methods) {
        const method = allMethods.find((m) => m.id === raiser.method_id);
        expect(method, `${entry.code} cites unknown method ${raiser.method_id}`).toBeDefined();
        expect(method?.member, `${entry.code} cites ${raiser.method_id} with wrong member`).toBe(
          raiser.member,
        );
        const toolNames = (method?.tools ?? []).map((t) => t.name);
        expect(
          toolNames,
          `${entry.code} cites tool ${raiser.tool}, not a route to ${raiser.method_id}`,
        ).toContain(raiser.tool);
        expect(['provider', 'pre-provider'], `${entry.code} position`).toContain(raiser.position);
      }
    }
  });
});

describe('taxonomy.json accounts for the whole inventory', () => {
  const disposition = (name: string): string | undefined => {
    if (codeNames.has(name)) return 'code';
    if (nonErrorNames.has(name)) return 'non-error';
    if (excludedNames.has(name)) return 'excluded';
    return undefined;
  };

  it('gives every INVENTORY.md section 5 provisional name exactly one disposition', () => {
    const names = inventorySection5Names();
    expect(names.size).toBeGreaterThan(20);
    for (const name of names) {
      expect(disposition(name), `${name} from INVENTORY.md section 5 has no disposition`).toBeDefined();
    }
  });

  it('gives every error code methods.json cites a disposition', () => {
    for (const method of allMethods) {
      for (const code of method.error_codes ?? []) {
        expect(
          disposition(code),
          `${code} (cited by methods.json ${method.id}) has no disposition`,
        ).toBeDefined();
      }
    }
  });

  // my-beads-db-27m.44: a bare non-error-outcome name inside error_codes
  // misdescribes it as a real code to a consumer reading methods.json alone,
  // even though taxonomy.json's disposition (and the reason recorded there)
  // says it deliberately gets none. methods.json instead cites these names
  // through a separate per-method `non_error_outcomes` field (see the
  // methods.json._meta note this bead adds), so `error_codes` stays a pure
  // list of taxonomy.json groups[].codes citations.
  it('never presents a non-error outcome name bare inside a methods.json error_codes array', () => {
    for (const method of allMethods) {
      for (const code of method.error_codes ?? []) {
        expect(
          nonErrorNames.has(code),
          `${method.id} error_codes cites ${code}, which taxonomy.json disposes as a non-error outcome -- ` +
            'move it to that method\'s non_error_outcomes field instead',
        ).toBe(false);
      }
    }
  });

  it('gives every methods.json non_error_outcomes citation a real taxonomy.json non-error disposition', () => {
    for (const method of allMethods) {
      for (const name of method.non_error_outcomes ?? []) {
        expect(
          nonErrorNames.has(name),
          `${method.id} non_error_outcomes cites ${name}, which taxonomy.json does not list as a non-error outcome`,
        ).toBe(true);
      }
    }
  });

  it('keeps codes, non-error outcomes and exclusions mutually disjoint', () => {
    for (const name of nonErrorNames) {
      expect(codeNames.has(name), `${name} is both a code and a non-error outcome`).toBe(false);
      expect(excludedNames.has(name), `${name} is both excluded and a non-error outcome`).toBe(false);
    }
    for (const name of excludedNames) {
      expect(codeNames.has(name), `${name} is both excluded and a live code`).toBe(false);
    }
  });

  it('lists the four mandated non-error outcomes with a reason', () => {
    for (const required of [
      'N-ANCHOR-VERBATIM-MISSING',
      'E-CLAMP',
      'E-DEDUP-NONE',
      'E-CONTRADICTION-FLAGGED',
    ]) {
      const outcome = taxonomy.non_error_outcomes.find((o) => o.name === required);
      expect(outcome, `${required} must be listed as getting no code`).toBeDefined();
      expect(outcome?.reason_no_code.trim(), `${required} has no reason`).not.toBe('');
      expect(outcome?.where.trim(), `${required} has no source pointer`).not.toBe('');
    }
  });
});

describe('directive activation is absent, not refused', () => {
  it('keeps the CLI-only activation codes out of every group', () => {
    expect(excludedNames.size).toBeGreaterThan(0);
    for (const name of excludedNames) {
      expect(codeNames.has(name), `${name} leaked into the closed set`).toBe(false);
    }
  });

  it('records a reason for each exclusion', () => {
    for (const excluded of taxonomy.excluded_from_closed_set.codes) {
      expect(excluded.reason_excluded.trim(), `${excluded.code} excluded with no reason`).not.toBe('');
    }
  });

  it('never names an excluded code in spec.md, which would document the route', () => {
    for (const name of excludedNames) {
      expect(specText.includes(name), `spec.md names excluded code ${name}`).toBe(false);
    }
  });
});

describe('spec.md error model stays consistent with taxonomy.json', () => {
  it('adds no code that taxonomy.json does not have', () => {
    for (const mentioned of specMentionedCodes()) {
      const known = codeNames.has(mentioned) || nonErrorNames.has(mentioned);
      expect(known, `spec.md mentions ${mentioned}, absent from taxonomy.json`).toBe(true);
    }
  });

  it('has a filled-in error-model section that points at taxonomy.json', () => {
    const start = specText.indexOf('## 3. Error model');
    const end = specText.indexOf('## 4.', start);
    expect(start).toBeGreaterThan(-1);
    const section = specText.slice(start, end);
    expect(section).not.toMatch(/RESERVED/);
    expect(section).toContain('taxonomy.json');
  });

  it('cross-references every governance code to a reserved invariant section', () => {
    const headings = specInvariantHeadings();
    expect(headings.size).toBeGreaterThan(0);
    for (const entry of taxonomy.groups.governance.codes) {
      const refs = entry.see_also ?? [];
      expect(refs.length, `governance code ${entry.code} has no invariant cross-reference`).toBeGreaterThan(0);
    }
  });

  it('resolves every cross-reference in every group to a real invariant heading', () => {
    const headings = specInvariantHeadings();
    for (const { entry } of codesWithGroup()) {
      for (const ref of entry.see_also ?? []) {
        expect(headings, `${entry.code} cross-references unknown spec.md section "${ref}"`).toContain(ref);
      }
    }
  });
});
