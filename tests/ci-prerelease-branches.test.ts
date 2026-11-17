import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// Workflow lint (no CI run): the prerelease branch must come from a
// stabilize_* pattern, never a hardcoded version.
const file = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');
const text = fs.readFileSync(file, 'utf8');
const wf = parse(text) as any;

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^$(){}|\\]/g, (c) => `\\${c}`)
    .replace(/\*\*/g, '@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@/g, '.*');
  return new RegExp('^' + esc + '$');
}
function pushBuilds(ref: string): boolean {
  const branch = ref.replace(/^refs\/heads\//, '');
  return (wf.on.push.branches as string[]).some((g) => globToRegExp(g).test(branch));
}
// Evaluates the one expression shape the impl uses:
//   github.event_name == 'push' && (github.ref == 'X' || startsWith(github.ref, 'Y'))
function prereleaseRuns(event: string, ref: string): boolean {
  const expr = String(wf.jobs.prerelease.if);
  const eq = [...expr.matchAll(/github\.ref == '([^']+)'/g)].map((m) => m[1]);
  const sw = [...expr.matchAll(/startsWith\(github\.ref, '([^']+)'\)/g)].map((m) => m[1]);
  expect(expr).toContain("github.event_name == 'push'");
  return event === 'push' && (eq.includes(ref) || sw.some((p) => ref.startsWith(p)));
}

describe('ci.yml prerelease branch selection', () => {
  it('has no hardcoded stabilize_<version> literal', () => {
    expect(text).not.toMatch(/stabilize_\d/);
  });

  it.each(['refs/heads/stabilize_0.4.5', 'refs/heads/stabilize_0.5.0', 'refs/heads/main'])(
    'push to %s builds and runs the prerelease job', (ref) => {
      expect(pushBuilds(ref)).toBe(true);
      expect(prereleaseRuns('push', ref)).toBe(true);
    });

  it('feature branches and pull requests do not run the prerelease job', () => {
    expect(prereleaseRuns('push', 'refs/heads/feat/foo')).toBe(false);
    expect(prereleaseRuns('push', 'refs/heads/fix/x')).toBe(false);
    expect(prereleaseRuns('pull_request', 'refs/heads/stabilize_0.4.5')).toBe(false);
    expect(prereleaseRuns('pull_request', 'refs/pull/1/merge')).toBe(false);
  });
});
