import { describe, it, expect, afterEach } from 'vitest';
import { deepMerge } from '../../src/cli/auth.js';

// The merge source is a JSON.parse result, where "__proto__" is an ordinary own
// key -- a naive recursive merge would walk into Object.prototype.
describe('auth deepMerge prototype-pollution guard', () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype.toString as unknown as Record<string, unknown>).polluted;
  });

  it('ignores __proto__ / constructor / prototype keys from parsed JSON', () => {
    const src = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"claudeAiOauth":{"accessToken":"t"}}',
    ) as Record<string, unknown>;
    const out = deepMerge({}, src);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).toEqual({ claudeAiOauth: { accessToken: 't' } });
  });

  it('never merges into an inherited member', () => {
    const src = JSON.parse('{"toString":{"polluted":"yes"}}') as Record<string, unknown>;
    const out = deepMerge({}, src);
    expect((Object.prototype.toString as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.toString).toEqual({ polluted: 'yes' });
  });

  it('still deep-merges own nested objects', () => {
    const target = { claudeAiOauth: { accessToken: 'old', refreshToken: 'r' }, other: 1 };
    const out = deepMerge(target, { claudeAiOauth: { accessToken: 'new' } });
    expect(out).toEqual({ claudeAiOauth: { accessToken: 'new', refreshToken: 'r' }, other: 1 });
  });
});
