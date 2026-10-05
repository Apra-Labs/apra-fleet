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
  REMOTE_SESSION_MCP_FILE,
} from '../src/services/session-mcp-config.js';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';
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
    expect(local).toEqual({ mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:${DEFAULT_PORT}/mcp?member=${ID}` } } });
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

