import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fleetKeyPath as jwtFleetKeyPath, getOrCreateKey } from '../src/services/jwt.js';
import {
  fleetDataDir,
  fleetKeyPath,
  supervisorIdDir,
  installConfigPath,
  codeIntelligenceDir,
} from '../src/paths.js';
import { usageLogPath } from '../src/tools/code-intelligence-telemetry.js';
import { readLocalToken } from '../packages/apra-fleet-client/src/auth/local-token.mjs';

// apra-fleet-q1ku: one resolver for every fleet-owned path. The functions are
// lazy, so flipping APRA_FLEET_DATA_DIR inside a test (restored afterwards)
// is observed without vi.resetModules(). HOME/USERPROFILE are already the
// per-run sandbox home (scripts/test-sandbox.mjs), so even the "unset" case
// never resolves the developer's real profile.

const ORIGINAL_DATA_DIR = process.env.APRA_FLEET_DATA_DIR;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-paths-resolver-'));
});
afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fleet-path resolver (src/paths.ts re-exports)', () => {
  it('APRA_FLEET_DATA_DIR unset: every path equals the pre-change ~/.apra-fleet path', () => {
    delete process.env.APRA_FLEET_DATA_DIR;
    const base = path.join(os.homedir(), '.apra-fleet');
    expect(fleetDataDir()).toBe(path.join(base, 'data'));
    expect(fleetKeyPath()).toBe(path.join(base, 'fleet.key'));
    expect(jwtFleetKeyPath()).toBe(path.join(base, 'fleet.key'));
    expect(supervisorIdDir()).toBe(path.join(base, 'supervisor'));
    expect(installConfigPath()).toBe(path.join(base, 'data', 'install-config.json'));
    expect(codeIntelligenceDir()).toBe(path.join(base, 'data', 'code-intelligence'));
    expect(usageLogPath()).toBe(path.join(base, 'data', 'code-intelligence', 'usage.jsonl'));
  });

  it('APRA_FLEET_DATA_DIR set: every path lives inside that dir', () => {
    process.env.APRA_FLEET_DATA_DIR = tmp;
    expect(fleetDataDir()).toBe(tmp);
    expect(jwtFleetKeyPath()).toBe(path.join(tmp, 'fleet.key'));
    expect(supervisorIdDir()).toBe(path.join(tmp, 'supervisor'));
    expect(installConfigPath()).toBe(path.join(tmp, 'install-config.json'));
    expect(usageLogPath()).toBe(path.join(tmp, 'code-intelligence', 'usage.jsonl'));
  });
});

describe('jwt.ts (signer) and local-token.mjs (reader) agree on fleet.key', () => {
  it('unset env: both resolve the same ~/.apra-fleet/fleet.key', () => {
    delete process.env.APRA_FLEET_DATA_DIR;
    const keyDir = path.dirname(jwtFleetKeyPath());
    fs.mkdirSync(keyDir, { recursive: true });
    const preexisting = fs.existsSync(jwtFleetKeyPath());
    try {
      const minted = getOrCreateKey();
      const read = readLocalToken(path.join(tmp, 'se'), { createIfMissing: false });
      expect(read.source).toBe('fleet-key');
      expect(read.path).toBe(jwtFleetKeyPath());
      expect(read.token).toBe(minted);
    } finally {
      if (!preexisting) fs.rmSync(jwtFleetKeyPath(), { force: true });
    }
  });

  it('APRA_FLEET_DATA_DIR set: the key jwt.ts mints is the one readLocalToken reports', () => {
    process.env.APRA_FLEET_DATA_DIR = tmp;
    const minted = getOrCreateKey();
    expect(fs.existsSync(path.join(tmp, 'fleet.key'))).toBe(true);
    const read = readLocalToken(path.join(tmp, 'se'), { createIfMissing: false });
    expect(read.source).toBe('fleet-key');
    expect(read.path).toBe(jwtFleetKeyPath());
    expect(read.token).toBe(minted);
  });
});
