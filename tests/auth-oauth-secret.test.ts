import { describe, it, expect } from 'vitest';
import { parseClaudeOAuthSecret } from '../src/cli/auth.js';

// Stabilization Issue 43 (smoke-test rehearsal): `auth --oauth` used to write
// { claudeAiOauth: { accessToken } } no matter what it was given. The Claude
// CLI rejects a credentials file whose claudeAiOauth has no expiresAt as
// "Not logged in", so every dispatch from a sandbox provisioned that way
// failed auth. The fix lets the secret be a FULL claudeAiOauth JSON object
// (seeded from the runner's real credentials file, preserving the real
// expiry and refresh token) while keeping bare-token behavior for the
// CLAUDE_CODE_OAUTH_TOKEN env-var path.
//
// apra-fleet-eft.48.3 (regression follow-up): the bare-token fallback path
// itself was found to STILL reproduce "Not logged in" -- it wrote
// { accessToken } with no additional session field at all. The fix
// synthesizes a minimally-sufficient additional field (a far-future
// expiresAt) whenever only a bare token is available, so the installed
// Claude CLI accepts the file as a valid session while still authenticating
// with the caller's real, unmodified access token.
describe('parseClaudeOAuthSecret', () => {
  it('passes a full claudeAiOauth JSON object through intact', () => {
    const full = {
      accessToken: 'sk-test-access',
      refreshToken: 'sk-test-refresh',
      expiresAt: 1999999999999,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    };
    expect(parseClaudeOAuthSecret(JSON.stringify(full))).toEqual(full);
  });

  it('tolerates surrounding whitespace on a JSON secret', () => {
    const full = { accessToken: 'sk-a', expiresAt: 123 };
    expect(parseClaudeOAuthSecret(`  ${JSON.stringify(full)}\n`)).toEqual(full);
  });

  it('wraps a bare token as { accessToken, expiresAt } -- a synthetic future expiresAt is added so the CLI accepts the file (apra-fleet-eft.48.3)', () => {
    const before = Date.now();
    const result = parseClaudeOAuthSecret('sk-bare-token');
    expect(result.accessToken).toBe('sk-bare-token');
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(before);
    // Far enough in the future that the CLI never treats it as expired/near-expiry.
    expect(result.expiresAt as number).toBeGreaterThan(before + 24 * 60 * 60 * 1000);
  });

  it('falls back to bare-token handling (with synthetic expiresAt) for JSON without an accessToken string', () => {
    const noToken = JSON.stringify({ expiresAt: 123 });
    const result = parseClaudeOAuthSecret(noToken);
    expect(result.accessToken).toBe(noToken);
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(Date.now());
  });

  it('falls back to bare-token handling (with synthetic expiresAt) for malformed JSON starting with a brace', () => {
    const result = parseClaudeOAuthSecret('{not json');
    expect(result.accessToken).toBe('{not json');
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(Date.now());
  });
});
