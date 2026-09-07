/**
 * detectVcsProviderFromRemoteUrl -- map a git remote URL onto the VCS provider
 * that hosts it (apra-fleet-5oo).
 *
 * WHY THIS EXISTS. `register_member` could fully register a dispatch-capable
 * member (llm_provider: 'claude') while leaving Agent.vcsProvider unset --
 * nothing in registration ever asked for or detected it. The gap only surfaced
 * hours later, mid-sprint, when fleet-sprint's VCSModule.resolveProvider()
 * threw "member has no registered VCS provider" on the first push/PR. This
 * function is the registration-time half of the fix: a best-effort read of the
 * member's own `origin` remote is mapped to a provider here, so the common case
 * needs no operator input at all.
 *
 * PARALLEL IMPLEMENTATION, DELIBERATELY. The orchestrator-side (fleet-se)
 * equivalent of this logic lives in
 * packages/apra-fleet-se/fleet-sprint/vcs-module.mjs (parseRemote /
 * parseProviderRepoRef) and each provider descriptor's own matchesHost()
 * under packages/apra-fleet-se/fleet-sprint/vcs-providers/. That code is a
 * separate package with its own registry and cannot be imported from the
 * server's src/ tree. The host rules below are kept deliberately in step with
 * those descriptors -- azure-devops.mjs's and bitbucket.mjs's anchored
 * HOST_REs, and github.mjs's anchored matchesHostForAuth() -- so the two
 * halves never disagree about who owns a host. Note that github.mjs ALSO
 * exports a deliberately wider substring matchesHost(); that one answers the
 * capabilities axis ("could a PR be opened here?", where GitHub Enterprise
 * Server must say yes) and is NOT the matcher any credential decision uses.
 *
 * URL SHAPES. Every form git itself accepts for a hosted remote:
 *   - https://host/owner/repo(.git)          scheme'd, optional userinfo/port
 *   - http://host/owner/repo(.git)
 *   - ssh://git@host(:port)/owner/repo(.git) scheme'd ssh
 *   - git://host/owner/repo.git              the read-only git protocol
 *   - git@host:owner/repo(.git)              scp-like shorthand (NO scheme --
 *                                            `new URL()` cannot parse it)
 * A `file://` remote, a local path, an empty/absent URL, or a host no provider
 * below claims all return null: "unknown", never a guess. Callers must treat
 * null as "could not determine", not as an error.
 *
 * Host matching is ANCHORED on purpose. A substring test would let
 * `github.com.evil.example` or `dev.azure.com.attacker.test` claim a provider
 * and send a member's freshly-minted push credential at the wrong host.
 * GitHub Enterprise Server hosts (which have no fixed domain) are therefore
 * NOT auto-detected here -- an operator registers those with an explicit
 * `vcs_provider`.
 *
 * Pure: no I/O, no throwing, no mutation. ASCII only.
 */

/** The provider vocabulary Agent.vcsProvider accepts (src/types.ts). */
export type DetectedVcsProvider = 'github' | 'bitbucket' | 'azure-devops';

/** github.com and its ssh alias. Anchored -- see the header note on GHE. */
const GITHUB_HOST_RE = /^(?:www\.|ssh\.)?github\.com$/i;

/** bitbucket.org and its alternate-SSH host. */
const BITBUCKET_HOST_RE = /^(?:www\.|altssh\.)?bitbucket\.org$/i;

/** dev.azure.com, its v3 ssh host, and the legacy <org>.visualstudio.com.
 *  Kept identical to azure-devops.mjs's HOST_RE. */
const AZURE_DEVOPS_HOST_RE = /^(?:dev\.azure\.com|ssh\.dev\.azure\.com|(?:[a-z0-9-]+\.)*visualstudio\.com)$/i;

const HOST_RULES: ReadonlyArray<{ provider: DetectedVcsProvider; re: RegExp }> = [
  { provider: 'github', re: GITHUB_HOST_RE },
  { provider: 'bitbucket', re: BITBUCKET_HOST_RE },
  { provider: 'azure-devops', re: AZURE_DEVOPS_HOST_RE },
];

/**
 * Extract the lowercased hostname from a git remote URL, for BOTH shapes git
 * speaks. Returns null for a file:// remote, a bare local path, or anything
 * unparseable -- mirroring vcs-module.mjs's parseRemote().
 */
export function parseRemoteHost(remoteUrl: unknown): string | null {
  const url = String(remoteUrl ?? '').trim();
  if (!url) return null;

  // scp-like shorthand (git@github.com:owner/repo.git) has no `scheme://`
  // prefix, which `new URL()` cannot parse. Guarded by the scheme test so a
  // real `ssh://user@host/...` URL falls through to the URL branch below.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const scp = /^[^@\s/]+@([^:\s/]+):/.exec(url);
    if (scp) return scp[1].toLowerCase();
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  // A file:// remote has no host to attribute to any hosted provider.
  if (scheme === 'file') return null;
  return parsed.hostname ? parsed.hostname.toLowerCase() : null;
}

/**
 * Resolve a git remote URL to the VCS provider that hosts it.
 *
 * @param remoteUrl a git remote URL in any of the shapes documented above.
 * @returns 'github' | 'bitbucket' | 'azure-devops', or null when the URL is
 *          absent/unparseable or its host is not one this function recognizes.
 *          Null is "unknown", NEVER a default provider.
 */
export function detectVcsProviderFromRemoteUrl(remoteUrl: unknown): DetectedVcsProvider | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) return null;
  for (const rule of HOST_RULES) {
    if (rule.re.test(host)) return rule.provider;
  }
  return null;
}
