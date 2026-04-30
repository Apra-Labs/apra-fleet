import { describe, it, expect } from 'vitest';
import { buildAuthEnvPrefix } from '../src/utils/auth-env.js';
import { encryptPassword } from '../src/utils/crypto.js';
import type { Agent } from '../src/types.js';

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
    expect(buildAuthEnvPrefix(member, 'linux')).toBe('');
    expect(buildAuthEnvPrefix(member, 'macos')).toBe('');
    expect(buildAuthEnvPrefix(member, 'windows')).toBe('');
  });

  it('returns empty string when encryptedEnvVars is empty object', () => {
    const member = { ...makeAgent(), encryptedEnvVars: {} } as Agent;
    expect(buildAuthEnvPrefix(member, 'linux')).toBe('');
    expect(buildAuthEnvPrefix(member, 'windows')).toBe('');
  });

  it('linux: returns export format with double-quoted value', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-123' });
    const prefix = buildAuthEnvPrefix(member, 'linux');
    expect(prefix).toContain('export GEMINI_API_KEY="test-key-123"');
    expect(prefix.endsWith(' && ')).toBe(true);
  });

  it('macos: returns same export format as linux', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-456' });
    const prefix = buildAuthEnvPrefix(member, 'macos');
    expect(prefix).toContain('export GEMINI_API_KEY="test-key-456"');
    expect(prefix.endsWith(' && ')).toBe(true);
  });

  it('windows: returns PowerShell $env: format with single-quoted value', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'test-key-789' });
    const prefix = buildAuthEnvPrefix(member, 'windows');
    expect(prefix).toContain("$env:GEMINI_API_KEY='test-key-789'");
    expect(prefix.endsWith('; ')).toBe(true);
  });

  it('linux: multiple env vars joined with &&', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'key1', OPENAI_API_KEY: 'key2' });
    const prefix = buildAuthEnvPrefix(member, 'linux');
    expect(prefix).toContain('export GEMINI_API_KEY="key1"');
    expect(prefix).toContain('export OPENAI_API_KEY="key2"');
    expect(prefix).toContain(' && ');
    // Should end with ' && ' for prepending to commands
    expect(prefix.endsWith(' && ')).toBe(true);
  });

  it('windows: multiple env vars joined with ;', () => {
    const member = makeAgent({ GEMINI_API_KEY: 'key1', OPENAI_API_KEY: 'key2' });
    const prefix = buildAuthEnvPrefix(member, 'windows');
    expect(prefix).toContain("$env:GEMINI_API_KEY='key1'");
    expect(prefix).toContain("$env:OPENAI_API_KEY='key2'");
    expect(prefix).toContain('; ');
    expect(prefix.endsWith('; ')).toBe(true);
  });

  it('linux: escapes special characters in values (double-quote escaping)', () => {
    const member = makeAgent({ API_KEY: 'key"with\'quotes$and\\backslash' });
    const prefix = buildAuthEnvPrefix(member, 'linux');
    // Double-quote escaping: " -> \", $ -> \$, \ -> \\
    expect(prefix).toContain('export API_KEY="');
    expect(prefix).not.toContain('key"with'); // raw " should be escaped
    expect(prefix).toContain('\\"');  // escaped double-quote
    expect(prefix).toContain('\\$'); // escaped dollar sign
    expect(prefix).toContain('\\\\'); // escaped backslash
  });

  it('windows: escapes single quotes in values (PowerShell escaping)', () => {
    const member = makeAgent({ API_KEY: "key'with'quotes" });
    const prefix = buildAuthEnvPrefix(member, 'windows');
    // PowerShell single-quote escaping: ' -> ''
    expect(prefix).toContain("$env:API_KEY='key''with''quotes'");
  });
});
