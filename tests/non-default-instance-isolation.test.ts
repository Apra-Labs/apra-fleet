import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyIsolatedHome } from './helpers/isolated-home.mjs';

// apra-fleet-q1ku [test]: a non-default instance (APRA_FLEET_DATA_DIR set)
// must never write under the real home. The "real home" here is a sentinel
// temp dir that HOME/USERPROFILE/HOMEDRIVE+HOMEPATH point at (via the shared
// isolated-home helper, so os.homedir() resolves to it on every platform),
// and APRA_FLEET_DATA_DIR points at a SEPARATE temp dir. Every fleet-owned
// writer is then exercised for real, and the sentinel must end up with no
// .apra-fleet entry at all while each file lands at the location the
// resolver (packages/apra-fleet-client/src/fleet-paths.mjs) documents.
//
// tests/setup.ts pre-loads src/paths.ts, so modules are reset and imported
// dynamically AFTER the env is set (the resolver is lazy anyway, but this
// keeps any eager import-time snapshot from predating the override).

let home: { tempHome: string; restore: () => Promise<void> };
let instanceDir: string;

beforeEach(async () => {
  home = await applyIsolatedHome('q1ku-sentinel-home-');
  instanceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'q1ku-instance-')));
  // The helper colocates APRA_FLEET_DATA_DIR under the sentinel home (the
  // default layout); a non-default instance points it elsewhere. restore()
  // puts the original value back.
  process.env.APRA_FLEET_DATA_DIR = instanceDir;
  vi.resetModules();
});

afterEach(async () => {
  await home.restore();
  fs.rmSync(instanceDir, { recursive: true, force: true });
  vi.resetModules();
});

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('non-default data dir instance writes nothing under the real home', () => {
  it('every fleet-owned writer lands inside APRA_FLEET_DATA_DIR and the sentinel home stays free of .apra-fleet', async () => {
    expect(os.homedir()).toBe(home.tempHome);
    expect(fs.readdirSync(home.tempHome)).not.toContain('.apra-fleet');

    const { getOrCreateKey } = await import('../src/services/jwt.js');
    const { writeInstallConfig } = await import('../src/cli/config.js');
    const { writeCodeIntelligenceConfig } = await import('../src/cli/install.js');
    const { recordUsage } = await import('../src/tools/code-intelligence-telemetry.js');
    const { resolveServiceToken } = await import('../packages/apra-fleet-se/src/supervisor/auth.mjs');
    const { readLocalToken } = await import('../packages/apra-fleet-client/src/auth/local-token.mjs');
    const { createIdAllocator } = await import('../packages/apra-fleet-se/src/supervisor/id-allocator.mjs');

    // 1. fleet.key (signer).
    const key = getOrCreateKey();

    // 2. fleet.key readers (supervisor + console): same file, same token.
    const seDataDir = path.join(instanceDir, 'se');
    const viaSupervisor = resolveServiceToken(seDataDir);
    const viaReader = readLocalToken(seDataDir, { createIfMissing: false });

    // 3. supervisor id-allocator, default dir.
    const allocator = createIdAllocator({ sweepMs: 60_000 });
    await allocator.start();
    await allocator.allocate('q1ku-parent');
    await allocator.stop();

    // 4. install-config.
    writeInstallConfig('claude', 'all');

    // 5. code-intelligence config + usage telemetry (fire-and-forget).
    const ciConfig = writeCodeIntelligenceConfig();
    recordUsage('code_query', 'q1ku-target', null);
    const usageLog = path.join(instanceDir, 'code-intelligence', 'usage.jsonl');
    await waitForFile(usageLog);

    // Assertion 1: nothing under the sentinel real home.
    expect(fs.readdirSync(home.tempHome)).not.toContain('.apra-fleet');

    // Assertion 2: each file is where the resolver documents it.
    const keyPath = path.join(instanceDir, 'fleet.key');
    expect(fs.readFileSync(keyPath, 'utf8').trim()).toBe(key);
    expect(allocator.dataDir).toBe(path.join(instanceDir, 'supervisor'));
    expect(fs.existsSync(allocator.filePath)).toBe(true);
    expect(path.dirname(allocator.filePath)).toBe(path.join(instanceDir, 'supervisor'));
    const installConfig = path.join(instanceDir, 'install-config.json');
    expect(JSON.parse(fs.readFileSync(installConfig, 'utf8')).providers.claude.skill).toBe('all');
    expect(ciConfig).toBe(path.join(instanceDir, 'code-intelligence', 'config.json'));
    expect(JSON.parse(fs.readFileSync(ciConfig, 'utf8')).provider).toBe('gitnexus');
    expect(fs.readFileSync(usageLog, 'utf8')).toContain('q1ku-target');

    // Assertion 3: the key jwt.ts minted is the one the readers report.
    expect(viaSupervisor.source).toBe('fleet-key');
    expect(viaSupervisor.path).toBe(keyPath);
    expect(viaSupervisor.token).toBe(key);
    expect(viaReader.source).toBe('fleet-key');
    expect(viaReader.path).toBe(keyPath);
    expect(viaReader.token).toBe(key);
    // fleet.key present -> the private/token fallback is never minted.
    expect(fs.existsSync(path.join(seDataDir, 'private'))).toBe(false);
  });
});
