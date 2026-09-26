import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import type { SSHExecResult } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * member_detail is the ONLY MCP surface the fleet-sprint engine has for member
 * facts (runner.js:1541 -- it coordinates members by name and has no registry
 * of its own). The engine's 7 kb_* call sites therefore cannot scope a remote
 * member's KB without this tool reporting the member's origin URL: with
 * repo_path alone, resolveProjectSlug shells out to git in a directory that
 * does not exist on the fleet server, both probes fail, and every remote member
 * collapses into the shared 'default' KB (src/services/knowledge/project-slug.ts).
 *
 * The forwarding rule is knownRepoRemoteUrl()'s and is deliberately narrow:
 * gitRepos is an ACCESS LIST, not an origin field, so only a single-entry list
 * holding a genuine URL is unambiguous. Anything else stays absent -- a guessed
 * URL routes writes into a slug that does not match the repo's real local-clone
 * slug, which is worse than the honest 'default' degradation.
 */

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

function setupDefaultMock(): void {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
    if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
    return { stdout: 'N/A', stderr: '', code: 0 };
  });
}

async function detailJson(gitRepos?: string[]): Promise<Record<string, unknown>> {
  const member = makeTestAgent({ friendlyName: 'kb-scope-member', gitRepos });
  addAgent(member);
  return JSON.parse(await memberDetail({ member_id: member.id, format: 'json' })) as Record<string, unknown>;
}

describe('member_detail reports the member repo origin URL for KB scoping', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    setupDefaultMock();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reports repo_remote_url when gitRepos holds exactly one https URL', async () => {
    const result = await detailJson(['https://github.com/acme/repo.git']);
    expect(result.repo_remote_url).toBe('https://github.com/acme/repo.git');
  });

  it('reports repo_remote_url when gitRepos holds exactly one ssh URL', async () => {
    const result = await detailJson(['git@github.com:acme/repo.git']);
    expect(result.repo_remote_url).toBe('git@github.com:acme/repo.git');
  });

  it('omits repo_remote_url for a bare "owner/repo" access identifier', async () => {
    const result = await detailJson(['acme/repo']);
    expect(result.repo_remote_url).toBeUndefined();
  });

  it('omits repo_remote_url when gitRepos holds more than one entry', async () => {
    const result = await detailJson(['https://github.com/acme/repo.git', 'https://github.com/acme/other.git']);
    expect(result.repo_remote_url).toBeUndefined();
  });

  it('omits repo_remote_url when the member has no gitRepos at all', async () => {
    const result = await detailJson(undefined);
    expect(result.repo_remote_url).toBeUndefined();
  });

  it('still reports the work folder, which the KB scope needs alongside the URL', async () => {
    const result = await detailJson(['https://github.com/acme/repo.git']);
    expect(result.folder).toBe('/home/testuser/project');
  });
});

describe('member_detail surfaces the shell field (apra-fleet-7dir.1.1)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    setupDefaultMock();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reports shell when set on the member', async () => {
    const member = makeTestAgent({ friendlyName: 'shell-member', shell: 'gitbash' });
    addAgent(member);
    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' })) as Record<string, unknown>;
    expect(result.shell).toBe('gitbash');
  });

  it('omits shell when unset on the member', async () => {
    const member = makeTestAgent({ friendlyName: 'no-shell-member' });
    addAgent(member);
    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' })) as Record<string, unknown>;
    expect(result.shell).toBeUndefined();
  });
});

/**
 * apra-fleet-rp7a.5 -- paired [test] bead for apra-fleet-rp7a.4's fix.
 *
 * member_detail's `gitAccess` field is the fleet-sprint engine's ONLY source
 * for the level a member's VCS credentials are ACTUALLY minted at
 * (register_member/update_member's git_access, stored as Agent.gitAccess).
 * Before apra-fleet-rp7a.4 the Sync-step workflows-permission preflight had
 * no way to read that level at all and could only compare the engine's own
 * provisioning default against itself -- a check that was always true. This
 * field is what makes the registered-vs-default distinction observable.
 */
describe('member_detail surfaces the member\'s registered git access level (apra-fleet-rp7a.4/.5)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    setupDefaultMock();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reports gitAccess when set on the member', async () => {
    const member = makeTestAgent({ friendlyName: 'git-access-member', gitAccess: 'push+pr' });
    addAgent(member);
    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' })) as Record<string, unknown>;
    expect(result.gitAccess).toBe('push+pr');
  });

  it('omits gitAccess when the member was registered without an explicit level', async () => {
    const member = makeTestAgent({ friendlyName: 'no-git-access-member' });
    addAgent(member);
    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' })) as Record<string, unknown>;
    expect(result.gitAccess).toBeUndefined();
  });

  // Guards apra-fleet-client's src/client/api.mjs (the thin wrapper other
  // packages, including fleet-sprint, use to call member_detail) against
  // drifting from what this tool actually returns -- per this repo's
  // CLAUDE.md, that client is not optional cleanup, it is part of the tool
  // change itself. packages/apra-fleet-client/test/client-server-typedef-
  // parity.test.mjs already asserts FULL field-for-field parity generically
  // (any field either side gains/loses), but that suite runs under its own
  // package's `npm test` (node:test), not the repo-root `npm test` this file
  // is part of -- so this reads the real typedef source directly (never a
  // copied fixture) and pins the ONE field this bead is about, inside the
  // suite that IS part of the repo-root run.
  it('the client wrapper\'s MemberDetailResult typedef declares gitAccess, matching the field member_detail.ts surfaces above', () => {
    const apiMjsSrc = fs.readFileSync(
      path.join(repoRoot, 'packages', 'apra-fleet-client', 'src', 'client', 'api.mjs'),
      'utf8',
    );
    const typedefStart = apiMjsSrc.indexOf('@typedef {Object} MemberDetailResult');
    expect(typedefStart, 'MemberDetailResult typedef not found in apra-fleet-client/src/client/api.mjs').not.toBe(-1);
    const typedefEnd = apiMjsSrc.indexOf('*/', typedefStart);
    expect(typedefEnd, 'unterminated MemberDetailResult typedef block').not.toBe(-1);
    const typedefBlock = apiMjsSrc.slice(typedefStart, typedefEnd);

    expect(typedefBlock).toMatch(/@property\s+\{[^}]*\}\s+\[gitAccess\]/);
  });
});
