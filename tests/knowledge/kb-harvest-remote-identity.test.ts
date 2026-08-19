/**
 * apra-fleet-tm7.9.1 / tm7.9.2: a REMOTE member's auto-harvest must be routed
 * by its repo's real origin URL, not by its work-folder path.
 *
 * Why the path is not enough. resolveProjectSlug (project-slug.ts) derives the
 * KB slug by running git in the directory it is given. A remote member's work
 * folder is a path on ANOTHER machine: on the fleet server both git probes
 * fail against it, the slug degrades to 'default', and every remote member's
 * harvested knowledge lands in one shared bucket instead of that repo's KB.
 *
 * apra-fleet-b4g.6 already forwards a URL when the registration record happens
 * to hold exactly one genuine URL. That covers a minority of members -- gitRepos
 * is an access list whose entries are usually bare "owner/repo" identifiers,
 * which b4g.6 deliberately refuses to turn into a URL. This closes the rest of
 * the gap by ASKING the member host, once, at registration.
 *
 * WHERE the probe lives is load-bearing, not incidental. Resolving it on the
 * dispatch path was implemented first and reverted: the auto-harvest is
 * detached (`void import(...).then(...)`), so the probe's exec escaped every
 * test's await boundary and raced 157 exec-count assertions across 14 test
 * files, turning unrelated tests intermittently red. Registration already makes
 * three remote round trips for OS detection, so one more there is free, and the
 * dispatch path then issues NO exec of its own -- which is also what
 * tm7.9.1 asks for ("must not add a blocking round trip on the hot path").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import {
  knownRepoRemoteUrl,
  resolveRepoRemoteUrl,
  clearRepoRemoteUrlCache,
} from '../../src/services/member-remote-url.js';
import type { SSHExecResult } from '../../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const ORIGIN_URL = 'https://github.com/acme/widget.git';

function probeReturns(stdout: string, code = 0): void {
  mockExecCommand.mockResolvedValue({ stdout, stderr: '', code });
}

describe('resolveRepoRemoteUrl: asking the member host for its origin URL (apra-fleet-tm7.9.1)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    clearRepoRemoteUrlCache();
  });

  afterEach(() => {
    restoreRegistry();
    clearRepoRemoteUrlCache();
  });

  // The headline: a remote member whose gitRepos carries NO usable URL -- the
  // common case -- still gets a real identity.
  it('resolves the origin URL from the member host when the record has none', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget', gitRepos: ['Apra-Labs/widget'] });
    probeReturns(`${ORIGIN_URL}\n`);

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBe(ORIGIN_URL);
  });

  it('issues the probe against the member work folder', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns(`${ORIGIN_URL}\n`);

    await resolveRepoRemoteUrl(agent);

    const cmd = String(mockExecCommand.mock.calls[0][0]);
    expect(cmd).toContain('git remote get-url origin');
    expect(cmd).toContain('/home/dev/widget');
  });

  // Degradation, not corruption.
  it('returns undefined when the probe exits non-zero', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns('', 128);

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBeUndefined();
  });

  it('returns undefined when the probe throws', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    mockExecCommand.mockRejectedValue(new Error('ssh channel closed'));

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBeUndefined();
  });

  it('treats empty output as no identity', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns('   \n');

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBeUndefined();
  });

  // Shell banners are emitted BEFORE the command's own output -- the same
  // reasoning member-home.ts's home-dir probe relies on.
  it('ignores a login-shell banner preceding the URL', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns(`Welcome to Ubuntu 24.04 LTS\nLast login: Mon\n${ORIGIN_URL}\n`);

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBe(ORIGIN_URL);
  });

  // Adopting arbitrary output is the guessing b4g.6 exists to refuse: a URL
  // that matches no real clone routes writes somewhere worse than 'default'.
  it('rejects output that is not a git remote URL', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns('fatal: not a git repository\n');

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBeUndefined();
  });

  it('never probes a local member -- its path already resolves on this host', async () => {
    const agent = makeTestLocalAgent({ workFolder: '/home/dev/widget' });
    probeReturns(`${ORIGIN_URL}\n`);

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBeUndefined();
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('does not probe when the record already carries a genuine URL', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget', gitRepos: ['git@github.com:acme/widget.git'] });
    probeReturns(`${ORIGIN_URL}\n`);

    await expect(resolveRepoRemoteUrl(agent)).resolves.toBe('git@github.com:acme/widget.git');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('probes once per member -- concurrent callers share one round trip', async () => {
    const agent = makeTestAgent({ workFolder: '/home/dev/widget' });
    probeReturns(`${ORIGIN_URL}\n`);

    const [a, b, c] = await Promise.all([
      resolveRepoRemoteUrl(agent),
      resolveRepoRemoteUrl(agent),
      resolveRepoRemoteUrl(agent),
    ]);

    expect([a, b, c]).toEqual([ORIGIN_URL, ORIGIN_URL, ORIGIN_URL]);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  // Windows members must not receive a POSIX command: the member's own shell
  // may be PowerShell, per the repo's cross-shell rule (apra-fleet-ot2z).
  it('sends an encoded PowerShell command to a Windows member', async () => {
    const agent = makeTestAgent({ workFolder: 'C:\\work\\widget', os: 'windows' });
    probeReturns(`${ORIGIN_URL}\n`);

    await resolveRepoRemoteUrl(agent);

    const cmd = String(mockExecCommand.mock.calls[0][0]);
    expect(cmd).toContain('powershell -EncodedCommand');
    expect(cmd).not.toContain('cd "C:\\work\\widget"');
    const decoded = Buffer.from(cmd.split('powershell -EncodedCommand ')[1], 'base64').toString('utf16le');
    expect(decoded).toContain('git remote get-url origin');
    expect(decoded).toContain('C:\\work\\widget');
  });
});

/**
 * The consumer half: what the dispatch path reads. knownRepoRemoteUrl is what
 * execute_prompt's auto-harvest calls, and it must answer from stored data
 * only -- no exec, so no perturbation of the exec-count assertions that 14
 * test files make about dispatch.
 */
describe('knownRepoRemoteUrl prefers the stored origin URL (apra-fleet-tm7.9.2)', () => {
  it('returns the URL resolved at registration', () => {
    const agent = makeTestAgent({ repoRemoteUrl: ORIGIN_URL, gitRepos: ['Apra-Labs/widget'] });
    expect(knownRepoRemoteUrl(agent)).toBe(ORIGIN_URL);
  });

  it('outranks a gitRepos entry, which is an access list rather than an origin', () => {
    const agent = makeTestAgent({
      repoRemoteUrl: ORIGIN_URL,
      gitRepos: ['https://github.com/acme/some-other-repo.git'],
    });
    expect(knownRepoRemoteUrl(agent)).toBe(ORIGIN_URL);
  });

  it('falls back to the single-genuine-URL rule when nothing was stored', () => {
    const agent = makeTestAgent({ gitRepos: ['https://github.com/acme/widget.git'] });
    expect(knownRepoRemoteUrl(agent)).toBe('https://github.com/acme/widget.git');
  });

  it('stays undefined when neither source qualifies -- the honest default fallback', () => {
    const agent = makeTestAgent({ gitRepos: ['Apra-Labs/widget'] });
    expect(knownRepoRemoteUrl(agent)).toBeUndefined();
  });
});
