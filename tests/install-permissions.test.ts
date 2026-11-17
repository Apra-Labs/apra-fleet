import { describe, it, expect } from 'vitest';
import { getProviderInstallConfig } from '../src/cli/config.js';
import { buildRequiredPerms, pruneInvalidRules } from '../src/cli/install.js';
import { convertClaudeAllowToAgyPermissions, formatAgyPermissionRules } from '../src/providers/agy.js';

// AGY validates every permissions.allow entry against this regex (verbatim from
// the agy CLI binary, 1.2.8) and ignores anything that fails it.
const AGY_RULE_RE = /^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$/;

describe('buildRequiredPerms', () => {
  it('does not include tracker_* for Claude provider', () => {
    const paths = getProviderInstallConfig('claude');
    const perms = buildRequiredPerms(paths);
    expect(perms).not.toContain('tracker_*');
    for (const p of perms) {
      expect(p).not.toMatch(/^[a-zA-Z_]+\*$/);
    }
  });

  it('includes tracker_* for AGY (Antigravity) provider', () => {
    const paths = getProviderInstallConfig('agy');
    const perms = buildRequiredPerms(paths);
    expect(perms).toContain('tracker_*');
  });

  it('always includes mcp__apra-fleet__* and Agent(*)', () => {
    for (const provider of ['claude', 'agy', 'codex'] as const) {
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

  it('preserves tracker_* for OpenCode provider', () => {
    const allow = ['mcp__apra-fleet__*', 'tracker_*', 'Agent(*)'];
    const result = pruneInvalidRules(allow, 'OpenCode');
    expect(result).toContain('tracker_*');
  });

  it('preserves tracker_* for non-Claude, non-AGY providers', () => {
    for (const name of ['OpenCode', 'Codex', 'Copilot']) {
      const allow = ['tracker_*', 'other_rule'];
      const result = pruneInvalidRules(allow, name);
      expect(result).toContain('tracker_*');
    }
  });

  it('strips Claude-syntax entries a previous install left in AGY settings.json', () => {
    // These are exactly what a pre-fix `install --llm agy` wrote. AGY rejects
    // every one of them, so pruning removes no effective grant -- it stops
    // fleet leaving junk in a settings file the human user also owns.
    const allow = [
      'mcp__apra-fleet__*',
      'activate_skill(*)',
      'Agent(*)',
      'Read(/home/u/.gemini/antigravity-cli/skills/**)',
      'tracker_*',
      'read_file(*)',
      'command(git)',
    ];
    const result = pruneInvalidRules(allow, 'Antigravity');
    expect(result).toEqual(['read_file(*)', 'command(git)']);
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

describe('AGY installer permission translation', () => {
  // mergePermissions() runs buildRequiredPerms' output through this pipeline
  // for Antigravity. Asserted here rather than through mergePermissions itself,
  // which writes to the real ~/.gemini settings file.
  it('renders every required perm AGY can express as a valid AGY rule, and drops the rest', () => {
    const paths = getProviderInstallConfig('agy');
    const required = buildRequiredPerms(paths);
    const translated = formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(required));

    expect(translated.length).toBeGreaterThan(0);
    for (const rule of translated) {
      expect(rule).toMatch(AGY_RULE_RE);
    }
    // The skills/agents Read grants survive as read_file prefixes...
    expect(translated.some(r => r.startsWith('read_file(') && r.includes('skills'))).toBe(true);
    expect(translated.some(r => r.startsWith('read_file(') && r.includes('agents'))).toBe(true);
    // ...and the tokens with no AGY equivalent are gone.
    expect(translated).not.toContain('mcp__apra-fleet__*');
    expect(translated).not.toContain('tracker_*');
    expect(translated).not.toContain('Agent(*)');
    expect(translated).not.toContain('activate_skill(*)');
  });

  it('reduces a Claude glob path to the directory prefix AGY matches on', () => {
    expect(formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(['Read(/home/u/.gemini/skills/**)'])))
      .toEqual(['read_file(/home/u/.gemini/skills)']);
    expect(formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(['Write(/home/u/out/*)'])))
      .toEqual(['write_file(/home/u/out)']);
    // A bare Read/Write carries no path and stays unrestricted, as in Claude.
    expect(formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(['Read', 'Write'])))
      .toEqual(['read_file(*)', 'write_file(*)']);
  });
});
