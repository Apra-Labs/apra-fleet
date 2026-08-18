import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import type { SSHExecResult } from '../src/types.js';

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
