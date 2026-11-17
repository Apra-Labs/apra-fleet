/**
 * Pins the wording of the `unreservable` field description on register_member
 * and update_member: it names fleet-sprint's shared "backlog" role, not the
 * deprecated "orchestrator" alias.
 */
import { describe, it, expect } from 'vitest';
import { registerMemberSchema } from '../src/tools/register-member.js';
import { updateMemberSchema } from '../src/tools/update-member.js';

describe('unreservable field description', () => {
  for (const [name, schema] of [
    ['register_member', registerMemberSchema],
    ['update_member', updateMemberSchema],
  ] as const) {
    it(`${name} refers to the backlog role, not orchestrator`, () => {
      const desc: string = (schema.shape.unreservable as any).description;
      expect(desc).toContain('"backlog"');
      expect(desc).not.toMatch(/orchestrator/i);
    });
  }
});
