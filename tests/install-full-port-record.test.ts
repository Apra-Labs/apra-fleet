/**
 * A full install run with APRA_FLEET_PORT=7524 records that port in its data
 * dir (full-install.json), so `apra-fleet start`, the service launch and logon
 * autostart -- none of which carry the env var -- bind 7524, the port the MCP
 * registration points at. fs is mocked in memory: nothing is written to disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { getServiceManager } from '../src/services/service-manager/index.js';
import { resolveServerPort, recordedMemberInstallPort, BUILTIN_DEFAULT_PORT } from '../src/paths.js';
import { writeMemberInstallMarker } from '../src/cli/install-guard.js';

vi.mock('node:os', () => ({
  default: { homedir: vi.fn(() => '/mock/home'), platform: vi.fn(() => 'linux') },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn(),
  gracefulStopByServerJson: vi.fn().mockResolvedValue(true),
}));

const DATA = '/mock/sandbox-data';
const RECORD = path.join(DATA, 'full-install.json');
const saved = { port: process.env.APRA_FLEET_PORT, data: process.env.APRA_FLEET_DATA_DIR };
let files: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  files = new Map();
  process.env.APRA_FLEET_DATA_DIR = DATA;
  delete process.env.APRA_FLEET_PORT;
  vi.mocked(os.homedir).mockReturnValue('/mock/home');
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    return ps.includes('version.json') || ps.includes('hooks-config.json') || files.has(ps);
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (files.has(ps)) return files.get(ps)!;
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p: any, c: any) => { files.set(p.toString(), c.toString()); });
  vi.mocked(fs.rmSync).mockImplementation((p: any) => { files.delete(p.toString()); });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    if (cmd.toString() === 'pgrep -x apra-fleet') throw Object.assign(new Error('no match'), { status: 1 });
    return '' as any;
  });
  vi.mocked(getServiceManager).mockResolvedValue({
    register: vi.fn().mockResolvedValue('created'),
    unregister: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn().mockResolvedValue(false),
  });
  _setSeaOverride(true);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  vi.restoreAllMocks();
  if (saved.port === undefined) delete process.env.APRA_FLEET_PORT; else process.env.APRA_FLEET_PORT = saved.port;
  if (saved.data === undefined) delete process.env.APRA_FLEET_DATA_DIR; else process.env.APRA_FLEET_DATA_DIR = saved.data;
});

describe('full install records its APRA_FLEET_PORT', () => {
  it('install with APRA_FLEET_PORT=7524, then no env var: resolveServerPort (start / service launch) is 7524', async () => {
    process.env.APRA_FLEET_PORT = '7524';
    await runInstall(['--skill', 'none']);
    expect(JSON.parse(files.get(RECORD)!).port).toBe(7524);
    expect(files.has(path.join(DATA, 'member-install.json'))).toBe(false);

    delete process.env.APRA_FLEET_PORT; // what a service launch / logon autostart / `apra-fleet start` sees
    expect(resolveServerPort()).toBe(7524);
  });

  it('an explicit APRA_FLEET_PORT still wins over the record', async () => {
    process.env.APRA_FLEET_PORT = '7524';
    await runInstall(['--skill', 'none']);
    process.env.APRA_FLEET_PORT = '7600';
    expect(resolveServerPort()).toBe(7600);
  });

  it('a later full install without APRA_FLEET_PORT resets start to the default port', async () => {
    process.env.APRA_FLEET_PORT = '7524';
    await runInstall(['--skill', 'none']);
    delete process.env.APRA_FLEET_PORT;
    await runInstall(['--skill', 'none']);
    expect(files.has(RECORD)).toBe(false);
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
  });

  it('member install semantics are unchanged: it writes only its own marker and reads it back', () => {
    writeMemberInstallMarker('v1', 7611);
    expect(files.has(RECORD)).toBe(false);
    expect(recordedMemberInstallPort()).toBe(7611);
    expect(resolveServerPort()).toBe(7611);
  });

  it('the member marker wins over a leftover full-install record', () => {
    files.set(RECORD, JSON.stringify({ port: 7524 }));
    writeMemberInstallMarker('v1', 7611);
    expect(resolveServerPort()).toBe(7611);
  });

  it('an unparseable or invalid record is ignored', () => {
    files.set(RECORD, '{not json');
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
    files.set(RECORD, JSON.stringify({ port: 99999 }));
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
  });
});
