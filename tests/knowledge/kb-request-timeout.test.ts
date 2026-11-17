import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { readKbConfigFromDisk, type KbConfigResult } from '../../src/services/knowledge/kb-config.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../src/services/knowledge/http-provider.js';
import { getActiveLogFile } from '../../src/utils/log-helpers.js';
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

});

describe('readKbConfigFromDisk request_timeout_ms bounds', () => {
  it.each([3e9, 999, 120001, 1500.5, 0, -5, 'abc', null])(
    'a hand-edited %s falls back to the default with a warning naming key, value and default',
    async (value) => {
      await setup(3000);
      writeRawConfig({ request_timeout_ms: value });
      const { result, warnings } = readWithWarnings();
      expect(result.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('request_timeout_ms');
      expect(warnings[0]).toContain(JSON.stringify(value));
      expect(warnings[0]).toContain(`default ${DEFAULT_REQUEST_TIMEOUT_MS}`);
    },
  );

  it.each([1000, 7500, 120000])('a valid %i passes through without a warning', async (value) => {
    await setup(3000);
    writeRawConfig({ request_timeout_ms: value });
    const { result, warnings } = readWithWarnings();
    expect(result.requestTimeoutMs).toBe(value);
    expect(warnings).toHaveLength(0);
  });
});

// Warnings logged by one readKbConfigFromDisk call: the kb_config warn lines
// appended to the real fleet log during it (logWarn writes synchronously).
function readWithWarnings(): { result: KbConfigResult; warnings: string[] } {
  const logFile = getActiveLogFile();
  if (!logFile) throw new Error('kb-request-timeout test: no active fleet log file');
  const offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const result = readKbConfigFromDisk();
  const appended = fs.readFileSync(logFile).subarray(offset).toString('utf-8');
  const warnings = appended
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { level: string; tag: string; msg: string })
    .filter(record => record.level === 'warn' && record.tag === 'kb_config')
    .map(record => record.msg);
  return { result, warnings };
}
