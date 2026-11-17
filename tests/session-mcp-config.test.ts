/**
 * Per-session member MCP config for Claude dispatches: the command line each
 * OS/shell gets (--mcp-config <file>, last, no --strict-mcp-config), the
 * config body (member URL and port), where the file goes, when injection is
 * available, and the shared member file writer it uses on remote members.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import { FLEET_DIR, DEFAULT_PORT, BUILTIN_DEFAULT_PORT } from '../src/paths.js';
import {
  sessionMcpInjectionAvailable,
  sessionMcpConfigContent,
  sessionMcpConfigPath,
  sessionMcpConfigIsPerDispatch,
  perFolderMcpEntryNeeded,
  writeSessionMcpConfig,
  removeLocalSessionMcpConfig,
  resolveSessionMcpAlwaysLoad,
  parseCliVersion,
  cliVersionAtLeast,
  resetCliVersionCache,
  CLI_VERSION_CACHE_TTL_MS,
  REMOTE_SESSION_MCP_FILE,
} from '../src/services/session-mcp-config.js';
import { makeTestAgent, makeTestLocalAgent, memberSecretHeaders } from './test-helpers.js';
import type { SSHExecResult } from '../src/types.js';

const ID = '11111111-2222-3333-4444-555555555555';
const claude = getProvider('claude');

const TASK = 'Your task is described in .fleet-task.md in the current directory. Read that file first, then execute the task.';

const baseOpts = {
  promptFile: '.fleet-task.md',
  sessionId: 'sess-1',
  resuming: false,
  unattended: false as const,
  model: 'claude-sonnet-4-6',
  maxTurns: 50,
};

describe('--mcp-config on the dispatch command line, per OS and shell', () => {
  it('local claude member on Windows (PowerShell): quoted Windows path, appended last', () => {
    const cfg = 'C:\\Users\\bella\\.apra-fleet\\data\\session-mcp\\' + ID + '.json';
    const cmd = getOsCommands('windows', 'powershell5').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: 'C:\\Users\\bella\\project', agentName: 'doer', mcpConfigPath: cfg,
    });
    const without = getOsCommands('windows', 'powershell5').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: 'C:\\Users\\bella\\project', agentName: 'doer',
    });
    expect(cmd).toBe(`${without} --mcp-config "${cfg}"`);
    expect(cmd.endsWith(`Write-Output "FLEET_PID:$pid"; claude --agent "doer" -p "${TASK}" --output-format json --max-turns 50 --session-id "sess-1" --permission-mode acceptEdits --model "claude-sonnet-4-6" --mcp-config "${cfg}"`)).toBe(true);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd.indexOf('--mcp-config')).toBeGreaterThan(cmd.indexOf(' -p "'));
  });

  it('remote claude member on Linux (bash): POSIX-quoted path after --model, before the tee mirror', () => {
    const cfg = `/home/u/repo/${REMOTE_SESSION_MCP_FILE}`;
    const cmd = getOsCommands('linux').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: '/home/u/repo', inv: 'inv-1', mcpConfigPath: cfg,
    });
    const without = getOsCommands('linux').buildAgentPromptCommand(claude, { ...baseOpts, folder: '/home/u/repo', inv: 'inv-1' });
    expect(cmd).toBe(without.replace('--model "claude-sonnet-4-6"', `--model "claude-sonnet-4-6" --mcp-config "${cfg}"`));
    expect(cmd).toContain(`claude -p "[inv-1] ${TASK}" --output-format json --max-turns 50 --session-id "sess-1" --permission-mode acceptEdits --model "claude-sonnet-4-6" --mcp-config "${cfg}" | tee`);
    expect(cmd).not.toContain('--strict-mcp-config');
  });

  it('remote claude member on Windows (PowerShell 7): backslash path, PowerShell quoting', () => {
    const cfg = `C:\\Users\\bella\\project\\${REMOTE_SESSION_MCP_FILE}`;
    const cmd = getOsCommands('windows', 'pwsh7').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: 'C:\\Users\\bella\\project', mcpConfigPath: cfg,
    });
    const without = getOsCommands('windows', 'pwsh7').buildAgentPromptCommand(claude, { ...baseOpts, folder: 'C:\\Users\\bella\\project' });
    expect(cmd).toBe(`${without} --mcp-config "${cfg}"`);
    expect(cmd.endsWith(`claude -p "${TASK}" --output-format json --max-turns 50 --session-id "sess-1" --permission-mode acceptEdits --model "claude-sonnet-4-6" --mcp-config "${cfg}"`)).toBe(true);
  });

  it('remote claude member on Windows (gitbash): POSIX quoting of the C:/ form', () => {
    const cfg = `C:/Users/bella/project/${REMOTE_SESSION_MCP_FILE}`;
    const cmd = getOsCommands('windows', 'gitbash').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: 'C:/Users/bella/project', mcpConfigPath: cfg,
    });
    expect(cmd).toContain(`--mcp-config "${cfg}"`);
  });

  it('PowerShell and POSIX metacharacters in the path are escaped, never expanded', () => {
    const win = getOsCommands('windows', 'pwsh7').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: 'C:\\x', mcpConfigPath: 'C:\\a$b`c\\f.json',
    });
    expect(win).toContain('--mcp-config "C:\\a`$b``c\\f.json"');
    const lin = getOsCommands('linux').buildAgentPromptCommand(claude, {
      ...baseOpts, folder: '/x', mcpConfigPath: '/a$b`c/f.json',
    });
    expect(lin).toContain('--mcp-config "/a\\$b\\`c/f.json"');
  });

  it('no mcpConfigPath (injection unavailable): no flag, byte-identical command', () => {
    for (const [os, shell] of [['linux', undefined], ['windows', 'powershell5'], ['windows', 'gitbash']] as const) {
      const cmds = getOsCommands(os, shell);
      const opts = { ...baseOpts, folder: os === 'linux' ? '/x' : 'C:\\x' };
      const without = cmds.buildAgentPromptCommand(claude, opts);
      expect(without).not.toContain('--mcp-config');
      expect(cmds.buildAgentPromptCommand(claude, { ...opts, mcpConfigPath: undefined })).toBe(without);
    }
  });

  it('a provider without mcpConfigFlag never gets the flag', () => {
    const cmd = getOsCommands('windows', 'pwsh7').buildAgentPromptCommand(getProvider('codex'), {
      ...baseOpts, folder: 'C:\\x', mcpConfigPath: 'C:\\x\\f.json',
    });
    expect(cmd).not.toContain('--mcp-config');
  });
});

describe('session MCP config body, path and availability', () => {
  it('local member: this server port; remote member: the member install default port', () => {
    const local = JSON.parse(sessionMcpConfigContent({ id: ID, agentType: 'local' }));
    // A local member shares this server: its config carries this install's member access secret.
    expect(local).toEqual({ mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:${DEFAULT_PORT}/mcp?member=${ID}`, headers: memberSecretHeaders() } } });
    const remote = JSON.parse(sessionMcpConfigContent({ id: ID, agentType: 'remote' }));
    expect(remote.mcpServers['apra-fleet'].url).toBe(`http://localhost:${BUILTIN_DEFAULT_PORT}/mcp?member=${ID}`);
    expect(Object.keys(remote.mcpServers)).toEqual(['apra-fleet']);
  });

  it('local file lives under the data dir per member (reused); remote file sits in the work folder per dispatch', () => {
    const local = makeTestLocalAgent({ id: ID });
    expect(sessionMcpConfigPath(local, local.workFolder)).toBe(path.join(FLEET_DIR, 'session-mcp', `${ID}.json`));
    expect(sessionMcpConfigIsPerDispatch(local)).toBe(false);
    const lin = makeTestAgent({ id: ID, os: 'linux' });
    expect(sessionMcpConfigPath(lin, '/home/u/repo')).toBe(`/home/u/repo/${REMOTE_SESSION_MCP_FILE}`);
    expect(sessionMcpConfigIsPerDispatch(lin)).toBe(true);
    const ps = makeTestAgent({ id: ID, os: 'windows', shell: 'pwsh7' });
    expect(sessionMcpConfigPath(ps, 'C:/Users/b/repo')).toBe(`C:\\Users\\b\\repo\\${REMOTE_SESSION_MCP_FILE}`);
    const gb = makeTestAgent({ id: ID, os: 'windows', shell: 'gitbash' });
    expect(sessionMcpConfigPath(gb, 'C:\\Users\\b\\repo')).toBe(`C:/Users/b/repo/${REMOTE_SESSION_MCP_FILE}`);
  });

  it('injection: claude only; local always; remote only when its own server answered a member session', () => {
    const at = 'x';
    expect(sessionMcpInjectionAvailable(makeTestLocalAgent())).toBe(true);
    expect(sessionMcpInjectionAvailable(makeTestLocalAgent({ fleetMcp: { state: 'unavailable', reason: 'role-agents-hide-member-tools', checkedAt: at } }))).toBe(true);
    expect(sessionMcpInjectionAvailable(makeTestLocalAgent({ fleetMcp: { state: 'unavailable', reason: 'member-session-failed', checkedAt: at } }))).toBe(false);
    expect(sessionMcpInjectionAvailable(makeTestLocalAgent({ llmProvider: 'opencode' }))).toBe(false);
    expect(sessionMcpInjectionAvailable(makeTestAgent())).toBe(false);
    expect(sessionMcpInjectionAvailable(makeTestAgent({ fleetMcp: { state: 'available', checkedAt: at } }))).toBe(true);
    expect(sessionMcpInjectionAvailable(makeTestAgent({ fleetMcp: { state: 'available', checkedAt: at, unverified: true } }))).toBe(false);
    expect(sessionMcpInjectionAvailable(makeTestAgent({ fleetMcp: { state: 'unavailable', reason: 'role-agents-hide-member-tools', checkedAt: at } }))).toBe(true);
    expect(sessionMcpInjectionAvailable(makeTestAgent({ fleetMcp: { state: 'unavailable', reason: 'member-session-failed', checkedAt: at } }))).toBe(false);
    expect(sessionMcpInjectionAvailable(makeTestAgent({ llmProvider: 'agy', fleetMcp: { state: 'available', checkedAt: at } }))).toBe(false);
  });

  it('per-folder entry: not for a local claude member; kept for remote members and other providers', () => {
    expect(perFolderMcpEntryNeeded(makeTestLocalAgent())).toBe(false);
    expect(perFolderMcpEntryNeeded(makeTestLocalAgent({ llmProvider: 'opencode' }))).toBe(true);
    expect(perFolderMcpEntryNeeded(makeTestAgent())).toBe(true);
  });
});

describe('writeSessionMcpConfig', () => {
  it('local: writes the file through fs (no member command)', async () => {
    const agent = makeTestLocalAgent({ id: `${ID}-w` });
    const p = sessionMcpConfigPath(agent, agent.workFolder);
    const exec = async (): Promise<SSHExecResult> => { throw new Error('no member command for a local member'); };
    expect(await writeSessionMcpConfig(agent, p, exec)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers['apra-fleet'].url).toContain(`?member=${ID}-w`);
    removeLocalSessionMcpConfig(agent);
    expect(fs.existsSync(p)).toBe(false);
    removeLocalSessionMcpConfig(agent); // absent: no throw
  });

  it('remote bash: the shared member writer (mkdir, heredoc write, read-back) with a quoted resolved path', async () => {
    const agent = makeTestAgent({ id: ID, os: 'linux' });
    const p = `/home/u/repo/${REMOTE_SESSION_MCP_FILE}`;
    const cmds: string[] = [];
    let written = '';
    const exec = async (cmd: string): Promise<SSHExecResult> => {
      cmds.push(cmd);
      const m = /<< 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/.exec(cmd);
      if (m) written = m[1];
      if (cmd.startsWith('if test -e')) return { stdout: written, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    expect(await writeSessionMcpConfig(agent, p, exec)).toEqual({ ok: true });
    expect(cmds[0]).toBe('mkdir -p "/home/u/repo"');
    expect(cmds[1]).toContain(`cat > "${p}" << 'FLEET_PERMS_EOF'`);
    expect(JSON.parse(written).mcpServers['apra-fleet'].url).toBe(`http://localhost:${BUILTIN_DEFAULT_PORT}/mcp?member=${ID}`);
    for (const c of cmds) expect(c).not.toMatch(/\$HOME|~\/|\$env:/);
  });

  it('remote: the written file is added to the clone exclude file at dispatch time (best effort)', async () => {
    const agent = makeTestAgent({ id: ID, os: 'linux', workFolder: '/home/u/repo' });
    const p = `/home/u/repo/${REMOTE_SESSION_MCP_FILE}`;
    const files = new Map<string, string>();
    const cmds: string[] = [];
    const exec = async (cmd: string): Promise<SSHExecResult> => {
      cmds.push(cmd);
      const w = /^cat > "([^"]+)" << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/.exec(cmd);
      if (w) { files.set(w[1], w[2]); return { stdout: '', stderr: '', code: 0 }; }
      const r = /^if test -e "([^"]+)"/.exec(cmd);
      if (r) return { stdout: files.get(r[1]) ?? '', stderr: '', code: 0 };
      if (cmd.includes('rev-parse --git-path info/exclude')) return { stdout: '.git/info/exclude\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    expect(await writeSessionMcpConfig(agent, p, exec)).toEqual({ ok: true });
    expect(files.get('/home/u/repo/.git/info/exclude')).toBe(`/${REMOTE_SESSION_MCP_FILE}`);
    // not a repo: the write still succeeds
    const noRepo = async (cmd: string): Promise<SSHExecResult> =>
      (cmd.includes('rev-parse') ? { stdout: '', stderr: 'not a repository', code: 128 } : exec(cmd));
    expect(await writeSessionMcpConfig(agent, p, noRepo)).toEqual({ ok: true });
  });

  it('remote PowerShell: WriteAllText with a PowerShell-quoted Windows path', async () => {
    const agent = makeTestAgent({ id: ID, os: 'windows', shell: 'powershell5' });
    const p = `C:\\Users\\b\\repo\\${REMOTE_SESSION_MCP_FILE}`;
    const cmds: string[] = [];
    const exec = async (cmd: string): Promise<SSHExecResult> => {
      cmds.push(cmd);
      if (cmd.startsWith('if (Test-Path')) return { stdout: sessionMcpConfigContent(agent), stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    expect(await writeSessionMcpConfig(agent, p, exec)).toEqual({ ok: true });
    expect(cmds[0]).toBe('New-Item -ItemType Directory -Force "C:\\Users\\b\\repo"');
    expect(cmds[1]).toContain(`[System.IO.File]::WriteAllText("${p}"`);
  });

  it('a failed write is reported, never thrown (caller falls back)', async () => {
    const agent = makeTestAgent({ id: ID, os: 'linux' });
    const exec = async (): Promise<SSHExecResult> => ({ stdout: '', stderr: 'Permission denied', code: 1 });
    const r = await writeSessionMcpConfig(agent, '/ro/x.json', exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('Permission denied');
  });
});

describe('non-deferral of the member kb/code tools (alwaysLoad)', () => {
  const ok = (stdout: string, code = 0): SSHExecResult => ({ stdout, stderr: '', code });

  it('config body carries alwaysLoad only when asked', () => {
    const on = JSON.parse(sessionMcpConfigContent({ id: ID, agentType: 'remote' }, { alwaysLoad: true }));
    expect(on.mcpServers['apra-fleet']).toEqual({ type: 'http', url: `http://localhost:${BUILTIN_DEFAULT_PORT}/mcp?member=${ID}`, alwaysLoad: true });
    for (const off of [sessionMcpConfigContent({ id: ID, agentType: 'remote' }), sessionMcpConfigContent({ id: ID, agentType: 'remote' }, { alwaysLoad: false })]) {
      expect(JSON.parse(off).mcpServers['apra-fleet']).not.toHaveProperty('alwaysLoad');
    }
  });

  it('only claude names an always-load floor; codex, copilot, agy, opencode and none do not', () => {
    expect(claude.mcpAlwaysLoadMinVersion?.()).toBe('2.1.288');
    for (const name of ['codex', 'copilot', 'agy', 'opencode', 'none'] as const) {
      expect(getProvider(name).mcpAlwaysLoadMinVersion).toBeUndefined();
    }
  });

  it('the mechanism adds nothing to the command line but the --mcp-config flag: no $VAR, backtick or ~', () => {
    const cfg = { linux: `/home/u/repo/${REMOTE_SESSION_MCP_FILE}`, pwsh7: `C:\\Users\\b\\repo\\${REMOTE_SESSION_MCP_FILE}`, gitbash: `C:/Users/b/repo/${REMOTE_SESSION_MCP_FILE}` };
    for (const [os, shell, path_, folder] of [
      ['linux', undefined, cfg.linux, '/home/u/repo'],
      ['windows', 'pwsh7', cfg.pwsh7, 'C:\\Users\\b\\repo'],
      ['windows', 'powershell5', cfg.pwsh7, 'C:\\Users\\b\\repo'],
      ['windows', 'gitbash', cfg.gitbash, 'C:/Users/b/repo'],
    ] as const) {
      const cmds = getOsCommands(os, shell);
      const without = cmds.buildAgentPromptCommand(claude, { ...baseOpts, folder });
      const withCfg = cmds.buildAgentPromptCommand(claude, { ...baseOpts, folder, mcpConfigPath: path_ });
      // the only difference is the flag naming the file that carries alwaysLoad
      const flag = ` --mcp-config "${path_}"`;
      expect(withCfg.replace(flag, '')).toBe(without);
      expect(flag).not.toMatch(/[$`~]/);
      expect(withCfg).not.toMatch(/ENABLE_TOOL_SEARCH|alwaysLoad/);
    }
  });

  it('commands for the other providers are unchanged by mcpConfigPath (they have no session config flag)', () => {
    for (const name of ['codex', 'copilot', 'agy', 'opencode'] as const) {
      const p = getProvider(name);
      for (const [os, shell, folder] of [['linux', undefined, '/x'], ['windows', 'pwsh7', 'C:\\x'], ['windows', 'gitbash', 'C:/x']] as const) {
        const cmds = getOsCommands(os, shell);
        const opts = { ...baseOpts, folder, projectId: 'proj-1' };
        expect(cmds.buildAgentPromptCommand(p, { ...opts, mcpConfigPath: '/x/f.json' })).toBe(cmds.buildAgentPromptCommand(p, opts));
      }
    }
  });

  it('version parsing and comparison', () => {
    expect(parseCliVersion('2.1.291 (Claude Code)\n')).toBe('2.1.291');
    expect(parseCliVersion('claude: not found')).toBeUndefined();
    expect(cliVersionAtLeast('2.1.291', '2.1.288')).toBe(true);
    expect(cliVersionAtLeast('2.1.288', '2.1.288')).toBe(true);
    expect(cliVersionAtLeast('2.1.100', '2.1.288')).toBe(false);
    expect(cliVersionAtLeast('3.0.0', '2.1.288')).toBe(true);
    expect(cliVersionAtLeast('2.0.999', '2.1.288')).toBe(false);
  });

  it('supported CLI: alwaysLoad, no warning; the version is probed once per member within the TTL, then again', async () => {
    resetCliVersionCache();
    let t = 1_000;
    const calls: string[] = [];
    const exec = async (cmd: string) => { calls.push(cmd); return ok('2.1.291 (Claude Code)\n'); };
    expect(await resolveSessionMcpAlwaysLoad({ id: ID }, '2.1.288', 'claude --version 2>&1', exec, () => t)).toEqual({ alwaysLoad: true });
    t += CLI_VERSION_CACHE_TTL_MS - 1;
    await resolveSessionMcpAlwaysLoad({ id: ID }, '2.1.288', 'claude --version 2>&1', exec, () => t);
    expect(calls).toEqual(['claude --version 2>&1']);
    t += 2;
    await resolveSessionMcpAlwaysLoad({ id: ID }, '2.1.288', 'claude --version 2>&1', exec, () => t);
    expect(calls).toHaveLength(2);
  });

  it('WARN causes: CLI too old, version unreadable (non-zero exit, no version text, exec throws), no provider option', async () => {
    const run = async (exec: (c: string) => Promise<SSHExecResult>, min: string | undefined = '2.1.288', noFloor = false) => {
      resetCliVersionCache();
      return resolveSessionMcpAlwaysLoad({ id: ID }, noFloor ? undefined : min, 'claude --version 2>&1', exec);
    };
    const old = await run(async () => ok('2.1.100 (Claude Code)'));
    expect(old.alwaysLoad).toBe(false);
    expect(old.warning).toMatch(/member CLI 2\.1\.100 is older than 2\.1\.288/);
    for (const exec of [
      async () => ok('2.1.291 (Claude Code)', 1),
      async () => ok('command not found'),
      async () => { throw new Error('ssh down'); },
    ]) {
      const r = await run(exec);
      expect(r.alwaysLoad).toBe(false);
      expect(r.warning).toMatch(/version could not be determined.*needs >= 2\.1\.288/);
    }
    const none = await run(async () => ok('2.1.291'), undefined, true);
    expect(none.alwaysLoad).toBe(false);
    expect(none.warning).toMatch(/no MCP always-load option/);
  });

  it('a failed probe is not cached: the next dispatch probes again', async () => {
    resetCliVersionCache();
    let n = 0;
    const exec = async () => { n++; return n === 1 ? ok('', 1) : ok('2.1.291'); };
    expect((await resolveSessionMcpAlwaysLoad({ id: ID }, '2.1.288', 'v', exec)).alwaysLoad).toBe(false);
    expect((await resolveSessionMcpAlwaysLoad({ id: ID }, '2.1.288', 'v', exec)).alwaysLoad).toBe(true);
  });

  it('writeSessionMcpConfig writes alwaysLoad when asked (local member, through fs)', async () => {
    const local = makeTestLocalAgent({ id: '99999999-2222-3333-4444-555555555555' });
    const p = sessionMcpConfigPath(local, local.workFolder);
    try {
      const r = await writeSessionMcpConfig(local, p, async () => { throw new Error('no member command for a local write'); }, { alwaysLoad: true });
      expect(r).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers['apra-fleet'].alwaysLoad).toBe(true);
    } finally {
      removeLocalSessionMcpConfig(local);
    }
  });
});
