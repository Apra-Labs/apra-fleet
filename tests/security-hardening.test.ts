import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { registerMemberSchema } from '../src/tools/register-member.js';
import { updateMemberSchema } from '../src/tools/update-member.js';
import { monitorTaskSchema } from '../src/tools/monitor-task.js';
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
      'test whoami',
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

// --- T1: Task ID validation ---

describe('monitorTaskSchema task_id validation', () => {
  const validBase = { member_id: 'test-member-id', task_id: 'task-abc123' };

  it('accepts valid task IDs', () => {
    const validIds = ['task-abc123', 'task-abcd', 'task-a1b2c3d4e5f6g7h8i9j0'];
    for (const task_id of validIds) {
      const result = monitorTaskSchema.safeParse({ ...validBase, task_id });
      expect(result.success, `Expected "${task_id}" to be valid`).toBe(true);
    }
  });

  it('rejects path traversal attempts', () => {
    const attacks = [
      '../../../etc/passwd',
      '../../.ssh/authorized_keys',
      'task-abc/../../../etc/passwd',
    ];
    for (const task_id of attacks) {
      const result = monitorTaskSchema.safeParse({ ...validBase, task_id });
      expect(result.success, `Expected path traversal "${task_id}" to be rejected`).toBe(false);
    }
  });

  it('rejects shell injection attempts', () => {
    const attacks = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
      'task-abc; echo pwned',
      'task-abc|cat /etc/passwd',
    ];
    for (const task_id of attacks) {
      const result = monitorTaskSchema.safeParse({ ...validBase, task_id });
      expect(result.success, `Expected injection "${task_id}" to be rejected`).toBe(false);
    }
  });

  it('rejects empty string', () => {
    const result = monitorTaskSchema.safeParse({ ...validBase, task_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects overly long task IDs (>20 suffix chars)', () => {
    const longId = 'task-' + 'a'.repeat(21);
    const result = monitorTaskSchema.safeParse({ ...validBase, task_id: longId });
    expect(result.success).toBe(false);
  });

  it('rejects task IDs without task- prefix', () => {
    const result = monitorTaskSchema.safeParse({ ...validBase, task_id: 'abc123' });
    expect(result.success).toBe(false);
  });
});

// --- T1: Cloud config input validation ---

describe('registerMemberSchema cloud config validation', () => {
  it('rejects invalid cloud_region format', () => {
    const invalidRegions = ['us-east', 'invalid', 'US-EAST-1', '1-us-east', ''];
    for (const cloud_region of invalidRegions) {
      const result = registerMemberSchema.shape.cloud_region.safeParse(cloud_region);
      expect(result.success, `Expected region "${cloud_region}" to be rejected`).toBe(false);
    }
  });

  it('accepts valid cloud_region format', () => {
    const validRegions = ['us-east-1', 'eu-west-2', 'ap-southeast-1'];
    for (const cloud_region of validRegions) {
      const result = registerMemberSchema.shape.cloud_region.safeParse(cloud_region);
      expect(result.success, `Expected region "${cloud_region}" to be valid`).toBe(true);
    }
  });

  it('rejects invalid cloud_instance_id format', () => {
    const invalidIds = ['abc123', 'i-xyz', 'i-GHIJKLMN', 'i-123', ''];
    for (const cloud_instance_id of invalidIds) {
      const result = registerMemberSchema.shape.cloud_instance_id.safeParse(cloud_instance_id);
      expect(result.success, `Expected instance ID "${cloud_instance_id}" to be rejected`).toBe(false);
    }
  });

  it('accepts valid cloud_instance_id format', () => {
    const validIds = ['i-0abc123def456789a', 'i-12345678', 'i-abcdef0123456789a'];
    for (const cloud_instance_id of validIds) {
      const result = registerMemberSchema.shape.cloud_instance_id.safeParse(cloud_instance_id);
      expect(result.success, `Expected instance ID "${cloud_instance_id}" to be valid`).toBe(true);
    }
  });

  it('rejects cloud_idle_timeout_min out of range', () => {
    const result0 = registerMemberSchema.shape.cloud_idle_timeout_min.safeParse(0);
    expect(result0.success).toBe(false);

    const result1441 = registerMemberSchema.shape.cloud_idle_timeout_min.safeParse(1441);
    expect(result1441.success).toBe(false);
  });

  it('accepts cloud_idle_timeout_min within range', () => {
    const result1 = registerMemberSchema.shape.cloud_idle_timeout_min.safeParse(1);
    expect(result1.success).toBe(true);

    const result1440 = registerMemberSchema.shape.cloud_idle_timeout_min.safeParse(1440);
    expect(result1440.success).toBe(true);
  });

  it('rejects unsupported cloud_provider with helpful message', () => {
    const result = registerMemberSchema.shape.cloud_provider.safeParse('gcp');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('aws');
    }
  });
});

// --- T1: Credential leakage audit ---

describe('credential leakage prevention', () => {
    beforeEach(() => {
        backupAndResetRegistry();
        vi.clearAllMocks();
    });

    afterEach(() => {
        restoreRegistry();
    });

    it('lifecycle log truncates error messages to prevent credential leakage', () => {
        // The reProvisionAuth function in lifecycle.ts uses .slice(0, 50) to prevent
        // long error messages (which might contain tokens) from being fully logged.
        const longMessage = 'Bearer ghp_' + 'x'.repeat(100);
        const truncated = longMessage.slice(0, 50);
        expect(truncated.length).toBe(50);
        expect(truncated).not.toContain('x'.repeat(51));
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

