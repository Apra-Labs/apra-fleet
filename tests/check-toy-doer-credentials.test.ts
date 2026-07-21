import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CREDENTIAL_ENV_VAR,
  defaultRegistryPath,
  defaultCredentialsPath,
  findAgentByName,
  hasProvisionedEnvVar,
  extractAccessToken,
  checkMemberEnvVarProvisioned,
  checkCleanEnvCredentialsFile,
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

  it('PASSES (post-fix state, real subprocess) when .claude/.credentials.json carries a non-empty accessToken -- reproduces LocalStrategy\'s "env -i ... bash -l -c" exec path for real', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-real-probe-token' } }),
    );
    const result = checkCleanEnvCredentialsFile(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/OK/);
  });

  it('supports dependency injection of execSync for isolated unit coverage', () => {
    const fakeExecSync = () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fake' } });
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
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-post-fix' } }),
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
