import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CREDENTIAL_ENV_VAR,
  defaultRegistryPath,
  defaultCredentialsPath,
  findAgentByName,
  hasProvisionedEnvVar,
  extractAccessToken,
  extractExpiresAt,
  hasSufficientSessionShape,
  checkMemberEnvVarProvisioned,
  checkCleanEnvCredentialsFile,
  checkEnvVarNotJsonBlob,
  checkToyDoerCredentialsProvisioned,
} from '../scripts/check-toy-doer-credentials.mjs';

// Tests for apra-fleet-eft.48.2: scripts/check-toy-doer-credentials.mjs is
// the guard that catches integ-test-playbook.md's toy-doer smoke-test
// member dispatching WITHOUT a provisioned LLM credential (the pre-fix
// apra-fleet-eft.48 state, which fails every real Planner dispatch with
// 'Authentication failed' / AGENT_DISPATCH_FAILED) before the smoke test
// burns 5 wasted retries discovering that the hard way.
//
// Hermetic: every fixture here is a fresh temp dir under os.tmpdir()
// standing in for a sandboxed fleet home; nothing touches the real
// ~/.apra-fleet or ~/.claude directories, and the clean-env probe only
// ever `cat`s a fixture file inside that temp dir.

describe('defaultRegistryPath / defaultCredentialsPath', () => {
  it('registry.json lives under <fleetHome>/.apra-fleet/data/registry.json by default', () => {
    // The test harness's global-setup.ts sets APRA_FLEET_DATA_DIR so the
    // suite never touches a real ~/.apra-fleet -- unset it here to exercise
    // the actual default-derivation-from-fleetHome path this function falls
    // back to when no override is present (matches src/paths.ts#FLEET_DIR).
    const saved = process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_DATA_DIR;
    try {
      expect(defaultRegistryPath('/home/sandbox')).toBe(
        path.join('/home/sandbox', '.apra-fleet', 'data', 'registry.json'),
      );
    } finally {
      if (saved !== undefined) process.env.APRA_FLEET_DATA_DIR = saved;
    }
  });

  it('honors an APRA_FLEET_DATA_DIR override, matching src/paths.ts#FLEET_DIR', () => {
    const saved = process.env.APRA_FLEET_DATA_DIR;
    process.env.APRA_FLEET_DATA_DIR = '/custom/data-dir';
    try {
      expect(defaultRegistryPath('/home/sandbox')).toBe(path.join('/custom/data-dir', 'registry.json'));
    } finally {
      if (saved !== undefined) process.env.APRA_FLEET_DATA_DIR = saved;
      else delete process.env.APRA_FLEET_DATA_DIR;
    }
  });

  it('credentials.json lives under <fleetHome>/.claude/.credentials.json', () => {
    expect(defaultCredentialsPath('/home/sandbox')).toBe(
      path.join('/home/sandbox', '.claude', '.credentials.json'),
    );
  });

  it('CREDENTIAL_ENV_VAR is CLAUDE_CODE_OAUTH_TOKEN (matches src/providers/claude.ts#authEnvVarForToken)', () => {
    expect(CREDENTIAL_ENV_VAR).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('findAgentByName / hasProvisionedEnvVar', () => {
  it('finds a registered member by friendlyName', () => {
    const registry = { agents: [{ friendlyName: 'toy-doer', encryptedEnvVars: {} }, { friendlyName: 'other' }] };
    expect(findAgentByName(registry, 'toy-doer')).toBe(registry.agents[0]);
  });

  it('returns null when no member matches', () => {
    const registry = { agents: [{ friendlyName: 'other' }] };
    expect(findAgentByName(registry, 'toy-doer')).toBeNull();
  });

  it('returns null for a malformed registry (no agents array)', () => {
    expect(findAgentByName({}, 'toy-doer')).toBeNull();
    expect(findAgentByName(null, 'toy-doer')).toBeNull();
  });

  it('hasProvisionedEnvVar is true when encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN is a non-empty string', () => {
    expect(hasProvisionedEnvVar({ encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: 'enc:abc123' } })).toBe(true);
  });

  it('hasProvisionedEnvVar is false when encryptedEnvVars is missing', () => {
    expect(hasProvisionedEnvVar({})).toBe(false);
    expect(hasProvisionedEnvVar(null)).toBe(false);
  });

  it('hasProvisionedEnvVar is false when the token value is an empty string', () => {
    expect(hasProvisionedEnvVar({ encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: '' } })).toBe(false);
  });
});

describe('extractAccessToken', () => {
  it('extracts claudeAiOauth.accessToken from valid credentials JSON', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-abc' } });
    expect(extractAccessToken(text)).toBe('sk-abc');
  });

  it('returns empty string for empty input (e.g. cat on a missing file)', () => {
    expect(extractAccessToken('')).toBe('');
    expect(extractAccessToken('   \n')).toBe('');
  });

  it('returns empty string for unparseable JSON', () => {
    expect(extractAccessToken('not json')).toBe('');
  });

  it('returns empty string when claudeAiOauth.accessToken is absent', () => {
    expect(extractAccessToken(JSON.stringify({ other: true }))).toBe('');
  });
});

describe('extractExpiresAt (stabilization Issue 43)', () => {
  it('extracts a positive numeric claudeAiOauth.expiresAt', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-abc', expiresAt: 1999999999999 } });
    expect(extractExpiresAt(text)).toBe(1999999999999);
  });

  it('returns 0 when expiresAt is absent, non-numeric, or non-positive', () => {
    expect(extractExpiresAt(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-abc' } }))).toBe(0);
    expect(extractExpiresAt(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-abc', expiresAt: 'soon' } }))).toBe(0);
    expect(extractExpiresAt(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-abc', expiresAt: 0 } }))).toBe(0);
  });

  it('returns 0 on empty or malformed input', () => {
    expect(extractExpiresAt('')).toBe(0);
    expect(extractExpiresAt('not json')).toBe(0);
  });
});

// apra-fleet-eft.48.4: hasSufficientSessionShape() generalizes the original
// expiresAt-only check so the guard proves the written file is genuinely
// CLI-acceptable (any of expiresAt/refreshToken/scopes/subscriptionType),
// not just non-empty accessToken -- catching the regression that slipped
// past eft.48.2's original (accessToken-only) probe.
describe('hasSufficientSessionShape (apra-fleet-eft.48.4)', () => {
  it('FAILS on the OLD accessToken-only shape (pre-eft.48.3) -- proves the guard would have caught this regression', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old-shape-only' } });
    expect(hasSufficientSessionShape(text)).toBe(false);
  });

  it('FAILS when claudeAiOauth is absent entirely', () => {
    expect(hasSufficientSessionShape(JSON.stringify({ other: true }))).toBe(false);
  });

  it('FAILS on empty or malformed input', () => {
    expect(hasSufficientSessionShape('')).toBe(false);
    expect(hasSufficientSessionShape('not json')).toBe(false);
  });

  it('PASSES on the full-shape file written by eft.48.3 (accessToken + expiresAt + refreshToken + scopes + subscriptionType)', () => {
    const text = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-full-shape',
        refreshToken: 'sk-refresh',
        expiresAt: 1999999999999,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    });
    expect(hasSufficientSessionShape(text)).toBe(true);
  });

  it('PASSES with expiresAt alone -- the minimally-sufficient field eft.48.3 synthesizes for bare tokens', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', expiresAt: 1999999999999 } });
    expect(hasSufficientSessionShape(text)).toBe(true);
  });

  it('PASSES with refreshToken alone (no expiresAt)', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', refreshToken: 'sk-refresh' } });
    expect(hasSufficientSessionShape(text)).toBe(true);
  });

  it('PASSES with scopes alone (non-empty array)', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', scopes: ['user:inference'] } });
    expect(hasSufficientSessionShape(text)).toBe(true);
  });

  it('FAILS with an empty scopes array', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', scopes: [] } });
    expect(hasSufficientSessionShape(text)).toBe(false);
  });

  it('PASSES with subscriptionType alone', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', subscriptionType: 'max' } });
    expect(hasSufficientSessionShape(text)).toBe(true);
  });

  it('FAILS when expiresAt is non-positive', () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-a', expiresAt: 0 } });
    expect(hasSufficientSessionShape(text)).toBe(false);
  });
});

describe('checkMemberEnvVarProvisioned', () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-toy-doer-creds-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FAILS when registry.json does not exist (member never registered)', () => {
    const result = checkMemberEnvVarProvisioned(registryPath, 'toy-doer');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no registry\.json/);
  });

  it('FAILS when the member is not found in registry.json', () => {
    fs.writeFileSync(registryPath, JSON.stringify({ version: '1.0', agents: [{ friendlyName: 'someone-else' }] }));
    const result = checkMemberEnvVarProvisioned(registryPath, 'toy-doer');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/);
  });

  it('FAILS (pre-fix state) when the member exists but has no encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ version: '1.0', agents: [{ friendlyName: 'toy-doer', workFolder: '/x' }] }),
    );
    const result = checkMemberEnvVarProvisioned(registryPath, 'toy-doer');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/NOT-PROVISIONED/);
  });

  it('PASSES when the member has a provisioned encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: '1.0',
        agents: [{ friendlyName: 'toy-doer', encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: 'enc:xyz' } }],
      }),
    );
    const result = checkMemberEnvVarProvisioned(registryPath, 'toy-doer');
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/OK/);
  });
});

describe('checkCleanEnvCredentialsFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-toy-doer-creds-cleanenv-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FAILS (pre-fix state) when .claude/.credentials.json does not exist under the fleet home', () => {
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/NOT-PROVISIONED/);
  });

  it('FAILS when .claude/.credentials.json exists but has no claudeAiOauth.accessToken', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', '.credentials.json'), JSON.stringify({ other: true }));
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(false);
  });

  it('PASSES (post-fix state, real subprocess) when .claude/.credentials.json carries accessToken AND expiresAt -- reproduces LocalStrategy\'s "env -i ... bash -l -c" exec path for real', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-real-probe-token', expiresAt: 1999999999999 } }),
    );
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/OK/);
  });

  it('FAILS (stabilization Issue 43) when the file has an accessToken but NO expiresAt -- the exact token-only shape the Claude CLI rejects as "Not logged in"', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-token-only' } }),
    );
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expiresAt/);
    expect(result.message).toMatch(/FULL claudeAiOauth object/);
  });

  it('PASSES (apra-fleet-eft.48.4) when the file carries refreshToken but no expiresAt -- proves the guard is not hardcoded to expiresAt alone', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-refresh-shape', refreshToken: 'sk-refresh-token' } }),
    );
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('supports dependency injection of execSync for isolated unit coverage', () => {
    const fakeExecSync = () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fake', expiresAt: 1999999999999 } });
    const result = checkCleanEnvCredentialsFile(tmpDir, { execSync: fakeExecSync });
    expect(result.ok).toBe(true);
  });

  it('FAILS with an actionable message when the probe subprocess itself errors', () => {
    const throwingExecSync = () => {
      throw new Error('env: command not found');
    };
    const result = checkCleanEnvCredentialsFile(tmpDir, { execSync: throwingExecSync });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/probe failed to run/);
  });
});

// apra-fleet-vak.3: verification for apra-fleet-vak.2's checkEnvVarNotJsonBlob
// (the hard-fail guard that catches a full claudeAiOauth JSON blob stored
// verbatim in encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN instead of the bare
// accessToken apra-fleet-vak.1's provisionEnvVarForMember is supposed to
// extract). Ciphertexts here are built with a self-contained AES-256-GCM
// helper that mirrors decryptEnvVarValue's own 'ivHex:authTagHex:cipherHex'
// format -- this stubs/injects the decrypt path via a fixture salt file
// under a fresh temp dir, rather than depending on a real
// ~/.apra-fleet/data/salt or requiring `npm run build` first.
describe('checkEnvVarNotJsonBlob (apra-fleet-vak.2, regression for apra-fleet-vak.1)', () => {
  let tmpDir: string;
  let saltPath: string;
  let key: Buffer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-toy-doer-creds-jsonblob-test-'));
    saltPath = path.join(tmpDir, 'salt');
    key = crypto.randomBytes(32);
    fs.writeFileSync(saltPath, key.toString('hex'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function encryptForFixture(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  it('plaintext-available + JSON-shaped value -> hard-fails, message explains the JSON-blob shape', () => {
    const ciphertext = encryptForFixture(JSON.stringify({ accessToken: 'sk-leaked', expiresAt: 123 }));
    const result = checkEnvVarNotJsonBlob(ciphertext, { saltPath });
    expect(result.status).toBe('hard-fail');
    expect(result.message).toMatch(/JSON-shaped blob/);
  });

  it('plaintext-available + bare token -> ok', () => {
    const ciphertext = encryptForFixture('sk-bare-token-value');
    const result = checkEnvVarNotJsonBlob(ciphertext, { saltPath });
    expect(result.status).toBe('ok');
  });

  it('plaintext unavailable (no readable salt) -> indeterminate, not ok-by-default, does not throw', () => {
    const ciphertext = encryptForFixture('sk-bare-token-value');
    const missingSaltPath = path.join(tmpDir, 'no-such-salt');
    expect(() => {
      const result = checkEnvVarNotJsonBlob(ciphertext, { saltPath: missingSaltPath });
      expect(result.status).toBe('indeterminate');
      expect(result.status).not.toBe('ok');
      expect(result.message).toMatch(/INDETERMINATE/);
    }).not.toThrow();
  });

  it('end-to-end via checkMemberEnvVarProvisioned\'s ciphertext field: a JSON-shaped provisioned token is caught from a real registry.json fixture', () => {
    const registryPath = path.join(tmpDir, 'registry.json');
    const ciphertext = encryptForFixture(JSON.stringify({ accessToken: 'sk-leaked-e2e', expiresAt: 123 }));
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: '1.0',
        agents: [{ friendlyName: 'toy-doer', encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: ciphertext } }],
      }),
    );
    const envVarCheck = checkMemberEnvVarProvisioned(registryPath, 'toy-doer');
    expect(envVarCheck.ok).toBe(true);
    const jsonBlobCheck = checkEnvVarNotJsonBlob(envVarCheck.ciphertext, { saltPath });
    expect(jsonBlobCheck.status).toBe('hard-fail');
  });
});

describe('checkToyDoerCredentialsProvisioned (combined guard)', () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-toy-doer-creds-combined-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FAILS on the pre-fix (unprovisioned) state: neither registry.json nor .claude/.credentials.json carries a credential', () => {
    const result = checkToyDoerCredentialsProvisioned({ memberName: 'toy-doer', fleetHome: tmpDir, registryPath });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no provisioned LLM credential/);
  });

  it('PASSES via the clean-env credentials-file path (the one integ-test-playbook.md step 3 actually uses, apra-fleet-eft.48.1)', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-post-fix', expiresAt: 1999999999999 } }),
    );
    const result = checkToyDoerCredentialsProvisioned({ memberName: 'toy-doer', fleetHome: tmpDir, registryPath });
    expect(result.ok).toBe(true);
  });

  it('PASSES via the registry.json env-var path alone, even with no credentials file', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: '1.0',
        agents: [{ friendlyName: 'toy-doer', encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: 'enc:xyz' } }],
      }),
    );
    const result = checkToyDoerCredentialsProvisioned({ memberName: 'toy-doer', fleetHome: tmpDir, registryPath });
    expect(result.ok).toBe(true);
    expect(result.envVarCheck.ok).toBe(true);
  });
});
