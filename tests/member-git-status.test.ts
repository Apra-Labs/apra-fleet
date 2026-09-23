/**
 * Unit coverage for the member_git_status building blocks
 * (apra-fleet-4qtu.3.1, src/services/git-status-probe.ts): the per-OS/shell
 * probe command builders, the porcelain v2 / worktree parsers, the
 * not-a-work-tree rule and the origin slug table.
 *
 * Nothing here touches a member, the registry or the filesystem -- every
 * function under test is pure, and the PowerShell builders are asserted on
 * their DECODED script (decodePowerShellEncodedCommand, tests/test-helpers.ts)
 * so the assertions survive the base64 wrapping wrapPowerShellEncoded applies.
 */
import { describe, it, expect } from 'vitest';
import { decodePowerShellEncodedCommand } from './test-helpers.js';
import {
  buildGitStatusProbes,
  isInsideWorkTree,
  parsePorcelainV2,
  parseWorktreeList,
  originSlugFromUrl,
  PLAYBOOK_FILES,
  BIBLE_PATH,
  type GitProbeName,
} from '../src/services/git-status-probe.js';

const EXPECTED_ORDER: GitProbeName[] = [
  'insideWorkTree', 'status', 'worktrees', 'originUrl', 'playbooks', 'bibleCommit',
];

/** The decoded text of a probe -- identity for POSIX, the script for PowerShell. */
function scriptOf(command: string): string {
  return decodePowerShellEncodedCommand(command);
}

describe('buildGitStatusProbes', () => {
  it('returns the F2 probe sequence in order for every supported shell', () => {
    const matrix = [
      buildGitStatusProbes('/work/repo', 'linux'),
      buildGitStatusProbes('/c/work/repo', 'windows', 'gitbash'),
      buildGitStatusProbes('C:\\work\\repo', 'windows', 'pwsh7'),
      buildGitStatusProbes('C:\\work\\repo', 'windows', 'powershell5'),
    ];
    for (const probes of matrix) {
      expect(probes.map((p) => p.name)).toEqual(EXPECTED_ORDER);
    }
  });

  describe('POSIX (linux member)', () => {
    const probes = buildGitStatusProbes('/work/repo', 'linux');
    const byName = Object.fromEntries(probes.map((p) => [p.name, p.command]));

    it('builds plain (un-encoded) git -C commands against the resolved folder', () => {
      expect(byName.insideWorkTree).toBe("git -C '/work/repo' rev-parse --is-inside-work-tree");
      expect(byName.status).toBe("git -C '/work/repo' status --porcelain=v2 --branch");
      expect(byName.worktrees).toBe("git -C '/work/repo' worktree list --porcelain");
      expect(byName.originUrl).toBe("git -C '/work/repo' remote get-url origin");
      expect(byName.bibleCommit).toBe(`git -C '/work/repo' log -1 --format='%H' -- '${BIBLE_PATH}'`);
    });

    it('probes each playbook by resolved absolute path and prints its bare name', () => {
      for (const file of PLAYBOOK_FILES) {
        expect(byName.playbooks).toContain(`[ -f '/work/repo/${file}' ]`);
        expect(byName.playbooks).toContain(`printf '%s\\n' '${file}'`);
      }
      // A missing last playbook must not make the probe look like a failure.
      expect(byName.playbooks.endsWith('; true')).toBe(true);
    });

    it('single-quotes a folder containing a quote rather than breaking out of the string', () => {
      const [first] = buildGitStatusProbes("/work/it's", 'linux');
      expect(first.command).toBe("git -C '/work/it'\\''s' rev-parse --is-inside-work-tree");
    });
  });

  describe('Git Bash on Windows', () => {
    const probes = buildGitStatusProbes('/c/work/repo', 'windows', 'gitbash');

    it('is treated as POSIX: no PowerShell encoding, forward-slash playbook paths', () => {
      for (const probe of probes) {
        expect(probe.command).not.toContain('-EncodedCommand');
      }
      expect(probes[0].command).toBe("git -C '/c/work/repo' rev-parse --is-inside-work-tree");
      expect(probes[4].command).toContain("[ -f '/c/work/repo/deploy.md' ]");
    });
  });

  for (const shell of ['pwsh7', 'powershell5'] as const) {
    describe(`PowerShell (${shell})`, () => {
      const probes = buildGitStatusProbes('C:\\work\\repo', 'windows', shell);
      const byName = Object.fromEntries(probes.map((p) => [p.name, p.command]));

      it('wraps every probe as a base64 -EncodedCommand invocation', () => {
        for (const probe of probes) {
          expect(probe.command.startsWith('powershell -EncodedCommand ')).toBe(true);
        }
      });

      it('carries the resolved folder as a literal single-quoted path in the decoded script', () => {
        expect(scriptOf(byName.insideWorkTree)).toContain("git -C 'C:\\work\\repo' rev-parse --is-inside-work-tree");
        expect(scriptOf(byName.status)).toContain("git -C 'C:\\work\\repo' status --porcelain=v2 --branch");
        expect(scriptOf(byName.worktrees)).toContain("git -C 'C:\\work\\repo' worktree list --porcelain");
        expect(scriptOf(byName.originUrl)).toContain("git -C 'C:\\work\\repo' remote get-url origin");
        expect(scriptOf(byName.bibleCommit)).toContain(`git -C 'C:\\work\\repo' log -1 --format='%H' -- '${BIBLE_PATH}'`);
      });

      it('tests each playbook with a backslash-joined literal path', () => {
        const script = scriptOf(byName.playbooks);
        for (const file of PLAYBOOK_FILES) {
          expect(script).toContain(`Test-Path -LiteralPath 'C:\\work\\repo\\${file}'`);
          expect(script).toContain(`Write-Output '${file}'`);
        }
      });

      it('never emits a shell variable or tilde path a member shell could expand', () => {
        for (const probe of probes) {
          const script = scriptOf(probe.command);
          // $ErrorActionPreference/$LASTEXITCODE/$_ belong to
          // wrapPowerShellEncoded's own guard prologue, which is the same for
          // every command in this codebase; the probe's own payload must add
          // no variable of its own.
          const payload = script
            .replace(/^\$ErrorActionPreference = 'Stop'; try \{ /, '')
            .replace(/; if \(\$LASTEXITCODE[\s\S]*$/, '');
          expect(payload).not.toMatch(/\$env:/);
          expect(payload).not.toMatch(/\$[A-Za-z_]/);
          expect(payload).not.toContain('~');
          expect(payload).not.toContain('%USERPROFILE%');
        }
      });

      it('doubles an embedded single quote instead of ending the literal', () => {
        const [first] = buildGitStatusProbes("C:\\work\\it's", 'windows', shell);
        expect(scriptOf(first.command)).toContain("git -C 'C:\\work\\it''s' rev-parse");
      });
    });
  }

  it('leaves no unexpanded shell variable or tilde in any POSIX probe', () => {
    for (const probe of buildGitStatusProbes('/work/repo', 'linux')) {
      expect(probe.command).not.toMatch(/\$[A-Za-z_{]/);
      expect(probe.command).not.toContain('~');
    }
  });
});

describe('isInsideWorkTree (DQ-27 non-git rule)', () => {
  it('accepts only exit 0 with true', () => {
    expect(isInsideWorkTree('true\n', 0)).toBe(true);
    expect(isInsideWorkTree('  TRUE  ', 0)).toBe(true);
  });

  it('treats a non-git folder as a normal negative answer, not an error', () => {
    // git's own failure on a plain folder
    expect(isInsideWorkTree('fatal: not a git repository (or any of the parent directories): .git\n', 128)).toBe(false);
    // the PowerShell wrapper catching that same failure
    expect(isInsideWorkTree('', 1)).toBe(false);
    // inside a bare repo's .git dir git prints false and exits 0
    expect(isInsideWorkTree('false\n', 0)).toBe(false);
  });
});

describe('parsePorcelainV2', () => {
  it('reports a clean checkout with an upstream', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');

    expect(parsePorcelainV2(out)).toEqual({
      branch: 'main',
      detached: false,
      head: '1111111111111111111111111111111111111111',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      dirty: false,
      dirtyFiles: [],
    });
  });

  it('reports modified, staged, renamed, unmerged and untracked paths, and skips ignored ones', () => {
    const out = [
      '# branch.oid 2222222222222222222222222222222222222222',
      '# branch.head feat/topic',
      '# branch.upstream origin/feat/topic',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/changed.ts',
      '1 A. N... 000000 100644 100644 0000 cccc src/added file.ts',
      '2 R. N... 100644 100644 100644 dddd eeee R100 docs/new.md\tdocs/old.md',
      'u UU N... 100644 100644 100644 100644 ffff 1111 2222 src/conflict.ts',
      '? notes.txt',
      '! dist/bundle.js',
      '',
    ].join('\n');

    const parsed = parsePorcelainV2(out);
    expect(parsed.branch).toBe('feat/topic');
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
    expect(parsed.dirty).toBe(true);
    expect(parsed.dirtyFiles).toEqual([
      { code: '.M', path: 'src/changed.ts' },
      { code: 'A.', path: 'src/added file.ts' },
      { code: 'R.', path: 'docs/new.md' },
      { code: 'UU', path: 'src/conflict.ts' },
      { code: '??', path: 'notes.txt' },
    ]);
  });

  it('reports a detached HEAD with no branch and no upstream', () => {
    const out = [
      '# branch.oid 3333333333333333333333333333333333333333',
      '# branch.head (detached)',
      '',
    ].join('\n');

    const parsed = parsePorcelainV2(out);
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeNull();
    expect(parsed.upstream).toBeNull();
    expect(parsed.ahead).toBeNull();
    expect(parsed.behind).toBeNull();
    expect(parsed.head).toBe('3333333333333333333333333333333333333333');
  });

  it('reports a branch with no upstream as ahead/behind null, not zero', () => {
    const out = ['# branch.oid 4444444444444444444444444444444444444444', '# branch.head local-only', ''].join('\n');
    const parsed = parsePorcelainV2(out);
    expect(parsed.branch).toBe('local-only');
    expect(parsed.upstream).toBeNull();
    expect(parsed.ahead).toBeNull();
    expect(parsed.behind).toBeNull();
  });

  it('reports an unborn branch as head null', () => {
    const out = ['# branch.oid (initial)', '# branch.head main', ''].join('\n');
    const parsed = parsePorcelainV2(out);
    expect(parsed.head).toBeNull();
    expect(parsed.branch).toBe('main');
  });

  it('tolerates CRLF output from a Windows member', () => {
    const out = '# branch.oid 5555555555555555555555555555555555555555\r\n# branch.head main\r\n? notes.txt\r\n';
    const parsed = parsePorcelainV2(out);
    expect(parsed.branch).toBe('main');
    expect(parsed.dirtyFiles).toEqual([{ code: '??', path: 'notes.txt' }]);
  });
});

describe('parseWorktreeList', () => {
  it('parses the main work tree plus a linked and a detached one', () => {
    const out = [
      'worktree /work/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /work/repo-feat',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/topic',
      'locked',
      '',
      'worktree /work/repo-detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreeList(out)).toEqual([
      { path: '/work/repo', head: '1111111111111111111111111111111111111111', branch: 'main', detached: false, bare: false, locked: false },
      { path: '/work/repo-feat', head: '2222222222222222222222222222222222222222', branch: 'feat/topic', detached: false, bare: false, locked: true },
      { path: '/work/repo-detached', head: '3333333333333333333333333333333333333333', branch: null, detached: true, bare: false, locked: false },
    ]);
  });

  it('parses a bare repository entry and an empty listing', () => {
    expect(parseWorktreeList('worktree /srv/mirror.git\nbare\n')).toEqual([
      { path: '/srv/mirror.git', head: null, branch: null, detached: false, bare: true, locked: false },
    ]);
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('originSlugFromUrl', () => {
  const table: Array<[string, string | null]> = [
    ['git@github.com:Apra-Labs/apra-fleet.git', 'github.com/apra-labs/apra-fleet'],
    ['git@github.com:Apra-Labs/apra-fleet', 'github.com/apra-labs/apra-fleet'],
    ['https://github.com/Apra-Labs/apra-fleet.git', 'github.com/apra-labs/apra-fleet'],
    ['https://github.com/Apra-Labs/apra-fleet', 'github.com/apra-labs/apra-fleet'],
    ['https://user:token@github.com/Apra-Labs/apra-fleet.git', 'github.com/apra-labs/apra-fleet'],
    ['ssh://git@github.com:22/Apra-Labs/apra-fleet.git', 'github.com/apra-labs/apra-fleet'],
    ['https://GitHub.com/Apra-Labs/apra-fleet/', 'github.com/apra-labs/apra-fleet'],
    ['ssh://git@ssh.dev.azure.com/v3/apra/proj/repo', 'ssh.dev.azure.com/v3/apra/proj/repo'],
    ['file:///srv/git/widgets.git', 'widgets'],
    ['/srv/git/widgets.git', 'widgets'],
    ['C:\\repos\\Widgets', 'widgets'],
    ['', null],
    ['   ', null],
  ];

  for (const [url, expected] of table) {
    it(`maps ${JSON.stringify(url)} to ${JSON.stringify(expected)}`, () => {
      expect(originSlugFromUrl(url)).toBe(expected);
    });
  }

  it('returns null for an absent remote', () => {
    expect(originSlugFromUrl(null)).toBeNull();
    expect(originSlugFromUrl(undefined)).toBeNull();
  });

  it('maps every spelling of one repository to the same slug', () => {
    const spellings = [
      'git@github.com:Apra-Labs/apra-fleet.git',
      'https://github.com/Apra-Labs/apra-fleet.git',
      'https://github.com/apra-labs/apra-fleet',
      'ssh://git@github.com:22/Apra-Labs/apra-fleet',
    ];
    expect(new Set(spellings.map((s) => originSlugFromUrl(s))).size).toBe(1);
  });
});
