/**
 * update_llm_cli resolves the CLI the member PATH actually runs, updates THAT
 * installation, and verifies the resolved binary's version. Strategy is a fake
 * member answering probe (path + version) and update commands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const { updateAgentCli } = await import('../src/tools/update-agent-cli.js');

const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
const isProbe = (c: string) => /command -v claude|Get-Command claude/.test(c);

/** Fake member: probe prints the resolved path then the version; update is scripted. */
function fakeMember(opts: { path: string; versions: [string, string]; updateOut?: string; latest?: string }) {
  let probes = 0;
  mockExecCommand.mockImplementation(async (cmd) => {
    if (isProbe(cmd)) return ok(`${opts.path}\n${opts.versions[probes++ === 0 ? 0 : 1]}`);
    if (/npm view /.test(cmd)) return ok(opts.latest ?? '');
    return ok(opts.updateOut ?? '');
  });
}
const isUpdate = (c: string) => !isProbe(c) && !/npm view /.test(c);
const updateCmd = () => mockExecCommand.mock.calls.map((c) => c[0]).find(isUpdate)!;

describe('update_llm_cli multi-install resolution', () => {
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
  afterEach(() => restoreRegistry());

  it('updates the npm-global install the PATH resolves and reports the resolved binary version', async () => {
    const m = makeTestAgent({ friendlyName: 'multi', os: 'linux' });
    addAgent(m);
    fakeMember({ path: '/usr/local/bin/claude', versions: ['2.1.274', '2.1.286'] });
    const report = await updateAgentCli({ member_id: m.id });
    expect(updateCmd()).toContain('npm install -g @anthropic-ai/claude-code@latest');
    expect(updateCmd()).not.toMatch(/claude update/);
    expect(report).toContain('2.1.274 \u2192 2.1.286');
    expect(report).toContain('\u2705 multi');
  });

  it('an unchanged resolved binary is a failure naming the resolved and the updated path', async () => {
    const m = makeTestAgent({ friendlyName: 'noop', os: 'linux' });
    addAgent(m);
    fakeMember({ path: '/opt/custom/claude', versions: ['2.1.274', '2.1.274'] });
    // resolved is not native and the provider has an npm package -> npm target,
    // so make the updater report nothing and keep the version: still a failure.
    const report = await updateAgentCli({ member_id: m.id });
    expect(report).toContain('\u274C noop');
    expect(report).toContain('/opt/custom/claude');
    expect(report).toMatch(/update targeted .*npm global/);
    expect(report).not.toContain('Already up to date');
  });

  it('reports already up to date only when the updater says the resolved binary is current', async () => {
    const m = makeTestAgent({ friendlyName: 'cur', os: 'linux' });
    addAgent(m);
    fakeMember({ path: '/home/u/.local/bin/claude', versions: ['2.1.286', '2.1.286'], updateOut: 'Claude Code is up to date (2.1.286)' });
    const report = await updateAgentCli({ member_id: m.id });
    expect(report).toContain('\u2705 cur');
    expect(report).toContain('Already up to date');
    expect(updateCmd()).toContain('claude update');
  });

  // npm prints 'changed 1 package' when it reinstalls the version already
  // installed; it never says "up to date". Real npm output, both shells.
  it.each([
    { os: 'linux', shell: undefined, path: '/home/u/.nvm/versions/node/v22.0.0/bin/claude' },
    { os: 'windows', shell: 'powershell5', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd' },
  ])('an npm-global binary already at the latest version is up to date ($os)', async ({ os, shell, path }) => {
    const m = makeTestAgent({ friendlyName: 'npmcur', os, shell } as any);
    addAgent(m);
    fakeMember({
      path, versions: ['2.1.286 (Claude Code)', '2.1.286 (Claude Code)'],
      updateOut: '\nchanged 1 package in 2s\n', latest: '2.1.286\n',
    });
    const report = await updateAgentCli({ member_id: m.id });
    expect(updateCmd()).toContain('npm install -g @anthropic-ai/claude-code@latest');
    expect(report).toContain('\u2705 npmcur');
    expect(report).toContain('Already up to date');
  });

  it('an npm-global binary still behind the latest version after npm exits 0 is a failure', async () => {
    const m = makeTestAgent({ friendlyName: 'npmold', os: 'linux' });
    addAgent(m);
    fakeMember({
      path: '/usr/local/bin/claude', versions: ['2.1.274 (Claude Code)', '2.1.274 (Claude Code)'],
      updateOut: 'changed 1 package in 2s', latest: '2.1.286',
    });
    const report = await updateAgentCli({ member_id: m.id });
    expect(report).toContain('\u274C npmold');
    expect(report).toContain('Latest version is 2.1.286');
    expect(report).not.toContain('Already up to date');
  });

  it('builds POSIX probe syntax for a POSIX member and PowerShell syntax for a PowerShell member', async () => {
    const linux = makeTestAgent({ friendlyName: 'px', os: 'linux' });
    addAgent(linux);
    fakeMember({ path: '/usr/local/bin/claude', versions: ['1.0.0', '1.0.1'] });
    await updateAgentCli({ member_id: linux.id });
    const posixProbe = mockExecCommand.mock.calls.map((c) => c[0]).find(isProbe)!;
    expect(posixProbe).toContain('command -v claude');
    expect(posixProbe).not.toContain('Get-Command');

    vi.clearAllMocks();
    const win = makeTestAgent({ friendlyName: 'ps', os: 'windows', shell: 'powershell5' } as any);
    addAgent(win);
    fakeMember({ path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', versions: ['1.0.0', '1.0.1'] });
    await updateAgentCli({ member_id: win.id });
    const psProbe = mockExecCommand.mock.calls.map((c) => c[0]).find(isProbe)!;
    expect(psProbe).toContain('(Get-Command claude -ErrorAction SilentlyContinue).Source');
    expect(psProbe).not.toContain('command -v');
    expect(psProbe).not.toMatch(/\$HOME|~\//);
  });
});
