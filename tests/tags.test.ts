import { describe, it, expect } from 'vitest';
import { updateMemberSchema } from '../src/tools/update-member.js';

describe('tags validation -- updateMemberSchema', () => {
  it('accepts a valid array of tags', () => {
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags: ['gpu', 'prod', 'high-mem'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty array (clear all tags)', () => {
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it('accepts exactly 10 tags (max-count boundary)', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags,
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map(e => e.message).join(' ');
      expect(messages).toMatch(/10 tags/i);
    }
  });

  it('accepts a tag of exactly 64 characters (max-length boundary)', () => {
    const tag = 'a'.repeat(64);
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags: [tag],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tag longer than 64 characters', () => {
    const tag = 'a'.repeat(65);
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
      tags: [tag],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map(e => e.message).join(' ');
      expect(messages).toMatch(/64 char/i);
    }
  });

  it('accepts tags when tags field is absent (optional)', () => {
    const result = updateMemberSchema.safeParse({
      member_id: 'test-id',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toBeUndefined();
    }
  });
});
