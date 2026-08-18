import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { FLEET_DIR } from '../../src/paths.js';

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

    // Assert on the file kb_setup actually WROTE, not on its return value. The
    // returned steps array never carries the token under any implementation, so
    // asserting against it cannot fail -- it would stay green if kbSetup wrote
    // config.token = input.token verbatim. The stored config is where the
    // plaintext-leak risk lives, so that is what has to be read back.
    const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
    const stored = fs.readFileSync(configPath, 'utf-8');
    expect(stored).not.toContain('secret-token-123');
    expect(JSON.parse(stored).token_encrypted).toBeTruthy();
  });
});
