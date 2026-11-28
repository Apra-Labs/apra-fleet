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
const RETRY = path.join(ROOT, '.github', 'workflows', 'regression-macos-retry.yml');
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

  it('is ordered after the installer build but runs under always() and not cancelled(), so a failed macOS leg cannot skip it', () => {
    const job = entry![1] as Job & { needs?: unknown; if?: string };
    expect(job.needs).toBe('build-installer');
    expect(job.if).toMatch(/\balways\(\)/);
    expect(job.if).toMatch(/!\s*cancelled\(\)/);
  });

  it('downloads only the Windows installer artifact and fails loudly when it is missing', () => {
    const steps = entry![1].steps ?? [];
    const downloads = steps.filter(s => /download-artifact/.test(s.uses ?? ''));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].with?.name).toBe('regression-apra-fleet-installer-win-x64.exe');
    expect(downloads[0].with?.pattern).toBeUndefined();
    const check = steps.find(s => /apra-fleet-installer-win-x64\.exe/.test(s.run ?? '') && /exit 1/.test(s.run ?? ''));
    expect(check, 'no step fails when the Windows artifact is missing').toBeTruthy();
    expect(check!.run).toMatch(/::error::[^\n]*missing/);
    expect(steps.indexOf(check!)).toBeGreaterThan(steps.indexOf(downloads[0]));
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

describe('regression.yml: triggers', () => {
  const on = (wf as unknown as { on: Record<string, unknown> }).on;
  it('is nightly + manual only: schedule and workflow_dispatch, no push or pull_request trigger', () => {
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(on).not.toHaveProperty('push');
    expect(on).not.toHaveProperty('pull_request');
    expect(on).not.toHaveProperty('pull_request_target');
  });
});

describe('regression-macos-retry.yml', () => {
  const rawRetry = fs.readFileSync(RETRY, 'utf8');
  const rwf = parse(rawRetry) as {
    name: string;
    on: { workflow_run?: { workflows?: string[]; types?: string[] } } & Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job & { if?: string; env?: Record<string, string> }>;
  };
  const jobs = Object.values(rwf.jobs);
  const text = jobs.flatMap(j => (j.steps ?? []).map(s => `${s.run ?? ''} ${s.uses ?? ''}`)).join('\n');

  it('triggers only on the completion of the regression workflow', () => {
    expect(Object.keys(rwf.on)).toEqual(['workflow_run']);
    expect(rwf.on.workflow_run!.workflows).toEqual([wf0Name()]);
    expect(rwf.on.workflow_run!.types).toEqual(['completed']);
  });

  it('only acts on a first attempt that failed or was cancelled', () => {
    for (const j of jobs) {
      expect(j.if).toMatch(/workflow_run\.run_attempt\s*==\s*1\b/);
      expect(j.if).toMatch(/conclusion == 'failure'/);
      expect(j.if).toMatch(/conclusion == 'cancelled'/);
    }
  });

  it('reruns the failed jobs once, and only when every failed job ran on macOS', () => {
    expect(text.match(/gh run rerun/g)).toHaveLength(1);
    expect(text).toMatch(/gh run rerun "\$RUN_ID" --failed/);
    expect(text).toMatch(/startswith\("macos"\)/);
    expect(text).toMatch(/non_mac"? -ne 0/);
  });

  it('grants actions: write and nothing broader, at workflow level and on every job', () => {
    expect(rwf.permissions).toEqual({ actions: 'write' });
    for (const j of jobs) expect((j as { permissions?: unknown }).permissions ?? { actions: 'write' }).toEqual({ actions: 'write' });
  });

  it('never checks out or runs code from the triggering run (fork-safe)', () => {
    expect(text).not.toMatch(/actions\/checkout/);
    expect(text).not.toMatch(/actions\/download-artifact/);
    expect(rawRetry).not.toMatch(/head_sha|head_branch|pull_requests|\bnpm\b|\bnode\b/);
  });

  it('has a timeout-minutes cap', () => {
    for (const j of jobs) expect(typeof j['timeout-minutes']).toBe('number');
  });
});

function wf0Name(): string {
  return (parse(raw) as { name: string }).name;
}

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
      // RFS: replace-full's refusal reason (update_member); RBS: the release install guard's code.
      expect(x.refusalCode, x.id).toBe(x.id === 'RFS' ? 'fleet-se-running' : x.id === 'RBS' ? 'E-FLEET-SE-RUNNING' : null);
      if (refusing) expect(x.expected).toMatch(/no destructive change/);
    }
  });

  it('a real run refuses without the disposable opt-in (no VM changes in a local run)', () => {
    const r = spawnSync(process.execPath, [DRIVER, '--binary', DRIVER], { encoding: 'utf8', env: { ...process.env, CI: '' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^REFUSED:/);
  });
});
