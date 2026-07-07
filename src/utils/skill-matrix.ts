/**
 * Skill matrix utility: maps (tags, vcs, project) to required skill names.
 *
 * This is the programmatic encoding of skills/fleet/skill-matrix.md.
 * Tags are real member tag names stored in Agent.tags; they drive both
 * skill selection during onboarding and permission profile merging in
 * compose_permissions.
 */

/** VCS provider identifiers (lowercase). */
export type VcsProvider = 'github' | 'bitbucket' | 'azdevops' | string;

/**
 * Return the list of skills required for a member, given its tags, VCS
 * provider, and optional project name. Skills are deduplicated and sorted.
 *
 * Members with no tags (or only tags that have no VCS mapping) get no
 * tag-driven skills -- the empty array is the correct result, not an error.
 */
export function getRequiredSkills(
  tags: string[],
  vcs: VcsProvider,
  project?: string,
): string[] {
  const skills = new Set<string>();
  const vcsNorm = vcs.toLowerCase();

  for (const tag of tags) {
    const tagNorm = tag.toLowerCase();

    // Bitbucket tag rules
    if (vcsNorm === 'bitbucket') {
      if (tagNorm === 'devops' || tagNorm === 'code-review') {
        skills.add('bitbucket-devops');
      }
    }

    // Azure DevOps tag rules (future skills -- added as placeholders)
    if (vcsNorm === 'azdevops' || vcsNorm === 'azure devops') {
      if (tagNorm === 'devops' || tagNorm === 'code-review') {
        skills.add('azdevops-devops');
      }
    }

    // Project-specific rules (VCS-agnostic)
    if (project) {
      const projNorm = project.toLowerCase();
      if (projNorm.includes('aprapipes') && tagNorm === 'devops') {
        skills.add('aprapipes-devops');
      }
      if (
        (projNorm.includes('streamsurv') || projNorm.includes('avms') || projNorm.includes('lvsm')) &&
        tagNorm === 'debugging'
      ) {
        skills.add('lvsm-log-analyzer-skill');
      }
    }
  }

  return [...skills].sort();
}
