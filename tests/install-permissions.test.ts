import { describe, it, expect } from 'vitest';
import { getProviderInstallConfig } from '../src/cli/config.js';
import { buildRequiredPerms, pruneInvalidRules } from '../src/cli/install.js';

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

describe('pruneInvalidRules', () => {
  it('removes tracker_* from existing Claude allow list', () => {
    const allow = ['mcp__apra-fleet__*', 'tracker_*', 'Agent(*)'];
    const result = pruneInvalidRules(allow, 'Claude');
    expect(result).not.toContain('tracker_*');
    expect(result).toContain('mcp__apra-fleet__*');
    expect(result).toContain('Agent(*)');
  });

  it('preserves tracker_* for Gemini provider', () => {
    const allow = ['mcp__apra-fleet__*', 'tracker_*', 'Agent(*)'];
    const result = pruneInvalidRules(allow, 'Gemini');
    expect(result).toContain('tracker_*');
  });

  it('preserves tracker_* for non-Claude providers', () => {
    for (const name of ['Gemini', 'Codex', 'Copilot', 'Antigravity']) {
      const allow = ['tracker_*', 'other_rule'];
      const result = pruneInvalidRules(allow, name);
      expect(result).toContain('tracker_*');
    }
  });

  it('is a no-op when tracker_* is not present for Claude', () => {
    const allow = ['mcp__apra-fleet__*', 'Agent(*)'];
    const result = pruneInvalidRules(allow, 'Claude');
    expect(result).toEqual(allow);
  });

  it('handles empty allow list', () => {
    expect(pruneInvalidRules([], 'Claude')).toEqual([]);
  });
});
