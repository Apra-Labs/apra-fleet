import { describe, it, expect } from 'vitest';
import { getProviderInstallConfig } from '../src/cli/config.js';
import { buildRequiredPerms } from '../src/cli/install.js';

describe('buildRequiredPerms', () => {
  it('does not include tracker_* for Claude provider', () => {
    const paths = getProviderInstallConfig('claude');
    const perms = buildRequiredPerms(paths);
    expect(perms).not.toContain('tracker_*');
    for (const p of perms) {
      expect(p).not.toMatch(/^[a-zA-Z_]+\*$/);
    }
  });

  it('includes tracker_* for Gemini provider', () => {
    const paths = getProviderInstallConfig('gemini');
    const perms = buildRequiredPerms(paths);
    expect(perms).toContain('tracker_*');
  });

  it('always includes mcp__apra-fleet__* and Agent(*)', () => {
    for (const provider of ['claude', 'gemini', 'codex'] as const) {
      const perms = buildRequiredPerms(getProviderInstallConfig(provider));
      expect(perms).toContain('mcp__apra-fleet__*');
      expect(perms).toContain('Agent(*)');
    }
  });
});
