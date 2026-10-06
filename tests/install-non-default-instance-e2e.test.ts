/**
 * [test] a non-default instance install is self-contained end to end
 * (apra-fleet-oqk7): runInstall --data-dir <tmp> --mcp-scope none.
 *
 * The home is the mocked '/mock/home' (node:os + node:fs are mocked, the same
 * isolation shape as tests/install-supervisor-service.test.ts) rather than
 * tests/helpers/isolated-home.mjs, because a real-fs SEA install would copy the
 * runtime binary; every fs call is recorded, so the "nothing under the default
 * data dir" assertion is made over the recorded write/mkdir paths.
 *
 * node:fs / node:os / node:child_process and the service manager are mocked
 * (same harness shape as tests/install-supervisor-service.test.ts), so nothing
 * here touches the real home, the real claude CLI or a real service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

const { mockGetSvcMgr, mcpMgr, supervisorMgr } = vi.hoisted(() => {
  const makeMgr = () => ({
    register: vi.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<any>>().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  });
  const mcpMgr = makeMgr();
  const supervisorMgr = makeMgr();
  return {
    mcpMgr,
    supervisorMgr,
    mockGetSvcMgr: vi.fn(async (id?: string) => (id === 'fleet-supervisor' ? supervisorMgr : mcpMgr)),
  };
});

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
    userInfo: vi.fn(() => ({ username: 'mockuser' })),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({ getServiceManager: mockGetSvcMgr }));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...orig, isApraFleetRunning: vi.fn().mockReturnValue(false) };
});
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

import { SUPERVISOR_SERVE_SCRIPT } from '../src/cli/supervisor.js';

const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
const savedPort = process.env.APRA_FLEET_PORT;
const EXIT_SENTINEL = '__process_exit__';
let exitCode: number | undefined;

const DATA = path.resolve('/tmp/oqk7-instance/data');

function makeFsMock(): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    return ps === SUPERVISOR_SERVE_SCRIPT || ps.includes('version.json') || ps.includes('hooks-config.json');
  });
  vi.mocked(fs.statSync).mockImplementation(() => ({ isDirectory: () => false }) as any);
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    if (ps.includes('install-config.json')) return JSON.stringify({ providers: { claude: { skill: 'all' } } });
    if (ps.includes('settings.json')) return JSON.stringify({});
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.renameSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined);
}

function output(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map(c => c.join(' ')).join('\n');
}
function shellCmds(): string[] {
  return vi.mocked(execSync).mock.calls.map(c => String(c[0]));
}
const mcpAdds = () => shellCmds().filter(c => c.startsWith('claude mcp add'));
const BASE = ['--transport', 'http', '--skill', 'none', '--workflows', 'none'];

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [mcpMgr, supervisorMgr]) {
    m.register.mockReset().mockResolvedValue(undefined);
    m.start.mockReset().mockResolvedValue(undefined);
  }
  exitCode = undefined;
  delete process.env.APRA_FLEET_DATA_DIR;
  delete process.env.APRA_FLEET_PORT;
  makeFsMock();
  _setSeaOverride(true);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error(EXIT_SENTINEL);
  }) as never);
});

afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
  if (savedPort === undefined) delete process.env.APRA_FLEET_PORT;
  else process.env.APRA_FLEET_PORT = savedPort;
  vi.restoreAllMocks();
});

const DEFAULT_DATA = path.join('/mock/home', '.apra-fleet', 'data');
const fsTouchedPaths = (): string[] => [
  ...vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0])),
  ...vi.mocked(fs.mkdirSync).mock.calls.map(c => String(c[0])),
  ...vi.mocked(fs.copyFileSync).mock.calls.map(c => String(c[1])),
  ...vi.mocked(fs.renameSync).mock.calls.map(c => String(c[1])),
];
const ARGS = ['--transport', 'http', '--skill', 'none'];

describe('non-default instance install is self-contained', () => {
  it('writes nothing under the default data dir, registers no MCP, and every service carries the data dir', async () => {
    await runInstall([...ARGS, '--data-dir', DATA, '--mcp-scope', 'none']);

    // 1. nothing under <home>/.apra-fleet/data; install-config under the instance.
    const touched = fsTouchedPaths();
    expect(touched.filter(p => p === DEFAULT_DATA || p.startsWith(DEFAULT_DATA + path.sep) || p.startsWith(DEFAULT_DATA + '/'))).toEqual([]);
    expect(touched.some(p => p.startsWith(DATA) && p.endsWith('install-config.json'))).toBe(true);

    // 2. the claude CLI runner received no mcp add.
    expect(mcpAdds()).toEqual([]);

    // 3. every service register call carries env.APRA_FLEET_DATA_DIR === <tmp>.
    const calls = [...mcpMgr.register.mock.calls, ...supervisorMgr.register.mock.calls];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[3]?.env?.APRA_FLEET_DATA_DIR).toBe(DATA);
  });

  it('baseline with no flags still adds the user-scope MCP entry and registers services with no env', async () => {
    await runInstall([...ARGS]);
    expect(mcpAdds()).toEqual([expect.stringContaining('claude mcp add --scope user')]);
    const calls = [...mcpMgr.register.mock.calls, ...supervisorMgr.register.mock.calls];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[3]?.env).toBeUndefined();
  });
});
