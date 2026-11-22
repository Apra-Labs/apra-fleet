// The repository a remote KB request is about, as the HTTP provider sends it.
//
// kb_* tools take no repository argument: fleet resolves the repository from
// the calling session (kb-self.ts). HttpKbProvider forwards that resolved
// repository to a shared remote KB server as two headers, so the server can
// keep repositories apart:
//
//   X-Repository         the normalised origin remote, `host/path`
//   X-Repository-Commit  the HEAD sha of the local folder, when readable
//   X-Repository-Branch  the checked-out branch of the local folder, when on
//                        one (not detached), percent-encoded
//
// All values come ONLY from fleet's resolved anchor, never from tool input.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { gitExecutable } from '../../os/git-executable.js';

export const REPOSITORY_HEADER = 'X-Repository';
export const REPOSITORY_COMMIT_HEADER = 'X-Repository-Commit';
export const REPOSITORY_BRANCH_HEADER = 'X-Repository-Branch';

/** Longest X-Repository-Branch value (after percent-encoding) that is sent. */
export const MAX_BRANCH_LENGTH = 255;

/** Longest X-Repository value a receiving server accepts. */
export const MAX_REPOSITORY_LENGTH = 512;

const AZURE_HOST = 'dev.azure.com';
const VISUALSTUDIO_SUFFIX = '.visualstudio.com';
const URL_SCHEMES = new Set(['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git']);
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;

/** The repository a provider sends with every request. */
export interface RepositoryIdentity {
  /** Normalised origin remote, `host/path` (see normaliseRepositoryRemote). */
  remote: string;
  /**
   * HEAD sha of the local folder; undefined when unknown. Must not throw. May
   * return a promise (only a reader's very first read does); the provider awaits it.
   */
  commitOf?: () => string | undefined | Promise<string | undefined>;
  /**
   * Checked-out branch of the local folder, percent-encoded; undefined when
   * unknown or HEAD is detached. Must not throw. May return a promise like commitOf.
   */
  branchOf?: () => string | undefined | Promise<string | undefined>;
  /**
   * The raw origin URL now configured in the local folder when its normalised
   * form differs from `remote`, else undefined. Never blocks and never throws:
   * it returns the last value read and refreshes in the background once the
   * TTL has expired, so a change shows within about one TTL.
   */
  originChange?: () => string | undefined;
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

  // Real userinfo sits in the authority and is already stripped. An '@' still in
  // the path means the parser misread credentials as the host (a password with a
  // numeric prefix and a '/', e.g. `https://u:1234/pw@host/o/r` turns `u:1234`
  // into host `u` and a port). Checked before the query/fragment strip so a
  // `#`/`?` in such a password cannot hide the '@'. Send no header.
  if (pathPart.includes('@')) return undefined;
  // Query and fragment never identify a repository and can carry tokens.
  pathPart = pathPart.replace(/[?#].*$/, '');
  const host = hostPart.toLowerCase();
  const repoPath = pathPart
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  // The host must be a hostname or a bracketed IPv6 literal. Anything else (a
  // password containing '/', a query before the path, a non-numeric port) means
  // the authority was not parsed as the remote intended, and what is left could
  // carry credentials or tokens: send no header rather than a leaking one.
  if (!repoPath || !HOSTNAME.test(host)) return undefined;

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

// escapePercent: also encode a literal '%' as %25. Needed where the value is a
// free-form name (the branch), else 'a%C3%A9' and 'a' + U+00E9 encode alike and
// a server cannot decode reliably. NOT used for X-Repository: a remote URL is
// already percent-encoded by git/the host (`my%20repo`), the receiving server
// canonicalises that form, and re-escaping would turn it into `my%2520repo` and
// break the match with the server's own key.
function percentEncode(value: string, escapePercent = false): string {
  let out = '';
  for (const ch of value) {
    out += /^[!-~]$/.test(ch) && !(escapePercent && ch === '%')
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

/**
 * Run git in `folder` without blocking the event loop (execFile, never the
 * sync variants: this runs on the KB HTTP request path). Undefined on any
 * failure or after the 3 s timeout.
 */
function gitOut(folder: string, args: string[]): Promise<string | undefined> {
  // Same ceiling as resolveProjectSlug / kb-self: the folder itself must be the
  // repository, never a checkout it merely sits inside.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(folder) };
  return new Promise(resolve => {
    try {
      execFile(gitExecutable(), args, {
        cwd: folder, env, encoding: 'utf-8', timeout: 3000, windowsHide: true,
      }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * A stale-while-revalidate reader around an async `read`. The first call
 * returns the in-flight promise (the only time a caller waits, bounded by the
 * read's own timeout); later calls return the last value immediately and, once
 * `ttlMs` has passed, start at most one background refresh. Concurrent calls
 * share one in-flight read. A failed read yields undefined (never throws).
 * `seed` pre-fills the cache so even the first call returns at once.
 */
function staleWhileRevalidate<T>(
  read: () => Promise<T | undefined>,
  ttlMs: number,
  seed?: { value: T | undefined },
): () => T | undefined | Promise<T | undefined> {
  let cached: { value: T | undefined; at: number } | undefined = seed ? { value: seed.value, at: Date.now() } : undefined;
  let inflight: Promise<T | undefined> | undefined;
  const refresh = (): Promise<T | undefined> => {
    inflight ??= read().catch(() => undefined).then(value => {
      cached = { value, at: Date.now() };
      inflight = undefined;
      return value;
    });
    return inflight;
  };
  return () => {
    if (!cached) return refresh();
    if (Date.now() - cached.at >= ttlMs) void refresh();
    return cached.value;
  };
}

/** A full SHA-1 or SHA-256 commit id, lowercase. */
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How long a read HEAD sha is reused before git is asked again. */
export const HEAD_COMMIT_TTL_MS = 5000;

/**
 * A reader for the HEAD sha of a local folder, stale-while-revalidate (see
 * staleWhileRevalidate): after the TTL a call still gets the last value at
 * once and one background git read refreshes it. Resolves/returns undefined
 * (never throws) when the folder is not a git repository or HEAD cannot be
 * resolved (unborn branch), or git fails or times out.
 */
export function headCommitReader(folder: string, ttlMs = HEAD_COMMIT_TTL_MS): () => string | undefined | Promise<string | undefined> {
  return staleWhileRevalidate(async () => {
    const sha = (await gitOut(folder, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.toLowerCase();
    return sha && COMMIT_SHA.test(sha) ? sha : undefined;
  }, ttlMs);
}

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * True when `value` is an X-Repository-Branch value that may be sent: 1-255
 * printable ASCII characters, no spaces.
 */
export function isValidBranchValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_BRANCH_LENGTH && /^[!-~]+$/.test(value);
}

/**
 * The header value for a branch name: '%' and characters outside printable
 * ASCII (non-ASCII, control, space) percent-encoded as UTF-8, so the value
 * decodes unambiguously. Undefined when the
 * result is empty or longer than MAX_BRANCH_LENGTH.
 */
export function branchHeaderValue(branch: string): string | undefined {
  const value = percentEncode(branch, true);
  return isValidBranchValue(value) ? value : undefined;
}

/**
 * A reader for the checked-out branch of a local folder (`git symbolic-ref
 * --quiet HEAD`, with `refs/heads/` stripped), stale-while-revalidate like
 * headCommitReader, so a branch switch shows within about one TTL. `--short` is not
 * used: it prints `heads/x` when a tag `x` also exists. Returns the header value
 * (see branchHeaderValue), or undefined (never throws) on a detached HEAD, a HEAD
 * not under refs/heads/, a folder that is not a git repository, a git failure or
 * timeout, or an invalid value.
 */
export function headBranchReader(folder: string, ttlMs = HEAD_COMMIT_TTL_MS): () => string | undefined | Promise<string | undefined> {
  return staleWhileRevalidate(async () => {
    const ref = await gitOut(folder, ['symbolic-ref', '--quiet', 'HEAD']);
    const branch = ref?.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : undefined;
    return branch ? branchHeaderValue(branch) : undefined;
  }, ttlMs);
}

/**
 * The repository identity for a resolved KB anchor, or undefined when there is
 * none. `remoteUrl` is set only when the folder lives on another host: then
 * the identity is that remote and the commit and branch are unknown (git
 * cannot run there). Otherwise the identity is the local folder's origin
 * remote, the commit is its HEAD and the branch its checked-out branch.
 */
export async function resolveRepositoryIdentity(
  folder: string, remoteUrl?: string, ttlMs = HEAD_COMMIT_TTL_MS,
): Promise<RepositoryIdentity | undefined> {
  if (remoteUrl && remoteUrl.trim()) {
    const remote = normaliseRepositoryRemote(remoteUrl);
    return remote ? { remote } : undefined;
  }
  const origin = await gitOut(folder, ['remote', 'get-url', 'origin']);
  const remote = origin ? normaliseRepositoryRemote(origin) : undefined;
  if (!remote) return undefined;
  // The origin is re-read on the same TTL as HEAD, seeded with the value just
  // read so it never waits. A change is not applied to this identity (X-Repository
  // stays what X-KB-Project, derived from the same origin, says): it is reported
  // through originChange and the caller re-selects the provider.
  const readOrigin = staleWhileRevalidate(() => gitOut(folder, ['remote', 'get-url', 'origin']), ttlMs, { value: origin });
  return {
    remote,
    commitOf: headCommitReader(folder, ttlMs),
    branchOf: headBranchReader(folder, ttlMs),
    originChange: () => {
      const url = readOrigin();
      const next = typeof url === 'string' ? normaliseRepositoryRemote(url) : undefined;
      return next !== undefined && next !== remote ? (url as string) : undefined;
    },
  };
}
