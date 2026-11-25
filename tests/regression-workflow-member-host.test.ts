/**
 * Structural guard for the nightly regression workflow (it only runs in CI, so
 * this is what a developer can run locally): the member-host upgrade job exists
 * and runs every pass, every macOS-capable job has an explicit timeout, the
 * workflow stays read-only and secret-free, the harness files it references
 * exist, and the driver's --plan lists exactly the passes with their expected
 * outcomes. No network; writes nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'regression.yml');
const DRIVER = path.join(ROOT, 'tests', 'integration', 'member-host', 'run.mjs');
const PASSES = ['Q', 'RF', 'RB', 'RFS', 'RBS'];

type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> };
type Job = { 'runs-on'?: unknown; 'timeout-minutes'?: unknown; strategy?: { matrix?: Record<string, unknown> }; steps?: Step[] };

const raw = fs.readFileSync(WORKFLOW, 'utf8');
const wf = parse(raw) as { permissions?: Record<string, string>; jobs: Record<string, Job> };

/** Every value the job's runs-on can resolve to, expanding ${{ matrix.* }}. */
function runnerLabels(job: Job): string[] {
  const ro = String(job['runs-on'] ?? '');
  const m = /\$\{\{\s*matrix\.(\w+)\s*\}\}/.exec(ro);
  if (!m) return [ro];
  const matrix = job.strategy?.matrix ?? {};
  const out: string[] = [];
  const values = matrix[m[1]];
  if (Array.isArray(values)) out.push(...values.map(String));
  const include = matrix.include;
  if (Array.isArray(include)) for (const i of include as Array<Record<string, unknown>>) if (i[m[1]] !== undefined) out.push(String(i[m[1]]));
  return out;
}

const stepText = (job: Job) => (job.steps ?? []).map(s => `${s.run ?? ''}\n${s.name ?? ''}`).join('\n');

describe('regression.yml: member-host upgrade job', () => {
  const entry = Object.entries(wf.jobs).find(([, j]) => runnerLabels(j).includes('windows-2022') && /member-host\/run\.mjs/.test(stepText(j)));

  it('has a windows-2022 job that runs the setup script and the member-host driver', () => {
    expect(entry, 'no windows-2022 job runs tests/integration/member-host/run.mjs').toBeTruthy();
    const job = entry![1];
    expect(stepText(job)).toMatch(/member-host\/setup-openssh-gitbash\.ps1/);
    expect(stepText(job)).toMatch(/-IAmDisposable/);
    expect(stepText(job)).toMatch(/--i-am-disposable/);
    expect(job.timeout_minutes ?? job['timeout-minutes']).toBeTypeOf('number');
  });

  it('runs every pass: quote-led, RF, RB, RFS and RBS', () => {
    const run = (entry![1].steps ?? []).map(s => s.run ?? '').find(r => /member-host\/run\.mjs/.test(r))!;
    const passes = /--passes\s+([A-Z,]+)/.exec(run)?.[1].split(',');
    expect(passes).toEqual(PASSES);
  });

  it('writes the report to the step summary and uploads it with if: always()', () => {
    const steps = entry![1].steps ?? [];
    const summary = steps.find(s => /GITHUB_STEP_SUMMARY/.test(s.run ?? ''));
    expect(summary?.if).toBe('always()');
    const upload = steps.find(s => /upload-artifact/.test(s.uses ?? ''));
    expect(upload?.if).toBe('always()');
  });

  it('needs the installer build and downloads the candidate artifact', () => {
    const job = entry![1] as Job & { needs?: unknown };
    expect(job.needs).toBe('build-installer');
    expect((job.steps ?? []).some(s => /download-artifact/.test(s.uses ?? ''))).toBe(true);
  });

  it('references harness files that exist on disk', () => {
    const refs = new Set(raw.match(/tests\/integration\/member-host\/[\w./-]+/g) ?? []);
    expect(refs.size).toBeGreaterThan(0);
    for (const r of refs) expect(fs.existsSync(path.join(ROOT, r)), r).toBe(true);
  });
});

describe('regression.yml: macOS runner cap and safety', () => {
  it('every job whose runs-on can resolve to a macOS runner has an explicit timeout-minutes', () => {
    const macJobs = Object.entries(wf.jobs).filter(([, j]) => runnerLabels(j).some(l => /macos/i.test(l)));
    expect(macJobs.length).toBeGreaterThan(0);
    for (const [name, j] of macJobs) {
      expect(typeof j['timeout-minutes'], `${name} has no timeout-minutes`).toBe('number');
      expect(j['timeout-minutes'] as number, name).toBeGreaterThan(0);
      expect(j['timeout-minutes'] as number, name).toBeLessThanOrEqual(90);
    }
  });

  it('a capped macOS job cannot cancel the other OS jobs: fail-fast stays false on every matrix', () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (j.strategy) expect((j.strategy as { 'fail-fast'?: boolean })['fail-fast'], name).toBe(false);
    }
  });

  it('keeps permissions contents: read and references no secrets', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(raw).not.toMatch(/\$\{\{\s*secrets\./);
    expect(raw).not.toMatch(/\bGITHUB_TOKEN\b/);
  });
});

describe('member-host driver --plan', () => {
  const plan = () => {
    const r = spawnSync(process.execPath, [DRIVER, '--plan'], { encoding: 'utf8', env: { ...process.env, CI: '' } });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).passes as Array<{ id: string; expected: string; refusalWithoutDestructiveChange: boolean; refusalCode: string | null }>;
  };

  it('lists exactly the passes the workflow runs, with their expected outcomes', () => {
    const p = plan();
    expect(p.map(x => x.id)).toEqual(PASSES);
    for (const x of p) expect(x.expected.length, x.id).toBeGreaterThan(10);
  });

  it('RFS and RBS expect a refusal without destructive change; the others do not', () => {
    for (const x of plan()) {
      const refusing = x.id === 'RFS' || x.id === 'RBS';
      expect(x.refusalWithoutDestructiveChange, x.id).toBe(refusing);
      expect(x.refusalCode, x.id).toBe(refusing ? 'E-FLEET-SE-RUNNING' : null);
      if (refusing) expect(x.expected).toMatch(/no destructive change/);
    }
  });

  it('a real run refuses without the disposable opt-in (no VM changes in a local run)', () => {
    const r = spawnSync(process.execPath, [DRIVER, '--binary', DRIVER], { encoding: 'utf8', env: { ...process.env, CI: '' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^REFUSED:/);
  });
});
