/**
 * boundChildEnv: the explicit rule bounding the env local Windows members hand
 * to bd/dolt/git (Windows CreateProcess "Not enough memory resources" failure;
 * see docs/troubleshooting.md). Pure function -- runs on every OS.
 */
import { describe, it, expect } from 'vitest';
import {
  boundChildEnv,
  dedupePathValue,
  envBlockSize,
  isProtectedEnvName,
  CHILD_ENV_BLOCK_CAP_CHARS,
} from '../src/os/child-env-bound.js';

describe('envBlockSize', () => {
  it('counts NAME=VALUE\\0 per variable plus the block terminator', () => {
    expect(envBlockSize({})).toBe(1);
    expect(envBlockSize({ A: 'bc' })).toBe(1 + 1 + 2 + 1 + 1);
  });
});

describe('dedupePathValue', () => {
  it('drops case-insensitive and trailing-slash duplicates and empty entries, first wins', () => {
    const v = 'C:\\Windows\\system32;C:\\Git\\cmd;;c:\\windows\\SYSTEM32\\;C:\\Git\\cmd;C:\\npm';
    expect(dedupePathValue(v, ';')).toBe('C:\\Windows\\system32;C:\\Git\\cmd;C:\\npm');
  });
});

describe('boundChildEnv', () => {
  it('merges Path/PATH keys into the first and dedupes them', () => {
    const { env, report } = boundChildEnv({ Path: 'C:\\a;C:\\b', PATH: 'C:\\B;C:\\c' });
    expect(env).toEqual({ Path: 'C:\\a;C:\\b;C:\\c' });
    expect(report.pathEntriesBefore).toBe(4);
    expect(report.pathEntriesAfter).toBe(3);
  });

  it('leaves an env already under the cap untouched apart from PATH dedupe', () => {
    const input = { Path: 'C:\\a', FOO: 'x'.repeat(1000), USERPROFILE: 'C:\\Users\\u' };
    const { env, report } = boundChildEnv(input);
    expect(env).toEqual(input);
    expect(report.dropped).toEqual([]);
    expect(report.overCap).toBe(false);
  });

  it('drops the largest non-protected variables first until the block fits the cap', () => {
    const input = {
      Path: 'C:\\Git\\cmd',
      HUGE: 'h'.repeat(30000),
      MEDIUM: 'm'.repeat(5000),
      SMALL: 's'.repeat(10),
      GH_TOKEN: 't'.repeat(20000),
    };
    const { env, report } = boundChildEnv(input, { capChars: 26000 });
    expect(report.dropped).toEqual(['HUGE']);
    expect(env.GH_TOKEN).toBe(input.GH_TOKEN);
    expect(env.MEDIUM).toBe(input.MEDIUM);
    expect(envBlockSize(env)).toBeLessThanOrEqual(26000);
    expect(report.sizeAfter).toBe(envBlockSize(env));
    expect(report.overCap).toBe(false);
  });

  it('never drops protected variables, and reports overCap when they alone exceed the cap', () => {
    const { env, report } = boundChildEnv(
      { Path: 'C:\\' + 'p'.repeat(CHILD_ENV_BLOCK_CAP_CHARS), JUNK: 'j' },
    );
    expect(Object.keys(env)).toEqual(['Path']);
    expect(report.dropped).toEqual(['JUNK']);
    expect(report.overCap).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = { Path: 'C:\\a;C:\\a', X: 'x'.repeat(40000) };
    const copy = { ...input };
    boundChildEnv(input);
    expect(input).toEqual(copy);
  });
});

describe('isProtectedEnvName', () => {
  it.each(['Path', 'HOME', 'userprofile', 'SystemRoot', 'GIT_ASKPASS', 'GCM_INTERACTIVE', 'GH_TOKEN',
    'ANTHROPIC_API_KEY', 'MY_SERVICE_PASSWORD', 'HTTPS_PROXY', 'TEMP'])('%s is protected', (n) => {
    expect(isProtectedEnvName(n)).toBe(true);
  });
  it.each(['BIG_INHERITED_BLOB', 'PS1', 'LS_COLORS'])('%s is droppable', (n) => {
    expect(isProtectedEnvName(n)).toBe(false);
  });
});
