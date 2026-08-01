/**
 * Tests for the create_pull_request tool (apra-fleet-6bu).
 *
 * The tool mints a short-lived GitHub App installation token server-side and
 * POSTs to /repos/{owner}/{repo}/pulls, so PR creation no longer depends on a
 * member-side `gh auth login` (which rejects the `ghs_` installation tokens
 * provision_vcs_auth deploys).
 *
 * Covers: success, the 422 "already exists" idempotent path, a missing
 * GitHub App config, and an invalid repo string. `fetch` and the GitHub App
 * config/private-key loaders are mocked -- no network, no real app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getGitHubApp = vi.fn();
const loadPrivateKey = vi.fn();
const mintGitToken = vi.fn();

vi.mock('../src/services/git-config.js', () => ({
  getGitHubApp: () => getGitHubApp(),
}));

vi.mock('../src/services/github-app.js', () => ({
  loadPrivateKey: (p: string) => loadPrivateKey(p),
  mintGitToken: (...args: any[]) => mintGitToken(...args),
}));

import { createPullRequest } from '../src/tools/create-pull-request.js';

const APP_CONFIG = { appId: '12345', privateKeyPath: '/tmp/app.pem', installationId: 999 };

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

const INPUT = {
  repo: 'Apra-Labs/apra-fleet',
  base: 'main',
  head: 'feat/server-side-pr',
  title: 'Auto-sprint [PASS]: feat/server-side-pr',
  body: 'Body text.',
};

describe('create_pull_request', () => {
  beforeEach(() => {
    getGitHubApp.mockReset();
    loadPrivateKey.mockReset();
    mintGitToken.mockReset();
    getGitHubApp.mockReturnValue(APP_CONFIG);
    loadPrivateKey.mockReturnValue('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    mintGitToken.mockResolvedValue({ token: 'ghs_faketoken', expiresAt: '2030-01-01T00:00:00Z' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the PR and returns its number and html_url', async () => {
    const fetchMock = mockFetchOnce(201, {
      number: 4242,
      html_url: 'https://github.com/Apra-Labs/apra-fleet/pull/4242',
    });

    const result = await createPullRequest(INPUT as any);

    expect(result).toContain('Created pull request #4242');
    expect(result).toContain('https://github.com/Apra-Labs/apra-fleet/pull/4242');
    expect(result).not.toMatch(/^ERROR:/m);

    // Token is minted scoped to just this repo, with the minimal PR permissions.
    expect(mintGitToken).toHaveBeenCalledWith(
      APP_CONFIG.appId,
      expect.any(String),
      APP_CONFIG.installationId,
      ['Apra-Labs/apra-fleet'],
      { pull_requests: 'write', contents: 'read', metadata: 'read' },
    );

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Apra-Labs/apra-fleet/pulls');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ghs_faketoken');
    expect(JSON.parse(init.body)).toEqual({
      title: INPUT.title,
      head: INPUT.head,
      base: INPUT.base,
      body: INPUT.body,
    });
  });

  it('passes draft through when requested', async () => {
    const fetchMock = mockFetchOnce(201, { number: 7, html_url: 'https://github.com/o/r/pull/7' });
    await createPullRequest({ ...INPUT, draft: true } as any);
    const [, init] = (fetchMock as any).mock.calls[0];
    expect(JSON.parse(init.body).draft).toBe(true);
  });

  it('treats a 422 "already exists" as an idempotent success containing "already exists"', async () => {
    mockFetchOnce(422, {
      message: 'Validation Failed',
      errors: [
        {
          resource: 'PullRequest',
          message: 'A pull request already exists for Apra-Labs:feat/server-side-pr. https://github.com/Apra-Labs/apra-fleet/pull/11',
        },
      ],
    });

    const result = await createPullRequest(INPUT as any);

    expect(result).toMatch(/already exists/i);
    expect(result).not.toMatch(/^ERROR:/m);
    expect(result).toContain('https://github.com/Apra-Labs/apra-fleet/pull/11');
  });

  it('returns an ERROR: marker when no GitHub App is configured', async () => {
    getGitHubApp.mockReturnValue(undefined);
    const fetchMock = mockFetchOnce(201, {});

    const result = await createPullRequest(INPUT as any);

    expect(result).toMatch(/^ERROR:/);
    expect(result).toMatch(/GitHub App not configured/);
    expect((fetchMock as any).mock.calls.length).toBe(0);
    expect(mintGitToken).not.toHaveBeenCalled();
  });

  it('returns an ERROR: marker for an invalid repo string and never mints a token', async () => {
    const fetchMock = mockFetchOnce(201, {});

    for (const repo of ['apra-fleet', 'owner/repo/extra', '', 'own er/repo']) {
      const result = await createPullRequest({ ...INPUT, repo } as any);
      expect(result).toMatch(/^ERROR:/);
      expect(result).toMatch(/expected "owner\/name"/);
    }

    expect(mintGitToken).not.toHaveBeenCalled();
    expect((fetchMock as any).mock.calls.length).toBe(0);
  });

  it('returns an ERROR: marker for a genuine (non-already-exists) API rejection', async () => {
    mockFetchOnce(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
    });

    const result = await createPullRequest(INPUT as any);

    expect(result).toMatch(/^ERROR:/);
    expect(result).toContain('422');
    expect(result).not.toMatch(/already exists/i);
  });

  it('returns an ERROR: marker when token minting fails', async () => {
    mintGitToken.mockRejectedValue(new Error('Token mint failed (403): Resource not accessible'));
    const fetchMock = mockFetchOnce(201, {});

    const result = await createPullRequest(INPUT as any);

    expect(result).toMatch(/^ERROR:/);
    expect(result).toMatch(/Token mint failed/);
    expect((fetchMock as any).mock.calls.length).toBe(0);
  });
});
