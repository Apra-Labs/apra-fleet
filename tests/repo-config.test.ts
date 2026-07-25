import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRepoCodeIntelConfig,
  writeRepoCodeIntelConfig,
  isCodeIntelEnabled,
} from '../src/services/knowledge/repo-config.js';

describe('repo-config', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'repo-config-test-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  describe('readRepoCodeIntelConfig()', () => {
    it('returns null when .apra-fleet/code-intel.json does not exist', async () => {
      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toBeNull();
    });

    it('reads a written config back', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: false });
      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toEqual({ enabled: false });
    });
  });

  describe('writeRepoCodeIntelConfig()', () => {
    it('creates the .apra-fleet directory and writes JSON', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: true });
      const filePath = join(repoPath, '.apra-fleet', 'code-intel.json');
      expect(existsSync(filePath)).toBe(true);
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ enabled: true });
    });
  });

  describe('isCodeIntelEnabled()', () => {
    it('returns true when config is missing (backward compat)', async () => {
      expect(await isCodeIntelEnabled(repoPath)).toBe(true);
    });

    it('returns false when enabled=false', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: false });
      expect(await isCodeIntelEnabled(repoPath)).toBe(false);
    });

    it('returns true when enabled=true', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: true });
      expect(await isCodeIntelEnabled(repoPath)).toBe(true);
    });

    it('returns true when config exists but enabled key is absent', async () => {
      await writeRepoCodeIntelConfig(repoPath, {});
      expect(await isCodeIntelEnabled(repoPath)).toBe(true);
    });
  });
});
