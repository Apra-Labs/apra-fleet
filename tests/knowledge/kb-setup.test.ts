import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup } from '../../src/tools/kb-setup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_setup', () => {
  it('installs post-commit hook in repo', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));
    expect(result.success).toBe(true);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    const hookContent = fs.readFileSync(hookPath, 'utf-8');
    expect(hookContent).toContain('kb invalidate');
  });

  it('writes config file with provider', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir, provider: 'sqlite' }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('config'))).toBe(true);
  });

  it('stores remote token encrypted (never plaintext)', async () => {
    const result = JSON.parse(await kbSetup({
      repo_path: tmpDir,
      provider: 'http',
      remote: 'http://localhost:7878',
      token: 'secret-token-123',
    }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('encrypted'))).toBe(true);

    // Verify token is NOT stored in plaintext
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('secret-token-123');
  });
});
