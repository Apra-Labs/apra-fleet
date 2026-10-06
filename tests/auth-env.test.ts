import { describe, it, expect } from 'vitest';
import { buildAuthEnvPrefix } from '../src/utils/auth-env.js';
import { encryptPassword } from '../src/utils/crypto.js';
import type { Agent } from '../src/types.js';
import { findRealBash, runBash } from './helpers/real-bash.js';

// Helper: build a minimal Agent with encryptedEnvVars
function makeAgent(envVars?: Record<string, string>): Agent {
  const encrypted = envVars
    ? Object.fromEntries(Object.entries(envVars).map(([k, v]) => [k, encryptPassword(v)]))
    : undefined;
  return {
    id: 'test-member',
    friendlyName: 'test',
    host: 'localhost',
    username: 'user',
    encryptedPassword: '',
    workFolder: '/tmp',
    encryptedEnvVars: encrypted,
  } as Agent;
}

describe('buildAuthEnvPrefix', () => {
  it('returns empty string when encryptedEnvVars is undefined', () => {
    const member = makeAgent();
    expect(buildAuthEnvPrefix(member, 'linux', undefined)).toBe('');
    expect(buildAuthEnvPrefix(member, 'macos', undefined)).toBe('');
    expect(buildAuthEnvPrefix(member, 'windows', undefined)).toBe('');
    expect(buildAuthEnvPrefix(member, 'windows', 'gitbash')).toBe('');
  });

  it('returns empty string when encryptedEnvVars is empty object', () => {
    const member = { ...makeAgent(), encryptedEnvVars: {} } as Agent;
    expect(buildAuthEnvPrefix(member, 'linux', undefined)).toBe('');
    expect(buildAuthEnvPrefix(member, 'windows', undefined)).toBe('');
  });

  it('linux: returns export format with single-quoted value', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-123' });
    expect(buildAuthEnvPrefix(member, 'linux', undefined)).toBe("export GEMINI_API_KEY='test-key-123' && ");
  });

  it('macos: returns same export format as linux', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-456' });
    expect(buildAuthEnvPrefix(member, 'macos', undefined)).toBe("export GEMINI_API_KEY='test-key-456' && ");
  });

  it('windows (no shell recorded): returns PowerShell $env: format with single-quoted value', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-789' });
    expect(buildAuthEnvPrefix(member, 'windows', undefined)).toBe("$env:GEMINI_API_KEY='test-key-789'; ");
  });

  it('windows + powershell shells: stays PowerShell', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'k' });
    expect(buildAuthEnvPrefix(member, 'windows', 'pwsh7')).toBe("$env:GEMINI_API_KEY='k'; ");
    expect(buildAuthEnvPrefix(member, 'windows', 'powershell5')).toBe("$env:GEMINI_API_KEY='k'; ");
  });

  it('windows + gitbash: returns the POSIX export form, never $env:', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-gb' });
    const prefix = buildAuthEnvPrefix(member, 'windows', 'gitbash');
    expect(prefix).toBe("export GEMINI_API_KEY='test-key-gb' && ");
    expect(prefix).not.toContain('$env:');
  });

  it('linux: multiple env vars joined with &&', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'key1', OPENAI_API_KEY: 'key2' });
    expect(buildAuthEnvPrefix(member, 'linux', undefined)).toBe("export GEMINI_API_KEY='key1' && export OPENAI_API_KEY='key2' && ");
  });

  it('windows: multiple env vars joined with ;', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'key1', OPENAI_API_KEY: 'key2' });
    expect(buildAuthEnvPrefix(member, 'windows', undefined)).toBe("$env:GEMINI_API_KEY='key1'; $env:OPENAI_API_KEY='key2'; ");
  });

  it('linux: single-quote escapes values (embedded quote closes/reopens; $ and \\ stay literal)', () => {
    const member = makeAgent({ API_KEY: 'key"with\'quotes$and\\backslash' });
    expect(buildAuthEnvPrefix(member, 'linux', undefined)).toBe(`export API_KEY='key"with'\\''quotes$and\\backslash' && `);
  });

  it('windows: escapes single quotes in values (PowerShell escaping)', () => {
    const member = makeAgent({ API_KEY: "key'with'quotes" });
    expect(buildAuthEnvPrefix(member, 'windows', undefined)).toContain("$env:API_KEY='key''with''quotes'");
  });
});

// Execute the built prefix in a REAL bash (Git Bash on Windows): proves the
// variable is actually set, byte-exact, and that the value never reaches
// stderr (the old OS-only branch handed `$env:K='v'` to bash on a gitbash
// member, which bash ran as a command and echoed back on stderr).
const bash = findRealBash();
if (!bash.path) console.warn(`[auth-env.test] skipping real-bash execution tests: ${bash.reason}`);

describe.skipIf(!bash.path)('buildAuthEnvPrefix executed in real bash', () => {
  const tricky = "s3cr'et $HOME `id` !! \\ \"dq\"\nline2 'end'";
  const cases: Array<[string, 'linux' | 'macos' | 'windows', 'gitbash' | undefined]> = [
    ['linux', 'linux', undefined],
    ['macos', 'macos', undefined],
    ['windows+gitbash', 'windows', 'gitbash'],
  ];

  for (const [label, os, shell] of cases) {
    it(`${label}: sets the variable byte-exact and never echoes it to stderr`, () => {
      const member = makeAgent({ FLEET_TEST_API_KEY: tricky, FLEET_TEST_OTHER: 'plain-value-42' });
      const prefix = buildAuthEnvPrefix(member, os, shell);
      const r = runBash(bash.path!, prefix + `printf '%s' "$FLEET_TEST_API_KEY"; printf '|%s' "$FLEET_TEST_OTHER"`);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${tricky}|plain-value-42`);
      expect(r.stderr).not.toContain('s3cr');
      expect(r.stderr).not.toContain('plain-value-42');
    });
  }

  it('the PowerShell form handed to bash is exactly the leak the shell branch prevents', () => {
    // Documents the failure mode: what a gitbash member used to receive.
    const member = makeAgent({ FLEET_TEST_API_KEY: 'leaky-value-9' });
    const psPrefix = buildAuthEnvPrefix(member, 'windows', undefined);
    const r = runBash(bash.path!, psPrefix + `printf '[%s]' "$FLEET_TEST_API_KEY"`);
    expect(r.stdout).toBe('[]');
    expect(r.stderr).toContain('leaky-value-9');
  });
});
