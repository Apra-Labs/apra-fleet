/**
 * Azure DevOps VCS provider -- deploys PAT credentials via git credential helper.
 * Auth pattern: placeholder username + PAT as password (see PAT_USERNAME).
 */

import type { VcsProviderService, VcsDeployResult, AzureDevOpsCredentials } from './types.js';
import { knownRepoRemoteUrl } from '../member-remote-url.js';

/** The modern Azure DevOps host. The git credential helper is bound to THIS
 *  host unless the credential's scope URL names a legacy host -- see
 *  credentialHostForScope(). */
const HOST = 'dev.azure.com';

// The username written into the git credential helper next to the PAT. It
// MUST be non-empty: with `username=` (empty) git still sends an
// `Authorization: Basic` header, but Azure DevOps' git endpoint answers 401
// to it every time, even for a perfectly valid PAT -- reproduced with an A/B
// of two helpers byte-identical except this one field against the real toy
// repo (`git ls-remote`: empty -> 401/401/401 + "Authentication failed",
// `pat` -> 200 with the HEAD sha). The REST API, by contrast, accepts
// `-u :PAT` (which is why the fleet's own curl-based PR calls were never
// affected). Azure DevOps ignores the username's VALUE for PAT auth; `pat`
// is the customary placeholder. Mirrors src/services/vcs/github.ts's
// `x-access-token` convention of a named constant, not an inline literal.
const PAT_USERNAME = 'pat';

/**
 * Every host Azure DevOps serves git over, ANCHORED (a substring test would
 * let `dev.azure.com.evil.example` claim this provider):
 *   - dev.azure.com               modern https remotes
 *   - ssh.dev.azure.com           modern v3 ssh remotes
 *   - <org>.visualstudio.com      legacy https remotes (org = first DNS label)
 *   - vs-ssh.visualstudio.com     legacy v3 ssh remotes
 * Kept in step with src/utils/vcs-provider-detect.ts's AZURE_DEVOPS_HOST_RE
 * and the engine-side HOST_RE in
 * packages/apra-fleet-se/fleet-sprint/vcs-providers/azure-devops.mjs.
 */
export const AZURE_DEVOPS_HOST_RE = /^(?:dev\.azure\.com|ssh\.dev\.azure\.com|(?:[a-z0-9-]+\.)*visualstudio\.com)$/i;

/** Both git transports an Azure DevOps remote can use. A PAT only ever
 *  applies to `https`; an `ssh` remote authenticates with the member's SSH
 *  key and the PAT is deployed for REST (pull-request) calls only. */
export type AzureDevOpsTransport = 'https' | 'ssh';

export interface AzureDevOpsRepoRef {
  org: string;
  project: string;
  repo: string;
  /** Lowercased hostname the remote points at. */
  host: string;
  transport: AzureDevOpsTransport;
  /** True for the legacy `<org>.visualstudio.com` / `vs-ssh.visualstudio.com` hosts. */
  legacy: boolean;
}

/** Percent-decode one path segment; an invalid escape is left as-is because
 *  the parser must never throw. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a remote URL into { host, path, scheme } for BOTH shapes git
 *  speaks: a real scheme'd URL and the scp-like `user@host:path` shorthand
 *  `new URL()` cannot parse. */
function splitRemote(url: string): { host: string; path: string; scheme: string } | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!parsed.hostname) return null;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname, scheme: parsed.protocol.replace(/:$/, '').toLowerCase() };
  }
  const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.*)$/.exec(url);
  if (!scp) return null;
  return { host: scp[1].toLowerCase(), path: `/${scp[2]}`, scheme: 'ssh' };
}

/**
 * Parse an Azure DevOps git remote URL into its { org, project, repo }
 * coordinates -- the identity every Azure DevOps REST call needs -- plus the
 * host and transport it was reached on. The SERVER-side twin of the engine's
 * parseRepoRef() (packages/apra-fleet-se/fleet-sprint/vcs-providers/
 * azure-devops.mjs); the two are kept in step by hand because the engine is
 * a separate package that cannot import from src/.
 *
 * Recognized shapes:
 *   https://[user@]dev.azure.com/ORG/PROJECT/_git/REPO[.git][/]
 *   https://[user@]dev.azure.com/ORG/_git/REPO                       (project == repo)
 *   https://[user@]ORG.visualstudio.com/[DefaultCollection/]PROJECT/_git/REPO
 *   https://[user@]ORG.visualstudio.com/[DefaultCollection/]_git/REPO (project == repo)
 *   git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO
 *   ORG@vs-ssh.visualstudio.com:v3/ORG/PROJECT/REPO
 *   ssh://git@ssh.dev.azure.com[:22]/v3/ORG/PROJECT/REPO
 *
 * Percent-encoded project names (Azure DevOps allows spaces) are decoded in
 * every returned field. NEVER throws; returns null for anything that is not
 * one of the shapes above, including a lookalike host.
 */
export function parseAzureDevOpsRemote(remoteUrl: unknown): AzureDevOpsRepoRef | null {
  if (typeof remoteUrl !== 'string') return null;
  const url = remoteUrl.trim();
  if (!url) return null;
  const split = splitRemote(url);
  if (!split || !AZURE_DEVOPS_HOST_RE.test(split.host)) return null;

  const raw = split.path.split('/').filter((part) => part !== '');
  if (raw.length === 0) return null;
  raw[raw.length - 1] = raw[raw.length - 1].replace(/\.git$/i, '');
  const segments = raw.map(decodeSegment);
  const legacy = /visualstudio\.com$/i.test(split.host);

  const build = (org: string, project: string, repo: string, transport: AzureDevOpsTransport): AzureDevOpsRepoRef | null => {
    if (!org || !project || !repo) return null;
    return { org, project, repo, host: split.host, transport, legacy };
  };

  // v3 ssh form: exactly v3/ORG/PROJECT/REPO on either ssh host.
  if (segments[0].toLowerCase() === 'v3') {
    if (segments.length !== 4 || split.scheme !== 'ssh') return null;
    return build(segments[1], segments[2], segments[3], 'ssh');
  }
  if (split.scheme !== 'https' && split.scheme !== 'http') return null;

  const marker = segments.indexOf('_git');
  if (marker === -1 || marker !== segments.length - 2) return null;
  const repo = segments[segments.length - 1];
  let prefix = segments.slice(0, marker);

  if (legacy) {
    // Legacy host: the org is the first hostname label, and an explicit
    // collection segment (historically 'DefaultCollection') may precede the
    // project.
    const org = split.host.split('.')[0];
    if (!org || org.toLowerCase() === 'visualstudio') return null;
    if (prefix.length > 0 && prefix[0].toLowerCase() === 'defaultcollection') prefix = prefix.slice(1);
    if (prefix.length > 1) return null;
    return build(org, prefix[0] || repo, repo, 'https');
  }
  if (prefix.length < 1 || prefix.length > 2) return null;
  return build(prefix[0], prefix[1] || repo, repo, 'https');
}

/**
 * Extract the organization from an Azure DevOps org URL, accepting both
 * hosts: "https://dev.azure.com/myorg" and the legacy
 * "https://myorg.visualstudio.com[/...]". Falls back to the input verbatim
 * (the historical behaviour) when neither shape matches.
 */
export function extractAzureDevOpsOrg(orgUrl: string): string {
  const modern = orgUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)/i);
  if (modern?.[1]) return modern[1];
  const legacy = orgUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?([a-z0-9-]+)\.visualstudio\.com(?:[/?#]|$)/i);
  if (legacy?.[1] && legacy[1].toLowerCase() !== 'vs-ssh') return legacy[1];
  return orgUrl;
}

function extractOrg(orgUrl: string): string {
  return extractAzureDevOpsOrg(orgUrl);
}

/**
 * The host the git credential helper is bound to for a given credential
 * scope URL. A scope on a legacy `<org>.visualstudio.com` host binds the PAT
 * to THAT host: git looks credentials up by the remote's own hostname, so a
 * helper registered for dev.azure.com is never consulted for a push to
 * `https://myorg.visualstudio.com/...`. Every other scope (the default bare
 * `https://dev.azure.com`, an org- or repo-scoped modern URL, a non-Azure or
 * unparseable value) keeps the modern host.
 */
export function credentialHostForScope(scopeUrl?: string): string {
  if (!scopeUrl) return HOST;
  let host: string;
  try {
    host = new URL(scopeUrl).hostname.toLowerCase();
  } catch {
    return HOST;
  }
  if (host && AZURE_DEVOPS_HOST_RE.test(host) && /visualstudio\.com$/i.test(host)) {
    const org = host.split('.')[0].toLowerCase();
    if (org && org !== 'visualstudio' && org !== 'vs-ssh') return host;
  }
  return HOST;
}

// apra-fleet-5co8.5.2 (review round 2): a candidate repo URL is only usable
// when it is a well-formed Azure DevOps https repo URL -- modern
// "https://dev.azure.com/<org>/<project>/_git/<repo>" or legacy
// "https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>"
// -- with each segment restricted to characters that can never be
// interpreted as shell metacharacters (percent-escapes such as %20 in a
// project name are allowed; a bare '%' is not). This single check closes two
// review defects at once: (1) knownRepoRemoteUrl is host-agnostic (see
// member-remote-url.ts), so without this a cross-host gitRepos entry (e.g. a
// github.com URL) could be ls-remote'd and reported as an Azure DevOps
// connectivity result -- a false success on the wrong host; (2) the derived
// URL is interpolated into a command string executed on the member (see
// below), so an unvalidated value is a command-injection vector. A bare
// org/project scope (the provision default, "https://dev.azure.com/<org>")
// deliberately fails this check -- it is not a clonable repo. SSH remotes
// also fail it: `git ls-remote` over ssh would exercise the member's SSH key,
// not the PAT this provider just deployed.
const SAFE_URL_RE = /^https:\/\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+(?:\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)+$/;

function isValidAzureRepoUrl(url: string): boolean {
  if (!SAFE_URL_RE.test(url)) return false;
  const ref = parseAzureDevOpsRemote(url);
  return ref !== null && ref.transport === 'https';
}

export const azureDevOpsProvider: VcsProviderService = {
  // apra-fleet-5co8.3.2: moved VERBATIM out of the provider switch in
  // src/tools/provision-vcs-auth.ts -- same `pat ?? token` alias, same
  // required-field error text, same unparseable-expiry rejection and the same
  // returned shape (expires_at is always present, undefined when unset).
  // The pat_expires_at check stays defence in depth behind the zod refine in
  // the tool schema: tool-registry casts the MCP payload with `as any`, so a
  // caller can bypass zod, and an unparseable expiry is worse than none at all
  // (NaN silences every checkVcsTokenExpiry comparison; scheduleCredentialCleanup
  // treats an unparseable expiresAt the same as an absent one and skips
  // scheduling entirely, so this rejection is about the silenced-warning
  // half of the failure mode, not an auto-revoke risk).
  buildCredentials(input) {
    const azPat = input.pat ?? input.token;
    if (!input.org_url || !azPat) return 'Azure DevOps requires "org_url" and "pat" (or "token") fields.';
    if (input.pat_expires_at !== undefined && Number.isNaN(Date.parse(input.pat_expires_at))) {
      return `Azure DevOps "pat_expires_at" is not a parseable date/time: ${input.pat_expires_at}`;
    }
    return { org_url: input.org_url, pat: azPat, expires_at: input.pat_expires_at };
  },

  // apra-fleet-5co8.3.2: the former
  // `if (provider === 'azure-devops' && pat === undefined && token === undefined)`
  // block, verbatim. Either field can carry the PAT, so the credential only
  // counts as missing when BOTH are absent; the collected secret lands in
  // `pat`, which is what buildCredentials prefers.
  missingCredential: {
    field: 'pat',
    isMissing: (input) => input.pat === undefined && input.token === undefined,
    promptFor: (memberName) => `Enter Azure DevOps personal access token for ${memberName}`,
  },

  async deploy(_agent, cmds, exec, credentials, label?, scopeUrl?) {
    const creds = credentials as AzureDevOpsCredentials;
    // Bind the helper to the host git will actually ask for: the legacy
    // host when the scope names one, dev.azure.com otherwise -- see
    // credentialHostForScope().
    await exec(cmds.gitCredentialHelperWrite(credentialHostForScope(scopeUrl), PAT_USERNAME, creds.pat, label, scopeUrl));
    return {
      success: true,
      message: 'Azure DevOps credentials deployed',
      // apra-fleet-5co8.5.1: `expiresAt` (when the caller supplied one --
      // see AzureDevOpsCredentials.expires_at) is what feeds the EXISTING
      // vcsTokenExpiresAt / checkVcsTokenExpiry / scheduleCredentialCleanup
      // plumbing (see provision-vcs-auth.ts), same as GitHub App tokens
      // already do. Absent an expiry, metadata carries no `expiresAt` key at
      // all and that plumbing behaves exactly as it did before this task.
      metadata: {
        org: extractOrg(creds.org_url),
        ...(creds.expires_at ? { expiresAt: creds.expires_at } : {}),
      },
    };
  },

  async revoke(_agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(credentialHostForScope(scopeUrl), label, scopeUrl));
    return { success: true, message: 'Azure DevOps credentials revoked' };
  },

  // apra-fleet-5co8.5.2: replaces the unauthenticated curl-the-org-root stub
  // (it verified nothing -- an unreachable/misconfigured host would 200 just
  // the same as a valid one) with `git ls-remote` against a concrete repo,
  // matching src/services/vcs/github.ts's pattern. `git ls-remote` goes
  // through the git credential helper deploy() already wrote, so the PAT is
  // read from the credential store at exec time and never appears in the
  // command string or any log line. When no concrete, validated repo is
  // known (the common case: gitRepos is an access list of bare identifiers,
  // not a repo URL -- see member-remote-url.ts), skip with a documented
  // message instead of reporting a false success.
  //
  // (review round 2) `scope_url` is what deploy() actually scoped the
  // credential to (gitCredentialHelperWrite writes credential.<scopeUrl>.helper
  // -- see src/os/linux.ts) so a repo-scoped scope_url is preferred over the
  // host-agnostic, access-list-derived gitRepos value; gitRepos is only
  // consulted when scope_url isn't itself a usable repo URL. Both candidates
  // are validated by isValidAzureRepoUrl before use -- see its comment for
  // why an unvalidated candidate is unsafe here.
  async testConnectivity(agent, exec, scopeUrl?) {
    const candidate =
      scopeUrl && isValidAzureRepoUrl(scopeUrl) ? scopeUrl : knownRepoRemoteUrl(agent);
    const repoUrl = candidate && isValidAzureRepoUrl(candidate) ? candidate : undefined;
    if (!repoUrl) {
      // apra-fleet-5co8.43: `success: true` here means "nothing failed", NOT
      // "the credential was verified" -- `skipped: true` is the machine-
      // detectable signal a caller must check before presenting this as a
      // passing connectivity check (see VcsDeployResult.skipped's doc).
      return {
        success: true,
        skipped: true,
        message: 'Skipped (no specific Azure DevOps repo known to test)',
      };
    }
    try {
      await exec(`git ls-remote ${repoUrl} HEAD`);
      return { success: true, message: `git ls-remote ${repoUrl} succeeded` };
    } catch {
      return { success: false, message: `git ls-remote ${repoUrl} failed` };
    }
  },
};
