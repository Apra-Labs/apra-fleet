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
  /** Blob id at head, so "viewed" marks reset when the file changes again. */
  blob?: string;
}

export interface CodeChanges {
  available: boolean;
  reason?: string;
  branch?: string;
  base?: string;
  /** The sprint branch's current commit; it moves as work lands. */
  head?: string;
  /** Where the sprint branch left its base. */
  mergeBase?: string;
  /** With `since`: files that changed between that commit and head, and by how much. */
  changedSince?: string[];
  sinceStats?: Record<string, { added: number; removed: number }>;
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

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Small memo for answers that depend only on commit ids, which never change. */
function memo<T>(max: number) {
  const m = new Map<string, T>();
  return {
    get: (k: string) => m.get(k),
    set: (k: string, v: T) => {
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value!);
      return v;
    },
  };
}
const changesMemo = memo<CodeChanges>(64);
const linesMemo = memo<{ lines: string[]; truncated: boolean }>(128);

export async function codeChanges(repo: string, branch: string, base: string, opts: { since?: string } = {}): Promise<CodeChanges> {
  const empty = { commits: [], files: [], totals: { added: 0, removed: 0, files: 0 } };
  let refs: Awaited<ReturnType<typeof resolveRefs>>;
  try {
    refs = await resolveRefs(repo, branch, base);
  } catch (e) {
    return { available: false, reason: (e as Error).message, ...empty };
  }
  if (typeof refs === 'string') return { available: false, reason: refs, branch, base, ...empty };
  const { head, baseRef } = refs;
  const [headSha, baseSha] = (await git(repo, ['rev-parse', head, baseRef])).trim().split('\n');
  const key = `${repo}\0${headSha}\0${baseSha}\0${opts.since ?? ''}`;
  const hit = changesMemo.get(key);
  if (hit) return { ...hit, branch, base };
  const mergeBase = (await git(repo, ['merge-base', baseSha, headSha])).trim();

  const log = await git(repo, ['log', '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%P%x1f%s', `${mergeBase}..${headSha}`]);
  const commits: Commit[] = log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, author, date, parents, subject] = line.split('\x1f');
      return { sha, author, date, subject, isMerge: (parents ?? '').trim().split(/\s+/).length > 1 };
    });

  const numstat = await git(repo, ['diff', '--no-color', '--numstat', mergeBase, headSha]);
  const files: FileChange[] = numstat
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [a, r, ...rest] = line.split('\t');
      const binary = a === '-' || r === '-';
      return { path: rest.join('\t'), added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
    });
  if (files.length) {
    const blobs = new Map<string, string>();
    const tree = await git(repo, ['ls-tree', '-r', headSha, '--', ...files.map(f => f.path).slice(0, 2000)]);
    for (const line of tree.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) blobs.set(m[2], m[1]);
    }
    for (const f of files) f.blob = blobs.get(f.path) ?? 'deleted';
  }
  const totals = files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed, files: t.files + 1 }), { added: 0, removed: 0, files: 0 });
  let changedSince: string[] | undefined;
  let sinceStats: CodeChanges['sinceStats'];
  if (opts.since && SHA_RE.test(opts.since) && opts.since !== headSha) {
    if (opts.since === mergeBase || commits.some(c => c.sha === opts.since)) {
      sinceStats = {};
      for (const line of (await git(repo, ['diff', '--no-color', '--numstat', opts.since, headSha])).split('\n').filter(Boolean)) {
        const [a, r, ...rest] = line.split('\t');
        sinceStats[rest.join('\t')] = { added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) };
      }
      changedSince = Object.keys(sinceStats);
    }
  }
  return changesMemo.set(key, { available: true, branch, base, head: headSha, mergeBase, commits, files, totals, ...(changedSince ? { changedSince, sinceStats } : {}) });
}

export interface DiffRow {
  /** hunk header, context, added, deleted, or a note such as "\ No newline at end of file". */
  k: 'hunk' | 'ctx' | 'add' | 'del' | 'note';
  /** Line number on the old side. */
  o?: number;
  /** Line number on the new side. */
  n?: number;
  t: string;
}

export interface ParsedDiff {
  oldPath?: string;
  newPath?: string;
  binary: boolean;
  rows: DiffRow[];
}

/** Unified diff of one file -> rows with old/new line numbers. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { binary: false, rows: [] };
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      out.rows.push({ k: 'hunk', t: line, o, n });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) out.oldPath = line === '--- /dev/null' ? undefined : line.slice(4).replace(/^a\//, '');
      else if (line.startsWith('+++ ')) out.newPath = line === '+++ /dev/null' ? undefined : line.slice(4).replace(/^b\//, '');
      else if (/^Binary files /.test(line)) out.binary = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const c = line.charAt(0);
    if (c === '+') out.rows.push({ k: 'add', n: n++, t: line.slice(1) });
    else if (c === '-') out.rows.push({ k: 'del', o: o++, t: line.slice(1) });
    else if (c === ' ') out.rows.push({ k: 'ctx', o: o++, n: n++, t: line.slice(1) });
    else if (c === '\\') out.rows.push({ k: 'note', t: line });
  }
  return out;
}
/**
 * Diff of one file on the sprint branch; only files the sprint touched.
 * `since` (a sprint commit, or where it started) narrows it to what changed
 * after that point.
 */
export async function fileDiff(
  repo: string, branch: string, base: string, file: string, opts: { since?: string; context?: number } = {},
): Promise<{ diff: string; truncated: boolean; head: string; from: string; parsed: ParsedDiff; newLines: number }> {
  const changes = await codeChanges(repo, branch, base);
  if (!changes.available) throw new Error(changes.reason ?? 'no changes');
  if (!changes.files.some(f => f.path === file)) throw new Error('file is not part of this sprint');
  let from = changes.mergeBase!;
  if (opts.since) {
    if (!SHA_RE.test(opts.since) || !(opts.since === changes.mergeBase || changes.commits.some(c => c.sha === opts.since))) throw new Error('that commit is not part of this sprint');
    from = opts.since;
  }
  const ctx = Math.min(Math.max(Math.floor(opts.context ?? 3), 0), 200);
  const out = await git(repo, ['diff', '--no-color', '-M', `-U${ctx}`, from, changes.head!, '--', file], MAX_DIFF_BYTES * 4);
  const truncated = out.length > MAX_DIFF_BYTES;
  const diff = truncated ? out.slice(0, out.lastIndexOf('\n', MAX_DIFF_BYTES)) : out;
  // How long the file is now, so the view offers more context only when there is some.
  const newLines = (await fileLines(repo, branch, base, file, 'new')).lines.length;
  return { diff, truncated, head: changes.head!, from, parsed: parseUnifiedDiff(diff), newLines };
}

const MAX_FILE_LINES = 20000;

/** One side of a sprint file, for showing more context around the changes. */
export async function fileLines(repo: string, branch: string, base: string, file: string, side: 'old' | 'new', at?: string): Promise<{ lines: string[]; truncated: boolean; rev: string }> {
  const changes = await codeChanges(repo, branch, base);
  if (!changes.available) throw new Error(changes.reason ?? 'no changes');
  if (!changes.files.some(f => f.path === file)) throw new Error('file is not part of this sprint');
  let rev = side === 'old' ? changes.mergeBase! : changes.head!;
  if (at) {
    if (!SHA_RE.test(at) || !(at === changes.mergeBase || changes.commits.some(c => c.sha === at))) throw new Error('that commit is not part of this sprint');
    rev = at;
  }
  const key = `${repo}\0${rev}\0${file}`;
  const hit = linesMemo.get(key);
  if (hit) return { ...hit, rev };
  let text: string;
  try {
    text = await git(repo, ['show', `${rev}:${file}`], MAX_DIFF_BYTES * 8);
  } catch {
    return { ...linesMemo.set(key, { lines: [], truncated: false }), rev };
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { ...linesMemo.set(key, { lines: lines.slice(0, MAX_FILE_LINES), truncated: lines.length > MAX_FILE_LINES }), rev };
}

/** Split a many-file diff into one parsed diff per file. */
export function parseMultiDiff(diff: string): ParsedDiff[] {
  const parts = diff.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '));
  return parts.map(p => {
    const d = parseUnifiedDiff(p);
    if (!d.oldPath && !d.newPath) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
      if (m) {
        d.oldPath = m[1];
        d.newPath = m[2];
      }
    }
    return d;
  });
}

/** Diff of a single commit on the sprint branch. */
export async function commitDiff(repo: string, branch: string, base: string, sha: string): Promise<{ diff: string; truncated: boolean; commit?: Commit; files: ParsedDiff[] }> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad commit id');
  const changes = await codeChanges(repo, branch, base);
  const commit = changes.commits.find(c => c.sha.startsWith(sha));
  if (!commit) throw new Error('commit is not part of this sprint');
  const out = await git(repo, ['show', '--no-color', '--format=%H%n%an <%ae>%n%aI%n%n%B', '-M', commit.sha], MAX_DIFF_BYTES * 4);
  const truncated = out.length > MAX_DIFF_BYTES;
  const diff = truncated ? out.slice(0, out.lastIndexOf('\n', MAX_DIFF_BYTES)) : out;
  return { diff, truncated, commit, files: parseMultiDiff(diff) };
}
