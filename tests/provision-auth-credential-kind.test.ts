import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';
import {
  provisionAuth,
  interpretClaudeAuthResult,
  sanitizeAuthErrorDetail,
  AUTH_TEST_IDLE_TIMEOUT_MS,
  AUTH_TEST_MAX_TOTAL_MS,
} from '../src/tools/provision-auth.js';
import { getProvider } from '../src/providers/index.js';
import { LinuxCommands } from '../src/os/linux.js';
import { WindowsCommands } from '../src/os/windows.js';
import type { SSHExecResult } from '../src/types.js';
import { FLEET_ENV_MARKER, unsetEnvSedExpr } from '../src/os/os-commands.js';
import { findRealBash } from './helpers/real-bash.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Fake credentials only -- never a real token.
const FAKE_OAUTH = 'sk-ant-oat01-FAKE';
const FAKE_API = 'sk-ant-api03-FAKE';

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn(),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotal?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    // Secret values travel in staged files, never in a command line.
    writeSecretFile: vi.fn(async (name: string, content: string) => {
      const p = `/home/testuser/${name}`;
      stagedFiles.push({ path: p, content });
      return p;
    }),
    removeSecretFile: vi.fn(async () => {}),
    close: vi.fn(),
  }),
}));
const stagedFiles: Array<{ path: string; content: string }> = [];

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('.credentials.json')) return mockExistsSync(...args);
        return actual.existsSync(...args);
      },
      readFileSync: (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('.credentials.json')) return mockReadFileSync(...args);
        return actual.readFileSync(...args);
      },
    },
  };
});

const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', code: 0 });
const isAuthTest = (c: string) => c.includes('-p "hello"');
const cmdsSent = () => mockExecCommand.mock.calls.map(c => c[0]);

describe('claude credential-kind detection', () => {
  const claude = getProvider('claude');

  it('routes an OAuth token (sk-ant-oat...) to CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(claude.authEnvVarForToken(FAKE_OAUTH)).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude.authEnvVarForToken(`  ${FAKE_OAUTH}\n`)).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude.authTokenKindWarning?.(FAKE_OAUTH)).toBeNull();
  });

  it('routes an API key (sk-ant-api...) to ANTHROPIC_API_KEY', () => {
    expect(claude.authEnvVarForToken(FAKE_API)).toBe('ANTHROPIC_API_KEY');
    expect(claude.authTokenKindWarning?.(FAKE_API)).toBeNull();
  });

  it('keeps legacy routing for unknown shapes but warns with the expected prefixes', () => {
    expect(claude.authEnvVarForToken('sk-ant-zzz-FAKE')).toBe('ANTHROPIC_API_KEY');
    expect(claude.authEnvVarForToken('opaque-FAKE')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    const w = claude.authTokenKindWarning?.('opaque-FAKE') ?? '';
    expect(w).toContain('sk-ant-oat');
    expect(w).toContain('sk-ant-api');
    expect(w).not.toContain('opaque-FAKE');
    expect(/^[\x20-\x7E]*$/.test(w)).toBe(true);
  });

  it('lists both kinds as mutually exclusive; a plain OAuth-file copy unsets neither', () => {
    expect(claude.authEnvVarNames?.()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(claude.oauthEnvVarsToUnset()).toEqual([]);
  });

  it('only an OAuth token supersedes the /login credentials file', () => {
    expect(claude.credentialFilesSupersededByEnvToken?.(FAKE_OAUTH)).toEqual(['~/.claude/.credentials.json']);
    expect(claude.credentialFilesSupersededByEnvToken?.(FAKE_API)).toEqual([]);
  });

  it('leaves other providers unaffected', () => {
    for (const name of ['codex', 'copilot', 'agy'] as const) {
      const p = getProvider(name);
      expect(p.authEnvVarForToken(FAKE_OAUTH)).toBe(p.authEnvVar);
      expect(p.authEnvVarNames).toBeUndefined();
      expect(p.credentialFilesSupersededByEnvToken).toBeUndefined();
    }
  });
});

describe('credentialFileMoveAside', () => {
  it('POSIX: renames only when the file exists', () => {
    const cmd = new LinuxCommands().credentialFileMoveAside('~/.claude/.credentials.json', '.fleet-superseded');
    expect(cmd).toBe('if [ -f "$HOME/.claude/.credentials.json" ]; then mv -f "$HOME/.claude/.credentials.json" "$HOME/.claude/.credentials.json.fleet-superseded" && echo moved; fi');
  });

  it('PowerShell: renames only when the file exists', () => {
    const cmd = new WindowsCommands().credentialFileMoveAside('~/.claude/.credentials.json', '.fleet-superseded');
    expect(cmd).toContain('if (Test-Path "~/.claude/.credentials.json")');
    expect(cmd).toContain('Move-Item -Path "~/.claude/.credentials.json" -Destination "~/.claude/.credentials.json.fleet-superseded" -Force');
  });

  it('rejects an unsafe suffix', () => {
    expect(() => new LinuxCommands().credentialFileMoveAside('~/x', '; rm -rf /')).toThrow();
  });
});

describe('auth test result interpretation', () => {
  it('treats exit 0 with is_error=true as a failure and reports the CLI text', () => {
    const r = interpretClaudeAuthResult(ok(JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key \u00b7 Please run /login' })));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('Invalid API key Please run /login');
  });

  it('passes a clean success', () => {
    expect(interpretClaudeAuthResult(ok(JSON.stringify({ type: 'result', is_error: false, result: 'Hi' })))).toEqual({ ok: true, detail: null });
  });

  it('falls back to stderr on a non-zero exit and redacts the secret', () => {
    const r = interpretClaudeAuthResult({ stdout: '', stderr: `bad credential ${FAKE_OAUTH} rejected`, code: 1 }, FAKE_OAUTH);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('[REDACTED]');
    expect(r.detail).not.toContain('FAKE');
  });

  it('redacts any sk-ant- shaped value and truncates', () => {
    const s = sanitizeAuthErrorDetail(`x sk-ant-api03-OTHERFAKE ${'y'.repeat(500)}`);
    expect(s).not.toContain('OTHERFAKE');
    expect(s.length).toBeLessThanOrEqual(303);
  });
});

describe('provisionAuth credential kinds', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    stagedFiles.length = 0;
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('OAuth token -> CLAUDE_CODE_OAUTH_TOKEN; clears a stale API key (POSIX profiles + registry) and moves the credentials file aside', async () => {
    const member = makeTestAgent({
      friendlyName: 'oat-posix',
      encryptedEnvVars: { ANTHROPIC_API_KEY: encryptPassword('sk-ant-oat01-STALEFAKE'), CLAUDE_CONFIG_DIR: encryptPassword('/cfg') },
    });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (cmd.includes('mv -f') ? ok('moved\n') : ok()));

    const { text, structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });

    expect(structuredContent.credentialLabel).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(structuredContent.reason).toBe('ok');
    expect(text).toContain('OAuth token provisioned');
    expect(text).toContain('Cleared: ANTHROPIC_API_KEY');
    expect(text).toMatch(/\.credentials\.json\.fleet-superseded-\d{14} /);
    // Timestamped backup suffix: never overwrites an earlier backup.
    expect(cmdsSent().some(c => /mv -f .*\.fleet-superseded-\d{14}"/.test(c))).toBe(true);
    expect(text).not.toContain('FAKE');

    const cmds = cmdsSent();
    expect(cmds).toContain(`sed -i '/export ANTHROPIC_API_KEY=/d' ~/.bashrc 2>/dev/null || true`);
    expect(cmds).toContain(`sed -i '/export ANTHROPIC_API_KEY=/d' ~/.profile 2>/dev/null || true`);
    // Persisted via a staged profile line and a path-only command, never inline.
    const persist = stagedFiles.find(f => f.path.includes('.apra-fleet-persist-'))!;
    expect(persist.content).toBe(`export CLAUDE_CODE_OAUTH_TOKEN="${FAKE_OAUTH}" # apra-fleet-managed\n`);
    expect(cmds.some(c => c.includes(`cat '${persist.path}' >> ~/.bashrc`))).toBe(true);
    expect(stagedFiles.some(f => f.content.includes('export ANTHROPIC_API_KEY='))).toBe(false);
    expect(cmds.some(c => c.includes(FAKE_OAUTH))).toBe(false);
    // Stale file moved before the auth test, so the test exercises the env token alone.
    const mvIdx = cmds.findIndex(c => c.includes('mv -f'));
    const testIdx = cmds.findIndex(isAuthTest);
    expect(mvIdx).toBeGreaterThanOrEqual(0);
    expect(mvIdx).toBeLessThan(testIdx);

    const stored = getAgent(member.id)!.encryptedEnvVars!;
    expect(Object.keys(stored).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);
    expect(decryptPassword(stored.CLAUDE_CODE_OAUTH_TOKEN)).toBe(FAKE_OAUTH);
  });

  it('API key -> ANTHROPIC_API_KEY; clears a stale OAuth token (PowerShell profile + registry)', async () => {
    const member = makeTestAgent({
      friendlyName: 'api-ps',
      os: 'windows',
      workFolder: 'C:\\work',
      encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: encryptPassword('sk-ant-oat01-STALEFAKE') },
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue(ok());

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_API });

    expect(structuredContent.credentialLabel).toBe('ANTHROPIC_API_KEY');
    const cmds = cmdsSent();
    expect(cmds).toContain(`[Environment]::SetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', $null, 'User')`);
    const persist = stagedFiles.find(f => f.path.includes('.apra-fleet-persist-'))!;
    expect(persist.content).toBe(Buffer.from(FAKE_API).toString('base64'));
    expect(cmds.some(c => c.includes("SetEnvironmentVariable('ANTHROPIC_API_KEY', $v, 'User')") && c.includes(persist.path))).toBe(true);
    expect(cmds.some(c => c.includes(FAKE_API))).toBe(false);
    // A real API key leaves the /login file alone (may be a human's own login).
    expect(cmds.some(c => c.includes('Move-Item'))).toBe(false);
    expect(Object.keys(getAgent(member.id)!.encryptedEnvVars!)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('reports the CLI error text when the auth test fails, with a bounded timeout and no secret', async () => {
    const member = makeTestAgent({ friendlyName: 'oat-fail' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (isAuthTest(cmd)
      ? { stdout: JSON.stringify({ type: 'result', is_error: true, result: `Invalid bearer token ${FAKE_OAUTH}` }), stderr: '', code: 1 }
      : ok()));

    const { text, structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });

    expect(structuredContent.ok).toBe(true);
    expect(structuredContent.verified).toBe(false);
    expect(structuredContent.reason).toBe('deployed_unverified');
    expect(text).toContain('Auth test: FAILED -- Invalid bearer token [REDACTED]');
    expect(text).not.toContain('FAKE');

    const call = mockExecCommand.mock.calls.find(c => isAuthTest(c[0]))!;
    expect(call[1]).toBe(AUTH_TEST_IDLE_TIMEOUT_MS);
    expect(call[2]).toBe(AUTH_TEST_MAX_TOTAL_MS);
  });

  it('reports a timed-out auth test instead of hanging', async () => {
    const member = makeTestAgent({ friendlyName: 'oat-timeout' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (isAuthTest(cmd)) throw new Error(`Command exceeded max total time of ${AUTH_TEST_MAX_TOTAL_MS}ms`);
      return ok();
    });

    const { text, structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });
    expect(structuredContent.verified).toBe(false);
    expect(text).toContain('Auth test: FAILED -- Command exceeded max total time');
  });

  it('warns on an unrecognised prefix without echoing the value', async () => {
    const member = makeTestAgent({ friendlyName: 'odd-prefix' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(ok());

    const { text } = await provisionAuth({ member_id: member.id, api_key: 'opaque-FAKE' });
    expect(text).toContain('[WARN] Unrecognised Claude credential prefix');
    expect(text).not.toContain('opaque-FAKE');
  });

  // Automatic callers (cloud start: {member_id}; sprint self-heal: {member_name})
  // pass no api_key and no force flag. They must re-deploy the operator's
  // stored credential, never copy this machine's login over it or erase it.
  for (const [label, stored, expectedVar] of [
    ['stored OAuth token', { CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH }, 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['stored API key', { ANTHROPIC_API_KEY: FAKE_API }, 'ANTHROPIC_API_KEY'],
  ] as const) {
    for (const by of ['member_id', 'member_name'] as const) {
      it(`no api_key (by ${by}) re-deploys a ${label} and keeps it`, async () => {
        const name = `auto-${expectedVar}-${by}`.toLowerCase().replace(/_/g, '-');
        const encrypted = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, encryptPassword(v)]));
        const member = makeTestAgent({ friendlyName: name, encryptedEnvVars: { ...encrypted, CLAUDE_CONFIG_DIR: encryptPassword('/cfg') } });
        addAgent(member);
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-LOCALFAKE"}}');
        mockExecCommand.mockResolvedValue(ok());

        const { text, structuredContent } = await provisionAuth(by === 'member_id' ? { member_id: member.id } : { member_name: name });

        expect(structuredContent.ok).toBe(true);
        expect(structuredContent.credentialLabel).toBe(expectedVar);
        expect(text).toContain(`Re-deployed the member's stored ${expectedVar}`);
        expect(text).not.toContain('FAKE');
        const cmds = cmdsSent();
        // The local login file is never copied over the operator's credential.
        expect(cmds.some(c => c.includes('LOCALFAKE'))).toBe(false);
        expect(cmds).not.toContain(`unset ${expectedVar}`);
        const after = getAgent(member.id)!.encryptedEnvVars!;
        expect(Object.keys(after).sort()).toEqual([expectedVar, 'CLAUDE_CONFIG_DIR'].sort());
        expect(decryptPassword(after[expectedVar])).toBe(stored[expectedVar as keyof typeof stored]);
      });
    }
  }

  it('no api_key re-deploy migrates an OAuth token misfiled under ANTHROPIC_API_KEY', async () => {
    const member = makeTestAgent({ friendlyName: 'misfiled-oat', encryptedEnvVars: { ANTHROPIC_API_KEY: encryptPassword(FAKE_OAUTH) } });
    addAgent(member);
    mockExecCommand.mockResolvedValue(ok());

    const { structuredContent } = await provisionAuth({ member_id: member.id });
    expect(structuredContent.credentialLabel).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(Object.keys(getAgent(member.id)!.encryptedEnvVars!)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('a plain OAuth-file copy (nothing stored) clears no env credentials', async () => {
    const member = makeTestAgent({ friendlyName: 'oauth-copy-plain', encryptedEnvVars: { CLAUDE_CONFIG_DIR: encryptPassword('/cfg') } });
    addAgent(member);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE"}}');
    mockExecCommand.mockResolvedValue(ok());

    const { text, structuredContent } = await provisionAuth({ member_id: member.id });
    expect(structuredContent.credentialLabel).toBe('oauth');
    const cmds = cmdsSent();
    expect(cmds.some(c => c.includes('ANTHROPIC_API_KEY') || c.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);
    expect(text).not.toContain('Cleared:');
    expect(Object.keys(getAgent(member.id)!.encryptedEnvVars!)).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('force_oauth_copy copies the local login and clears (and reports) stored env credentials', async () => {
    const member = makeTestAgent({
      friendlyName: 'oauth-copy-force',
      encryptedEnvVars: { ANTHROPIC_API_KEY: encryptPassword(FAKE_API), CLAUDE_CONFIG_DIR: encryptPassword('/cfg') },
    });
    addAgent(member);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE"}}');
    mockExecCommand.mockResolvedValue(ok());

    const { text, structuredContent } = await provisionAuth({ member_id: member.id, force_oauth_copy: true });
    expect(structuredContent.credentialLabel).toBe('oauth');
    expect(text).toContain('Cleared: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN');
    const cmds = cmdsSent();
    expect(cmds).toContain('unset ANTHROPIC_API_KEY');
    expect(cmds).toContain('unset CLAUDE_CODE_OAUTH_TOKEN');
    expect(Object.keys(getAgent(member.id)!.encryptedEnvVars!)).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('codex API key flow does not touch Claude credential kinds or files', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-kind', llmProvider: 'codex' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(ok());

    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: 'sk-openai-FAKE' });
    expect(structuredContent.credentialLabel).toBe('OPENAI_API_KEY');
    const cmds = cmdsSent();
    expect(cmds.some(c => c.includes('mv -f') || c.includes('.credentials.json'))).toBe(false);
    expect(cmds.some(c => c.includes('ANTHROPIC_API_KEY') || c.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);
  });

  it('local members are skipped without any remote command', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'local-oat' });
    addAgent(member);
    const { structuredContent } = await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });
    expect(structuredContent.reason).toBe('skipped_local_member');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// Provisioning is an explicit delivery/replacement of the var: its unset
// calls remove EVERY export line for the name (marked or not), unlike
// remove_member, which removes only fleet-marked lines.
describe('provisionAuth profile cleanup removes every export line for the name', () => {
  const allForm = (name: string, f: string) => `sed -i '${unsetEnvSedExpr(name, { all: true })}' ~/${f} 2>/dev/null || true`;
  const markedForm = (name: string) => unsetEnvSedExpr(name);

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    stagedFiles.length = 0;
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue(ok());
  });
  afterEach(() => restoreRegistry());

  it('force_oauth_copy clears env credentials with the remove-all form', async () => {
    const member = makeTestAgent({ friendlyName: 'force-all', os: 'linux' });
    addAgent(member);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE"}}');

    await provisionAuth({ member_id: member.id, force_oauth_copy: true });

    const cmds = cmdsSent();
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      for (const f of ['.bashrc', '.profile']) expect(cmds).toContain(allForm(name, f));
      expect(cmds.some(c => c.includes(markedForm(name)))).toBe(false);
    }
  });

  it('api_key clears the other kind with the remove-all form; the persist command replaces every line of the delivered name', async () => {
    const member = makeTestAgent({ friendlyName: 'api-all', os: 'linux' });
    addAgent(member);

    await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });

    const cmds = cmdsSent();
    const persistIdx = cmds.findIndex(c => c.includes('.apra-fleet-persist-'));
    for (const f of ['.bashrc', '.profile']) {
      const idx = cmds.indexOf(allForm('ANTHROPIC_API_KEY', f));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(persistIdx);
      expect(cmds[persistIdx]).toContain(`sed -i '${unsetEnvSedExpr('CLAUDE_CODE_OAUTH_TOKEN', { all: true })}' ~/${f}`);
    }
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(cmds.some(c => c.includes(markedForm(name)))).toBe(false);
    }
  });

  // Rotation: a legacy unmarked export of the delivered name must not survive
  // next to the new marked line. Runs the exact command sequence provisionAuth
  // sent, in bash, against profiles in a temp HOME.
  const bash = findRealBash();
  it.skipIf(!bash.path)('rotation over a legacy unmarked export leaves exactly one marked line', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-rotation-'));
    try {
      const legacy = 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-OLDFAKE"';
      for (const f of ['.bashrc', '.profile']) fs.writeFileSync(path.join(home, f), `# owner\n${legacy}\nexport KEEP=1\n`);
      const member = makeTestAgent({ friendlyName: 'rotate', os: 'linux' });
      addAgent(member);

      await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });

      const persist = stagedFiles.find(f => f.path.includes('.apra-fleet-persist-'))!;
      const realStaged = path.join(home, 'staged-persist').split(path.sep).join('/');
      fs.writeFileSync(realStaged, persist.content);
      const profileCmds = cmdsSent()
        .filter(c => c.startsWith('sed -i ') || c.includes(persist.path))
        .map(c => c.split(persist.path).join(realStaged));
      expect(profileCmds.some(c => c.includes(realStaged))).toBe(true);
      const h = home.split(path.sep).join('/');
      for (const cmd of profileCmds) {
        spawnSync(bash.path!, ['--noprofile', '--norc', '-c', cmd], { env: { ...process.env, HOME: h, USERPROFILE: home } });
      }

      for (const f of ['.bashrc', '.profile']) {
        const lines = fs.readFileSync(path.join(home, f), 'utf-8').split('\n').filter(l => l.includes('export CLAUDE_CODE_OAUTH_TOKEN='));
        expect(lines, f).toEqual([`export CLAUDE_CODE_OAUTH_TOKEN="${FAKE_OAUTH}" # ${FLEET_ENV_MARKER}`]);
        expect(fs.readFileSync(path.join(home, f), 'utf-8')).toContain('export KEEP=1');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// provision_llm_auth records what it delivered (Agent.llmAuthDelivered) --
// the only credentials remove_member will later remove.
describe('provisionAuth records the LLM credentials it delivered', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    stagedFiles.length = 0;
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue(ok());
  });
  afterEach(() => restoreRegistry());

  it('api_key: records the persisted env var name only', async () => {
    const member = makeTestAgent({ friendlyName: 'rec-api', os: 'linux' });
    addAgent(member);

    await provisionAuth({ member_id: member.id, api_key: FAKE_API });

    expect(getAgent(member.id)!.llmAuthDelivered).toEqual({ files: [], envVars: ['ANTHROPIC_API_KEY'] });
  });

  it('OAuth copy: records the installed credential file paths', async () => {
    const member = makeTestAgent({ friendlyName: 'rec-oauth', os: 'linux' });
    addAgent(member);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE"}}');

    await provisionAuth({ member_id: member.id });

    const files = (getProvider('claude').oauthCredentialFiles() ?? []).map(f => f.remotePath);
    expect(files.length).toBeGreaterThan(0);
    expect(getAgent(member.id)!.llmAuthDelivered).toEqual({ files, envVars: [] });
  });

  it('a failed persist records nothing', async () => {
    const member = makeTestAgent({ friendlyName: 'rec-fail', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (cmd.includes('.apra-fleet-persist-')
      ? { stdout: '', stderr: 'disk full', code: 1 } : ok()));

    await provisionAuth({ member_id: member.id, api_key: FAKE_API });

    expect(getAgent(member.id)!.llmAuthDelivered).toBeUndefined();
  });

  it('switching kinds and an OAuth token moving the login file aside update the record', async () => {
    const member = makeTestAgent({
      friendlyName: 'rec-switch', os: 'linux',
      llmAuthDelivered: { files: ['~/.claude/.credentials.json'], envVars: ['ANTHROPIC_API_KEY'] },
    });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (cmd.includes('mv -f') ? ok('moved\n') : ok()));

    await provisionAuth({ member_id: member.id, api_key: FAKE_OAUTH });

    expect(getAgent(member.id)!.llmAuthDelivered).toEqual({ files: [], envVars: ['CLAUDE_CODE_OAUTH_TOKEN'] });
  });

  it('force_oauth_copy drops the cleared env vars from the record', async () => {
    const member = makeTestAgent({
      friendlyName: 'rec-force', os: 'linux',
      llmAuthDelivered: { files: [], envVars: ['ANTHROPIC_API_KEY'] },
    });
    addAgent(member);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE"}}');

    await provisionAuth({ member_id: member.id, force_oauth_copy: true });

    const rec = getAgent(member.id)!.llmAuthDelivered!;
    expect(rec.envVars).toEqual([]);
    expect(rec.files.length).toBeGreaterThan(0);
  });
});
