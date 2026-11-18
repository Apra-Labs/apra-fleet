import { describe, it, expect } from 'vitest';
import { executePromptSchema } from '../src/tools/execute-prompt.js';
// @ts-expect-error -- plain .mjs workspace package without type declarations
import { EXECUTE_PROMPT_MAX_TURNS } from '../packages/apra-fleet-client/src/client/api.mjs';

function schemaMaxTurns(): number {
  const field: any = (executePromptSchema as any).shape.max_turns;
  const checks: any[] = field.unwrap?.()?._def?.checks ?? field._def?.innerType?._def?.checks ?? [];
  const max = checks.find((c) => c.kind === 'max');
  if (max) return max.value;
  // zod v4 exposes maxValue on the schema itself
  const inner: any = field.unwrap?.() ?? field;
  return inner.maxValue;
}

describe('EXECUTE_PROMPT_MAX_TURNS', () => {
  it('equals the max_turns maximum in executePromptSchema', () => {
    expect(schemaMaxTurns()).toBe(EXECUTE_PROMPT_MAX_TURNS);
  });
  it('is accepted by the schema and one more is rejected', () => {
    const base = { member_id: 'm', prompt: 'p' } as any;
    expect(executePromptSchema.safeParse({ ...base, max_turns: EXECUTE_PROMPT_MAX_TURNS }).success).toBe(true);
    expect(executePromptSchema.safeParse({ ...base, max_turns: EXECUTE_PROMPT_MAX_TURNS + 1 }).success).toBe(false);
  });
});
