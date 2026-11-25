// The legacy-helper upgrade notice must name the operator-auth fix. Pure
// function test: no git, no home, no global config is touched.
import { describe, it, expect } from 'vitest';
import { describeLegacyGlobalKey } from '../src/services/vcs-credential-revoke.js';
import type { VcsCredentialRevokeResult } from '../src/services/vcs-credential-revoke.js';
import type { Agent } from '../src/types.js';

const scopeUrl = 'https://github.com';

describe('describeLegacyGlobalKey operator-auth fix', () => {
  it('kept-for-sharer notice names operator-auth github and token', () => {
    const r = {
      success: true, message: '',
      legacyLeftForSharer: { friendlyName: 'sibling' } as Agent,
    } as VcsCredentialRevokeResult;
    const line = describeLegacyGlobalKey(r);
    expect(line).toContain('[WARN] Upgrade');
    expect(line).toContain('apra-fleet operator-auth github');
    expect(line).toContain('apra-fleet operator-auth token');
  });

  it('removed notice names operator-auth github', () => {
    const r = {
      success: true, message: '',
      legacyGlobalKey: { scopeUrl, report: { removed: 1, kept: 0, failed: false, resetRemoved: true } },
    } as unknown as VcsCredentialRevokeResult;
    const line = describeLegacyGlobalKey(r);
    expect(line).toContain('[WARN] Upgrade');
    expect(line).toContain('apra-fleet operator-auth github');
  });
});
