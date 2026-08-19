import type { Agent } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { logWarn } from '../utils/log-helpers.js';
import { wrapPowerShellEncoded } from '../os/windows.js';

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
  // apra-fleet-tm7.9.1: a URL resolved from the member host at registration is
  // a FACT about the clone, so it outranks anything inferred from the access
  // list below. Read-only and free -- callers on the dispatch hot path pay
  // nothing for it.
  if (agent.repoRemoteUrl) return agent.repoRemoteUrl;
  const repos = agent.gitRepos;
  if (!repos || repos.length !== 1) return undefined;
  const first = repos[0];
  return first.includes('://') || first.startsWith('git@') ? first : undefined;
}

/**
 * apra-fleet-tm7.9.1: ask the MEMBER what its repo's origin URL is.
 *
 * knownRepoRemoteUrl above answers from the registration record, which is
 * authoritative but usually silent -- gitRepos is an access list whose entries
 * are normally bare "owner/repo" identifiers, and turning one of those into a
 * URL is the guessing that function exists to refuse. That leaves most REMOTE
 * members with no identity at all, and a remote member's work folder cannot
 * supply one either: resolveProjectSlug runs git in the directory it is given,
 * and that directory lives on another machine, so both probes fail on the
 * fleet server and the slug degrades to 'default'. Every remote member's
 * harvested knowledge then lands in one shared bucket instead of its own repo
 * KB (apra-fleet-tm7 / apra-fleet-3zl).
 *
 * So this asks the host that actually has the clone. The result is a fact
 * rather than a guess, which is what makes it safe to route on.
 *
 * Local members are never probed: their work folder IS a real path on this
 * host, so resolveProjectSlug already derives the right slug from it, and the
 * probe would be a pure cost. Their behaviour is byte-for-byte unchanged.
 */

/** memberId -> resolved origin URL. Successful probes only. */
const remoteUrlCache = new Map<string, string>();
/** memberId -> in-flight probe, so concurrent dispatches cause ONE remote exec. */
const inFlightProbes = new Map<string, Promise<string | undefined>>();

const PROBE_TIMEOUT_MS = 10_000;

/** Clear the probe cache. Exposed for tests and for member re-registration. */
export function clearRepoRemoteUrlCache(): void {
  remoteUrlCache.clear();
  inFlightProbes.clear();
}

/**
 * The same shape test knownRepoRemoteUrl applies to a registration entry. A
 * probe can return anything the member's shell felt like printing -- `fatal:
 * not a git repository`, a login banner, an error page -- and none of that is
 * an identity. Adopting one would route writes into a slug that matches no
 * real clone, which is worse than the honest 'default' fallback.
 */
function looksLikeGitRemoteUrl(candidate: string): boolean {
  return candidate.includes('://') || candidate.startsWith('git@');
}

/**
 * Built per the repo's cross-shell rule: never rely on POSIX expansion in a
 * member-bound command, because the member's shell may be PowerShell. The
 * Windows form is base64-encoded (wrapPowerShellEncoded) so no intermediate
 * shell can re-tokenize the path, matching member-home.ts's probe and the
 * apra-fleet-ot2z precedent. `-LiteralPath` so a folder containing [ ] or
 * other glob metacharacters is taken verbatim.
 */
function probeCommandFor(targetOs: TargetOS, workFolder: string): string {
  if (targetOs === 'windows') {
    const psPath = workFolder.replace(/'/g, "''");
    return wrapPowerShellEncoded(`Set-Location -LiteralPath '${psPath}'; git remote get-url origin`);
  }
  const shPath = workFolder.replace(/(["\$`])/g, '\\$1');
  return `cd "${shPath}" && git remote get-url origin`;
}

export async function resolveRepoRemoteUrl(agent: Agent): Promise<string | undefined> {
  // The registration record wins when it has a genuine URL: it is authoritative
  // and free, so there is nothing a round trip could improve.
  const known = knownRepoRemoteUrl(agent);
  if (known) return known;

  // Local members already resolve correctly from their path.
  if (agent.agentType === 'local') return undefined;
  if (!agent.workFolder) return undefined;

  const cached = remoteUrlCache.get(agent.id);
  if (cached) return cached;
  const inFlight = inFlightProbes.get(agent.id);
  if (inFlight) return inFlight;

  const probe = (async (): Promise<string | undefined> => {
    try {
      const targetOs = getAgentOS(agent) as TargetOS;
      const result = await getStrategy(agent).execCommand(
        probeCommandFor(targetOs, agent.workFolder as string),
        PROBE_TIMEOUT_MS,
      );
      if (result.code !== 0) return undefined;
      // Take the LAST non-empty line: a login shell / PowerShell banner is
      // emitted BEFORE the command's own output, never after it.
      const candidate = result.stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .pop();
      if (!candidate || !looksLikeGitRemoteUrl(candidate)) return undefined;
      remoteUrlCache.set(agent.id, candidate);
      return candidate;
    } catch (err) {
      // Never throw into the caller: this feeds a fire-and-forget harvest, and
      // a harvest must never fail the prompt it followed.
      logWarn('member_repo_url_probe', `origin probe failed for ${agent.friendlyName}: ${(err as Error).message}`);
      return undefined;
    } finally {
      inFlightProbes.delete(agent.id);
    }
  })();

  inFlightProbes.set(agent.id, probe);
  return probe;
}
