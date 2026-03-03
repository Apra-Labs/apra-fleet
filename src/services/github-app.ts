import crypto from 'node:crypto';
import fs from 'node:fs';

const GITHUB_API = 'https://api.github.com';

/**
 * Read and validate a PEM private key file.
 */
export function loadPrivateKey(keyPath: string): string {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key file not found: ${keyPath}`);
  }
  const key = fs.readFileSync(keyPath, 'utf-8').trim();
  if (!key.startsWith('-----BEGIN')) {
    throw new Error('Invalid private key: file does not start with -----BEGIN');
  }
  return key;
}

/**
 * Create a JWT for GitHub App authentication (RS256).
 * Valid for 10 minutes, backdated 60 seconds for clock skew.
 */
export function createAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function githubGet(path: string, jwt: string): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/**
 * Verify GitHub App connectivity: authenticate as the app, then check the installation exists.
 */
export async function verifyAppConnectivity(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<{ ok: boolean; error?: string; appName?: string; orgName?: string }> {
  const jwt = createAppJWT(appId, privateKey);

  const appRes = await githubGet('/app', jwt);
  if (!appRes.ok) {
    return { ok: false, error: `GET /app failed (${appRes.status}): ${appRes.data?.message ?? 'unknown error'}` };
  }

  const installRes = await githubGet(`/app/installations/${installationId}`, jwt);
  if (!installRes.ok) {
    return { ok: false, error: `Installation ${installationId} not found (${installRes.status}): ${installRes.data?.message ?? 'unknown error'}` };
  }

  return {
    ok: true,
    appName: appRes.data.name,
    orgName: installRes.data.account?.login,
  };
}

/**
 * Map fleet access levels to GitHub App installation token permissions.
 */
export function mapAccessLevel(level: string): Record<string, string> {
  const levels: Record<string, Record<string, string>> = {
    read: { contents: 'read', metadata: 'read' },
    push: { contents: 'write', metadata: 'read' },
    admin: { contents: 'write', administration: 'write', actions: 'write', metadata: 'read' },
    issues: { issues: 'write', pull_requests: 'write', metadata: 'read' },
    full: { contents: 'write', administration: 'write', issues: 'write', pull_requests: 'write', actions: 'write', metadata: 'read' },
  };
  return levels[level] ?? levels.read;
}

/**
 * Mint a scoped, short-lived installation access token.
 */
export async function mintGitToken(
  appId: string,
  privateKey: string,
  installationId: number,
  repos: string[],
  permissions: Record<string, string>,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = createAppJWT(appId, privateKey);

  if (repos.some(r => r !== '*' && !/^[\w.-]+\/[\w.-]+$/.test(r))) {
    throw new Error('Invalid repo name format');
  }

  // repos are "owner/name" — GitHub API wants just the name part
  const repoNames = repos.filter(r => r !== '*').map(r => r.split('/').pop()!);

  const body: Record<string, unknown> = { permissions };
  if (repoNames.length > 0) {
    body.repositories = repoNames;
  }

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token mint failed (${res.status}): ${data?.message ?? 'unknown error'}`);
  }

  return { token: data.token, expiresAt: data.expires_at };
}
