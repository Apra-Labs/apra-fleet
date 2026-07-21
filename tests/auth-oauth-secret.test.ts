import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeOAuthSecret, runAuth } from '../src/cli/auth.js';
import { checkCleanEnvCredentialsFile } from '../scripts/check-toy-doer-credentials.mjs';

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
// synthesizes a minimally-sufficient additional field whenever only a bare
// token is available, so the installed Claude CLI accepts the file as a
// valid session while still authenticating with the caller's real,
// unmodified access token.
//
// apra-fleet-eft.48.6 (regression follow-up to eft.48.3, whose
// expiresAt-only synthesis STILL reproduced "Not logged in"): a clean-env
// repro against the installed claude CLI 2.1.212 showed the deciding field
// is `scopes` -- the CLI only accepts the credentials file when
// claudeAiOauth.scopes contains `user:inference` (accessToken+expiresAt
// alone is rejected). The bare-token synthesis therefore now also writes a
// `scopes` array containing `user:inference`, alongside the far-future
// expiresAt.
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

  it('wraps a bare token as { accessToken, expiresAt, scopes } -- synthetic future expiresAt AND a user:inference scope are added so the CLI accepts the file (apra-fleet-eft.48.3 / eft.48.6)', () => {
    const before = Date.now();
    const result = parseClaudeOAuthSecret('sk-bare-token');
    expect(result.accessToken).toBe('sk-bare-token');
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(before);
    // Far enough in the future that the CLI never treats it as expired/near-expiry.
    expect(result.expiresAt as number).toBeGreaterThan(before + 24 * 60 * 60 * 1000);
    // eft.48.6: the empirically-decisive field -- the installed Claude CLI
    // only accepts the credentials file when scopes contains 'user:inference'.
    expect(Array.isArray(result.scopes)).toBe(true);
    expect(result.scopes as string[]).toContain('user:inference');
  });

  it('falls back to bare-token handling (with synthetic expiresAt + scopes) for JSON without an accessToken string', () => {
    const noToken = JSON.stringify({ expiresAt: 123 });
    const result = parseClaudeOAuthSecret(noToken);
    expect(result.accessToken).toBe(noToken);
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(Date.now());
    expect(result.scopes as string[]).toContain('user:inference');
  });

  it('falls back to bare-token handling (with synthetic expiresAt + scopes) for malformed JSON starting with a brace', () => {
    const result = parseClaudeOAuthSecret('{not json');
    expect(result.accessToken).toBe('{not json');
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt as number).toBeGreaterThan(Date.now());
    expect(result.scopes as string[]).toContain('user:inference');
  });
});

// apra-fleet-eft.48.5: regression verification for the parent apra-fleet-eft.48
// ('Authentication failed on toy-doer'). parseClaudeOAuthSecret() above already
// pins the JSON-shaping logic in isolation; these tests pin the actual file
// this project writes to disk end to end -- `apra-fleet auth --oauth`'s
// getOAuthCredentialPatch()/handleOAuth() write path (src/cli/auth.ts) -- so a
// future change cannot regress back to writing an accessToken-only file while
// parseClaudeOAuthSecret's own unit tests still (misleadingly) pass.
//
// Hermetic: HOME is pointed at a fresh temp dir for the duration of each test
// (os.homedir(), which getOAuthCredentialPatch() reads via node:os, resolves
// from $HOME on POSIX -- see node:os docs), so nothing here ever touches a
// real ~/.claude/.credentials.json. No token/credential value used below is a
// real secret.
describe('handleOAuth / getOAuthCredentialPatch write path (apra-fleet-eft.48.5)', () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-auth-oauth-write-test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function credPath(): string {
    return path.join(tmpHome, '.claude', '.credentials.json');
  }

  it('writes the FULL claudeAiOauth object (accessToken + expiresAt/refreshToken/scopes/subscriptionType) given a full-credential source', async () => {
    const full = {
      accessToken: 'sk-test-full-write',
      refreshToken: 'sk-test-refresh-write',
      expiresAt: 1999999999999,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    };
    await runAuth(['--oauth', '--llm', 'claude', JSON.stringify(full)]);

    const parsed = JSON.parse(fs.readFileSync(credPath(), 'utf-8'));
    expect(parsed.claudeAiOauth).toEqual(full);
  });

  it('preserves unrelated keys via deep-merge when a pre-existing credentials file already has other data', async () => {
    fs.mkdirSync(path.dirname(credPath()), { recursive: true });
    fs.writeFileSync(
      credPath(),
      JSON.stringify({
        someOtherApp: { token: 'keep-me' },
        claudeAiOauth: { staleField: 'keep-me-too' },
      }),
    );

    const full = {
      accessToken: 'sk-test-merge-write',
      refreshToken: 'sk-test-merge-refresh',
      expiresAt: 1999999999999,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    };
    await runAuth(['--oauth', '--llm', 'claude', JSON.stringify(full)]);

    const parsed = JSON.parse(fs.readFileSync(credPath(), 'utf-8'));
    expect(parsed.someOtherApp).toEqual({ token: 'keep-me' });
    expect(parsed.claudeAiOauth.staleField).toBe('keep-me-too');
    expect(parsed.claudeAiOauth.accessToken).toBe(full.accessToken);
    expect(parsed.claudeAiOauth.refreshToken).toBe(full.refreshToken);
  });

  // REGRESSION PIN: reproduces the exact pre-eft.48.3 failure mode (a
  // credentials file with accessToken and NO other session field) and proves
  // the eft.48.4 guard would have failed loud on it, then proves the current
  // write path (this test's real `runAuth` call) produces a file that same
  // guard accepts.
  it('the eft.48.4 guard fails against the pre-eft.48.3 accessToken-only shape and passes against the write path\'s new full-shape output', async () => {
    fs.mkdirSync(path.dirname(credPath()), { recursive: true });
    fs.writeFileSync(credPath(), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old-shape-only' } }));
    expect(checkCleanEnvCredentialsFile(tmpHome).ok).toBe(false);

    // Real write path, bare token (no full session object available) --
    // apra-fleet-eft.48.3 synthesizes expiresAt so this is still accepted.
    await runAuth(['--oauth', '--llm', 'claude', 'sk-bare-token-regression-check']);
    expect(checkCleanEnvCredentialsFile(tmpHome).ok).toBe(true);
  });

  // Clean-env acceptance: the real CLI is not reliably present/usable
  // (network login state) in CI, so this reuses
  // scripts/check-toy-doer-credentials.mjs#checkCleanEnvCredentialsFile --
  // the documented harness stub (apra-fleet-eft.48.4) that reproduces
  // LocalStrategy's exact 'env -i <seed> bash -l -c' clean-env exec path and
  // models the installed Claude CLI's "valid session requires an additional
  // field beyond accessToken" acceptance rule -- against a file written by
  // the real (non-mocked) `runAuth` write path.
  it('clean-env acceptance: a file written via the full-credential source is accepted through the same clean-env path LocalStrategy uses', async () => {
    const full = {
      accessToken: 'sk-test-cleanenv-accept',
      refreshToken: 'sk-test-cleanenv-refresh',
      expiresAt: 1999999999999,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    };
    await runAuth(['--oauth', '--llm', 'claude', JSON.stringify(full)]);

    const result = checkCleanEnvCredentialsFile(tmpHome);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/OK/);
  });

  it('clean-env acceptance: a bare-token write (synthetic expiresAt + user:inference scope) is also accepted through the same clean-env path', async () => {
    await runAuth(['--oauth', '--llm', 'claude', 'sk-test-bare-cleanenv']);

    const result = checkCleanEnvCredentialsFile(tmpHome);
    expect(result.ok).toBe(true);

    // eft.48.6: the bare-token write now carries the user:inference scope the
    // real CLI requires, not just a synthetic expiresAt.
    const parsed = JSON.parse(fs.readFileSync(credPath(), 'utf-8'));
    expect(parsed.claudeAiOauth.scopes).toContain('user:inference');
  });
});
