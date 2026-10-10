/**
 * [test] LLM CLI under a user prefix or nvm is found and invoked by absolute
 * path on every OS/shell (apra-fleet-fqkr.1.3).
 *
 * End to end through the REAL resolver (src/services/llm-cli-resolver.ts --
 * unmocked here; tests/setup.ts mocks it globally) and the REAL OS command
 * builders, against a FAKE member: the strategy's execCommand simulates a
 * member filesystem and a non-interactive PATH that does NOT contain the CLI
 * (the login-shell `command -v` probe finds nothing). Each scenario then runs
 * the real execute_prompt / provision_llm_auth / update_llm_cli tools and
 * asserts the command each one sent invokes the CLI by its quoted absolute
 * path with that path's directory prepended to PATH.
 *
 * Can-fail check (assertion 1): reverting the absolute-path invocation --
 * i.e. making posixAbsoluteCli/posixCliSetup in src/os/linux.ts return the
 * bare command and the old PATH setup -- fails scenario (1): the execute_prompt
 * command then lacks `export PATH='<home>/.npm-global/bin':` and
 * `'<home>/.npm-global/bin/claude' -p`. Verified by restoring the
 * pre-absolute-path src/os/linux.ts and src/os/windows.ts and re-running this
 * file: scenarios (1), (2), (3), (5) and the stale-path case fail; (4) still
 * passes because the not-found path never reaches a builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.unmock('../src/services/llm-cli-resolver.js');

import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { _resetLlmCliResolverState } from '../src/services/llm-cli-resolver.js';
import type { Agent, SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));
vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async (agent: { agyProjectId?: string }) => {
    agent.agyProjectId = agent.agyProjectId ?? '1afd6dbb-498f-4918-a9d9-6da64b75a204';
    return { projectId: agent.agyProjectId };
  }),
}));

type ExecFn = (cmd: string, timeoutMs?: number, maxTotalMs?: number, onPid?: (pid: number) => void) => Promise<SSHExecResult>;
const mockExecCommand = vi.fn<ExecFn>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    transferFiles: vi.fn(),
    writeSecretFile: vi.fn(async (name: string) => `/tmp/${name}`),
    removeSecretFile: vi.fn(async () => {}),
    close: vi.fn(),
  }),
}));

const { executePrompt, provisionedRemoteAgents } = await import('../src/tools/execute-prompt.js');
const { provisionAuth } = await import('../src/tools/provision-auth.js');
const { updateAgentCli } = await import('../src/tools/update-agent-cli.js');

function decodePs(cmd: string): string {
  const m = cmd.match(/-EncodedCommand (\S+)/);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
}

const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', code: 0 });
const fail = (): SSHExecResult => ({ stdout: '', stderr: 'not found', code: 1 });
const DISPATCH_OK = ok(JSON.stringify({ result: 'done', session_id: 'sess-1' }));

interface FakeMember {
  home: string;
  /** Files that exist (absolute paths), e.g. the CLI binary. */
  files: string[];
  ps?: boolean;
}

/**
 * Simulated member: answers the resolver's probes from `files`, the home-dir
 * probe with `home`, and everything else (prompt-file writes, the dispatch
 * itself, version checks) with success. The login shell never finds the CLI.
 */
function installFakeMember(m: FakeMember): void {
  mockExecCommand.mockImplementation(async (cmd) => {
    const text = m.ps ? decodePs(cmd) : cmd;
    // home dir probe (member-home.ts)
    if (text === `printf '%s' "$HOME"` || text.includes('[Console]::Out.Write($env:USERPROFILE)')) return ok(m.home);
    // login-shell / Get-Command probes: the CLI is NOT on the non-interactive PATH
    if (text.startsWith('bash -lc ') && text.includes('command -v')) return fail();
    if (text.includes('Get-Command')) return ok('');
    // npm prefix -g: npm is not on the login PATH either
    if (text.includes('npm prefix -g')) return fail();
    // nvm glob listing
    const nvm = text.match(/^ls -1d '([^']+)'\/\*\/bin\/'([^']+)'/);
    if (nvm) {
      const hits = m.files.filter(f => f.startsWith(nvm[1] + '/') && f.endsWith(`/bin/${nvm[2]}`));
      return ok(hits.join('\n'));
    }
    // POSIX existence chain: if [ -x 'p' ] && [ ! -d 'p' ]; then printf '%s' 'p'; ...
    if (text.startsWith('if [ -x ')) {
      const cands = [...text.matchAll(/\[ -x '([^']+)' \]/g)].map(x => x[1]);
      const hit = cands.find(c => m.files.includes(c));
      return ok(hit ?? '');
    }
    // PowerShell existence: foreach ($fleetCliCandidate in @('a','b')) { Test-Path ... }
    if (text.includes('$fleetCliCandidate')) {
      const list = text.match(/@\(([^)]*)\)/)?.[1] ?? '';
      const cands = [...list.matchAll(/'((?:[^']|'')*)'/g)].map(x => x[1].replace(/''/g, "'"));
      const hit = cands.find(c => m.files.includes(c));
      return ok(hit ?? '');
    }
    if (/--version/.test(text)) return ok('2.1.0');
    return DISPATCH_OK;
  });
}

const commands = () => mockExecCommand.mock.calls.map(c => c[0]);
const dispatchCommand = () => commands().find(c => c.includes('Your task is described in'))!;

describe('LLM CLI under a user prefix or nvm is invoked by absolute path', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    _resetLlmCliResolverState();
    provisionedRemoteAgents.clear();
  });
  afterEach(() => restoreRegistry());

  function member(over: Partial<Agent>): Agent {
    const a = makeTestAgent({ id: `cli-${Math.random().toString(36).slice(2)}`, ...over });
    addAgent(a);
    return a;
  }

  it('(1) POSIX: CLI only under ~/.npm-global/bin -- resolved, stored, and invoked by absolute path in execute_prompt, provision_llm_auth and update_llm_cli', async () => {
    const home = '/home/npmuser';
    const abs = `${home}/.npm-global/bin/claude`;
    const prepend = `export PATH='${home}/.npm-global/bin':"$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin"`;
    installFakeMember({ home, files: [abs] });
    const a = member({ friendlyName: 'npm-global-box', os: 'linux', username: 'npmuser' });

    const res = await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(res.structuredContent).not.toMatchObject({ isError: true });
    expect(getAgent(a.id)?.llmCli).toMatchObject({ provider: 'claude', path: abs, source: 'npm-global' });
    const dispatch = dispatchCommand();
    expect(dispatch).toContain(prepend);
    expect(dispatch).toContain(`'${abs}' -p`);
    expect(dispatch).not.toMatch(/&& claude -p/);

    // The stored path is reused: no further resolver probes.
    mockExecCommand.mockClear();
    installFakeMember({ home, files: [abs] });
    await provisionAuth({ member_id: a.id, api_key: 'sk-ant-api03-TESTKEY' });
    expect(commands().some(c => c.includes('command -v'))).toBe(false);
    const verify = commands().find(c => c.includes('-p "hello"'))!;
    expect(verify).toContain(prepend);
    expect(verify).toContain(`'${abs}' -p "hello"`);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [abs] });
    await updateAgentCli({ member_id: a.id, install_if_missing: false });
    expect(commands().some(c => c.includes(`'${abs}' --version`) && c.includes(prepend))).toBe(true);
    expect(commands().some(c => c.includes(`'${abs}' update`) && c.includes(prepend))).toBe(true);
  });

  it('(2) POSIX: CLI only under an nvm per-version bin dir -- the highest version is invoked by absolute path', async () => {
    const home = '/Users/nvmuser';
    const old = `${home}/.nvm/versions/node/v18.20.0/bin/claude`;
    const abs = `${home}/.nvm/versions/node/v22.3.0/bin/claude`;
    installFakeMember({ home, files: [old, abs] });
    const a = member({ friendlyName: 'nvm-box', os: 'macos', username: 'nvmuser' });

    await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(a.id)?.llmCli).toMatchObject({ path: abs, source: 'nvm' });
    const dispatch = dispatchCommand();
    expect(dispatch).toContain(`export PATH='${home}/.nvm/versions/node/v22.3.0/bin':`);
    expect(dispatch).toContain(`'${abs}' -p`);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [old, abs] });
    await provisionAuth({ member_id: a.id, api_key: 'sk-ant-api03-TESTKEY' });
    expect(commands().find(c => c.includes('-p "hello"'))).toContain(`'${abs}' -p "hello"`);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [old, abs] });
    await updateAgentCli({ member_id: a.id, install_if_missing: false });
    expect(commands().some(c => c.includes(`'${abs}' update`))).toBe(true);
  });

  it('(3) Windows PowerShell: CLI under the npm prefix (AppData\\Roaming\\npm) -- invoked via & with correct quoting', async () => {
    const home = "C:\\Users\\o'neil";
    const dir = `${home}\\AppData\\Roaming\\npm`;
    const abs = `${dir}\\claude.cmd`;
    const quotedAbs = `& 'C:\\Users\\o''neil\\AppData\\Roaming\\npm\\claude.cmd'`;
    const prepend = `$env:Path = 'C:\\Users\\o''neil\\AppData\\Roaming\\npm;' + "$env:USERPROFILE\\.local\\bin;$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"; `;
    installFakeMember({ home, files: [abs], ps: true });
    const a = member({ friendlyName: 'win-box', os: 'windows', shell: 'powershell5', workFolder: 'C:\\work', username: "o'neil" });

    await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(a.id)?.llmCli).toMatchObject({ path: abs, source: 'npm-prefix' });
    const dispatch = dispatchCommand();
    expect(dispatch).toContain(prepend);
    expect(dispatch).toContain(`Write-Output "FLEET_PID:$pid"; ${quotedAbs} `);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [abs], ps: true });
    await provisionAuth({ member_id: a.id, api_key: 'sk-ant-api03-TESTKEY' });
    const verify = commands().find(c => c.includes('-p "hello"'))!;
    expect(verify).toContain(prepend);
    expect(verify).toContain(`${quotedAbs} -p "hello"`);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [abs], ps: true });
    await updateAgentCli({ member_id: a.id, install_if_missing: false });
    expect(commands().some(c => c.includes(`${quotedAbs} --version`) && c.includes(prepend))).toBe(true);
    expect(commands().some(c => c.includes(`${quotedAbs} update`))).toBe(true);
  });

  it('(4) not found: every tool reports the probed locations and a one-line fix, never "command not found"', async () => {
    const home = '/home/nocli';
    installFakeMember({ home, files: [] });
    const a = member({ friendlyName: 'no-cli-box', os: 'linux', username: 'nocli' });

    const res = await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(res.structuredContent).toMatchObject({ isError: true, reason: 'llm_cli_not_found' });
    const nf = (res.structuredContent as { llmCliNotFound: { probed: { kind: string; location: string }[]; fix: string } }).llmCliNotFound;
    expect(nf.probed.map(p => p.kind)).toEqual(['login-shell', 'npm-prefix', 'nvm', 'local-bin', 'npm-global']);
    expect(nf.probed.map(p => p.location)).toEqual(expect.arrayContaining([
      `${home}/.nvm/versions/node/*/bin/claude`, `${home}/.local/bin/claude`, `${home}/.npm-global/bin/claude`,
    ]));
    expect(nf.fix).toMatch(/^Fix: symlink the CLI into ~\/\.local\/bin .*, or reinstall it/);
    expect(nf.fix.split('\n')).toHaveLength(1);
    expect(dispatchCommand()).toBeUndefined();

    const auth = await provisionAuth({ member_id: a.id, api_key: 'sk-ant-api03-TESTKEY' });
    expect(auth.structuredContent.llmCliNotFound?.binary).toBe('claude');
    expect(auth.text).toContain('Probed locations:');

    const report = await updateAgentCli({ member_id: a.id, install_if_missing: false });
    expect(report).toContain(`${home}/.npm-global/bin/claude`);
    expect(report).toContain('Fix: symlink the CLI into ~/.local/bin');
    for (const text of [JSON.stringify(res), auth.text, report]) expect(text).not.toContain('command not found');
  });

  it('(5) a non-claude provider (codex, under ~/.local/bin) resolves and is invoked the same way', async () => {
    const home = '/home/codexuser';
    const abs = `${home}/.local/bin/codex`;
    installFakeMember({ home, files: [abs] });
    const a = member({ friendlyName: 'codex-box', os: 'linux', llmProvider: 'codex', username: 'codexuser' });

    await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(a.id)?.llmCli).toMatchObject({ provider: 'codex', path: abs, source: 'local-bin' });
    const dispatch = dispatchCommand();
    expect(dispatch).toContain(`export PATH='${home}/.local/bin':`);
    expect(dispatch).toContain(`'${abs}' exec`);

    mockExecCommand.mockClear();
    installFakeMember({ home, files: [abs] });
    await provisionAuth({ member_id: a.id, api_key: 'sk-TESTKEY-0123456789abcdef' });
    expect(commands().some(c => c.includes(`'${abs}' --version`))).toBe(true);
  });

  it('a stored path that no longer exists is re-resolved before invocation', async () => {
    const home = '/home/moved';
    const stale = `${home}/.nvm/versions/node/v18.0.0/bin/claude`;
    const fresh = `${home}/.npm-global/bin/claude`;
    installFakeMember({ home, files: [fresh] });
    const a = member({ friendlyName: 'moved-box', os: 'linux', username: 'moved', llmCli: { provider: 'claude', path: stale, source: 'nvm', resolvedAt: 'x' } });

    await executePrompt({ member_id: a.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(a.id)?.llmCli?.path).toBe(fresh);
    expect(dispatchCommand()).toContain(`'${fresh}' -p`);
    expect(dispatchCommand()).not.toContain(stale);
  });
});
