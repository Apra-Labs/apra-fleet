import { describe, it, expect } from 'vitest';
import { executePromptSchema } from '../src/tools/execute-prompt.js';
// @ts-expect-error -- plain .mjs engine module without type declarations
import { ROLE_POLICIES } from '../packages/apra-fleet-se/fleet-sprint/role-policies.mjs';
// @ts-expect-error -- plain .mjs engine module without type declarations
import { resolveMaxTurns, TURN_BASES } from '../packages/apra-fleet-se/fleet-sprint/dispatch-role.mjs';

// Every max_turns the sprint engine can send, resolved through the same
// clamp runDispatch uses, must pass the real execute_prompt input schema.
const base = { member_id: 'm', prompt: 'p' } as any;
const parses = (n: number) => executePromptSchema.safeParse({ ...base, max_turns: n });

describe('engine dispatch max_turns vs the real executePromptSchema', () => {
  const rows: Array<[string, any]> = Object.entries(ROLE_POLICIES) as any;

  it('finds the policy rows', () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  for (const [name, p] of rows) {
    it(`${name}: main and secondary budgets parse`, () => {
      for (const row of [p, p.secondary].filter(Boolean)) {
        if (!row.maxTurns) continue;
        if (row.maxTurns.kind === 'runtime') {
          // The doer's escalating ladder: BASE * 2^n for every resume attempt.
          const attempts = (p.retry && p.retry.resumeAttempts) || 2;
          for (let n = 1; n <= attempts + 1; n++) {
            const v = resolveMaxTurns(row.maxTurns, { [row.maxTurns.binding]: TURN_BASES.BASE_DOER_MAX_TURNS * 2 ** n });
            const r = parses(v);
            expect(r.success, `${name} runtime attempt ${n} -> ${v}`).toBe(true);
          }
        } else {
          const v = resolveMaxTurns(row.maxTurns, {});
          expect(parses(v).success, `${name} constant -> ${v}`).toBe(true);
        }
      }
    });
  }

  it('the unclamped policy values really exceed the schema (the clamp is load-bearing)', () => {
    const raw = Math.max(...rows.flatMap(([, p]) => [p, p.secondary]).filter((r: any) => r?.maxTurns?.kind === 'constant').map((r: any) => r.maxTurns.value));
    expect(parses(raw).success).toBe(false);
  });
});
