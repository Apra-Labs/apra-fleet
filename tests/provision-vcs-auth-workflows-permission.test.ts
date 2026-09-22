// apra-fleet-2wdc.8 (Track B1): pin the wiring from a REGISTERED MEMBER's
// git_access level, through the real provision_vcs_auth handler, to the
// actual outbound GitHub token-mint HTTP request -- proving a push-level
// member's minted token really requests workflows: 'write'.
//
// WHY A SEPARATE FILE FROM tests/provision-vcs-auth.test.ts. That file's
// top-level `vi.mock('../src/services/github-app.js', ...)` replaces
// mintGitToken() wholesale for every test in it (including its own
// "github-app mode deploys successfully" case), so nothing there ever
// executes the real mapAccessLevel() -> mintGitToken() -> fetch() chain --
// it only proves provisionVcsAuth() CALLS mintGitToken, not what request
// mintGitToken actually sends. tests/github-app.test.ts separately proves
// mintGitToken() sends the right body for a given permission map, but calls
// it directly with a hand-built `permissions` argument -- it never goes
// through a registered member's git_access field or the provisionVcsAuth
// handler at all.
//
// This file leaves src/services/github-app.js UNMOCKED (so mapAccessLevel,
// mintGitToken and createAppJWT all run for real) and stubs only the actual
// network boundary, global fetch -- the outbound GitHub HTTP call itself --
// per this bead's Track B1 instruction. That is the one gap neither existing
// suite covers: a member registered at git_access 'push' -> the real handler
// -> the real permission map -> the real POST body.
//
// ASCII only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, FLEET_DIR } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import type { SSHExecResult } from '../src/types.js';

const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

const mockCollectOobApiKey = vi.fn<(memberName: string, toolName: string, opts?: any) => Promise<{ password?: string; fallback?: string }>>();
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: (memberName: string, toolName: string, opts?: any) => mockCollectOobApiKey(memberName, toolName, opts),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// A real RSA keypair, exactly as tests/github-app.test.ts generates one --
// createAppJWT() really signs with it (RS256), so this test genuinely
// exercises the real signing path, not a stub.
const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_KEY_PATH = path.join(os.tmpdir(), `fleet-test-wf-perm-key-${Date.now()}.pem`);

function setGitHubAppConfig(): void {
  const config = {
    version: '1.0',
    github: { appId: '123', privateKeyPath: TEST_KEY_PATH, installationId: 999, createdAt: '2026-01-01T00:00:00Z' },
  };
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

let gitConfigBackup: string | null = null;
const originalFetch = global.fetch;

describe('provisionVcsAuth wiring: a registered member git_access level -> the real minted-token request body', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockCollectOobApiKey.mockResolvedValue({ fallback: '[FAIL] OOB cancelled in test.' });
    fs.writeFileSync(TEST_KEY_PATH, testPrivateKey);
    if (fs.existsSync(GIT_CONFIG_PATH)) {
      gitConfigBackup = fs.readFileSync(GIT_CONFIG_PATH, 'utf-8');
    }
    setGitHubAppConfig();
  });

  afterEach(() => {
    restoreRegistry();
    if (gitConfigBackup !== null) {
      fs.writeFileSync(GIT_CONFIG_PATH, gitConfigBackup);
      gitConfigBackup = null;
    } else if (fs.existsSync(GIT_CONFIG_PATH)) {
      fs.unlinkSync(GIT_CONFIG_PATH);
    }
    if (fs.existsSync(TEST_KEY_PATH)) fs.unlinkSync(TEST_KEY_PATH);
    global.fetch = originalFetch;
  });

  function stubTokenMintFetch() {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/access_tokens')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ token: 'ghs_wired_token_value', expires_at: '2026-09-22T12:00:00Z' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('a member registered with git_access "push" mints a token whose request body carries workflows: "write"', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-wire-push', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const fetchMock = stubTokenMintFetch();

    const { text } = await provisionVcsAuth({ member_id: member.id, provider: 'github' });
    expect(text).toContain('[OK]');
    expect(text).not.toContain('ghs_wired_token_value'); // token itself must stay masked

    const tokenCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/access_tokens'));
    expect(tokenCall).toBeDefined();
    const [url, opts] = tokenCall!;
    expect(String(url)).toContain('/app/installations/999/access_tokens');
    const body = JSON.parse((opts as { body: string }).body);
    // The whole point of apra-fleet-2wdc: a push-level member's minted token
    // must request workflows: 'write', not just contents: 'write'.
    expect(body.permissions).toMatchObject({ contents: 'write', metadata: 'read', workflows: 'write' });
  });

  it('a member registered with git_access "read" mints a token whose request body does NOT carry workflows', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-wire-read', gitAccess: 'read', gitRepos: ['Org/Repo'] });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const fetchMock = stubTokenMintFetch();

    const { text } = await provisionVcsAuth({ member_id: member.id, provider: 'github' });
    expect(text).toContain('[OK]');

    const tokenCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/access_tokens'));
    expect(tokenCall).toBeDefined();
    const [, opts] = tokenCall!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.permissions).not.toHaveProperty('workflows');
    expect(body.permissions).toEqual({ contents: 'read', metadata: 'read' });
  });

  it('a member registered with git_access "admin" mints a token whose request body carries workflows: "write"', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-wire-admin', gitAccess: 'admin', gitRepos: ['Org/Repo'] });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const fetchMock = stubTokenMintFetch();

    await provisionVcsAuth({ member_id: member.id, provider: 'github' });

    const tokenCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/access_tokens'));
    const [, opts] = tokenCall!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.permissions.workflows).toBe('write');
  });
});
