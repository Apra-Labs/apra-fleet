/**
 * create_pull_request -- open a GitHub pull request from the fleet SERVER,
 * using a short-lived GitHub App installation token minted on demand.
 *
 * Why this exists (apra-fleet-6bu): callers used to shell out to `gh pr
 * create` on a member via execute_command. That can never work on a member
 * whose git credentials were provisioned by provision_vcs_auth, because that
 * flow deploys a GitHub App INSTALLATION token (`ghs_...`) and
 * `gh auth login --with-token` rejects installation tokens (401 -- it wants a
 * user-context token). PR creation therefore only ever worked on members that
 * happened to carry a leftover manual `gh auth login`.
 *
 * An installation token minted with `pull_requests: write` CAN create a PR
 * through the REST API, so this tool mints its own token server-side (scoped
 * to just the target repo, minimal permissions) and calls
 * `POST /repos/{owner}/{repo}/pulls` directly -- no member-side `gh`, no
 * member-side auth, no extra dependency (raw fetch, same as github-app.ts).
 *
 * Result contract (callers depend on it -- see the fleet-sprint runner's
 * Publish-PR / Abort-PR steps):
 *   - success      -> text containing "Created pull request #<n>" and the URL
 *   - already open -> text containing the phrase "already exists" (an
 *                     idempotent success, NOT an error), plus the existing
 *                     PR's URL when GitHub reports one
 *   - anything else-> text starting with the ASCII marker "ERROR:" so a caller
 *                     can detect the failure and fall back to its own path
 */

import { z } from 'zod';
import { getGitHubApp } from '../services/git-config.js';
import { loadPrivateKey, mintGitToken } from '../services/github-app.js';
import { logLine } from '../utils/log-helpers.js';

const GITHUB_API = 'https://api.github.com';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Minimal permission set an installation token needs to open a PR. */
const PR_PERMISSIONS: Record<string, string> = {
  pull_requests: 'write',
  contents: 'read',
  metadata: 'read',
};

export const createPullRequestSchema = z.object({
  repo: z.string().describe('Target repository as "owner/name" (e.g. "Apra-Labs/apra-fleet").'),
  base: z.string().min(1).describe('Branch the PR merges INTO (e.g. "main").'),
  head: z.string().min(1).describe('Branch containing the changes. Must already be pushed to the remote.'),
  title: z.string().min(1).describe('Pull request title.'),
  body: z.string().optional().describe('Pull request body (markdown).'),
  draft: z.boolean().optional().describe('Open the PR as a draft. Defaults to false.'),
});

export type CreatePullRequestInput = z.infer<typeof createPullRequestSchema>;

/**
 * True when a GitHub 422 response describes "a PR for this head already
 * exists" rather than a genuine validation failure. GitHub phrases this as
 * an error entry whose message begins "A pull request already exists for
 * <owner>:<branch>."
 */
function isAlreadyExists(status: number, data: any): boolean {
  if (status !== 422) return false;
  const parts: string[] = [];
  if (data && typeof data.message === 'string') parts.push(data.message);
  if (data && Array.isArray(data.errors)) {
    for (const e of data.errors) {
      if (e && typeof e.message === 'string') parts.push(e.message);
    }
  }
  return parts.some(m => /already exists/i.test(m));
}

/** Flatten a GitHub error payload into one readable line. */
function githubErrorText(data: any): string {
  const msg = data && typeof data.message === 'string' ? data.message : 'unknown error';
  const details = data && Array.isArray(data.errors)
    ? data.errors
      .map((e: any) => (e && (e.message || `${e.field ?? ''} ${e.code ?? ''}`.trim())) || '')
      .filter(Boolean)
      .join('; ')
    : '';
  return details ? `${msg} (${details})` : msg;
}

export async function createPullRequest(input: CreatePullRequestInput): Promise<string> {
  const repo = String(input.repo ?? '').trim();
  if (!REPO_RE.test(repo)) {
    return `ERROR: Invalid repo "${input.repo}" - expected "owner/name" (e.g. "Apra-Labs/apra-fleet").`;
  }

  const ghApp = getGitHubApp();
  if (!ghApp) {
    return 'ERROR: GitHub App not configured. Run setup_git_app first, or create the PR another way.';
  }

  let privateKey: string;
  try {
    privateKey = loadPrivateKey(ghApp.privateKeyPath);
  } catch (err: any) {
    return `ERROR: Failed to load GitHub App private key: ${err.message}`;
  }

  let token: string;
  try {
    const minted = await mintGitToken(ghApp.appId, privateKey, ghApp.installationId, [repo], PR_PERMISSIONS);
    token = minted.token;
  } catch (err: any) {
    return `ERROR: Token mint failed for ${repo}: ${err.message}`;
  }

  const payload: Record<string, unknown> = {
    title: input.title,
    head: input.head,
    base: input.base,
  };
  if (input.body !== undefined) payload.body = input.body;
  if (input.draft !== undefined) payload.draft = input.draft;

  let status: number;
  let data: any;
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    status = res.status;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } catch (err: any) {
    return `ERROR: POST /repos/${repo}/pulls failed: ${err.message}`;
  }

  if (status >= 200 && status < 300) {
    logLine('create_pull_request', `repo=${repo} head=${input.head} base=${input.base} pr=${data?.number}`);
    return `Created pull request #${data?.number} in ${repo}\n`
      + `  ${data?.html_url ?? '(no url returned)'}\n`
      + `  ${input.head} -> ${input.base}`;
  }

  if (isAlreadyExists(status, data)) {
    // Idempotent success: the desired end state (an open PR for this head)
    // already holds. Callers grep for the phrase "already exists".
    logLine('create_pull_request', `repo=${repo} head=${input.head} base=${input.base} already-exists`);
    const url = typeof data?.errors?.[0]?.message === 'string'
      ? (/https?:\/\/\S+/.exec(data.errors[0].message) || [])[0]
      : undefined;
    return `A pull request already exists for ${repo} head "${input.head}" -- treating as success.\n`
      + `  ${url ? url.replace(/[.,)]+$/, '') : `${githubErrorText(data)}`}`;
  }

  return `ERROR: POST /repos/${repo}/pulls returned ${status}: ${githubErrorText(data)}`;
}
