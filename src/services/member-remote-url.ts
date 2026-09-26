import type { Agent } from '../types.js';

/**
 * apra-fleet-b4g.6: the only place a genuine origin URL for a member can
 * already be known server-side is the member's own registration record
 * (gitRepos) -- and only when it already IS a URL. In practice gitRepos entries
 * are almost always a bare "owner/repo" access identifier (see
 * src/services/vcs/github.ts's own https://github.com/${repo}.git construction,
 * used for a narrower purpose -- connectivity testing), so this intentionally
 * does not build a URL out of one: an incorrect derived URL would route KB
 * reads and writes into a slug that does not match the repo's real local-clone
 * slug, worse than the honest 'default' fallback. Returns undefined when
 * nothing already known qualifies.
 *
 * apra-fleet-b4g.14: gitRepos is an ACCESS LIST (src/tools/register-member.ts
 * documents git_repos as "Git repositories this member can access"), not an
 * origin field -- so index 0 is not guaranteed to be the repo the member's
 * work_folder is actually a clone of. Only forward the URL when gitRepos has
 * EXACTLY one entry: that is the one case where "index 0" and "the member's
 * own repo" are provably the same thing, since there is nothing else the
 * single entry could mean. A multi-entry gitRepos whose first element happens
 * to look like a URL is ambiguous -- it could equally be an access grant to a
 * DIFFERENT repo than the one being scoped -- so it is deliberately left
 * unforwarded rather than guessed, matching the no-guessing rule this function
 * already applies to bare "owner/repo" entries above.
 * src/services/watch/project-resolver.ts's own gitRepos[0] use is display-only
 * grouping, is unaffected by this narrowing, and is deliberately left unchanged.
 *
 * Lives here rather than in execute-prompt.ts (its first caller) because
 * member_detail needs the same rule to report the URL to the fleet-sprint
 * engine, and importing the dispatch module for one pure helper would pull the
 * whole prompt-dispatch stack into a read-only status tool.
 */
export function knownRepoRemoteUrl(agent: Agent): string | undefined {
  const repos = agent.gitRepos;
  if (!repos || repos.length !== 1) return undefined;
  const first = repos[0];
  return first.includes('://') || first.startsWith('git@') ? first : undefined;
}
