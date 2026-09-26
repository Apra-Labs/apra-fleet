import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Agent } from '../../types.js';

/**
 * A member paired with the project/feature context needed to group it.
 * origin is the git remote URL the member's work folder was cloned from (the
 * project identity); branch is the member's current git branch (the feature).
 */
export interface MemberContext {
  agent: Agent;
  origin: string | null;
  branch: string | null;
}

export interface FeatureGroup {
  /** Display label for the feature -- branch name, or '(no branch)'. */
  feature: string;
  members: MemberContext[];
}

export interface ProjectGroup {
  /** Display label for the project -- repo name or folder basename. */
  project: string;
  /** Stable grouping key (normalized origin or path key). */
  key: string;
  features: FeatureGroup[];
}

/** Run a git command in a folder, returning trimmed stdout or null on any error. */
function git(folder: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', folder, ...args], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Strip a trailing .git and surrounding whitespace from a remote URL. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\.git$/i, '');
}

/**
 * Strip a worktree suffix so a base checkout and its `<repo>-wt/<track>` siblings
 * share one project key. `/a/myapp-wt/track-1` -> `/a/myapp`.
 */
export function stripWorktreeSuffix(folder: string): string {
  const m = folder.match(/^(.*)-wt[\\/][^\\/]+[\\/]?$/);
  return m ? m[1] : folder;
}

/** Stable grouping key: normalized origin if present, else the worktree-stripped path. */
export function projectKey(ctx: MemberContext): string {
  if (ctx.origin) return normalizeOrigin(ctx.origin);
  return stripWorktreeSuffix(ctx.agent.workFolder);
}

/** Human-friendly project label derived from origin or folder. */
export function projectLabel(ctx: MemberContext): string {
  const key = projectKey(ctx);
  const base = key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || key;
  return base;
}

/**
 * Enrich a member with git context. Local members are queried directly with git;
 * remote members fall back to stored registry fields (gitRepos, lastBranch) since
 * v1 does not open SSH connections.
 */
export function enrichMember(agent: Agent): MemberContext {
  if (agent.agentType === 'local') {
    return {
      agent,
      origin: git(agent.workFolder, ['remote', 'get-url', 'origin']),
      branch: git(agent.workFolder, ['rev-parse', '--abbrev-ref', 'HEAD']),
    };
  }
  return {
    agent,
    origin: agent.gitRepos && agent.gitRepos.length > 0 ? agent.gitRepos[0] : null,
    branch: agent.lastBranch ?? null,
  };
}

/**
 * Group members by project, then by feature (branch). Pure -- takes already
 * enriched contexts. Projects and features are sorted by label for stable output.
 */
export function groupByProject(members: MemberContext[]): ProjectGroup[] {
  const byKey = new Map<string, { label: string; members: MemberContext[] }>();
  for (const ctx of members) {
    const key = projectKey(ctx);
    let group = byKey.get(key);
    if (!group) {
      group = { label: projectLabel(ctx), members: [] };
      byKey.set(key, group);
    }
    group.members.push(ctx);
  }

  const projects: ProjectGroup[] = [];
  for (const [key, group] of byKey) {
    const byFeature = new Map<string, MemberContext[]>();
    for (const ctx of group.members) {
      const feature = ctx.branch ?? '(no branch)';
      const list = byFeature.get(feature);
      if (list) list.push(ctx);
      else byFeature.set(feature, [ctx]);
    }
    const features: FeatureGroup[] = [...byFeature.entries()]
      .map(([feature, ms]) => ({ feature, members: ms }))
      .sort((a, b) => a.feature.localeCompare(b.feature));
    projects.push({ project: group.label, key, features });
  }
  return projects.sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * Resolve the project key for a --project <dir> argument, matching the same
 * scheme enrichMember uses so filtering lines up with grouping.
 */
export function projectKeyForDir(dir: string): string {
  const origin = git(dir, ['remote', 'get-url', 'origin']);
  if (origin) return normalizeOrigin(origin);
  return stripWorktreeSuffix(path.resolve(dir));
}
