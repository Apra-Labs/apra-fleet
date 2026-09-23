/**
 * Pure building blocks for the member_git_status tool (apra-fleet-4qtu.3.1,
 * design refs F2 / DQ-27): the per-OS/shell probe command builders, the
 * porcelain v2 / worktree parsers and the origin slug normaliser.
 *
 * Nothing here talks to a member, a registry or a strategy -- the tool
 * (src/tools/member-git-status.ts) feeds these commands through the existing
 * execute path and hands the raw stdout back to the parsers, so every rule
 * below is unit-testable without a live checkout.
 *
 * Command-building rules (CLAUDE.md, enforced by the tests):
 *  - Every path is resolved in JavaScript and embedded as a literal. A
 *    member-bound command string must never rely on shell-level expansion
 *    ($HOME, ~, %USERPROFILE%, backticks): the member's shell may be
 *    PowerShell, cmd-hosted PowerShell, or Git Bash, and whichever shell sits
 *    in between would expand (or fail to expand) it differently.
 *  - `git -C <dir>` is used instead of a `cd`/`Set-Location` prelude so the
 *    working directory is an argument, not shell state, and a single string
 *    stays valid in every shell.
 *  - Windows (pwsh7 / powershell5) commands go through wrapPowerShellEncoded
 *    (src/os/windows.ts), which base64/utf16le-encodes the script so it
 *    survives re-tokenisation by an intermediate shell. Paths inside that
 *    script are PowerShell single-quoted literals (escapePowerShellArg), in
 *    which PowerShell performs no variable expansion at all.
 *  - A Windows member registered with shell 'gitbash' is POSIX for this
 *    purpose (isPosixShell), exactly as every other member-bound command
 *    builder in this codebase treats it.
 */
import path from 'node:path';
import type { RemoteOS } from '../utils/platform.js';
import type { MemberShell } from '../os/os-commands.js';
import { isPosixShell } from '../utils/agent-helpers.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { escapeShellArg, escapePowerShellArg } from '../utils/shell-escape.js';

/** Ordered probe identifiers. The tool branches on these names, never on order alone. */
export type GitProbeName =
  | 'insideWorkTree'
  | 'status'
  | 'worktrees'
  | 'originUrl'
  | 'playbooks'
  | 'bibleCommit';

export interface GitProbe {
  /** Machine-readable probe identifier. */
  name: GitProbeName;
  /** The exact string handed to the member's execute path. */
  command: string;
}

/**
 * Playbook files whose presence is reported. Derived from the documented
 * target-file contract (TARGET_FILE_CONTRACT in
 * packages/apra-fleet-se/scripts/check-generic-boundary.mjs), not invented
 * here: those are the three files a conforming target repo may own.
 */
export const PLAYBOOK_FILES = ['deploy.md', 'integ-test-playbook.md', 'regression-test-playbook.md'] as const;

/**
 * Path of the "bible" export whose last commit is reported. Relative to the
 * checkout root, and always spelled POSIX-style: it is a git pathspec, which
 * git itself always takes with forward slashes on every platform.
 */
export const BIBLE_PATH = '.fleet/kb-canonical.json';

/** Join a member-side folder with a relative child, using the member's own separator. */
function joinMemberPath(folder: string, child: string, posix: boolean): string {
  const trimmed = folder.replace(/[\\/]+$/, '');
  const base = trimmed === '' ? folder : trimmed;
  return posix ? `${base}/${child}` : path.win32.join(base, child.replace(/\//g, '\\'));
}

/**
 * The F2 probe sequence, in order, for one member folder.
 *
 * Exported as ONE ordered list rather than six separate builders so the tool
 * and its tests share a single source of truth for both the command strings
 * and their order -- a tool that re-derived the sequence could drift from the
 * tests that pin it.
 *
 * The caller decides how far to walk the list: `insideWorkTree` is first
 * precisely so a folder that is not a git work tree can short-circuit to
 * {checkout: null} without running the remaining five probes (DQ-27 -- the
 * server never requires a checkout).
 */
export function buildGitStatusProbes(folder: string, os: RemoteOS, shell?: MemberShell): GitProbe[] {
  const posix = isPosixShell(os, shell);
  return posix ? posixProbes(folder) : powerShellProbes(folder);
}

function posixProbes(folder: string): GitProbe[] {
  const dir = escapeShellArg(folder);
  const git = (args: string) => `git -C ${dir} ${args}`;
  // `ls`-free presence test: one bracket test per file with the name printed
  // literally, so the output is basenames and the string contains no shell
  // variable at all. The trailing `true` keeps the exit code 0 when the last
  // file is absent (a missing playbook is not an error).
  const playbooks = PLAYBOOK_FILES
    .map((file) => `[ -f ${escapeShellArg(joinMemberPath(folder, file, true))} ] && printf '%s\\n' ${escapeShellArg(file)}`)
    .join('; ') + '; true';
  return [
    { name: 'insideWorkTree', command: git('rev-parse --is-inside-work-tree') },
    { name: 'status', command: git('status --porcelain=v2 --branch') },
    { name: 'worktrees', command: git('worktree list --porcelain') },
    { name: 'originUrl', command: git('remote get-url origin') },
    { name: 'playbooks', command: playbooks },
    { name: 'bibleCommit', command: git(`log -1 --format='%H' -- ${escapeShellArg(BIBLE_PATH)}`) },
  ];
}

function powerShellProbes(folder: string): GitProbe[] {
  const dir = escapePowerShellArg(folder);
  const git = (args: string) => wrapPowerShellEncoded(`git -C ${dir} ${args}`);
  const playbooks = PLAYBOOK_FILES
    .map((file) => `if (Test-Path -LiteralPath ${escapePowerShellArg(joinMemberPath(folder, file, false))}) { Write-Output ${escapePowerShellArg(file)} }`)
    .join('; ');
  return [
    { name: 'insideWorkTree', command: git('rev-parse --is-inside-work-tree') },
    { name: 'status', command: git('status --porcelain=v2 --branch') },
    { name: 'worktrees', command: git('worktree list --porcelain') },
    { name: 'originUrl', command: git('remote get-url origin') },
    { name: 'playbooks', command: wrapPowerShellEncoded(playbooks) },
    { name: 'bibleCommit', command: git(`log -1 --format='%H' -- ${escapePowerShellArg(BIBLE_PATH)}`) },
  ];
}

/**
 * The DQ-27 "is this even a checkout?" rule, kept pure so both the tool and
 * its tests apply exactly one definition: the folder is a work tree only when
 * the first probe exits 0 AND prints `true`. Any non-zero exit (git's own
 * "not a git repository", exit 128, or the PowerShell wrapper's exit 1 after
 * it catches that failure) and any other output -- including the `false` git
 * prints inside a bare .git directory -- means "no checkout here", which is a
 * normal, non-error answer.
 */
export function isInsideWorkTree(stdout: string, exitCode: number): boolean {
  return exitCode === 0 && stdout.trim().toLowerCase() === 'true';
}

/** One changed path reported by `git status --porcelain=v2`. */
export interface GitDirtyEntry {
  /**
   * The porcelain v2 XY code for a tracked change ('.M', 'M.', 'A.', ...),
   * 'uu' for an unmerged path, or '??' for an untracked one.
   */
  code: string;
  /** Path relative to the checkout root, as git reported it. */
  path: string;
}

/** Parsed `git status --porcelain=v2 --branch` output. */
export interface GitStatusSummary {
  /** Branch name, or null when detached or unborn. */
  branch: string | null;
  /** True when HEAD is detached. */
  detached: boolean;
  /** HEAD commit sha, or null on an unborn branch. */
  head: string | null;
  /** Upstream ref (e.g. origin/main), or null when there is none. */
  upstream: string | null;
  /** Commits ahead of upstream, null when there is no upstream. */
  ahead: number | null;
  /** Commits behind upstream, null when there is no upstream. */
  behind: number | null;
  /** True when any tracked change, unmerged path or untracked file exists. */
  dirty: boolean;
  /** Every changed/unmerged/untracked path. Ignored files are deliberately excluded. */
  dirtyFiles: GitDirtyEntry[];
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * Header lines are `# branch.oid|head|upstream|ab`; entry lines are '1'
 * (ordinary change), '2' (rename/copy, whose path field is
 * `<path>\t<origPath>`), 'u' (unmerged) and '?' (untracked). '!' (ignored)
 * lines are skipped -- an ignored file is not a dirty work tree. The
 * porcelain v2 format is explicitly stable, which is why it is probed
 * instead of the human-readable output.
 */
export function parsePorcelainV2(stdout: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    branch: null, detached: false, head: null,
    upstream: null, ahead: null, behind: null,
    dirty: false, dirtyFiles: [],
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      summary.head = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') {
        summary.detached = true;
      } else {
        summary.branch = head;
      }
    } else if (line.startsWith('# branch.upstream ')) {
      summary.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const ab = /^\# branch\.ab \+(-?\d+) -(-?\d+)/.exec(line);
      if (ab) {
        summary.ahead = Number(ab[1]);
        summary.behind = Number(ab[2]);
      }
    } else if (line.startsWith('# ')) {
      continue;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const fields = line.split(' ');
      const pathIndex = line.startsWith('1 ') ? 8 : 9;
      const rest = fields.slice(pathIndex).join(' ');
      summary.dirtyFiles.push({ code: fields[1], path: rest.split('\t')[0] });
    } else if (line.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = line.split(' ');
      summary.dirtyFiles.push({ code: fields[1], path: fields.slice(10).join(' ') });
    } else if (line.startsWith('? ')) {
      summary.dirtyFiles.push({ code: '??', path: line.slice(2) });
    }
  }
  summary.dirty = summary.dirtyFiles.length > 0;
  return summary;
}

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute path of the work tree, as git reported it. */
  path: string;
  /** Checked-out commit sha, or null for a bare/unborn entry. */
  head: string | null;
  /** Branch short name (refs/heads/ stripped), or null when detached/bare. */
  branch: string | null;
  /** True when the entry is detached. */
  detached: boolean;
  /** True when the entry is a bare repository. */
  bare: boolean;
  /** True when the entry is locked. */
  locked: boolean;
}

/**
 * Parse `git worktree list --porcelain`: newline-separated `key value`
 * records, one blank line between work trees, with valueless flag keys
 * (`bare`, `detached`, `locked` -- `locked` may also carry a reason).
 */
export function parseWorktreeList(stdout: string): GitWorktree[] {
  const trees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') { current = null; continue; }
    const spaceIdx = line.indexOf(' ');
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
    if (key === 'worktree') {
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false };
      trees.push(current);
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
  }
  return trees;
}

/**
 * Normalise an origin remote URL to `host/path` -- lowercased, with any
 * userinfo, port, trailing `.git` and leading/trailing slashes removed. The
 * three remote spellings of the same repository
 *   git@github.com:Apra-Labs/apra-fleet.git
 *   https://github.com/Apra-Labs/apra-fleet.git
 *   ssh://git@github.com:22/Apra-Labs/apra-fleet
 * therefore all yield `github.com/apra-labs/apra-fleet`, which is what lets a
 * consumer group members by the repository they are clones of.
 *
 * Deliberately NOT resolveProjectSlug()'s slugify
 * (src/services/knowledge/project-slug.ts): that one flattens everything to a
 * dash-joined, filesystem-safe KB scope key. This is the human-readable
 * host+path identity the F2 design asks for, and the two are kept separate on
 * purpose rather than one being bent into the other's job.
 *
 * A remote with no host at all (a local path or file:// URL) has no host+path
 * identity to normalise, so its repository basename is used instead. Returns
 * null for an empty/absent remote.
 */
export function originSlugFromUrl(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (raw === '') return null;

  // scp-like syntax: [user@]host:path (no scheme). A Windows drive letter
  // ("C:\repos\x") is not a host, so a single-character host is excluded.
  const scp = /^(?:[^@/\\]+@)?([A-Za-z0-9.-]{2,}):(?!\/\/)(.+)$/.exec(raw);
  if (!raw.includes('://') && scp) {
    return normaliseHostPath(scp[1], scp[2]);
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (scheme) {
    const afterScheme = scheme[2].replace(/^[^@/]*@/, '');
    const slashIdx = afterScheme.indexOf('/');
    const authority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
    const rest = slashIdx === -1 ? '' : afterScheme.slice(slashIdx + 1);
    const host = authority.replace(/:\d+$/, '');
    if (host === '') return basenameSlug(rest);
    return normaliseHostPath(host, rest);
  }

  return basenameSlug(raw);
}

function normaliseHostPath(host: string, repoPath: string): string | null {
  const cleanPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const cleanHost = host.replace(/:\d+$/, '').toLowerCase();
  if (cleanHost === '') return basenameSlug(repoPath);
  const slug = cleanPath === '' ? cleanHost : `${cleanHost}/${cleanPath.toLowerCase()}`;
  return slug === '' ? null : slug;
}

function basenameSlug(candidate: string): string | null {
  const parts = candidate.replace(/[\\/]+$/, '').split(/[\\/]/);
  const base = (parts[parts.length - 1] ?? '').replace(/\.git$/, '').toLowerCase();
  return base === '' ? null : base;
}
