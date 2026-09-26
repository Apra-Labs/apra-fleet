/**
 * Code changes for a sprint: commits and files on the sprint branch since it
 * left its base, and the diff of any one file. Read-only git, no shell.
 */
import { execFile } from 'node:child_process';

const MAX_DIFF_BYTES = 400_000;

function git(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** First of `candidates` that resolves in `repo`. */
async function firstRef(repo: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (await refExists(repo, c)) return c;
  return null;
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  isMerge: boolean;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CodeChanges {
  available: boolean;
  reason?: string;
  branch?: string;
  base?: string;
  commits: Commit[];
  files: FileChange[];
  totals: { added: number; removed: number; files: number };
}

const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

async function resolveRefs(repo: string, branch: string, base: string): Promise<{ head: string; baseRef: string } | string> {
  if (!REF_RE.test(branch) || !REF_RE.test(base) || branch.startsWith('-') || base.startsWith('-')) return 'bad branch name';
  const head = await firstRef(repo, [branch, `origin/${branch}`]);
  if (!head) return `branch ${branch} does not exist yet - it appears once the first change lands`;
  const baseRef = await firstRef(repo, [base, `origin/${base}`]);
  if (!baseRef) return `base branch ${base} not found`;
  return { head, baseRef };
}

export async function codeChanges(repo: string, branch: string, base: string): Promise<CodeChanges> {
  const empty = { commits: [], files: [], totals: { added: 0, removed: 0, files: 0 } };
  let refs: Awaited<ReturnType<typeof resolveRefs>>;
  try {
    refs = await resolveRefs(repo, branch, base);
  } catch (e) {
    return { available: false, reason: (e as Error).message, ...empty };
  }
  if (typeof refs === 'string') return { available: false, reason: refs, branch, base, ...empty };
  const { head, baseRef } = refs;

  const log = await git(repo, ['log', '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%P%x1f%s', `${baseRef}..${head}`]);
  const commits: Commit[] = log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, author, date, parents, subject] = line.split('\x1f');
      return { sha, author, date, subject, isMerge: (parents ?? '').trim().split(/\s+/).length > 1 };
    });

  const numstat = await git(repo, ['diff', '--no-color', '--numstat', `${baseRef}...${head}`]);
  const files: FileChange[] = numstat
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [a, r, ...rest] = line.split('\t');
      const binary = a === '-' || r === '-';
      return { path: rest.join('\t'), added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
    });
  const totals = files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed, files: t.files + 1 }), { added: 0, removed: 0, files: 0 });
  return { available: true, branch, base, commits, files, totals };
}

/** Unified diff of one file on the sprint branch; only files the sprint touched. */
export async function fileDiff(repo: string, branch: string, base: string, file: string): Promise<{ diff: string; truncated: boolean }> {
  const changes = await codeChanges(repo, branch, base);
  if (!changes.available) throw new Error(changes.reason ?? 'no changes');
  if (!changes.files.some(f => f.path === file)) throw new Error('file is not part of this sprint');
  const refs = (await resolveRefs(repo, branch, base)) as { head: string; baseRef: string };
  const out = await git(repo, ['diff', '--no-color', '-M', `${refs.baseRef}...${refs.head}`, '--', file], MAX_DIFF_BYTES * 4);
  const truncated = out.length > MAX_DIFF_BYTES;
  return { diff: truncated ? out.slice(0, MAX_DIFF_BYTES) : out, truncated };
}

/** Diff of a single commit on the sprint branch. */
export async function commitDiff(repo: string, branch: string, base: string, sha: string): Promise<{ diff: string; truncated: boolean }> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad commit id');
  const changes = await codeChanges(repo, branch, base);
  if (!changes.commits.some(c => c.sha.startsWith(sha))) throw new Error('commit is not part of this sprint');
  const out = await git(repo, ['show', '--no-color', '--format=%H%n%an <%ae>%n%aI%n%n%B', '-M', sha], MAX_DIFF_BYTES * 4);
  const truncated = out.length > MAX_DIFF_BYTES;
  return { diff: truncated ? out.slice(0, MAX_DIFF_BYTES) : out, truncated };
}
