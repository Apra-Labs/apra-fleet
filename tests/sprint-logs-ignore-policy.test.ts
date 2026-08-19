import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * sprint-logs/ is split three ways and the split lives in two places that
 * cannot import each other: .gitignore, and the harvester instructions in
 * apra-pm/docs/sprint-workflow.md + apra-pm/skills/pm/cost.md. When they
 * disagree, the failure is silent -- the harvester writes a file it is told to
 * commit, git refuses to stage it, and the sprint reports success. That drift
 * shipped once already: main's .gitignore ignored *.jsonl and *.analysis.md
 * while three separate doc lines said to commit them, and a sprint (apra-fleet
 * -tm7.13) spent a cycle rediscovering it and "fixed" it in the other direction.
 *
 * This is the guard. It asserts the ignore rules directly rather than the prose,
 * because the rules are what git actually enforces.
 *
 * --no-index is LOAD-BEARING on every check-ignore call below. Without it git
 * silently skips paths that are tracked, so an assertion about calibration.json
 * would pass vacuously no matter what the rules said.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', relPath], {
      cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// Both depths matter: apra-pm keeps its own sprint-logs/ alongside the root one,
// so a rule anchored at the root would silently miss half the cases.
const DEPTHS = ['sprint-logs', 'packages/apra-fleet-se/apra-pm/sprint-logs'];

describe('sprint-logs ignore policy', () => {
  describe.each(DEPTHS)('%s', (dir) => {
    it('ignores the raw per-dispatch ledgers', () => {
      expect(isIgnored(`${dir}/feat-example-20260818_120000.jsonl`)).toBe(true);
    });

    it('ignores the per-run state snapshot bin/cli.mjs writes on exit', () => {
      expect(isIgnored(`${dir}/sprint_130635.json`)).toBe(true);
    });

    // cost.md:118 tells the harvester to commit this; it is the only
    // cross-machine cost record, so an ignore rule here loses the team's history.
    it('keeps calibration.json stageable', () => {
      expect(isIgnored(`${dir}/calibration.json`)).toBe(false);
    });

    // cost.md:115 tells the harvester to write and commit this summary.
    it('keeps the analysis summary stageable', () => {
      expect(isIgnored(`${dir}/feat-example-20260818_120000.analysis.md`)).toBe(false);
    });
  });

  /**
   * A directory-level ignore shadows everything inside it, so a blanket
   * '/sprint-logs/' rule makes calibration.json and the analysis summaries
   * unstageable no matter what a narrower pattern elsewhere says. That rule
   * existed on main and is exactly what forced `git add -f` on every sprint.
   */
  it('carries no blanket sprint-logs directory rule', () => {
    const rules = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const blanket = rules.filter((l) => /^\/?(\*\*\/)?sprint-logs\/?$/.test(l));
    expect(blanket).toEqual([]);
  });
});
