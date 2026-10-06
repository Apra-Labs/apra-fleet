/**
 * apra-fleet install --data-dir / --mcp-scope (apra-fleet-oqk7).
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

describe('install --data-dir', () => {
  it.each([
    ['space form', ['--data-dir', DATA]],
    ['equals form', [`--data-dir=${DATA}`]],
  ])('parses the %s and writes install-config under the given dir', async (_n, flag) => {
    await runInstall([...BASE, ...flag, '--mcp-scope', 'none']);
    expect(process.env.APRA_FLEET_DATA_DIR).toBe(DATA);
    const written = vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0]));
    expect(written.some(p => p.startsWith(DATA) && p.endsWith('install-config.json'))).toBe(true);
    expect(written.some(p => p.includes(path.join('/mock/home', '.apra-fleet', 'data')))).toBe(false);
  });

  it('resolves a relative path to an absolute one', async () => {
    await runInstall([...BASE, '--data-dir', 'rel/inst', '--mcp-scope', 'none']);
    expect(process.env.APRA_FLEET_DATA_DIR).toBe(path.resolve('rel/inst'));
  });

  it.each([
    ['missing value', ['--data-dir']],
    ['empty equals value', ['--data-dir=']],
    ['next token is a flag', ['--data-dir', '--force']],
  ])('rejects %s', async (_n, flag) => {
    await expect(runInstall([...BASE, ...flag])).rejects.toThrow(EXIT_SENTINEL);
    expect(exitCode).toBe(1);
    expect(output()).toContain('--data-dir requires');
  });

  it('passes APRA_FLEET_DATA_DIR in RegisterOptions.env to both service registrations', async () => {
    await runInstall(['--transport', 'http', '--skill', 'none', '--data-dir', DATA, '--mcp-scope', 'none']);
    expect(mcpMgr.register).toHaveBeenCalledTimes(1);
    expect(mcpMgr.register.mock.calls[0][3]).toEqual({ env: { APRA_FLEET_DATA_DIR: DATA } });
    expect(supervisorMgr.register).toHaveBeenCalledTimes(1);
    expect(supervisorMgr.register.mock.calls[0][3].env).toEqual({ APRA_FLEET_DATA_DIR: DATA });
  });

  it('carries a non-default APRA_FLEET_PORT into the service env too', async () => {
    process.env.APRA_FLEET_PORT = '8899';
    await runInstall([...BASE, '--data-dir', DATA, '--mcp-scope', 'none']);
    expect(mcpMgr.register.mock.calls[0][3].env).toEqual({ APRA_FLEET_DATA_DIR: DATA, APRA_FLEET_PORT: '8899' });
  });

  it('without the flag the MCP service is registered with no options (unchanged)', async () => {
    await runInstall([...BASE]);
    expect(mcpMgr.register.mock.calls[0]).toHaveLength(3);
  });
});

describe('install --mcp-scope', () => {
  it('defaults to user scope', async () => {
    await runInstall([...BASE]);
    expect(mcpAdds()).toEqual([expect.stringContaining('claude mcp add --scope user --transport http apra-fleet')]);
  });

  it('none issues no claude mcp add or remove', async () => {
    await runInstall([...BASE, '--mcp-scope', 'none']);
    expect(shellCmds().filter(c => c.startsWith('claude mcp'))).toEqual([]);
  });

  it('project uses --scope project for both add and remove', async () => {
    await runInstall([...BASE, '--mcp-scope=project']);
    expect(mcpAdds()).toEqual([expect.stringContaining('claude mcp add --scope project')]);
    expect(shellCmds()).toContain('claude mcp remove apra-fleet --scope project');
    expect(shellCmds().some(c => c.includes('--scope user'))).toBe(false);
  });

  it('an invalid scope exits non-zero naming the allowed values', async () => {
    await expect(runInstall([...BASE, '--mcp-scope', 'global'])).rejects.toThrow(EXIT_SENTINEL);
    expect(exitCode).toBe(1);
    expect(output()).toContain('user, project, none');
    expect(mcpAdds()).toEqual([]);
  });

  it('a missing value is an error', async () => {
    await expect(runInstall([...BASE, '--mcp-scope'])).rejects.toThrow(EXIT_SENTINEL);
    expect(exitCode).toBe(1);
  });

  it('project is refused for a non-claude provider', async () => {
    await expect(runInstall([...BASE, '--llm', 'codex', '--mcp-scope', 'project'])).rejects.toThrow(EXIT_SENTINEL);
    expect(output()).toContain('only supported with --llm claude');
  });
});

describe('install --help', () => {
  it('lists both flags', async () => {
    await expect(runInstall(['--help'])).rejects.toThrow(EXIT_SENTINEL);
    expect(exitCode).toBe(0);
    const out = output();
    expect(out).toContain('--data-dir <path>');
    expect(out).toContain('--mcp-scope <');
  });
});
