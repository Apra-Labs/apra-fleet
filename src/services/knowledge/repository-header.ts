// The repository a remote KB request is about, as the HTTP provider sends it.
//
// kb_* tools take no repository argument: fleet resolves the repository from
// the calling session (kb-self.ts). HttpKbProvider forwards that resolved
// repository to a shared remote KB server as two headers, so the server can
// keep repositories apart:
//
//   X-Repository         the normalised origin remote, `host/path`
//   X-Repository-Commit  the HEAD sha of the local folder, when readable
//
// Both values come ONLY from fleet's resolved anchor, never from tool input.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const REPOSITORY_HEADER = 'X-Repository';
export const REPOSITORY_COMMIT_HEADER = 'X-Repository-Commit';

/** Longest X-Repository value a receiving server accepts. */
export const MAX_REPOSITORY_LENGTH = 512;

const AZURE_HOST = 'dev.azure.com';
const VISUALSTUDIO_SUFFIX = '.visualstudio.com';
const URL_SCHEMES = new Set(['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git']);

/** The repository a provider sends with every request. */
export interface RepositoryIdentity {
  /** Normalised origin remote, `host/path` (see normaliseRepositoryRemote). */
  remote: string;
  /** HEAD sha of the local folder; undefined when unknown. Must not throw. */
  commitOf?: () => string | undefined;
}

/**
 * Normalise a git remote URL to `host/path`: no scheme, no user info or
 * credentials, no port, no query or fragment, no trailing `.git` or `/`. The
 * host is lowercased; the path keeps its case. ssh forms (`git@host:org/repo`,
 * `ssh://git@host/org/repo`) map to the same value as https. Azure DevOps
 * spellings fold to `dev.azure.com/<org>/<project>/_git/<repo>` (org
 * lowercased), as the receiving server canonicalises them. Characters outside
 * printable ASCII (space, non-ASCII) are percent-encoded.
 *
 * Returns undefined for anything that is not a network remote (a local path, a
 * file:// URL) or that would not be a valid header value.
 */
export function normaliseRepositoryRemote(remoteUrl: string): string | undefined {
  const raw = remoteUrl.trim();
  if (!raw || raw.includes('\\')) return undefined;

  let hostPart: string;
  let pathPart: string;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (scheme) {
    if (!URL_SCHEMES.has(scheme[1].toLowerCase())) return undefined;
    const rest = scheme[2];
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    pathPart = slash < 0 ? '' : rest.slice(slash + 1);
    // Drop user info (and any credentials in it): everything up to the LAST '@'
    // of the authority, then the port.
    hostPart = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  } else {
    // scp-like form: [user@]host:path. A single-letter "host" is a Windows
    // drive (C:/x), and a path with no ':' before its first '/' is local.
    const scp = /^(?:[^@/]*@)?([^@/:]+):(.*)$/.exec(raw);
    if (!scp || scp[1].length < 2) return undefined;
    hostPart = scp[1];
    pathPart = scp[2];
  }

  // Query and fragment never identify a repository and can carry tokens.
  pathPart = pathPart.replace(/[?#].*$/, '');
  const host = hostPart.toLowerCase();
  const repoPath = pathPart
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!host || !repoPath || host.includes('@')) return undefined;

  const value = canonicaliseAzure(percentEncode(`${host}/${repoPath}`));
  return isValidRepositoryValue(value) ? value : undefined;
}

/**
 * True when `value` is a header value a receiving server accepts: at most 512
 * printable ASCII characters, no spaces, no scheme, no '@' before the first '/'.
 */
export function isValidRepositoryValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REPOSITORY_LENGTH) return false;
  if (!/^[!-~]+$/.test(value) || value.includes('://')) return false;
  const at = value.indexOf('@');
  const slash = value.indexOf('/');
  return slash > 0 && (at < 0 || slash < at);
}

function percentEncode(value: string): string {
  let out = '';
  for (const ch of value) {
    out += /^[!-~]$/.test(ch)
      ? ch
      : Array.from(Buffer.from(ch, 'utf8'), b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  return out;
}

function azureKey(org: string, project: string, repo: string): string {
  return `${AZURE_HOST}/${org.toLowerCase()}/${project}/_git/${repo}`;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Mirrors the receiving server's canonicalisation of Azure DevOps spellings,
// so fleet sends the canonical key rather than relying on the server to fold it.
function canonicaliseAzure(value: string): string {
  const segments = value.split('/');
  if (segments.some(s => s.length === 0)) return value;
  const host = segments[0];

  // ssh.dev.azure.com/v3/<org>/<project>/<repo>, vs-ssh.visualstudio.com/v3/...
  if ((host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com')
    && segments.length === 5 && eq(segments[1], 'v3')) {
    return azureKey(segments[2], segments[3], segments[4]);
  }
  // dev.azure.com/<org>/<project>/_git/<repo>
  if (host === AZURE_HOST && segments.length === 5 && eq(segments[3], '_git')) {
    return azureKey(segments[1], segments[2], segments[4]);
  }
  if (host.endsWith(VISUALSTUDIO_SUFFIX) && host.length > VISUALSTUDIO_SUFFIX.length) {
    const org = host.slice(0, -VISUALSTUDIO_SUFFIX.length);
    // <org>.visualstudio.com/<project>/_git/<repo>
    if (segments.length === 4 && eq(segments[2], '_git')) {
      return azureKey(org, segments[1], segments[3]);
    }
    // <org>.visualstudio.com/DefaultCollection/<project>/_git/<repo>
    if (segments.length === 5 && eq(segments[1], 'DefaultCollection') && eq(segments[3], '_git')) {
      return azureKey(org, segments[2], segments[4]);
    }
  }
  return value;
}

function gitOut(folder: string, args: string[]): string | undefined {
  // Same ceiling as resolveProjectSlug / kb-self: the folder itself must be the
  // repository, never a checkout it merely sits inside.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(folder) };
  try {
    return execFileSync('git', args, {
      cwd: folder, env, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How long a read HEAD sha is reused before git is asked again. */
export const HEAD_COMMIT_TTL_MS = 5000;

/**
 * A reader for the HEAD sha of a local folder, cached for `ttlMs` so it is not
 * re-read on every request. Returns undefined (never throws) when the folder
 * is not a git repository or HEAD cannot be resolved (unborn branch).
 */
export function headCommitReader(folder: string, ttlMs = HEAD_COMMIT_TTL_MS): () => string | undefined {
  let cached: { value: string | undefined; at: number } | undefined;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const sha = gitOut(folder, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.toLowerCase();
    cached = { value: sha && COMMIT_SHA.test(sha) ? sha : undefined, at: now };
    return cached.value;
  };
}

/**
 * The repository identity for a resolved KB anchor, or undefined when there is
 * none. `remoteUrl` is set only when the folder lives on another host: then
 * the identity is that remote and the commit is unknown (git cannot run
 * there). Otherwise the identity is the local folder's origin remote and the
 * commit is its HEAD.
 */
export function resolveRepositoryIdentity(folder: string, remoteUrl?: string): RepositoryIdentity | undefined {
  if (remoteUrl && remoteUrl.trim()) {
    const remote = normaliseRepositoryRemote(remoteUrl);
    return remote ? { remote } : undefined;
  }
  const origin = gitOut(folder, ['remote', 'get-url', 'origin']);
  const remote = origin ? normaliseRepositoryRemote(origin) : undefined;
  return remote ? { remote, commitOf: headCommitReader(folder) } : undefined;
}
