/**
 * No credential VALUE may appear in any command string the fleet sends to a
 * member: those strings become the argv of the member's shell (`bash -c` /
 * `powershell -c`), readable by every local user via ps / /proc/<pid>/cmdline
 * for as long as the command runs -- the whole dispatch, for execute_prompt.
 *
 * Every exec string a tool sends is scanned raw AND through every base64 token
 * it contains (decoded as utf8 and utf16le, recursively), so a value hidden in
 * a `powershell -EncodedCommand` blob or a `base64 -d` payload is still caught.
 * Values reach the member only through strategy.writeSecretFile (SFTP / fs).
 *
 * Fake credentials only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { RelayStrategy } from '../src/services/relay-strategy.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const FAKE_KEY = 'sk-ant-api03-FAKE-not-a-real-key-0123456789abcdef';
const FAKE_OAUTH = 'sk-ant-oat01-FAKE-oauth-token-9876543210zyxw';
const FAKE_CFG = '/home/testuser/.FAKE-claude-config-dir';

vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async () => ({ projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' })),
}));
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
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn(),
  collectOobConfirm: vi.fn(),
}));

const execCalls: string[] = [];
const secretFiles: Array<{ path: string; content: string }> = [];
const removedFiles: string[] = [];
const mockExecCommand = vi.fn<(cmd: string) => Promise<SSHExecResult>>();

function homeFor(a: Agent | undefined): string {
  if (a?.os === 'windows') return 'C:/Users/testuser';
  if (a?.os === 'macos') return '/Users/testuser';
  return '/home/testuser';
}

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: (agent: Agent) => {
    return {
      execCommand: (cmd: string, ...rest: unknown[]) => { execCalls.push(cmd); return mockExecCommand(cmd, ...(rest as [])); },
      testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
      transferFiles: vi.fn(),
      writeSecretFile: vi.fn(async (name: string, content: string) => {
        if (agent.agentType === 'relay') throw new Error('relay: no safe delivery channel');
        if (agent.host === 'no-sftp.example') throw new Error('Unable to start subsystem: sftp');
        const p = `${homeFor(agent)}/${name}`;
        secretFiles.push({ path: p, content });
        return p;
      }),
      removeSecretFile: vi.fn(async (p: string) => { removedFiles.push(p); }),
      close: vi.fn(),
    };
  },
}));

/** The raw string plus every base64 token in it decoded (utf8 + utf16le), recursively. */
function decodedViews(s: string, depth = 0): string[] {
  const out = [s];
  if (depth >= 3) return out;
  for (const m of s.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) {
    const buf = Buffer.from(m[0], 'base64');
    for (const enc of ['utf8', 'utf16le'] as const) out.push(...decodedViews(buf.toString(enc), depth + 1));
  }
  return out;
}

function expectNoSecretInArgv(secrets: string[]): void {
  expect(execCalls.length).toBeGreaterThan(0);
  for (const cmd of execCalls) {
    for (const view of decodedViews(cmd)) {
      for (const secret of secrets) {
        if (view.includes(secret)) throw new Error(`secret value found in a member command line (${secret.slice(0, 12)}...)`);
      }
    }
  }
}

function storedEnv(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, encryptPassword(v)]));
}

const OK_RESULT = { stdout: JSON.stringify({ result: 'done', session_id: 'sess-1' }), stderr: '', code: 0 };

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  execCalls.length = 0;
  secretFiles.length = 0;
  removedFiles.length = 0;
  provisionedRemoteAgents.clear();
  mockExecCommand.mockResolvedValue(OK_RESULT);
});
afterEach(() => restoreRegistry());

describe('the scanner itself', () => {
  it('catches a value inside a PowerShell -EncodedCommand blob and a nested base64 payload', () => {
    const ps = `powershell -EncodedCommand ${Buffer.from(`$env:K='${FAKE_KEY}'; x`, 'utf16le').toString('base64')}`;
    expect(decodedViews(ps).some(v => v.includes(FAKE_KEY))).toBe(true);
    const inner = Buffer.from(`echo ${FAKE_KEY}`).toString('base64');
    const nested = `printf '%s' '${Buffer.from(`X=$(printf '%s' '${inner}' | base64 -d)`).toString('base64')}' | base64 -d`;
    expect(decodedViews(nested).some(v => v.includes(FAKE_KEY))).toBe(true);
  });
});

const SHELLS: Array<{ label: string; over: Partial<Agent>; posix: boolean }> = [
  { label: 'linux', over: { os: 'linux' }, posix: true },
  { label: 'macos', over: { os: 'macos', workFolder: '/Users/testuser/project' }, posix: true },
  { label: 'windows (PowerShell)', over: { os: 'windows', workFolder: 'C:\\Users\\testuser\\project' }, posix: false },
  { label: 'windows (Git Bash)', over: { os: 'windows', shell: 'gitbash', workFolder: 'C:/Users/testuser/project' }, posix: true },
];

describe('execute_prompt dispatch never inlines stored credentials', () => {
  for (const { label, over, posix } of SHELLS) {
    it(`${label}: the value travels in a staged file the dispatch loads and deletes`, async () => {
      const member = makeTestAgent({ friendlyName: `ep-${label}`, ...over, encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
      addAgent(member);

      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

      expectNoSecretInArgv([FAKE_KEY]);
      // The CLI still gets the credential: exactly one staged file, carrying it...
      expect(secretFiles).toHaveLength(1);
      const { path: p, content } = secretFiles[0];
      expect(p).toMatch(/\/\.apra-fleet-env-[0-9a-f-]{36}$/);
      if (posix) {
        expect(content).toBe(`export ANTHROPIC_API_KEY='${FAKE_KEY}'\n`);
      } else {
        expect(content).toBe(`ANTHROPIC_API_KEY=${Buffer.from(FAKE_KEY).toString('base64')}\n`);
      }
      // ...and the dispatch command loads it (then deletes it) before the CLI starts.
      const dispatch = execCalls.find(c => c.includes(p) && /claude/.test(c));
      expect(dispatch).toBeDefined();
      if (posix) {
        expect(dispatch!.startsWith(`. '${p}' && rm -f '${p}' && `)).toBe(true);
      } else {
        expect(dispatch!.startsWith(`$__fleetEnv = '${p}'; try {`)).toBe(true);
        expect(dispatch).toContain("'Process')");
      }
    });
  }

  it('upgrade: a member provisioned by the current release (three stored vars) keeps working with no re-provision', async () => {
    const member = makeTestAgent({
      friendlyName: 'ep-upgrade',
      os: 'linux',
      encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, CLAUDE_CONFIG_DIR: FAKE_CFG }),
    });
    addAgent(member);

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expectNoSecretInArgv([FAKE_KEY, FAKE_OAUTH]);
    expect(secretFiles).toHaveLength(1);
    expect(secretFiles[0].content).toContain(`export ANTHROPIC_API_KEY='${FAKE_KEY}'`);
    expect(secretFiles[0].content).toContain(`export CLAUDE_CODE_OAUTH_TOKEN='${FAKE_OAUTH}'`);
    expect(secretFiles[0].content).toContain(`export CLAUDE_CONFIG_DIR='${FAKE_CFG}'`);
  });

  it('a member with no stored env vars stages nothing (unchanged behaviour)', async () => {
    const member = makeTestAgent({ friendlyName: 'ep-none', os: 'linux' });
    addAgent(member);
    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(secretFiles).toHaveLength(0);
    expect(execCalls.some(c => c.includes('.apra-fleet-env-'))).toBe(false);
  });

  it('a retried attempt stages its own fresh file; leftovers are cleaned with the prompt file', async () => {
    vi.useFakeTimers();
    try {
      const member = makeTestAgent({ friendlyName: 'ep-retry', os: 'linux', encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
      addAgent(member);
      mockExecCommand
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // writePromptFile
        .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
        .mockResolvedValueOnce(OK_RESULT)
        .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const p = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
      await vi.advanceTimersByTimeAsync(10_000);
      await p;

      expectNoSecretInArgv([FAKE_KEY]);
      expect(secretFiles).toHaveLength(2);
      expect(secretFiles[0].path).not.toBe(secretFiles[1].path);
      for (const f of secretFiles) {
        expect(execCalls.some(c => c.startsWith(`. '${f.path}' && rm -f '${f.path}' && `))).toBe(true);
      }
      const cleanup = execCalls[execCalls.length - 1];
      for (const f of secretFiles) expect(cleanup).toContain(f.path);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('execute_command never inlines stored credentials', () => {
  for (const { label, over, posix } of SHELLS) {
    it(`${label}: sync command loads the staged file`, async () => {
      const member = makeTestAgent({ friendlyName: `ec-${label}`, ...over, encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });

      await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });

      expectNoSecretInArgv([FAKE_KEY]);
      expect(secretFiles).toHaveLength(1);
      const p = secretFiles[0].path;
      expect(execCalls[0].startsWith(posix ? `. '${p}'` : `$__fleetEnv = '${p}'`)).toBe(true);
      expect(removedFiles).toEqual([]); // consumed by the command itself
    });
  }

  it('a failed run removes the staged file it may not have consumed', async () => {
    const member = makeTestAgent({ friendlyName: 'ec-fail', os: 'linux', encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
    addAgent(member);
    mockExecCommand.mockRejectedValue(new Error('channel closed'));
    await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });
    expect(removedFiles).toEqual([secretFiles[0].path]);
  });
});

describe('provision_llm_auth api_key never puts the key on a command line', () => {
  for (const { label, over } of SHELLS) {
    it(`${label}: profile persist + verification both go through staged files`, async () => {
      const member = makeTestAgent({ friendlyName: `pa-${label}`, ...over });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: 'sk-ant-api', stderr: '', code: 0 });

      await provisionAuth({ member_id: member.id, api_key: FAKE_KEY });

      expectNoSecretInArgv([FAKE_KEY]);
      // persist file + verify env file
      expect(secretFiles.length).toBeGreaterThanOrEqual(2);
      expect(secretFiles.every(f => decodedViews(f.content).some(v => v.includes(FAKE_KEY)))).toBe(true);
      const persist = secretFiles.find(f => f.path.includes('.apra-fleet-persist-'))!;
      expect(persist).toBeDefined();
      expect(execCalls.some(c => c.includes(persist.path))).toBe(true);
    });
  }
});

describe('agy project provisioning never embeds the stored key in its script', () => {
  for (const { label, over, posix } of SHELLS) {
    it(`${label}: the key reaches agy via the staged env file, not the node script text`, async () => {
      const { provisionAgyProject } = await vi.importActual<typeof import('../src/services/agy-project.js')>('../src/services/agy-project.js');
      const member = makeTestAgent({ friendlyName: `agy-${label}`, llmProvider: 'agy', ...over, encryptedEnvVars: storedEnv({ ANTIGRAVITY_API_KEY: FAKE_KEY }) });
      const sent: string[] = [];
      const exec = async (cmd: string) => { sent.push(cmd); execCalls.push(cmd); return { stdout: 'not-json', stderr: '', code: 1 }; };
      await provisionAgyProject(member, exec, { file: 'agy', args: [] }).catch(() => {});
      expectNoSecretInArgv([FAKE_KEY]);
      expect(sent).toHaveLength(1);
      const p = secretFiles[0].path;
      expect(sent[0].startsWith(posix ? `. '${p}' && rm -f '${p}' && ` : `$__fleetEnv = '${p}'`)).toBe(true);
      expect(removedFiles).toEqual([p]); // failed run: leftover removed
    });
  }
});

describe('relay members', () => {
  it('fail loudly instead of falling back to an inline value', async () => {
    const relay = new RelayStrategy({ friendlyName: 'relay-m', agentType: 'relay' } as Agent);
    await expect(relay.writeSecretFile('.apra-fleet-env-x', 'x')).rejects.toThrow(/relay/);
  });

  it('provision_llm_auth refuses before storing a key it could never deliver', async () => {
    const member = makeTestAgent({ friendlyName: 'pa-relay', agentType: 'relay', relayMemberId: 'hub-m' });
    addAgent(member);
    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_KEY });
    expect(structuredContent.reason).toBe('secret_delivery_unavailable');
    expect(structuredContent.ok).toBe(false);
    expect(getAgent(member.id)?.encryptedEnvVars?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(execCalls.some(c => c.includes(FAKE_KEY))).toBe(false);
  });
});

// Upgrade safety: a member whose stored credential can no longer be delivered
// (relay, or an SSH member without the SFTP subsystem) gets a typed,
// non-retried, actionable failure and a supported recovery path.
const UNDELIVERABLE: Array<{ label: string; over: Partial<Agent>; remedy: RegExp }> = [
  { label: 'relay member', over: { agentType: 'relay', relayMemberId: 'hub-m' }, remedy: /Relay members have no channel/ },
  { label: 'SSH member without the SFTP subsystem', over: { host: 'no-sftp.example' }, remedy: /Subsystem sftp/ },
];

describe('undeliverable stored credentials', () => {
  for (const { label, over, remedy } of UNDELIVERABLE) {
    it(`${label}: execute_prompt fails typed BEFORE touching the member, never retried, with the remedy`, async () => {
      const member = makeTestAgent({ friendlyName: `ud-ep-${label}`, os: 'linux', ...over, encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
      addAgent(member);

      const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

      expect(result.structuredContent).toMatchObject({ isError: true, reason: 'secret_delivery_unavailable' });
      expect(result.text).toMatch(remedy);
      expect(result.text).toContain('clear_stored_credentials');
      // No kill, no prompt write, no dispatch, no retry.
      expect(execCalls).toEqual([]);
    });

    it(`${label}: execute_command still runs, WITHOUT the stored vars, and says so`, async () => {
      const member = makeTestAgent({ friendlyName: `ud-ec-${label}`, os: 'linux', ...over, encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });

      const result = await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });

      expect(typeof result).not.toBe('string');
      const r = result as { text: string; structuredContent: Record<string, unknown> };
      expect(r.structuredContent.exitCode).toBe(0);
      expect(r.structuredContent.storedEnvNotDelivered).toBe('secret_delivery_unavailable');
      expect(r.text).toContain('WITHOUT the member\'s stored credential env vars');
      expect(execCalls).toHaveLength(1);
      expectNoSecretInArgv([FAKE_KEY]);
      expect(execCalls[0]).not.toContain('.apra-fleet-env-');
    });

    it(`${label}: clear_stored_credentials (registry only) is the supported recovery`, async () => {
      const member = makeTestAgent({ friendlyName: `ud-clr-${label}`, os: 'linux', ...over, encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CONFIG_DIR: FAKE_CFG }) });
      addAgent(member);

      const cleared = await provisionAuth({ member_id: member.id, clear_stored_credentials: true });
      expect(cleared.structuredContent).toMatchObject({ ok: true, reason: 'stored_credentials_cleared', credentialLabel: 'ANTHROPIC_API_KEY,CLAUDE_CONFIG_DIR' });
      expect(getAgent(member.id)?.encryptedEnvVars).toBeUndefined();
      expect(execCalls).toEqual([]); // never contacts the member

      // Dispatch now proceeds (no stored vars -> nothing to deliver).
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
      expect(execCalls.length).toBeGreaterThan(0);
      expect(secretFiles).toHaveLength(0);
    });
  }

  it('clear_stored_credentials cannot be combined with api_key', async () => {
    const member = makeTestAgent({ friendlyName: 'ud-clr-bad', os: 'linux', encryptedEnvVars: storedEnv({ ANTHROPIC_API_KEY: FAKE_KEY }) });
    addAgent(member);
    const r = await provisionAuth({ member_id: member.id, clear_stored_credentials: true, api_key: FAKE_KEY });
    expect(r.structuredContent).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    expect(getAgent(member.id)?.encryptedEnvVars?.ANTHROPIC_API_KEY).toBeDefined();
  });

  it('provision_llm_auth api_key on an SSH member without SFTP refuses with the sshd remedy', async () => {
    const member = makeTestAgent({ friendlyName: 'ud-pa-nosftp', os: 'linux', host: 'no-sftp.example' });
    addAgent(member);
    const r = await provisionAuth({ member_id: member.id, api_key: FAKE_KEY });
    expect(r.structuredContent.reason).toBe('secret_delivery_unavailable');
    expect(r.text).toContain('Subsystem sftp');
    expect(getAgent(member.id)?.encryptedEnvVars).toBeUndefined();
  });
});

