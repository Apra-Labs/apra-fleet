import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { statSync as statSyncNamed } from 'node:fs';
import os from 'node:os';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

// install warns, inside its existing KB/code-intelligence step, when node or
// npx cannot be resolved from the installer PATH. The PATH lookup (statSync) is
// faked: only the tools in `present` exist, under /fake/bin.

let present = new Set<string>();
const realPath = process.env.PATH;

function makeFsMock() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    return ps.includes('version.json') || ps.includes('hooks-config.json');
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  const fakeStat = ((p: any) => {
    const parts = p.toString().split(/[\\/]/);
    const name = (parts.pop() ?? '').replace(/\.\w+$/, '');
    if (parts.slice(-2).join('/') === 'fake/bin' && present.has(name)) return { isFile: () => true, mode: 0o755 } as any;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }) as any;
  // find-on-path.ts imports statSync by name; mock both the named and default export.
  vi.mocked(fs.statSync).mockImplementation(fakeStat);
  vi.mocked(statSyncNamed).mockImplementation(fakeStat);
}

describe('install: node/npx PATH warning for code intelligence', () => {
  let lines: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    makeFsMock();
    process.env.PATH = '/fake/bin';
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    lines = [];
    const grab = (...a: unknown[]) => { lines.push(a.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'warn').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
  });
  afterEach(() => {
    process.env.PATH = realPath;
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  const warning = () => lines.find((l) => l.includes('not resolvable from the installer PATH'));

  it('PATH lacking npx: warns naming npx only, with the remedy', async () => {
    present = new Set(['node']);
    await runInstall([]);
    const w = warning();
    expect(w).toBeDefined();
    expect(w).toMatch(/\bnpx is not resolvable/);
    expect(w).toContain('[!] npx is not');
    expect(w).toContain('code intelligence will be unavailable');
    expect(w).toContain("re-run 'apra-fleet install'");
  });

  it('PATH lacking node: warns naming node only', async () => {
    present = new Set(['npx']);
    await runInstall([]);
    const w = warning();
    expect(w).toMatch(/\bnode is not resolvable/);
    expect(w).not.toMatch(/npx (and|is|are) /);
  });

  it('PATH lacking both names both; PATH with both prints no warning', async () => {
    present = new Set();
    await runInstall([]);
    expect(warning()).toMatch(/node and npx are not resolvable/);
    lines.length = 0;
    present = new Set(['node', 'npx']);
    await runInstall([]);
    expect(warning()).toBeUndefined();
  });

  it('adds no numbered step: step labels still run 1..N of the same N', async () => {
    present = new Set();
    await runInstall([]);
    const labels = lines.map((l) => /\[(\d+)\/(\d+)\]/.exec(l)).filter(Boolean).map((m) => [Number(m![1]), Number(m![2])]);
    const total = labels[0][1];
    expect(labels.map((l) => l[1]).every((t) => t === total)).toBe(true);
    expect(labels.map((l) => l[0])).toEqual(Array.from({ length: total }, (_, i) => i + 1).slice(0, labels.length));
  });
});
