/**
 * Member-side delivery of ~/.claude.json (ensureWorkspaceTrusted and
 * ClaudeProvider.syncMemberMcpEntry): the landing of the staged merged file is
 * a compare-and-swap, and its final step is always a same-directory rename.
 *
 * - A write by another process (Claude Code) between the fleet's re-read and
 *   its move is detected; the cycle re-reads and keeps both that write and the
 *   fleet delta. Retries are bounded; when exhausted the call fails naming the
 *   file and the file keeps the other writer's content.
 * - A secret-file channel that stages outside the destination directory is
 *   copied next to the destination first, then renamed (POSIX sh, gitbash,
 *   PowerShell).
 * - The PowerShell landing is sent -EncodedCommand-wrapped, and a failure to
 *   delete the copied-from source after a successful swap only warns.
 *
 * POSIX commands run in real bash against a temp sandbox; PowerShell commands
 * run in real powershell.exe when the test host is Windows, and are asserted on
 * their generated text everywhere. HOME/USERPROFILE point at a fresh temp dir,
 * CLAUDE_CONFIG_DIR is unset for every child shell; the real ~/.claude.json is
 * never touched and no Claude CLI runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync, exec as cpExec, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import { escapeForDoubleQuotes } from '../src/utils/shell-escape.js';
import type { MemberSecretFileChannel, WorkspaceTrustTransport } from '../src/providers/provider.js';
import type { SSHExecResult } from '../src/types.js';
import {
  parseLandingMove, unwrapPowerShellEncoded, isWindowsLandingMove, parseFingerprintProbe,
  landingExpectedFingerprint, fakeFingerprint,
} from './helpers/landing-move.js';

let hasBash = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { hasBash = false; }
const isWin = process.platform === 'win32';

type Exec = (cmd: string, timeoutMs?: number) => Promise<SSHExecResult>;

let sandbox: string;
let childEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cas-landing-'));
  const fakeUserHome = path.join(sandbox, 'user-home');
  fs.mkdirSync(fakeUserHome);
  vi.stubEnv('HOME', fakeUserHome);
  vi.stubEnv('USERPROFILE', fakeUserHome);
  childEnv = { ...process.env, HOME: fakeUserHome, USERPROFILE: fakeUserHome };
  delete childEnv.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const bashExec = (): Exec => (cmd) => new Promise((resolve) => {
  execFile('bash', ['-c', cmd], { encoding: 'utf8', env: childEnv }, (err, stdout, stderr) => {
    resolve({ stdout, stderr, code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 });
  });
});

/** Same shape as LocalStrategy on a Windows host: the string runs as a powershell.exe command. */
const powershellExec = (): Exec => (cmd) => new Promise((resolve) => {
  cpExec(cmd, { shell: 'powershell.exe', encoding: 'utf8', env: childEnv, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ stdout, stderr, code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 });
  });
});

const fwd = (p: string) => p.replace(/\\/g, '/');

/** A member home with an existing ~/.claude.json, plus the work folder. */
function setupMember(): { home: string; work: string; file: string } {
  const home = path.join(sandbox, 'member-home');
  const work = path.join(sandbox, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: {}, userSetting: 'keep-me' }, null, 2));
  return { home, work, file };
}

/** A concurrent writer (standing in for Claude Code) that adds one top-level key. */
function concurrentWrite(file: string, key: string): void {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  cur[key] = 'written-by-another-process';
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
}

/** Wraps `exec` so the concurrent writer runs right before the first `times` landing commands. */
function racing(exec: Exec, file: string, times: number): { exec: Exec; landings: string[] } {
  const landings: string[] = [];
  return {
    landings,
    exec: async (cmd, t) => {
      if (parseLandingMove(cmd)) {
        landings.push(cmd);
        if (landings.length <= times) concurrentWrite(file, `concurrent${landings.length}`);
      }
      return exec(cmd, t);
    },
  };
}

const fileTransport = (home: string): WorkspaceTrustTransport => ({
  writeHomeFile: async (rel, content) => { fs.writeFileSync(path.join(home, rel), content); },
});

/** Secret-file channel staging OUTSIDE the destination directory (another dir, possibly another volume). */
function outsideSecretChannel(): MemberSecretFileChannel & { staged: string[] } {
  const stageDir = path.join(sandbox, 'secret-stage');
  fs.mkdirSync(stageDir, { recursive: true });
  const staged: string[] = [];
  return {
    staged,
    write: async (content: string) => {
      const p = path.join(stageDir, `apra-fleet-claude-config-${staged.length}`);
      fs.writeFileSync(p, content, { mode: 0o600 });
      staged.push(p);
      return p;
    },
    remove: async (p: string) => { fs.rmSync(p, { force: true }); },
  };
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter(n => n !== '.claude.json');

describe('CAS: a concurrent write between re-read and move is kept together with the fleet delta', () => {
  it.runIf(hasBash)('POSIX (linux member, real bash): ensureWorkspaceTrusted re-reads and keeps both', async () => {
    const m = setupMember();
    const r = racing(bashExec(), m.file, 1);
    const res = await new ClaudeProvider().ensureWorkspaceTrusted(fwd(m.work), r.exec, 'linux', undefined, fileTransport(m.home), fwd(m.home));

    expect(res.seeded).toBe(true);
    const final = JSON.parse(fs.readFileSync(m.file, 'utf8'));
    expect(final.concurrent1).toBe('written-by-another-process');
    expect(final.userSetting).toBe('keep-me');
    expect(final.projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
    // The first landing was refused, the second landed.
    expect(r.landings).toHaveLength(2);
    expect(landingExpectedFingerprint(r.landings[0])).toMatch(/^\d+ \d+$/);
    expect(leftovers(m.home)).toEqual([]);
  });

  it.runIf(hasBash)('POSIX (linux member, real bash): syncMemberMcpEntry re-reads and keeps both', async () => {
    const m = setupMember();
    const r = racing(bashExec(), m.file, 1);
    const url = 'http://127.0.0.1:1/mcp?member=m1';
    await new ClaudeProvider().syncMemberMcpEntry({
      agent: { id: 'm1', workFolder: fwd(m.work) } as any,
      execCommand: r.exec,
      memberHomeDir: fwd(m.home),
      agentOs: 'linux',
      url,
      transport: fileTransport(m.home),
    });

    const final = JSON.parse(fs.readFileSync(m.file, 'utf8'));
    expect(final.concurrent1).toBe('written-by-another-process');
    expect(final.userSetting).toBe('keep-me');
    expect(final.projects[fwd(m.work)].mcpServers['apra-fleet']).toEqual({ type: 'http', url });
    expect(r.landings).toHaveLength(2);
    expect(leftovers(m.home)).toEqual([]);
  });

  it.runIf(hasBash)('gitbash Windows member (POSIX command forms, real bash): keeps both', async () => {
    const m = setupMember();
    const r = racing(bashExec(), m.file, 1);
    const res = await new ClaudeProvider().ensureWorkspaceTrusted(fwd(m.work), r.exec, 'windows', 'gitbash', fileTransport(m.home), fwd(m.home));

    expect(res.seeded).toBe(true);
    expect(r.landings.every(c => !c.startsWith('powershell'))).toBe(true);
    const final = JSON.parse(fs.readFileSync(m.file, 'utf8'));
    expect(final.concurrent1).toBe('written-by-another-process');
    expect(final.projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
    expect(r.landings).toHaveLength(2);
    expect(leftovers(m.home)).toEqual([]);
  });

  it.runIf(isWin)('PowerShell Windows member (real powershell.exe): keeps both', async () => {
    const m = setupMember();
    const r = racing(powershellExec(), m.file, 1);
    const res = await new ClaudeProvider().ensureWorkspaceTrusted(m.work, r.exec, 'windows', undefined, fileTransport(m.home), m.home);

    expect(res.seeded).toBe(true);
    const final = JSON.parse(fs.readFileSync(m.file, 'utf8'));
    expect(final.concurrent1).toBe('written-by-another-process');
    expect(final.userSetting).toBe('keep-me');
    expect(final.projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
    expect(r.landings).toHaveLength(2);
    expect(landingExpectedFingerprint(r.landings[0])).toMatch(/^[0-9A-F]{64}$/);
    expect(leftovers(m.home)).toEqual([]);
  }, 60_000);

  it('PowerShell Windows member (fake member, any host): the landing carries the fingerprint probed before the re-read', async () => {
    const files = new Map<string, string>([['C:\\Users\\member\\.claude.json', '{"projects":{}}']]);
    const calls: string[] = [];
    let landings = 0;
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      const probed = parseFingerprintProbe(cmd);
      if (probed !== null) return { stdout: fakeFingerprint(files.get(probed)), stderr: '', code: 0 };
      if (cmd.startsWith('Get-Content -Raw "C:\\Users\\member\\.claude.json"')) {
        return { stdout: `${files.get('C:\\Users\\member\\.claude.json') ?? ''}\n---FLEET_MCP_SPLIT---\n`, stderr: '', code: 0 };
      }
      const land = parseLandingMove(cmd);
      if (land) {
        landings++;
        // Another writer lands right before the first move.
        if (landings === 1) files.set(land.to, '{"projects":{},"concurrent":true}');
        if (landingExpectedFingerprint(cmd) !== fakeFingerprint(files.get(land.to))) {
          files.delete(land.from);
          return { stdout: 'FLEET_MEMBER_CONFIG_CHANGED', stderr: '', code: 1 };
        }
        files.set(land.to, files.get(land.from)!);
        files.delete(land.from);
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error(`unexpected command: ${cmd.slice(0, 100)}`);
    };
    const transport: WorkspaceTrustTransport = { writeHomeFile: async (rel, c) => { files.set(`C:\\Users\\member\\${rel}`, c); } };
    await new ClaudeProvider().ensureWorkspaceTrusted('C:/work/p', exec, 'windows', 'powershell5', transport, 'C:\\Users\\member');

    const final = JSON.parse(files.get('C:\\Users\\member\\.claude.json')!);
    expect(final.concurrent).toBe(true);
    expect(final.projects['C:/work/p'].hasTrustDialogAccepted).toBe(true);
    expect(landings).toBe(2);
    expect([...files.keys()]).toEqual(['C:\\Users\\member\\.claude.json']);
  });
});

describe('CAS retries exhausted: loud failure naming the file, target left as the other writer left it', () => {
  it.runIf(hasBash)('POSIX (real bash): ensureWorkspaceTrusted', async () => {
    const m = setupMember();
    const r = racing(bashExec(), m.file, 99);
    let lastSeen = '';
    const exec: Exec = async (cmd, t) => {
      const out = await r.exec(cmd, t);
      if (parseLandingMove(cmd)) lastSeen = fs.readFileSync(m.file, 'utf8');
      return out;
    };
    await expect(new ClaudeProvider().ensureWorkspaceTrusted(fwd(m.work), exec, 'linux', undefined, fileTransport(m.home), fwd(m.home)))
      .rejects.toThrow(/E-MEMBER-CONFIG-CHANGED: .*member-home\/\.claude\.json was changed by another writer .* on 3 attempts in a row/);
    expect(r.landings).toHaveLength(3);
    const final = fs.readFileSync(m.file, 'utf8');
    expect(final).toBe(lastSeen);
    expect(JSON.parse(final).projects).toEqual({});
    expect(JSON.parse(final).concurrent3).toBe('written-by-another-process');
    expect(leftovers(m.home)).toEqual([]);
  });

  it.runIf(hasBash)('POSIX (real bash): syncMemberMcpEntry, secret-file channel staged outside the directory', async () => {
    const m = setupMember();
    const r = racing(bashExec(), m.file, 99);
    const secret = outsideSecretChannel();
    await expect(new ClaudeProvider().syncMemberMcpEntry({
      agent: { id: 'm1', workFolder: fwd(m.work) } as any,
      execCommand: r.exec,
      memberHomeDir: fwd(m.home),
      agentOs: 'linux',
      url: 'http://127.0.0.1:1/mcp?member=m1',
      secretChannel: secret,
    })).rejects.toThrow(/E-MEMBER-CONFIG-CHANGED: .*\.claude\.json/);
    expect(r.landings).toHaveLength(3);
    expect(JSON.parse(fs.readFileSync(m.file, 'utf8')).projects).toEqual({});
    expect(leftovers(m.home)).toEqual([]);
    expect(fs.readdirSync(path.dirname(secret.staged[0]))).toEqual([]);
  });
});

describe('secret channel staged in another directory: the final step is a same-directory rename', () => {
  it.runIf(hasBash)('POSIX and gitbash: copy next to the destination, conditional mv, staged source removed (real bash)', async () => {
    for (const [agentOs, shell] of [['linux', undefined], ['windows', 'gitbash']] as const) {
      const m = setupMember();
      const secret = outsideSecretChannel();
      const calls: string[] = [];
      const exec: Exec = async (cmd, t) => { calls.push(cmd); return bashExec()(cmd, t); };
      const res = await new ClaudeProvider().ensureWorkspaceTrusted(fwd(m.work), exec, agentOs, shell, undefined, fwd(m.home), secret);
      expect(res.seeded).toBe(true);

      const landing = calls.find(c => parseLandingMove(c))!;
      // The staged path is embedded as the channel returned it, escaped for "...".
      const staged = escapeForDoubleQuotes(secret.staged[0], false);
      const destFile = `${fwd(m.home)}/.claude.json`;
      const cp = landing.match(/^cp "([^"]+)" "([^"]+)" \|\|/)!;
      expect(cp[1]).toBe(staged);
      // The copy lands in the destination directory...
      expect(cp[2]).toMatch(new RegExp(`^${destFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.fleet-land-[0-9a-f]{16}\\.tmp$`));
      // ...and the final step renames that copy within the directory.
      expect(landing).toContain(`mv "${cp[2]}" "${destFile}"`);

      expect(JSON.parse(fs.readFileSync(m.file, 'utf8')).projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
      expect(fs.existsSync(secret.staged[0])).toBe(false);
      expect(leftovers(m.home)).toEqual([]);
      fs.rmSync(m.home, { recursive: true, force: true });
      fs.rmSync(m.work, { recursive: true, force: true });
      fs.rmSync(path.dirname(secret.staged[0]), { recursive: true, force: true });
    }
  });

  it('PowerShell (command text, any host): copies next to the destination, then swaps there', async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      if (parseFingerprintProbe(cmd) !== null) return { stdout: 'FLEET_ABSENT', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const secret = { write: async () => 'D:\\fleet-stage\\apra-fleet-claude-config-1', remove: async () => undefined };
    await new ClaudeProvider().ensureWorkspaceTrusted('C:/work/p', exec, 'windows', undefined, undefined, 'C:\\Users\\member', secret);

    const landing = calls.find(c => parseLandingMove(c))!;
    expect(landing).toMatch(/^powershell -EncodedCommand \S+$/);
    const script = unwrapPowerShellEncoded(landing);
    expect(parseLandingMove(landing)).toEqual({ from: 'D:\\fleet-stage\\apra-fleet-claude-config-1', to: 'C:\\Users\\member\\.claude.json' });
    expect(script).toContain("[System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($s)) -ne [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($d))) { $t = $d + '.fleet-land-'");
    expect(script).toContain('[System.IO.File]::Copy($s, $t, $false); $src = $t');
    expect(script).toContain('[System.IO.File]::Replace($src, $d, [NullString]::Value)');
  });

  it.runIf(isWin)('PowerShell (real powershell.exe): lands via a copy in the destination directory, staged source removed', async () => {
    const m = setupMember();
    const secret = outsideSecretChannel();
    const res = await new ClaudeProvider().ensureWorkspaceTrusted(m.work, powershellExec(), 'windows', undefined, undefined, m.home, secret);
    expect(res.seeded).toBe(true);
    expect(JSON.parse(fs.readFileSync(m.file, 'utf8')).projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
    expect(fs.existsSync(secret.staged[0])).toBe(false);
    expect(leftovers(m.home)).toEqual([]);
  }, 60_000);
});

describe('PowerShell landing is sent -EncodedCommand-wrapped', () => {
  it('ensureWorkspaceTrusted and syncMemberMcpEntry on a PowerShell member', async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      if (parseFingerprintProbe(cmd) !== null) return { stdout: 'FLEET_ABSENT', stderr: '', code: 0 };
      if (cmd.startsWith('git -C ')) return { stdout: '', stderr: 'fatal: not a git repository', code: 128 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const transport: WorkspaceTrustTransport = { writeHomeFile: async () => undefined };
    await new ClaudeProvider().ensureWorkspaceTrusted('C:/work/p', exec, 'windows', 'pwsh7', transport, 'C:\\Users\\member');
    await new ClaudeProvider().syncMemberMcpEntry({
      agent: { id: 'm1', workFolder: 'C:\\work\\p' } as any,
      execCommand: exec,
      memberHomeDir: 'C:\\Users\\member',
      agentOs: 'windows',
      shell: 'pwsh7',
      url: 'http://127.0.0.1:1/mcp?member=m1',
      transport,
    });
    const landings = calls.filter(c => parseLandingMove(c));
    expect(landings).toHaveLength(2);
    for (const c of landings) {
      expect(c).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
      expect(isWindowsLandingMove(c)).toBe(true);
      expect(landingExpectedFingerprint(c)).toBe('FLEET_ABSENT');
    }
  });
});

describe('a failed delete of the copied-from source after a successful swap only warns', () => {
  it.runIf(hasBash && !isWin && typeof process.getuid === 'function' && process.getuid() !== 0)('POSIX (real bash): exit 0, target updated, warning on stderr', async () => {
    const m = setupMember();
    const stageDir = path.join(sandbox, 'locked-stage');
    fs.mkdirSync(stageDir);
    const stagedPath = path.join(stageDir, 'staged');
    const calls: Array<{ cmd: string; r: SSHExecResult }> = [];
    const exec: Exec = async (cmd, t) => { const r = await bashExec()(cmd, t); calls.push({ cmd, r }); return r; };
    const secret: MemberSecretFileChannel = {
      write: async (content) => { fs.writeFileSync(stagedPath, content); fs.chmodSync(stageDir, 0o555); return stagedPath; },
      remove: async () => undefined,
    };
    try {
      const res = await new ClaudeProvider().ensureWorkspaceTrusted(m.work, exec, 'linux', undefined, undefined, m.home, secret);
      expect(res.seeded).toBe(true);
      const landing = calls.find(c => parseLandingMove(c.cmd))!;
      expect(landing.r.code).toBe(0);
      expect(landing.r.stderr).toContain('warning: could not remove staged');
      expect(JSON.parse(fs.readFileSync(m.file, 'utf8')).projects[m.work].hasTrustDialogAccepted).toBe(true);
    } finally {
      fs.chmodSync(stageDir, 0o755);
    }
  });

  it.runIf(isWin)('PowerShell (real powershell.exe): exit 0, target updated, warning on stderr', async () => {
    const m = setupMember();
    const stageDir = path.join(sandbox, 'held-stage');
    fs.mkdirSync(stageDir);
    const stagedPath = path.join(stageDir, 'staged');
    // Another process holds the staged file open without delete sharing, so
    // the post-swap Delete fails (the copy, which only reads, succeeds).
    let holder: ReturnType<typeof spawn> | undefined;
    const calls: Array<{ cmd: string; r: SSHExecResult }> = [];
    const exec: Exec = async (cmd, t) => { const r = await powershellExec()(cmd, t); calls.push({ cmd, r }); return r; };
    const secret: MemberSecretFileChannel = {
      write: async (content) => {
        fs.writeFileSync(stagedPath, content);
        const p = stagedPath.replace(/'/g, "''");
        holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$f = [System.IO.File]::Open('${p}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('HELD'); Start-Sleep -Seconds 60`], { windowsHide: true });
        await new Promise<void>((resolve, reject) => {
          holder!.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('HELD')) resolve(); });
          holder!.on('exit', () => reject(new Error('holder exited early')));
        });
        return stagedPath;
      },
      remove: async () => undefined,
    };
    try {
      const res = await new ClaudeProvider().ensureWorkspaceTrusted(m.work, exec, 'windows', undefined, undefined, m.home, secret);
      expect(res.seeded).toBe(true);
      const landing = calls.find(c => parseLandingMove(c.cmd))!;
      expect(landing.r.code).toBe(0);
      expect(landing.r.stderr).toContain('warning: could not remove staged');
      expect(JSON.parse(fs.readFileSync(m.file, 'utf8')).projects[fwd(m.work)].hasTrustDialogAccepted).toBe(true);
      expect(leftovers(m.home)).toEqual([]);
    } finally {
      holder?.kill();
      if (holder && holder.exitCode === null && holder.signalCode === null) await new Promise(r => holder!.once('exit', r));
    }
  }, 60_000);
});
