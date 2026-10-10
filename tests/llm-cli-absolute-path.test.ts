/**
 * apra-fleet-fqkr.1.2: when a member has a resolved LLM CLI path, every CLI
 * invocation builder uses the quoted absolute path AND prepends its directory
 * to PATH (an nvm / npm-prefix install is a node shebang script that needs
 * the sibling node). Without a path, the builders are unchanged.
 *
 * Pure builder assertions for POSIX (linux, macos, gitbash) and PowerShell,
 * plus update_llm_cli against a stubbed strategy (the resolver is globally
 * mocked by tests/setup.ts to reuse the member's stored path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { ensureMemberLlmCli } from '../src/services/llm-cli-resolver.js';
import type { SSHExecResult, LlmProvider } from '../src/types.js';

type ExecFn = (cmd: string, timeoutMs?: number, maxTotalMs?: number, onPid?: (pid: number) => void) => Promise<SSHExecResult>;
const mockExecCommand = vi.fn<ExecFn>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const { updateAgentCli } = await import('../src/tools/update-agent-cli.js');

const NVM = '/home/bella/.nvm/versions/node/v20.11.1/bin';
const WIN_NPM = 'C:\\Users\\bella\\AppData\\Roaming\\npm';
const promptOpts = { folder: '/srv/work', promptFile: '.fleet-task.md', projectId: 'proj-1' };

describe('POSIX builders with a resolved CLI path', () => {
  const PROVIDERS: LlmProvider[] = ['claude', 'agy', 'opencode', 'codex', 'copilot'];

  for (const os of ['linux', 'macos'] as const) {
    for (const name of PROVIDERS) {
      it(`${os}/${name}: agentCommand, agentVersion and the prompt command invoke the quoted absolute path with its dir on PATH`, () => {
        const cmds = getOsCommands(os);
        const provider = getProvider(name);
        const abs = `${NVM}/${name}`;
        const prepend = `export PATH='${NVM}':"$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin" && `;

        const cmd = cmds.agentCommand(provider, '-p "hi"', abs);
        expect(cmd.startsWith(prepend)).toBe(true);
        expect(cmd).toContain(`'${abs}' -p "hi"`);

        const ver = cmds.agentVersion(provider, abs);
        expect(ver.startsWith(prepend)).toBe(true);
        expect(ver).toContain(`'${abs}' --version`);

        const prompt = cmds.buildAgentPromptCommand(provider, { ...promptOpts, cliPath: abs });
        expect(prompt).toContain(prepend);
        expect(prompt).toContain(`&& '${abs}' `);
        // The bare name is no longer the invoked command.
        expect(prompt).not.toMatch(new RegExp(`&& ${name} `));
      });
    }
  }

  it('updateAgent: a self-updating CLI is invoked by path; an npm-managed update keeps npm but gets the dir on PATH', () => {
    const cmds = getOsCommands('linux');
    expect(cmds.updateAgent(getProvider('claude'), `${NVM}/claude`)).toContain(`'${NVM}/claude' update`);
    const npmUpdate = cmds.updateAgent(getProvider('codex'), `${NVM}/codex`);
    expect(npmUpdate).toContain(`export PATH='${NVM}':`);
    expect(npmUpdate).toContain('npm update -g @openai/codex');
  });

  it('a path with a single quote is escaped for POSIX', () => {
    const cmd = getOsCommands('linux').agentVersion(getProvider('claude'), "/home/o'brien/.local/bin/claude");
    expect(cmd).toContain(`export PATH='/home/o'\\''brien/.local/bin':`);
    expect(cmd).toContain(`'/home/o'\\''brien/.local/bin/claude' --version`);
  });

  it('a gitbash Windows member uses the POSIX form', () => {
    const abs = '/c/Users/bella/AppData/Roaming/npm/claude';
    const cmd = getOsCommands('windows', 'gitbash').agentVersion(getProvider('claude'), abs);
    expect(cmd).toContain(`export PATH='/c/Users/bella/AppData/Roaming/npm':`);
    expect(cmd).toContain(`'${abs}' --version`);
  });

  it('without a path the commands are unchanged (bare name, existing PATH setup)', () => {
    const cmds = getOsCommands('linux');
    const provider = getProvider('claude');
    expect(cmds.agentVersion(provider)).toBe('export PATH="$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin" && unset ANTIGRAVITY_SOURCE_METADATA CLAUDE_SOURCE_METADATA COPILOT_SOURCE_METADATA CODEX_SOURCE_METADATA && claude --version 2>&1');
    expect(cmds.buildAgentPromptCommand(provider, promptOpts)).toBe(cmds.buildAgentPromptCommand(provider, { ...promptOpts, cliPath: undefined }));
  });
});

describe('PowerShell builders with a resolved CLI path', () => {
  for (const shell of ['powershell5', 'pwsh7', undefined] as const) {
    it(`${shell ?? 'default'}: invoke via & '<abs>' with the dir prepended to $env:Path`, () => {
      const cmds = getOsCommands('windows', shell);
      const provider = getProvider('claude');
      const abs = `${WIN_NPM}\\claude.cmd`;
      const prepend = `$env:Path = '${WIN_NPM};' + "$env:USERPROFILE\\.local\\bin;$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"; `;

      const ver = cmds.agentVersion(provider, abs);
      expect(ver.startsWith(prepend)).toBe(true);
      expect(ver).toContain(`& '${abs}' --version`);

      expect(cmds.agentCommand(provider, '-p "hi"', abs)).toContain(`& '${abs}' -p "hi"`);
      expect(cmds.updateAgent(provider, abs)).toContain(`& '${abs}' update`);

      const prompt = cmds.buildAgentPromptCommand(provider, { ...promptOpts, folder: 'C:\\work', cliPath: abs });
      expect(prompt).toContain(prepend);
      expect(prompt).toContain(`Write-Output "FLEET_PID:$pid"; & '${abs}' `);
    });
  }

  it('agy (a provider with its own Windows wrapper) also invokes the absolute path', () => {
    const abs = `${WIN_NPM}\\agy.cmd`;
    const prompt = getOsCommands('windows').buildAgentPromptCommand(getProvider('agy'), { ...promptOpts, folder: 'C:\\work', cliPath: abs });
    expect(prompt).toContain(`& '${abs}' --model`);
  });

  it("single quotes in a Windows path are doubled", () => {
    const cmd = getOsCommands('windows').agentVersion(getProvider('claude'), "C:\\Users\\o'brien\\.local\\bin\\claude.exe");
    expect(cmd).toContain(`$env:Path = 'C:\\Users\\o''brien\\.local\\bin;'`);
    expect(cmd).toContain(`& 'C:\\Users\\o''brien\\.local\\bin\\claude.exe' --version`);
  });

  it('without a path the PowerShell commands are unchanged', () => {
    const cmd = getOsCommands('windows').agentVersion(getProvider('claude'));
    expect(cmd).toBe('$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"; \'ANTIGRAVITY_SOURCE_METADATA\',\'CLAUDE_SOURCE_METADATA\',\'COPILOT_SOURCE_METADATA\',\'CODEX_SOURCE_METADATA\' | ForEach-Object { Remove-Item "env:$_" -ErrorAction SilentlyContinue }; claude --version 2>&1');
  });
});

describe('update_llm_cli uses the resolved path', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => restoreRegistry());

  it('POSIX member with a stored path: version and update run by absolute path with the dir on PATH', async () => {
    const abs = `${NVM}/claude`;
    const m = makeTestAgent({ friendlyName: 'nvm-box', os: 'linux', llmCli: { provider: 'claude', path: abs, source: 'nvm', resolvedAt: 'x' } });
    addAgent(m);
    mockExecCommand.mockImplementation(async (cmd) => ({ stdout: cmd.includes('update') ? 'updated' : '2.0.0', stderr: '', code: 0 }));
    await updateAgentCli({ member_id: m.id, install_if_missing: false });
    const cmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(cmds.filter(c => c.includes(`'${abs}' --version`)).length).toBe(2);
    expect(cmds.some(c => c.includes(`'${abs}' update`) && c.includes(`export PATH='${NVM}':`))).toBe(true);
    expect(cmds.some(c => / claude --version/.test(c))).toBe(false);
  });

  it('PowerShell member with a stored path: & quoted invocation', async () => {
    const abs = `${WIN_NPM}\\claude.cmd`;
    const m = makeTestAgent({ friendlyName: 'win-box', os: 'windows', shell: 'powershell5', llmCli: { provider: 'claude', path: abs, source: 'npm-prefix', resolvedAt: 'x' } });
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '2.0.0', stderr: '', code: 0 });
    await updateAgentCli({ member_id: m.id, install_if_missing: false });
    const cmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes(`& '${abs}' --version`) && c.includes(`$env:Path = '${WIN_NPM};'`))).toBe(true);
  });

  it('a member whose CLI is found nowhere gets the structured not-found message, not "command not found"', async () => {
    const m = makeTestAgent({ friendlyName: 'bare-box', os: 'linux' });
    addAgent(m);
    vi.mocked(ensureMemberLlmCli).mockResolvedValueOnce({
      ok: false,
      notFound: { provider: 'claude', binary: 'claude', probed: [{ kind: 'local-bin', location: '/home/testuser/.local/bin/claude' }], fix: 'Fix: symlink the CLI into ~/.local/bin, or reinstall it.' },
      message: 'claude CLI "claude" not found on member "bare-box". Probed locations:\n  - local-bin: /home/testuser/.local/bin/claude\nFix: symlink the CLI into ~/.local/bin, or reinstall it.',
    });
    const report = await updateAgentCli({ member_id: m.id, install_if_missing: false });
    expect(report).toContain('Probed locations:');
    expect(report).toContain('/home/testuser/.local/bin/claude');
    expect(report).toContain('Fix: symlink the CLI into ~/.local/bin');
    expect(report).not.toContain('command not found');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('a member with no stored path and the CLI on the default PATH keeps working (bare name)', async () => {
    const m = makeTestAgent({ friendlyName: 'plain-box', os: 'linux' });
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '2.0.0', stderr: '', code: 0 });
    const report = await updateAgentCli({ member_id: m.id, install_if_missing: false });
    expect(report).toContain('Already up to date');
    expect(mockExecCommand.mock.calls[0][0]).toContain('&& claude --version');
  });
});
