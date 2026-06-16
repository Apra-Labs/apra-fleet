import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Inline evaluateGates logic from .github/e2e/validate-sprint.mjs so we can
// unit-test it without spawning a subprocess.

const SCAFFOLD = ['requirements.md', 'plan.md', 'feedback.md', 'progress.json'];
const baseName = (p: string) => p.split('/').pop()!.toLowerCase();

interface GateData {
  pr?: { url: string; number: number } | null;
  commitCount?: number;
  finalFiles?: string[];
  touchedBasenames?: string[];
  closedP1?: string[];
  minCommits?: number;
  expectedIssues?: number;
}

function evaluateGates(d: GateData) {
  const gates: Array<{ name: string; pass: boolean; detail: string }> = [];
  const add = (name: string, pass: boolean, detail = '') => gates.push({ name, pass, detail });

  add('pr-exists', !!(d.pr && d.pr.url), d.pr ? `#${d.pr.number}` : 'no PR found');

  const minCommits = d.minCommits ?? 10;
  add(`commits>=${minCommits}`, (d.commitCount || 0) >= minCommits, `${d.commitCount || 0} commits`);

  const finalBases = (d.finalFiles || []).map(baseName);
  const leaked = SCAFFOLD.filter((f) => finalBases.includes(f));
  add('final-changeset-clean', leaked.length === 0,
    leaked.length ? `process files still in net diff: ${leaked.join(', ')}` : 'no process files in net diff');

  const touched = new Set((d.touchedBasenames || []).map((s) => s.toLowerCase()));
  const missing = SCAFFOLD.filter((f) => !touched.has(f));
  add('process-discipline', missing.length === 0,
    missing.length ? `never committed (no discipline proof): ${missing.join(', ')}` : 'all process files appeared in intermediate commits');

  const expected = d.expectedIssues ?? 3;
  const closed = d.closedP1 || [];
  add('beads-closed', closed.length >= expected,
    `${closed.length} of the picked P1 issue(s) closed${closed.length ? ': ' + closed.join(', ') : ''}`);

  return { gates, pass: gates.every((g) => g.pass) };
}

describe('evaluateGates', () => {
  const passing: GateData = {
    pr: { url: 'https://github.com/test/repo/pull/42', number: 42 },
    commitCount: 12,
    finalFiles: ['src/index.ts', 'src/utils.ts'],
    touchedBasenames: ['requirements.md', 'plan.md', 'feedback.md', 'progress.json', 'index.ts'],
    closedP1: ['beads-001', 'beads-002', 'beads-003'],
    minCommits: 4,
    expectedIssues: 3,
  };

  it('all-pass fixture', () => {
    const r = evaluateGates(passing);
    expect(r.pass).toBe(true);
    expect(r.gates.every((g) => g.pass)).toBe(true);
  });

  it('fails pr-exists when no PR', () => {
    const r = evaluateGates({ ...passing, pr: null });
    expect(r.pass).toBe(false);
    const g = r.gates.find((x) => x.name === 'pr-exists');
    expect(g!.pass).toBe(false);
  });

  it('fails commits gate when too few', () => {
    const r = evaluateGates({ ...passing, commitCount: 2 });
    expect(r.pass).toBe(false);
    const g = r.gates.find((x) => x.name.startsWith('commits>='));
    expect(g!.pass).toBe(false);
  });

  it('fails final-changeset-clean when scaffold leaks', () => {
    const r = evaluateGates({ ...passing, finalFiles: ['src/index.ts', 'plan.md'] });
    expect(r.pass).toBe(false);
    const g = r.gates.find((x) => x.name === 'final-changeset-clean');
    expect(g!.pass).toBe(false);
    expect(g!.detail).toContain('plan.md');
  });

  it('fails process-discipline when scaffold never touched', () => {
    const r = evaluateGates({ ...passing, touchedBasenames: ['index.ts'] });
    expect(r.pass).toBe(false);
    const g = r.gates.find((x) => x.name === 'process-discipline');
    expect(g!.pass).toBe(false);
  });

  it('fails beads-closed when not enough closed', () => {
    const r = evaluateGates({ ...passing, closedP1: ['beads-001'] });
    expect(r.pass).toBe(false);
    const g = r.gates.find((x) => x.name === 'beads-closed');
    expect(g!.pass).toBe(false);
  });
});

describe('suite config files', () => {
  it('lite-suites.json parses and has required keys', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), '.github/e2e/lite-suites.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    expect(cfg.toy).toBeTruthy();
    expect(Array.isArray(cfg.suites)).toBe(true);
    expect(cfg.suites).toHaveLength(1);
    expect(cfg.suites[0].id).toBe('s10');
    expect(cfg.suites[0].provider).toBe('opencode');
    for (const s of cfg.suites) {
      expect(s.id).toBeTruthy();
      expect(s.provider).toBeTruthy();
      expect(s.cli).toBeTruthy();
      expect(s).not.toHaveProperty('os');
    }
  });

  it('suites.json parses and has required keys', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), '.github/e2e/suites.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    expect(cfg.suites).toBeTruthy();
    expect(typeof cfg.suites).toBe('object');
  });
});
