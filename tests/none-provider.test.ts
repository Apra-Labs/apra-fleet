import { describe, it, expect } from 'vitest';
import { NoneProvider } from '../src/providers/none.js';
import { getProvider } from '../src/providers/index.js';

describe('NoneProvider (apra-fleet-us9.14)', () => {
  const p = new NoneProvider();

  it('has name "none" and is resolvable via getProvider', () => {
    expect(p.name).toBe('none');
    expect(getProvider('none')).toBeInstanceOf(NoneProvider);
  });

  it('throws on every method that would only be reached via execute_prompt, rather than returning a plausible fake value', () => {
    expect(() => p.cliCommand('args')).toThrow(/no LLM provider/);
    expect(() => p.versionCommand()).toThrow(/no LLM provider/);
    expect(() => p.installCommand('linux')).toThrow(/no LLM provider/);
    expect(() => p.updateCommand()).toThrow(/no LLM provider/);
    expect(() => p.buildPromptCommand({} as any)).toThrow(/no LLM provider/);
    expect(() => p.parseResponse({} as any)).toThrow(/no LLM provider/);
    expect(() => p.wrapWindowsPrompt('', '', '')).toThrow(/no LLM provider/);
    expect(() => p.headlessInvocation('literal')).toThrow(/no LLM provider/);
  });

  it('returns harmless/empty values for capability-query methods that might be called generically (e.g. by compose_permissions or a status render)', () => {
    expect(p.skipPermissionsFlag()).toBe('');
    expect(p.permissionModeAutoFlag()).toBeNull();
    expect(p.supportsResume()).toBe(false);
    expect(p.supportsMaxTurns()).toBe(false);
    expect(p.permissionConfigPaths()).toEqual([]);
    expect(p.composePermissionConfig('doer', [])).toEqual([]);
    expect(p.supportsOAuthCopy()).toBe(false);
    expect(p.supportsApiKey()).toBe(false);
    expect(p.oauthCredentialFiles()).toBeNull();
    expect(p.oauthSettingsMerge()).toBeNull();
    expect(p.oauthEnvVarsToUnset()).toEqual([]);
    expect(p.jsonOutputFlag()).toBe('');
  });
});
