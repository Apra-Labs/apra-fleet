import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Exercise the shared gate logic directly from e2e/lib/validate-sprint.mjs. These
// fixtures use profile 'fleet' -- the 5-gate subset (pr-exists, commits>=N,
// final-changeset-clean, process-discipline, beads-closed) over the wider scaffold
// set (requirements/plan/feedback/progress) with no feedback-verdict requirement --
// which is what the fleet harness runs.
import { evaluateGates } from '../e2e/lib/validate-sprint.mjs';

interface GateData {
  pr?: { url: string; number: number } | null;
  commitCount?: number;
  finalFiles?: string[];
  touchedBasenames?: string[];
  closedP1?: string[];
  minCommits?: number;
  expectedIssues?: number;
  profile?: 'pm' | 'fleet';
}

describe('evaluateGates', () => {
  const passing: GateData = {
    profile: 'fleet',
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

  it('fleet profile runs exactly the 5-gate subset', () => {
    const r = evaluateGates(passing);
    const names = r.gates.map((g) => g.name).sort();
    expect(names).toEqual(
      ['beads-closed', 'commits>=4', 'final-changeset-clean', 'pr-exists', 'process-discipline'].sort(),
    );
  });
});

describe('suite registry', () => {
  it('e2e/suites.json parses and carries both namespaces', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'e2e/suites.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    // Fleet namespace: object keyed by suite id (fleet-s*), read by fleet-e2e.yml.
    expect(cfg.fleet?.suites).toBeTruthy();
    expect(typeof cfg.fleet.suites).toBe('object');
    expect(cfg.fleet.suites['fleet-s1']).toBeTruthy();
    // pm namespace: array of run configs (pm-s*), read by apra-pm run-e2e.mjs.
    expect(Array.isArray(cfg.pm?.suites)).toBe(true);
    expect(cfg.pm.toy).toBeTruthy();
    expect(cfg.pm.suites.map((s: { id: string }) => s.id)).toContain('pm-s1');
  });
});
