import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { FLEET_DIR } from '../../src/paths.js';

// kb_setup request_timeout_ms: validation, persistence, and read-back through
// the real config reader. FLEET_DIR is the per-run test sandbox (tests/setup.ts);
// each test still starts from no config and restores what was there.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const REMOTE = 'http://127.0.0.1:59999';

let tmpDir: string;
let savedConfig: string | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-request-timeout-'));
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
});

function setup(timeout: number): Promise<string> {
  return kbSetup({ provider: 'http', remote: REMOTE, token: 't', request_timeout_ms: timeout }, { folder: tmpDir });
}

function writeRawConfig(extra: Record<string, unknown>): void {
  const current = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  fs.writeFileSync(configPath, JSON.stringify({ ...current, ...extra }));
}

describe('kb_setup request_timeout_ms', () => {
  it.each([1000, 7500, 120000])('accepts %i, stores it, and reads it back', async (value) => {
    const result = JSON.parse(await setup(value)) as { steps: string[] };
    expect(result.steps).toContain('Stored request timeout');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).request_timeout_ms).toBe(value);
    expect(readKbConfigFromDisk().requestTimeoutMs).toBe(value);
  });

  it.each([0, -1, 999, 120001, 1500.5, Number.NaN])(
    'refuses %s with a message naming the field, range and value, leaving the config unchanged',
    async (value) => {
      await setup(2000);
      const before = fs.readFileSync(configPath, 'utf-8');
      await expect(setup(value)).rejects.toThrow(
        `kb_setup: request_timeout_ms must be an integer between 1000 and 120000, got ${value}`,
      );
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    },
  );

  it('a refusal on a fresh install writes no config', async () => {
    await expect(setup(999)).rejects.toThrow(/request_timeout_ms/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('is absent from the stored and read config when never set', async () => {
    await kbSetup({ provider: 'http', remote: REMOTE, token: 't' }, { folder: tmpDir });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).not.toHaveProperty('request_timeout_ms');
    expect(readKbConfigFromDisk()).not.toHaveProperty('requestTimeoutMs');
  });

  it('survives a later re-run that does not pass it', async () => {
    await setup(3000);
    await kbSetup({ remote: REMOTE }, { folder: tmpDir });
    expect(readKbConfigFromDisk().requestTimeoutMs).toBe(3000);
  });

  it('survives a remote change that drops the stored token', async () => {
    await setup(3000);
    await kbSetup({ remote: 'http://127.0.0.1:59998', token: 't2' }, { folder: tmpDir });
    expect(readKbConfigFromDisk().requestTimeoutMs).toBe(3000);
  });

  it.each([0, -5, 'abc', null])('the reader ignores a hand-edited non-positive or non-numeric value (%s)', async (value) => {
    await setup(3000);
    writeRawConfig({ request_timeout_ms: value });
    expect(readKbConfigFromDisk()).not.toHaveProperty('requestTimeoutMs');
  });
});
