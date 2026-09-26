import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-review-'));
const prevLazy = process.env.LAZYFLEET_DIR;
const prevData = process.env.APRA_FLEET_DATA_DIR;
process.env.LAZYFLEET_DIR = path.join(tmp, 'lazy');
process.env.APRA_FLEET_DATA_DIR = path.join(tmp, 'fleet');

const { parseUnifiedDiff, parseMultiDiff, fileDiff, codeChanges } = await import('../src/lazy/sprints/code.js');
const review = await import('../src/lazy/sprints/review.js');
const tasks = await import('../src/lazy/sprints/tasks.js');

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, encoding: 'utf-8' });

afterAll(() => {
  tasks.setBdRunner(null);
  process.env.LAZYFLEET_DIR = prevLazy;
  process.env.APRA_FLEET_DATA_DIR = prevData;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseUnifiedDiff', () => {
  it('numbers old and new lines through hunks', () => {
    const d = parseUnifiedDiff([
      'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
      '@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' c', '@@ -10,2 +11,2 @@ fn', ' j', '-k', '+K', '\\ No newline at end of file',
    ].join('\n'));
    expect(d.oldPath).toBe('x.js');
    expect(d.newPath).toBe('x.js');
    expect(d.rows.map(r => [r.k, r.o ?? null, r.n ?? null, r.t])).toEqual([
      ['hunk', 1, 1, '@@ -1,3 +1,4 @@'],
      ['ctx', 1, 1, 'a'], ['del', 2, null, 'b'], ['add', null, 2, 'B'], ['add', null, 3, 'C'], ['ctx', 3, 4, 'c'],
      ['hunk', 10, 11, '@@ -10,2 +11,2 @@ fn'],
      ['ctx', 10, 11, 'j'], ['del', 11, null, 'k'], ['add', null, 12, 'K'], ['note', null, null, '\\ No newline at end of file'],
    ]);
  });

  it('knows added, deleted and binary files, and splits a commit by file', () => {
    expect(parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi').oldPath).toBeUndefined();
    expect(parseUnifiedDiff('--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye').newPath).toBeUndefined();
    expect(parseUnifiedDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ').binary).toBe(true);
    const files = parseMultiDiff('abc\n\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-p\n+q\n');
    expect(files.map(f => f.newPath)).toEqual(['a', 'b']);
  });
});

describe('locate', () => {
  const lines = ['a', 'x = 1', 'y = 2', 'b', 'x = 1', 'y = 2', 'c'];
  it('stays put, follows moved code, prefers the matching line above, and gives up when the code is gone', () => {
    expect(review.locate({ line: 2, endLine: 3, anchor: ['x = 1', 'y = 2'] }, lines)).toEqual({ state: 'current', line: 2, endLine: 3 });
    expect(review.locate({ line: 1, endLine: 2, anchor: ['x = 1', 'y = 2'] }, lines)).toEqual({ state: 'moved', line: 2, endLine: 3 });
    expect(review.locate({ line: 1, endLine: 2, anchor: ['x = 1', 'y = 2'], before: 'b' }, lines)).toEqual({ state: 'moved', line: 5, endLine: 6 });
    expect(review.locate({ line: 3, endLine: 3, anchor: ['z = 3'] }, lines).state).toBe('outdated');
    // A blank line alone cannot be found again anywhere else.
    expect(review.locate({ line: 1, endLine: 1, anchor: [''] }, ['x', '', '']).state).toBe('outdated');
  });
});

describe('scopeTasks', () => {
  it('keeps the root and its descendants, marks readiness and goal placement', () => {
    const all = [
      { id: 'r', status: 'open', issue_type: 'epic', priority: 1 },
      { id: 'r.1', parent: 'r', status: 'open', priority: 1 },
      { id: 'r.2', parent: 'r', status: 'open', priority: 1, dependencies: [{ issue_id: 'r.2', depends_on_id: 'r.1', type: 'blocks' }] },
      { id: 'r.3', parent: 'r', status: 'open', priority: 3 },
      { id: 'other', status: 'open', priority: 1 },
    ];
    const s = tasks.scopeTasks(all as any, { rootIssue: 'r', goal: 'P1/P2' });
    expect(s.map(t => t.id)).toEqual(['r', 'r.1', 'r.2', 'r.3']);
    expect(s.find(t => t.id === 'r.2')!.ready).toBe(false);
    expect(s.find(t => t.id === 'r.1')!.ready).toBe(true);
    expect(s.find(t => t.id === 'r.3')!.placement).toBe('backlog');
  });
});

// A sprint with a real branch in helper 1's copy, and a fake bd.
function makeSprint(name: string) {
  const ws = path.join(tmp, name);
  const h0 = path.join(ws, 'h0');
  fs.mkdirSync(path.join(h0, '.beads'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'h1', '.git'), { recursive: true });
  git(h0, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(h0, 'a.js'), 'one\ntwo\nthree\n');
  git(h0, 'add', 'a.js'); git(h0, 'commit', '-qm', 'base');
  git(h0, 'checkout', '-qb', 'feat/x');
  fs.writeFileSync(path.join(h0, 'a.js'), 'one\ntwo\nTHREE\nfour\n');
  git(h0, 'commit', '-qam', 'change');
  const rec: any = { runId: name, title: 'Do x', ask: 'x', repo: h0, slug: name, workspace: ws, branch: 'feat/x', base: 'main', goal: 'P1/P2', helpers: ['lz-p-0', 'lz-p-1'], rootIssue: 'p-1', logPath: '', createdAt: '', setup: { state: 'started', steps: [] }, publish: false, designId: 'fast-pipeline' };
  return { rec, h0, ws };
}

interface BdCall { args: string[]; cwd: string }
function fakeBd(state: { tasks: any[]; calls: BdCall[] }) {
  tasks.setBdRunner(async (args, cwd) => {
    state.calls.push({ args, cwd });
    if (args[0] === 'list') return JSON.stringify(state.tasks);
    if (args[0] === 'create') {
      const t = { id: `p-1.${state.tasks.length}`, title: args[args.indexOf('--title') + 1], parent: args[args.indexOf('--parent') + 1], status: 'open', priority: Number(args[args.indexOf('--priority') + 1]) };
      state.tasks.push(t);
      return 'Warning: auto-export noise\n' + JSON.stringify(t);
    }
    if (args[0] === 'comments' && args[1] === 'add') return JSON.stringify({ id: 'c1', issue_id: args[2], author: 'you', text: args[3], created_at: '' });
    if (args[0] === 'comments') return '[]';
    if (args[0] === 'close') { state.tasks.find(t => t.id === args[1]).status = 'closed'; return ''; }
    if (args[0] === 'reopen') { state.tasks.find(t => t.id === args[1]).status = 'open'; return ''; }
    return '';
  });
}

describe('code review threads', () => {
  let s: ReturnType<typeof makeSprint>;
  let ctx: any;
  const bdState = { tasks: [] as any[], calls: [] as BdCall[] };
  beforeAll(() => {
    s = makeSprint('rv1');
    bdState.tasks = [{ id: 'p-1', status: 'open', issue_type: 'epic', priority: 1 }];
    fakeBd(bdState);
    ctx = { rec: s.rec, repo: s.h0, tasks: [], live: true, building: ['lz-p-1'] };
  });

  it('pins a comment to the lines it was made on', async () => {
    const t = await review.addThread(ctx, { file: 'a.js', line: 3, endLine: 4, body: '  Rename these  ' });
    expect(t).toMatchObject({ file: 'a.js', side: 'new', line: 3, endLine: 4, anchor: ['THREE', 'four'], before: 'two', status: 'open' });
    expect(t.comments[0].body).toBe('Rename these');
    const old = await review.addThread(ctx, { file: 'a.js', side: 'old', line: 3, body: 'Why drop this?' });
    expect(old.anchor).toEqual(['three']);
    await expect(review.addThread(ctx, { file: 'a.js', line: 9, body: 'x' })).rejects.toThrow(/not in the file/);
    await expect(review.addThread(ctx, { file: 'nope.js', line: 1, body: 'x' })).rejects.toThrow(/not part of this sprint/);
    await expect(review.addThread(ctx, { file: 'a.js', line: 1, body: '   ' })).rejects.toThrow(/empty/);
  });

  it('replies, edits, resolves and deletes', async () => {
    const [t] = review.loadReview('rv1').threads;
    review.resolveThread('rv1', t.id, true);
    const replied = review.replyThread('rv1', t.id, 'Also this');
    expect(replied.status).toBe('open');
    const edited = review.editComment('rv1', t.id, replied.comments[1].id, 'Also this, please');
    expect(edited.comments[1]).toMatchObject({ body: 'Also this, please' });
    expect(edited.comments[1].editedAt).toBeTruthy();
    expect(review.deleteComment('rv1', t.id, edited.comments[1].id)!.comments).toHaveLength(1);
    const temp = await review.addThread(ctx, { file: 'a.js', line: 1, body: 'temp' });
    expect(review.deleteComment('rv1', temp.id, temp.comments[0].id)).toBeNull();
    expect(review.loadReview('rv1').threads.map(x => x.id)).not.toContain(temp.id);
  });

  it('follows the code as new commits land and marks gone code outdated', async () => {
    fs.writeFileSync(path.join(s.h0, 'a.js'), 'zero\none\ntwo\nTHREE\nfour\n');
    git(s.h0, 'commit', '-qam', 'insert a line on top');
    let v = await review.reviewView(ctx);
    const pinned = v.threads.find(t => t.side === 'new')!;
    expect(pinned).toMatchObject({ state: 'moved', lineNow: 4, endLineNow: 5 });
    expect(v.threads.find(t => t.side === 'old')!.state).toBe('current');
    fs.writeFileSync(path.join(s.h0, 'a.js'), 'zero\none\ntwo\nthree-ish\n');
    git(s.h0, 'commit', '-qam', 'rewrite the end');
    v = await review.reviewView(ctx);
    expect(v.threads.find(t => t.side === 'new')!.state).toBe('outdated');
    expect(v.counts).toMatchObject({ open: 2, unsent: 2, outdated: 1 });
  });

  it('files open comments as one task per file in the task list, and tells the busy helpers', async () => {
    const out = await review.sendThreads(ctx);
    expect(out.mode).toBe('tasks');
    expect(out.tasks).toEqual([{ id: 'p-1.1', file: 'a.js', threads: 2 }]);
    const create = bdState.calls.find(c => c.args[0] === 'create')!;
    expect(create.cwd).toBe(s.h0);
    expect(create.args).toEqual(expect.arrayContaining(['--type', 'task', '--parent', 'p-1', '--labels', 'review']));
    const desc = create.args[create.args.indexOf('--description') + 1];
    expect(desc).toContain('Why drop this?');
    expect(desc).toContain('(in the old version of the file, before this sprint)');
    expect(desc).toContain('Rename these');
    expect(fs.readFileSync(path.join(s.ws, 'h1', '.lazyfleet', 'inbox.txt'), 'utf-8')).toContain('p-1.1');
    const after = review.loadReview('rv1');
    expect(after.threads.every(t => t.sent?.taskId === 'p-1.1')).toBe(true);
    await expect(review.sendThreads(ctx)).rejects.toThrow(/No open comments/);
  });

  it('shows the task outcome on the thread once a helper closes it', async () => {
    const v = await review.reviewView({ ...ctx, tasks: [{ id: 'p-1.1', status: 'closed', close_reason: 'Renamed', closed_at: '2026-01-01T00:00:00Z' }] });
    const t = v.threads[0];
    expect(t.task).toMatchObject({ id: 'p-1.1', status: 'closed' });
    expect(t.comments[t.comments.length - 1]).toMatchObject({ system: true, body: 'Handled in p-1.1: Renamed' });
    // The stored thread never gets the made-up reply.
    expect(review.loadReview('rv1').threads[0].comments.some(c => c.system)).toBe(false);
  });
});

describe('sending comments on a finished sprint', () => {
  it('starts a follow-up sprint from the sprint branch', async () => {
    const s = makeSprint('rv2');
    const launched: any[] = [];
    const ctx: any = { rec: s.rec, repo: s.h0, tasks: [], live: false, launch: async (i: any) => { launched.push(i); return { runId: 'next' }; } };
    await review.addThread(ctx, { file: 'a.js', line: 3, body: 'Use a constant ```suggestion\nconst THREE = 3;\n```' });
    const out = await review.sendThreads(ctx);
    expect(out).toEqual({ mode: 'follow-up', followUp: 'next' });
    expect(launched[0]).toMatchObject({ repo: s.h0, base: 'feat/x', design: 'fast-pipeline', goal: 'P1/P2', title: 'Review fixes: Do x' });
    expect(launched[0].ask).toContain('Suggested replacement for those lines');
    expect(review.loadReview('rv2').threads[0].sent).toMatchObject({ followUp: 'next' });
  });
});

describe('board changes through bd', () => {
  const st = { tasks: [] as any[], calls: [] as BdCall[] };
  let rec: any;
  beforeEach(() => {
    st.calls.length = 0;
    st.tasks = [
      { id: 'p-1', status: 'open', issue_type: 'epic', priority: 1 },
      { id: 'p-1.1', parent: 'p-1', status: 'in_progress', priority: 1, issue_type: 'task' },
      { id: 'p-1.2', parent: 'p-1', status: 'open', priority: 2, issue_type: 'task' },
      { id: 'q-9', status: 'open', priority: 1 },
    ];
    fakeBd(st);
    rec = makeSprintOnce();
  });
  let made: any;
  function makeSprintOnce() { return made ?? (made = makeSprint('rv3').rec); }

  it('creates an issue under the sprint, in a lane that belongs to it', async () => {
    const t = await tasks.createTask(rec, { title: 'Fix the flash', type: 'bug', priority: 0 });
    expect(t.id).toBe('p-1.4');
    expect(st.calls.find(c => c.args[0] === 'create')!.args).toEqual(expect.arrayContaining(['--type', 'bug', '--priority', '0', '--parent', 'p-1', '--title', 'Fix the flash']));
    await expect(tasks.createTask(rec, { title: 'x', parent: 'q-9' })).rejects.toThrow(/not part of this sprint/);
    await expect(tasks.createTask(rec, { title: '  ' })).rejects.toThrow(/empty/);
  });

  it('changes priority and adds notes only on its own tasks', async () => {
    await tasks.updateTask(rec, 'p-1.2', { priority: 0 });
    expect(st.calls.some(c => c.args.join(' ') === 'update p-1.2 --priority 0')).toBe(true);
    await expect(tasks.updateTask(rec, 'q-9', { priority: 1 })).rejects.toThrow(/not part of this sprint/);
    await expect(tasks.updateTask(rec, 'p-1.2', { priority: 9 })).rejects.toThrow(/Priority/);
    await expect(tasks.updateTask(rec, '--all', { priority: 1 })).rejects.toThrow(/bad task id/);
    await tasks.commentTask(rec, 'p-1.2', 'Check Safari');
    expect(st.calls.find(c => c.args[0] === 'comments')!.args).toEqual(['comments', 'add', 'p-1.2', 'Check Safari', '--author', 'you', '--json']);
  });

  it('never skips a task a helper is building, and reopens skipped ones', async () => {
    await expect(tasks.skipTask(rec, 'p-1.1')).rejects.toThrow(/helper is working/);
    await tasks.skipTask(rec, 'p-1.2');
    expect(st.tasks.find(t => t.id === 'p-1.2').status).toBe('closed');
    await tasks.reopenTask(rec, 'p-1.2');
    expect(st.tasks.find(t => t.id === 'p-1.2').status).toBe('open');
  });

  it('retries a busy task database, then reports other errors as they are', async () => {
    let n = 0;
    tasks.setBdRunner(async (args) => {
      if (args[0] === 'list') {
        n++;
        if (n < 3) throw new Error('database is locked');
        return JSON.stringify(st.tasks);
      }
      throw new Error('no such issue');
    });
    await expect(tasks.liveTasks(rec)).resolves.toHaveLength(3);
    await expect(tasks.updateTask(rec, 'p-1.2', { priority: 1 })).rejects.toThrow(/no such issue/);
  });
});

describe('fileDiff since a commit', () => {
  it('narrows to what changed after that commit and lists the changed files', async () => {
    const s = makeSprint('rv4');
    const first = git(s.h0, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(s.h0, 'b.js'), 'new file\n');
    git(s.h0, 'add', 'b.js'); git(s.h0, 'commit', '-qm', 'add b');
    const c = await codeChanges(s.h0, 'feat/x', 'main', { since: first });
    expect(c.changedSince).toEqual(['b.js']);
    expect(c.files.map(f => f.path).sort()).toEqual(['a.js', 'b.js']);
    const d = await fileDiff(s.h0, 'feat/x', 'main', 'a.js', { since: first });
    expect(d.parsed.rows).toHaveLength(0);
    await expect(fileDiff(s.h0, 'feat/x', 'main', 'a.js', { since: 'deadbeef' })).rejects.toThrow(/not part of this sprint/);
  });
});

describe('review and board API', () => {
  const TOKEN = 'review-ui-token-0123456789';
  let server: http.Server;
  let base = '';
  let h: Record<string, string>;
  const st = { tasks: [] as any[], calls: [] as BdCall[] };

  function runState(runId: string, root: string, live: boolean) {
    return { runId, workflowName: 'fleet-sprint', status: live ? 'running' : 'success', args: { members: ['lz-p-0'], targetIssues: [root], goal: 'P1/P2' }, startedAt: new Date().toISOString(), tree: [], extensions: { beads: { sprintTasks: [{ id: root, status: 'open', issue_type: 'epic' }] } }, result: live ? null : { verdict: 'PASS' } };
  }
  beforeAll(async () => {
    const live = makeSprint('api-live');
    const done = makeSprint('api-done');
    live.rec.pid = process.pid;
    fs.mkdirSync(path.join(tmp, 'lazy'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lazy', 'sprints.json'), JSON.stringify([live.rec, done.rec]));
    for (const [dir, id, isLive] of [['running', 'api-live', true], ['old_runs', 'api-done', false]] as const) {
      fs.mkdirSync(path.join(tmp, 'fleet', dir), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'fleet', dir, `${id}.json`), JSON.stringify(runState(id, 'p-1', isLive)));
    }
    st.tasks = [{ id: 'p-1', status: 'open', issue_type: 'epic', priority: 1 }, { id: 'p-1.1', parent: 'p-1', status: 'open', issue_type: 'task', priority: 1, title: 'Live task' }];
    fakeBd(st);
    const { createLazyServer } = await import('../src/lazy/server.js');
    const probe = http.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    server = createLazyServer({
      config: { port, upstream: 'http://127.0.0.1:9', detection: { context: true, entropy: true }, helpers: { maxParallel: 3, idleMinutes: 120, askBeforeRemote: true }, uiToken: TOKEN },
      sprints: { launch: async () => ({ runId: 'follow' }) as any, stop: async () => true },
    }).server;
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${port}/_lazy/api/sprints/`;
    const r = await fetch(`http://127.0.0.1:${port}/_lazy/?t=${TOKEN}`, { redirect: 'manual' });
    h = { cookie: r.headers.get('set-cookie')!.split(';')[0], 'x-lazy': '1', 'content-type': 'application/json' };
  });
  afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(body) });

  it('shows the live task list on the board and takes board changes while the sprint runs', async () => {
    const view = await (await fetch(base + 'api-live', { headers: h })).json();
    expect(view.canEdit).toBe(true);
    expect(view.board.cards.map((c: any) => c.title)).toEqual(['Live task']);
    const made = await (await post('api-live/tasks', { title: 'From the board' })).json();
    expect(made.task.id).toBe('p-1.2');
    expect((await post('api-live/tasks/p-1.1/update', { priority: 0 })).status).toBe(200);
  });

  it('refuses board changes once the sprint has finished', async () => {
    const view = await (await fetch(base + 'api-done', { headers: h })).json();
    expect(view.canEdit).toBe(false);
    const r = await post('api-done/tasks', { title: 'Too late' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/finished/);
    expect((await post('api-done/tasks/p-1.1/skip', {})).status).toBe(400);
  });

  it('runs a review from comment to follow-up, and needs the page header for writes', async () => {
    const t = await (await post('api-done/review/threads', { file: 'a.js', line: 3, body: 'Hmm' })).json();
    expect(t.thread.anchor).toEqual(['THREE']);
    const id = t.thread.id;
    expect((await post(`api-done/review/threads/${id}/reply`, { body: 'More' })).status).toBe(200);
    const noCsrf = await fetch(base + `api-done/review/threads/${id}/delete`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const view = await (await fetch(base + 'api-done/review', { headers: h })).json();
    expect(view.threads[0].comments.map((c: any) => c.body)).toEqual(['Hmm', 'More']);
    expect(view.head).toMatch(/^[0-9a-f]{40}$/);
    expect((await post('api-done/review/seen', { head: view.head })).status).toBe(200);
    const sent = await (await post('api-done/review/send', {})).json();
    expect(sent).toMatchObject({ ok: true, mode: 'follow-up', followUp: 'follow' });
    const lines = await (await fetch(base + 'api-done/code/lines?side=old&path=a.js', { headers: h })).json();
    expect(lines.lines).toEqual(['one', 'two', 'three']);
    expect((await fetch(base + 'api-done/code/lines?path=../../etc/passwd', { headers: h })).status).toBe(400);
  });
});
