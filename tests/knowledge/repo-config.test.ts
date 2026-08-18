import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRepoCodeIntelConfig,
  writeRepoCodeIntelConfig,
  isCodeIntelEnabled,
  repoCodeIntelConfigPath,
} from '../../src/services/knowledge/repo-config.js';

// apra-fleet-le1.1.1 (reopened for missing tests): pins the four done-criteria
// plus the fail-open paths the reviewer called out as untested -- see the
// bead's close_reason history for the exact gap list this file closes.
describe('repo-config: per-repo code-intel opt-out (apra-fleet-le1.1.1)', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'code-intel-repo-config-test-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  describe('repoCodeIntelConfigPath()', () => {
    it('points at <repoPath>/.apra-fleet/code-intel.json', () => {
      expect(repoCodeIntelConfigPath(repoPath)).toBe(join(repoPath, '.apra-fleet', 'code-intel.json'));
    });
  });

  describe('readRepoCodeIntelConfig()', () => {
    it('returns null when the config file is missing', async () => {
      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toBeNull();
    });

    it('returns null when the repo path does not exist on disk at all', async () => {
      const config = await readRepoCodeIntelConfig(join(repoPath, 'does-not-exist'));
      expect(config).toBeNull();
    });

    it('returns null (fail-open, not a throw) when the config file is malformed JSON', async () => {
      mkdirSync(join(repoPath, '.apra-fleet'), { recursive: true });
      writeFileSync(join(repoPath, '.apra-fleet', 'code-intel.json'), '{ not valid json');

      await expect(readRepoCodeIntelConfig(repoPath)).resolves.toBeNull();
    });

    it('parses a valid config file', async () => {
      mkdirSync(join(repoPath, '.apra-fleet'), { recursive: true });
      writeFileSync(
        join(repoPath, '.apra-fleet', 'code-intel.json'),
        JSON.stringify({ enabled: false, indexedAt: '2026-08-18T00:00:00.000Z' }),
      );

      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toEqual({ enabled: false, indexedAt: '2026-08-18T00:00:00.000Z' });
    });
  });

  describe('writeRepoCodeIntelConfig()', () => {
    it('creates the .apra-fleet directory (recursive mkdir) and writes the config file', async () => {
      const configDir = join(repoPath, '.apra-fleet');
      expect(existsSync(configDir)).toBe(false);

      await writeRepoCodeIntelConfig(repoPath, { enabled: false });

      expect(existsSync(configDir)).toBe(true);
      const raw = readFileSync(join(configDir, 'code-intel.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual({ enabled: false });
      // Written with a trailing newline (matches the module's template literal).
      expect(raw.endsWith('\n')).toBe(true);
    });

    it('round-trips through readRepoCodeIntelConfig()', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: true, indexedAt: '2026-08-18T00:00:00.000Z' });

      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toEqual({ enabled: true, indexedAt: '2026-08-18T00:00:00.000Z' });
    });

    it('overwrites an existing config file on a second write', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: false });
      await writeRepoCodeIntelConfig(repoPath, { enabled: true });

      const config = await readRepoCodeIntelConfig(repoPath);
      expect(config).toEqual({ enabled: true });
    });
  });

  describe('isCodeIntelEnabled()', () => {
    it('returns true (backward compat) when the config file is missing', async () => {
      await expect(isCodeIntelEnabled(repoPath)).resolves.toBe(true);
    });

    it('returns true (fail-open) when the repo path does not exist on disk', async () => {
      await expect(isCodeIntelEnabled(join(repoPath, 'does-not-exist'))).resolves.toBe(true);
    });

    it('returns true (fail-open) when the config file is malformed JSON', async () => {
      mkdirSync(join(repoPath, '.apra-fleet'), { recursive: true });
      writeFileSync(join(repoPath, '.apra-fleet', 'code-intel.json'), 'not json at all');

      await expect(isCodeIntelEnabled(repoPath)).resolves.toBe(true);
    });

    it('returns false when the config explicitly sets enabled: false', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: false });

      await expect(isCodeIntelEnabled(repoPath)).resolves.toBe(false);
    });

    it('returns true when the config explicitly sets enabled: true', async () => {
      await writeRepoCodeIntelConfig(repoPath, { enabled: true });

      await expect(isCodeIntelEnabled(repoPath)).resolves.toBe(true);
    });
  });
});
