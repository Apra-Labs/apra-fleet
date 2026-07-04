import { describe, it, expect } from 'vitest';
import {
  normalizeOrigin,
  stripWorktreeSuffix,
  projectKey,
  groupByProject,
  type MemberContext,
} from '../src/services/watch/project-resolver.js';
import type { Agent } from '../src/types.js';

function agent(name: string, workFolder: string): Agent {
  return {
    id: name,
    friendlyName: name,
    agentType: 'local',
    workFolder,
    createdAt: '2026-07-04T00:00:00Z',
  };
}

function ctx(name: string, workFolder: string, origin: string | null, branch: string | null): MemberContext {
  return { agent: agent(name, workFolder), origin, branch };
}

describe('normalizeOrigin', () => {
  it('strips a trailing .git', () => {
    expect(normalizeOrigin('https://github.com/Org/Repo.git')).toBe('https://github.com/Org/Repo');
  });
  it('trims whitespace', () => {
    expect(normalizeOrigin('  git@github.com:Org/Repo  ')).toBe('git@github.com:Org/Repo');
  });
});

describe('stripWorktreeSuffix', () => {
  it('collapses a worktree sibling to its base repo path', () => {
    expect(stripWorktreeSuffix('/home/x/myapp-wt/track-1')).toBe('/home/x/myapp');
  });
  it('leaves a plain repo path untouched', () => {
    expect(stripWorktreeSuffix('/home/x/myapp')).toBe('/home/x/myapp');
  });
});

describe('projectKey', () => {
  it('prefers normalized origin over path', () => {
    const c = ctx('a', '/wherever', 'https://github.com/Org/Repo.git', 'main');
    expect(projectKey(c)).toBe('https://github.com/Org/Repo');
  });
  it('falls back to worktree-stripped path when no origin', () => {
    const c = ctx('a', '/home/x/myapp-wt/track-1', null, 'feat/x');
    expect(projectKey(c)).toBe('/home/x/myapp');
  });
});

describe('groupByProject', () => {
  it('groups two folders with the same origin as one project (path differs)', () => {
    const doer = ctx('doer', '/a/repo', 'https://github.com/Org/Repo.git', 'feat/x');
    const reviewer = ctx('reviewer', '/a/repo-review', 'https://github.com/Org/Repo.git', 'feat/x');
    const groups = groupByProject([doer, reviewer]);
    expect(groups).toHaveLength(1);
    expect(groups[0].features).toHaveLength(1);
    expect(groups[0].features[0].members.map((m) => m.agent.friendlyName).sort()).toEqual(['doer', 'reviewer']);
  });

  it('separates features by branch within one project', () => {
    const a = ctx('a', '/a/repo', 'https://github.com/Org/Repo.git', 'feat/subtract');
    const b = ctx('b', '/a/repo2', 'https://github.com/Org/Repo.git', 'feat/multiply');
    const groups = groupByProject([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].features.map((f) => f.feature)).toEqual(['feat/multiply', 'feat/subtract']);
  });

  it('separates distinct origins into distinct projects', () => {
    const a = ctx('a', '/a/one', 'https://github.com/Org/One.git', 'main');
    const b = ctx('b', '/a/two', 'https://github.com/Org/Two.git', 'main');
    const groups = groupByProject([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.project).sort()).toEqual(['One', 'Two']);
  });

  it('labels missing branch as (no branch)', () => {
    const a = ctx('a', '/a/one', null, null);
    const groups = groupByProject([a]);
    expect(groups[0].features[0].feature).toBe('(no branch)');
  });
});
