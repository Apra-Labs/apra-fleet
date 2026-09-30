/**
 * Real execution of the shadow probe + quarantine on the HOST OS (PowerShell
 * on Windows, sh elsewhere) through the real local strategy, against a temp
 * git repo. Proves the generated member commands actually work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestLocalAgent } from './test-helpers.js';
import {
  checkProjectAgentShadows,
  buildQuarantineCommand,
  buildShadowProbeCommand,
  parseQuarantineOutput,
  parseShadowProbeOutput,
} from '../src/services/agent-shadow.js';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}

describe.skipIf(!hasGit())('agent-shadow real exec on host OS', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-shadow it's-"));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'ignore' });
    git('init', '-q');
    const agents = path.join(repo, '.claude', 'agents');
    fs.mkdirSync(path.join(agents, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'doer.md'), '---\nname: doer\n---\nstale July prompt\n');       // untracked, basename
    fs.writeFileSync(path.join(agents, 'sub', 'old.md'), '---\nname: planner\n---\nstale\n');           // untracked, name, nested
    fs.writeFileSync(path.join(agents, 'reviewer.md'), '---\nname: reviewer\n---\ntracked\n');          // tracked
    fs.writeFileSync(path.join(agents, 'custom.md'), '---\nname: my-custom\n---\nkeep\n');              // non-colliding
    git('add', '.claude/agents/reviewer.md');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('quarantines untracked shadows, reports tracked, leaves non-colliding files', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'real-exec', workFolder: repo });
    const r = await checkProjectAgentShadows(agent, new Date('2026-09-30T10:00:00.000Z'));

    expect(r.status).toBe('shadowed');
    expect(r.quarantined.sort()).toEqual(['doer.md', 'sub/old.md']);
    expect(r.tracked).toEqual(['reviewer.md']);
    expect(r.persistentWarning).toContain('reviewer.md');

    const agents = path.join(repo, '.claude', 'agents');
    const qdir = path.join(repo, '.claude', 'agents-shadowed-by-fleet', '2026-09-30T10-00-00-000Z');
    expect(fs.existsSync(path.join(agents, 'doer.md'))).toBe(false);
    expect(fs.existsSync(path.join(agents, 'sub', 'old.md'))).toBe(false);
    expect(fs.readFileSync(path.join(qdir, 'doer.md'), 'utf-8')).toContain('stale July prompt');
    expect(fs.existsSync(path.join(qdir, 'sub', 'old.md'))).toBe(true);
    expect(fs.existsSync(path.join(agents, 'reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(agents, 'custom.md'))).toBe(true);
    // Quarantined files are git-ignored so they cannot be swept into a commit.
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { windowsHide: true, encoding: 'utf-8' });
    expect(status).not.toContain('agents-shadowed-by-fleet');
  }, 60_000);

  it('skips a work folder whose agents dir is a symlink/junction (nothing moved)', async () => {
    const wf = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-link-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-target-'));
    try {
      fs.writeFileSync(path.join(target, 'doer.md'), '---\nname: doer\n---\nmanaged\n');
      fs.mkdirSync(path.join(wf, '.claude'));
      fs.symlinkSync(target, path.join(wf, '.claude', 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = await checkProjectAgentShadows(makeTestLocalAgent({ friendlyName: 'real-link', workFolder: wf }));
      expect(r.status).toBe('skipped');
      expect(r.warning).toContain('symlink/junction');
      expect(fs.existsSync(path.join(target, 'doer.md'))).toBe(true);
      expect(fs.existsSync(path.join(wf, '.claude', 'agents-shadowed-by-fleet'))).toBe(false);
    } finally {
      fs.rmSync(wf, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Run a built member command directly on the host shell, with an optional PATH prefix. */
function runOnHost(cmd: string, pathPrefix?: string): string {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (pathPrefix) env[pathKey] = `${pathPrefix}${path.delimiter}${env[pathKey] ?? ''}`;
  if (process.platform === 'win32') {
    const enc = cmd.replace(/^powershell -EncodedCommand /, '');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { env, encoding: 'utf-8', windowsHide: true });
  }
  return execFileSync('sh', ['-c', cmd], { env, encoding: 'utf-8', windowsHide: true });
}

describe.skipIf(!hasGit())('agent-shadow generated commands, real host shell', () => {
  const posix = process.platform !== 'win32';
  const winNative = !posix;
  const j = (...p: string[]) => (winNative ? path.win32.join(...p) : path.posix.join(...p.map(s => s.replace(/\\/g, '/'))));

  it('quarantine reports a vanished source as FLEETMOVEFAIL, not MOVED', () => {
    const wf = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-q-'));
    try {
      const agents = j(wf, '.claude', 'agents');
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(path.join(agents, 'doer.md'), 'x');
      const qroot = j(wf, '.claude', 'agents-shadowed-by-fleet');
      const out = runOnHost(buildQuarantineCommand(posix, winNative, agents, qroot, j(qroot, 'T'), ['doer.md', 'gone.md']));
      const parsed = parseQuarantineOutput(out);
      expect(parsed.moved).toEqual(['doer.md']);
      expect(parsed.failed).toEqual(['gone.md']);
    } finally {
      fs.rmSync(wf, { recursive: true, force: true });
    }
  }, 60_000);

  it('git refusing (dubious ownership) in a repo subdir yields unknown, never norepo', () => {
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-dubious-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-fakegit-'));
    try {
      execFileSync('git', ['-C', repo2, 'init', '-q'], { windowsHide: true, stdio: 'ignore' });
      const sub = j(repo2, 'pkg');
      fs.mkdirSync(j(sub, '.claude', 'agents'), { recursive: true });
      if (winNative) {
        fs.writeFileSync(path.join(fakeBin, 'git.cmd'), '@echo fatal: detected dubious ownership in repository 1>&2\r\n@exit /b 128\r\n');
      } else {
        fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n', { mode: 0o755 });
      }
      const out = runOnHost(buildShadowProbeCommand(posix, j(sub, '.claude', 'agents'), sub), fakeBin);
      expect(parseShadowProbeOutput(out)!.gitState).toBe('unknown');

      // Control: a real not-a-repo dir with the real git is norepo.
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-plain-'));
      try {
        const out2 = runOnHost(buildShadowProbeCommand(posix, j(plain, '.claude', 'agents'), plain));
        expect(parseShadowProbeOutput(out2)!.gitState).toBe('norepo');
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  }, 60_000);
});
