import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pointHomeAt } from './helpers/isolated-home.mjs';

// register-member --id: drives the real CLI entry (--type local, --llm none)
// against a sandboxed APRA_FLEET_DATA_DIR and HOME, so the developer's real
// registry and home directory are never touched. FLEET_DIR is read at module
// load, so the env is set before the modules are (re)imported.

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

let sandbox: string;
let dataDir: string;
let registryPath: string;
let runRegisterMember: (args: string[]) => Promise<void>;
const saved: Record<string, string | undefined> = {};

function readRegistry(): { agents: any[] } {
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}
function folder(name: string): string {
  const p = path.join(sandbox, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function args(id: string, name: string, p: string, llm = 'none'): string[] {
  return ['--type', 'local', '--id', id, '--name', name, '--path', p, '--llm', llm];
}

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-member-id-'));
  dataDir = path.join(sandbox, 'data');
  registryPath = path.join(dataDir, 'registry.json');
  for (const k of ['APRA_FLEET_DATA_DIR', 'HOME', 'USERPROFILE']) saved[k] = process.env[k];
  process.env.APRA_FLEET_DATA_DIR = dataDir;
  pointHomeAt(sandbox);
  process.env.USERPROFILE = sandbox;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.resetModules();
  ({ runRegisterMember } = await import('../src/cli/register-member.js'));
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('register-member --id', () => {
  it('same id twice leaves exactly one registry entry with that id', async () => {
    const f = folder('w1');
    await runRegisterMember(args(ID_A, 'm1', f));
    expect(process.exitCode).toBeUndefined();
    await runRegisterMember(args(ID_A, 'm1', f));
    expect(process.exitCode).toBeUndefined();
    const { agents } = readRegistry();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(ID_A);
    expect(agents[0].friendlyName).toBe('m1');
  });

  it('same id with a new name, folder and provider updates the entry in place', async () => {
    await runRegisterMember(args(ID_A, 'm1', folder('w1'), 'none'));
    const created = readRegistry().agents[0].createdAt;
    const f2 = folder('w2');
    await runRegisterMember(args(ID_A, 'm1-renamed', f2, 'claude'));
    expect(process.exitCode).toBeUndefined();
    const { agents } = readRegistry();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: ID_A, friendlyName: 'm1-renamed', workFolder: f2, llmProvider: 'claude', createdAt: created });
  });

  it('a folder registered under another id fails with E-FOLDER-TAKEN and the registry is byte-identical', async () => {
    const f = folder('w1');
    await runRegisterMember(args(ID_A, 'm1', f));
    const before = fs.readFileSync(registryPath);
    await runRegisterMember(args(ID_B, 'm2', f));
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('E-FOLDER-TAKEN');
    expect(Buffer.compare(before, fs.readFileSync(registryPath))).toBe(0);
    expect(readRegistry().agents.map(a => a.id)).toEqual([ID_A]);
  });

  it('rejects a non-uuid --id with a clear error and registers nothing', async () => {
    await runRegisterMember(args('not-a-uuid', 'm1', folder('w1')));
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/--id must be a UUID/);
    expect(fs.existsSync(registryPath) ? readRegistry().agents : []).toHaveLength(0);
  });
});
