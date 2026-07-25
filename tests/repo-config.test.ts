import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRepoCodeIntelConfig,
  writeRepoCodeIntelConfig,
  isCodeIntelEnabled,
} from '../src/services/knowledge/repo-config.js';

describe('repo-config', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'repo-config-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  describe('readRepoCodeIntelConfig()', () => {
    it('returns null when .apra-fleet/code-intel.json is missing', async () => {
      const config = await readRepoCodeIntelConfig(tempRepo);
      expect(config).toBeNull();
    });

    it('reads and parses .apra-fleet/code-intel.json when present', async () => {
      await writeRepoCodeIntelConfig(tempRepo, { enabled: false });

      const config = await readRepoCodeIntelConfig(tempRepo);
      expect(config).toEqual({ enabled: false });
    });

    it('returns null when the file is unparseable', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(join(tempRepo, '.apra-fleet'), { recursive: true });
      writeFileSync(join(tempRepo, '.apra-fleet', 'code-intel.json'), 'not json');

      const config = await readRepoCodeIntelConfig(tempRepo);
      expect(config).toBeNull();
    });
  });

  describe('writeRepoCodeIntelConfig()', () => {
    it('creates the .apra-fleet directory and writes the config file', async () => {
      await writeRepoCodeIntelConfig(tempRepo, { enabled: true });

      const raw = readFileSync(join(tempRepo, '.apra-fleet', 'code-intel.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual({ enabled: true });
    });
  });

  describe('isCodeIntelEnabled()', () => {
    it('returns true when config is missing (backward compat)', async () => {
      await expect(isCodeIntelEnabled(tempRepo)).resolves.toBe(true);
    });

    it('returns false when enabled=false', async () => {
      await writeRepoCodeIntelConfig(tempRepo, { enabled: false });
      await expect(isCodeIntelEnabled(tempRepo)).resolves.toBe(false);
    });

    it('returns true when enabled=true', async () => {
      await writeRepoCodeIntelConfig(tempRepo, { enabled: true });
      await expect(isCodeIntelEnabled(tempRepo)).resolves.toBe(true);
    });

    it('returns true when config exists but omits enabled', async () => {
      await writeRepoCodeIntelConfig(tempRepo, {});
      await expect(isCodeIntelEnabled(tempRepo)).resolves.toBe(true);
    });
  });
});
