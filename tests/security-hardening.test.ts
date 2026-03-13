import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { registerMemberSchema } from '../src/tools/register-member.js';
import { updateMemberSchema } from '../src/tools/update-member.js';
import { addAgent, getAllAgents } from '../src/services/registry.js';
import { LinuxCommands } from '../src/os/linux.js';
import { WindowsCommands } from '../src/os/windows.js';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';
import { makeTestAgent, REGISTRY_PATH, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

// --- Item 1: Registry file permissions ---

describe('registry file permissions', () => {
  beforeEach(() => backupAndResetRegistry());
  afterEach(() => restoreRegistry());

  it('writes registry with mode 0o600 (non-Windows)', () => {
    if (process.platform === 'win32') return;

    // Trigger a registry write
    addAgent(makeTestAgent({ id: 'perm-test' }));

    const stat = fs.statSync(REGISTRY_PATH);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// --- Item 2: friendlyName validation ---

describe('friendlyName Zod validation', () => {
  it('accepts valid names: alphanumeric, dots, dashes, underscores', () => {
    const validNames = ['web-server', 'my_agent.v2', 'Test123', 'a', 'a'.repeat(64)];
    for (const name of validNames) {
      const result = registerMemberSchema.shape.friendly_name.safeParse(name);
      expect(result.success, `Expected "${name}" to be valid`).toBe(true);
    }
  });

  it('rejects names with special characters (command injection prevention)', () => {
    const invalidNames = [
      'test;whoami',
      'test$(id)',
      'test`id`',
      'test|cat /etc/passwd',
      'test & rm -rf /',
      'test\nwhoami',
      'hello world',
      'name<script>',
      "it's",
    ];
    for (const name of invalidNames) {
      const result = registerMemberSchema.shape.friendly_name.safeParse(name);
      expect(result.success, `Expected "${name}" to be rejected`).toBe(false);
    }
  });

  it('rejects empty string', () => {
    const result = registerMemberSchema.shape.friendly_name.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects names longer than 64 characters', () => {
    const result = registerMemberSchema.shape.friendly_name.safeParse('a'.repeat(65));
    expect(result.success).toBe(false);
  });

  it('update-agent schema applies the same validation', () => {
    const result = updateMemberSchema.shape.friendly_name.safeParse('test;whoami');
    expect(result.success).toBe(false);

    const validResult = updateMemberSchema.shape.friendly_name.safeParse('valid-name');
    expect(validResult.success).toBe(true);
  });
});

// Legacy salt removal: covered by crypto.test.ts (round-trip + tampered ciphertext)

// --- Item 4: Cross-platform SSH key deployment ---

describe('deploySSHPublicKey', () => {
  const testKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAA... claude-fleet-test';

  it('Linux: generates proper commands with escapeShellArg', () => {
    const cmds = new LinuxCommands();
    const result = cmds.deploySSHPublicKey(testKey);

    expect(result).toHaveLength(5);
    expect(result[0]).toBe('mkdir -p ~/.ssh');
    expect(result[1]).toBe('chmod 700 ~/.ssh');
    expect(result[2]).toBe('touch ~/.ssh/authorized_keys');
    expect(result[3]).toBe('chmod 600 ~/.ssh/authorized_keys');
    // Should use single-quote escaping
    expect(result[4]).toContain("'");
    expect(result[4]).toContain('>> ~/.ssh/authorized_keys');
  });

  it('Linux: escapes single quotes in key comments', () => {
    const cmds = new LinuxCommands();
    const keyWithQuote = "ssh-rsa AAAA... claude-fleet-it's-key";
    const result = cmds.deploySSHPublicKey(keyWithQuote);

    // Should not have unescaped single quotes
    expect(result[4]).not.toContain("it's-key'");
    expect(result[4]).toContain("'\\''");
  });

  it('Windows: generates proper commands', () => {
    const cmds = new WindowsCommands();
    const result = cmds.deploySSHPublicKey(testKey);

    expect(result).toHaveLength(4);
    expect(result[0]).toContain('New-Item');
    expect(result[0]).toContain('.ssh');
    // Uses .NET AppendAllText with explicit UTF-8 no-BOM encoding (OpenSSH requires it)
    expect(result[1]).toContain('AppendAllText');
    expect(result[1]).toContain('authorized_keys');
    expect(result[1]).toContain('UTF8Encoding');
    expect(result[2]).toContain('icacls');
    // Deploy to admin authorized_keys (Windows OpenSSH admin user workaround)
    expect(result[3]).toContain('administrators_authorized_keys');
  });

  it('Windows: escapes single quotes in key', () => {
    const cmds = new WindowsCommands();
    const keyWithQuote = "ssh-rsa AAAA... comment'test";
    const result = cmds.deploySSHPublicKey(keyWithQuote);

    // PowerShell single-quote escaping doubles the quote
    expect(result[1]).toContain("''");
  });
});
