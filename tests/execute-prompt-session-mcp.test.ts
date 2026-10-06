/**
 * execute_prompt injects the member-scoped apra-fleet MCP config into every
 * claude dispatch session (--mcp-config <file>) through the one dispatch path,
 * end to end with a stubbed member transport:
 *  - remote bash / remote PowerShell members whose own server answered a
 *    member session: the file is written in the work folder, named on the
 *    command line, and removed with the prompt file;
 *  - a local member: the file is written under the data dir with this
 *    server's port, and no member command touches the folder;
 *  - fallback: no recorded fleetMcp, or a failed write -> the dispatch still
 *    runs, without the flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeTestAgent,
  makeTestLocalAgent,
  backupAndResetRegistry,
  restoreRegistry,
  resultText,
  decodePowerShellEncodedCommand,
} from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { FLEET_DIR, DEFAULT_PORT, BUILTIN_DEFAULT_PORT } from '../src/paths.js';
import { resetCliVersionCache } from '../src/services/session-mcp-config.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<
  (cmd: string, timeout?: number, maxTotalMs?: number, onPid?: (pid: number) => void) => Promise<SSHExecResult>
>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

const OK = JSON.stringify({ result: 'ok', session_id: 'sess-x' });
const AVAILABLE = { state: 'available' as const, checkedAt: '2026-10-05T00:00:00Z' };

/** Stub member: answers the read-back of the session config with what was written. */
function stubMember(opts: { failSessionWrite?: boolean; cliVersion?: string | null } = {}) {
  let written = '';
  mockExecCommand.mockImplementation(async (cmd: string) => {
    // The member CLI version probe that gates the always-load option.
    if (/claude --version/.test(decoded(cmd))) {
      const v = opts.cliVersion === undefined ? '2.1.291 (Claude Code)' : opts.cliVersion;
      return v === null ? { stdout: '', stderr: 'claude: command not found', code: 127 } : { stdout: `${v}
`, stderr: '', code: 0 };
    }
    // Not a repo: the best-effort exclude step is a no-op here (its own
    // behaviour is covered in session-mcp-config.test.ts).
    if (cmd.includes('rev-parse --git-path')) return { stdout: '', stderr: 'not a repository', code: 128 };
    const heredoc = /<< 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/.exec(cmd);
    if (heredoc) {
      if (opts.failSessionWrite) return { stdout: '', stderr: 'No space left on device', code: 1 };
      written = heredoc[1];
      return { stdout: '', stderr: '', code: 0 };
    }
    const ps = /WriteAllText\("[^"]*", '([\s\S]*)\n', \(New-Object/.exec(cmd);
    if (ps) { written = ps[1].replace(/''/g, "'"); return { stdout: '', stderr: '', code: 0 }; }
    if (cmd.startsWith('if test -e') || cmd.startsWith('if (Test-Path')) return { stdout: written, stderr: '', code: 0 };
    return { stdout: OK, stderr: '', code: 0 };
  });
  return () => written;
}

const allCmds = () => mockExecCommand.mock.calls.map(c => c[0] as string);
const decoded = (c: string) => (c.startsWith('powershell -EncodedCommand ') ? decodePowerShellEncodedCommand(c) : c);
const mainCmd = () => allCmds().map(decoded).find(c => c.includes('--output-format json'))!;

describe('execute_prompt: per-session member MCP config', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    provisionedRemoteAgents.clear();
    resetCliVersionCache();
  });
  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('remote Linux bash member: writes the work-folder config, names it last on the command line, removes it after', async () => {
    const member = makeTestAgent({ friendlyName: 'smcp-lin', os: 'linux', workFolder: '/home/u/repo', fleetMcp: AVAILABLE });
    addAgent(member);
    const read = stubMember();
    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(r)).toContain('ok');

    const cfg = '/home/u/repo/.fleet-session-mcp.json';
    expect(JSON.parse(read())).toEqual({ mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:${BUILTIN_DEFAULT_PORT}/mcp?member=${member.id}`, alwaysLoad: true } } });
    const main = mainCmd();
    expect(main).toContain(`--mcp-config "${cfg}"`);
    expect(main).not.toContain('--strict-mcp-config');
    // written before the dispatch, removed by the final cleanup round trip
    const idxWrite = allCmds().findIndex(c => c.includes(`cat > "${cfg}"`));
    const idxMain = allCmds().findIndex(c => c === main);
    expect(idxWrite).toBeGreaterThanOrEqual(0);
    expect(idxWrite).toBeLessThan(idxMain);
    const last = allCmds()[allCmds().length - 1];
    expect(last.startsWith('rm -f ')).toBe(true);
    expect(last).toContain(` "${cfg}"; cd "/home/u/repo" && rm -f .fleet-task.md`);
  });

  it('remote Windows PowerShell member: backslash path, PowerShell-quoted flag, Remove-Item cleanup', async () => {
    const member = makeTestAgent({ friendlyName: 'smcp-win', os: 'windows', shell: 'pwsh7', workFolder: 'C:\\Users\\bella\\repo', fleetMcp: AVAILABLE });
    addAgent(member);
    const read = stubMember();
    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    const cfg = 'C:\\Users\\bella\\repo\\.fleet-session-mcp.json';
    expect(JSON.parse(read()).mcpServers['apra-fleet']).toEqual({ type: 'http', url: `http://localhost:${BUILTIN_DEFAULT_PORT}/mcp?member=${member.id}`, alwaysLoad: true });
    expect(mainCmd().endsWith(`--model "sonnet" --mcp-config "${cfg}"`)).toBe(true);
    const cleanup = decoded(allCmds()[allCmds().length - 1]);
    expect(cleanup).toContain(`Remove-Item -LiteralPath '${cfg}'`);
  });

  it('remote member with no recorded fleetMcp: no write, no flag (session keeps its own MCP config)', async () => {
    const member = makeTestAgent({ friendlyName: 'smcp-none', os: 'linux', workFolder: '/home/u/repo' });
    addAgent(member);
    stubMember();
    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(allCmds().some(c => c.includes('.fleet-session-mcp.json'))).toBe(false);
    expect(mainCmd()).not.toContain('--mcp-config');
  });

  it('a failed config write falls back: the dispatch still runs, without the flag', async () => {
    const member = makeTestAgent({ friendlyName: 'smcp-fail', os: 'linux', workFolder: '/home/u/repo', fleetMcp: AVAILABLE });
    addAgent(member);
    stubMember({ failSessionWrite: true });
    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(r)).toContain('ok');
    expect(mainCmd()).not.toContain('--mcp-config');
  });

  it('local member: config under the data dir with this server port; no per-folder file in the work folder', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'smcp-local' });
    fs.mkdirSync(member.workFolder, { recursive: true });
    addAgent(member);
    stubMember();
    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    const cfg = path.join(FLEET_DIR, 'session-mcp', `${member.id}.json`);
    expect(JSON.parse(fs.readFileSync(cfg, 'utf-8'))).toEqual({
      mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:${DEFAULT_PORT}/mcp?member=${member.id}`, alwaysLoad: true } },
    });
    expect(mainCmd()).toContain('--mcp-config "');
    expect(mainCmd()).toContain(`${member.id}.json"`);
    // nothing in the clone: no session file there, and no member command writes one
    expect(fs.existsSync(path.join(member.workFolder, '.fleet-session-mcp.json'))).toBe(false);
    expect(allCmds().some(c => /FLEET_PERMS_EOF|WriteAllText|\.claude\.json/.test(decoded(c)))).toBe(false);
    fs.rmSync(member.workFolder, { recursive: true, force: true });
  });

  describe('non-deferral of the member kb/code tools (alwaysLoad)', () => {
    const warnLines = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[fleet:warn]'));

    it('a supported member CLI: alwaysLoad in the config, no always-load WARN, CLI probed once per member', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const member = makeTestAgent({ friendlyName: 'smcp-al-ok', os: 'linux', workFolder: '/home/u/repo', fleetMcp: AVAILABLE });
      addAgent(member);
      const read = stubMember({ cliVersion: '2.1.291 (Claude Code)' });
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
      expect(JSON.parse(read()).mcpServers['apra-fleet'].alwaysLoad).toBe(true);
      expect(warnLines(spy).filter(l => /always-load/.test(l))).toEqual([]);
      await executePrompt({ member_id: member.id, prompt: 'hi again', resume: false, timeout_s: 5 });
      expect(allCmds().filter(c => /claude --version/.test(decoded(c)))).toHaveLength(1);
    });

    it('a member CLI older than the floor: config attached WITHOUT alwaysLoad, WARN names the version', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const member = makeTestAgent({ friendlyName: 'smcp-al-old', os: 'linux', workFolder: '/home/u/repo', fleetMcp: AVAILABLE });
      addAgent(member);
      const read = stubMember({ cliVersion: '2.0.5 (Claude Code)' });
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
      expect(JSON.parse(read()).mcpServers['apra-fleet']).not.toHaveProperty('alwaysLoad');
      expect(mainCmd()).toContain('--mcp-config "/home/u/repo/.fleet-session-mcp.json"');
      const w = warnLines(spy).filter(l => /always-load/.test(l));
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/member CLI 2\.0\.5 is older than 2\.1\.288/);
    });

    it('a member CLI version that cannot be read: config attached WITHOUT alwaysLoad, WARN names the cause', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const member = makeTestAgent({ friendlyName: 'smcp-al-unk', os: 'windows', shell: 'pwsh7', workFolder: 'C:\\Users\\bella\\repo', fleetMcp: AVAILABLE });
      addAgent(member);
      const read = stubMember({ cliVersion: null });
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
      expect(JSON.parse(read()).mcpServers['apra-fleet']).not.toHaveProperty('alwaysLoad');
      const w = warnLines(spy).filter(l => /always-load/.test(l));
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/version could not be determined/);
    });
  });
});
