import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { HttpKbProvider, DEFAULT_REQUEST_TIMEOUT_MS } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';

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

describe('kb_setup request_timeout_ms', () => {
  it.each([1000, 120000])('accepts %i and reads it back', async (value) => {
    await setup(value);
    expect(readKbConfigFromDisk().requestTimeoutMs).toBe(value);
  });

  it.each([999, 120001, 1500.5, Number.NaN])('refuses %s and leaves the config unchanged', async (value) => {
    await setup(2000);
    const before = fs.readFileSync(configPath, 'utf-8');
    await expect(setup(value)).rejects.toThrow(/request_timeout_ms/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('refusal on a fresh install writes no config', async () => {
    await expect(setup(999)).rejects.toThrow(/request_timeout_ms/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('is absent from the read config when not set, and the provider default is 5000', async () => {
    await kbSetup({ provider: 'http', remote: REMOTE, token: 't' }, { folder: tmpDir });
    expect(readKbConfigFromDisk().requestTimeoutMs).toBeUndefined();
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
    const provider = new HttpKbProvider(REMOTE, 't');
    expect((provider as unknown as { requestTimeoutMs: number }).requestTimeoutMs).toBe(5000);
    provider.dispose();
  });

  it('survives a later re-run that does not pass it', async () => {
    await setup(3000);
    await kbSetup({ remote: REMOTE }, { folder: tmpDir });
    expect(readKbConfigFromDisk().requestTimeoutMs).toBe(3000);
  });
});
