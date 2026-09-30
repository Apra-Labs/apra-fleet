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
import { checkProjectAgentShadows } from '../src/services/agent-shadow.js';

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
});
