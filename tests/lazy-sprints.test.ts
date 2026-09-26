import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeRunState, RUN_ID } from './fixtures/lazy-sprint-state.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sprints-'));
const prevData = process.env.APRA_FLEET_DATA_DIR;
const prevLazy = process.env.LAZYFLEET_DIR;
process.env.APRA_FLEET_DATA_DIR = path.join(tmp, 'fleet');
process.env.LAZYFLEET_DIR = path.join(tmp, 'lazy');

const { buildBoard, mentionedIds, listRunFiles, columnFor } = await import('../src/lazy/sprints/board.js');
const { codeChanges, fileDiff, commitDiff } = await import('../src/lazy/sprints/code.js');
const launcher = await import('../src/lazy/sprints/launcher.js');
const { listSprints, sprintView } = await import('../src/lazy/sprints/index.js');
const { createLazyServer } = await import('../src/lazy/server.js');

function writeRun(state: any, live = true) {
  const dir = path.join(process.env.APRA_FLEET_DATA_DIR!, live ? 'running' : 'old_runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${state.runId}.json`), JSON.stringify(state));
}

afterAll(() => {
  process.env.APRA_FLEET_DATA_DIR = prevData;
  process.env.LAZYFLEET_DIR = prevLazy;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mentionedIds', () => {
  it('matches whole ids only', () => {
    const ids = ['a-1.1', 'a-1.10', 'a-1.1.2', 'a-1'];
    expect(mentionedIds('Streak a-1.1', ids)).toEqual(['a-1.1']);
    expect(mentionedIds('Streak a-1.10 and a-1.1.2', ids).sort()).toEqual(['a-1.1.2', 'a-1.10']);
    expect(mentionedIds('Planner: a-1.', ids)).toEqual(['a-1']);
    expect(mentionedIds('nothing here', ids)).toEqual([]);
  });
});

describe('buildBoard', () => {
  const now = Date.now();
  const board = buildBoard({ state: makeRunState(now) as any, live: true, file: '' });
  const card = (id: string) => board.cards.find(c => c.id === id)!;

  it('puts every leaf issue in a JIRA-style column and keeps parents as lanes', () => {
    expect(board.columns.map(c => c.title)).toEqual(['To Do', 'Blocked', 'In Progress', 'Done']);
    expect(card('shop-9x.1.1').column).toBe('done');
    expect(card('shop-9x.1.2').column).toBe('progress');
    expect(card('shop-9x.2.1').column).toBe('todo');
    expect(card('shop-9x.2.2').column).toBe('blocked');
    expect(card('shop-9x.2.2').blockedBy).toEqual(['shop-9x.2.1']);
    expect(board.cards.some(c => c.id === 'shop-9x' || c.id === 'shop-9x.1')).toBe(false);
    expect(board.lanes.map(l => l.id)).toEqual(['shop-9x', 'shop-9x.1', 'shop-9x.2']);
    expect(board.lanes.find(l => l.id === 'shop-9x.1')).toMatchObject({ title: 'Theme foundation', total: 3, done: 1 });
    expect(card('shop-9x.3').lane).toBe('shop-9x');
  });

  it('shows which helper is on which issue right now, in parallel', () => {
    expect(board.helpersNow.map(h => [h.member, h.taskIds])).toEqual([
      ['lz-shop-1', ['shop-9x.1.2']],
      ['lz-shop-2', ['shop-9x.1.3']],
    ]);
    expect(card('shop-9x.1.2').working[0].member).toBe('lz-shop-1');
    expect(card('shop-9x.1.1').lastHelper).toBe('lz-shop-2'); // reviewer touched it last
    expect(card('shop-9x.2.3').lastHelper).toBe('lz-shop-0');
  });

  it('reports phases, progress and spend', () => {
    expect(board.currentPhase).toBe('Build');
    expect(board.phases.map(p => p.title)).toEqual(['Ensure Sprint Branch', 'Plan C1 R1', 'Develop C1 R1']);
    expect(board.stages).toEqual([
      { stage: 'Plan', state: 'done' },
      { stage: 'Build', state: 'current' },
      { stage: 'Review', state: 'todo' },
      { stage: 'Test', state: 'todo' },
      { stage: 'Wrap up', state: 'todo' },
    ]);
    expect(board.cycle).toBe(1);
    expect(board.progress).toEqual({ done: 1, total: 7 });
    expect(board.cost).toBeCloseTo(3.87);
    expect(board.recent[0].label).toBe('Streak shop-9x.2.3'); // ended most recently
  });

  it('ignores the engine bookkeeping commands when showing who is working', () => {
    expect(board.helpersNow.some(h => h.label.startsWith('bd close'))).toBe(false);
    expect(board.recent.some(r => r.label.startsWith('Fetch main'))).toBe(false);
    expect(card('shop-9x.2.1').column).toBe('todo');
  });

  it('maps engine phases to plain stages', async () => {
    const { stageOf } = await import('../src/lazy/sprints/board.js');
    expect(stageOf('Develop C2 R3')).toEqual({ stage: 'Build', cycle: 2 });
    expect(stageOf('Replan C1 R2')).toEqual({ stage: 'Plan', cycle: 1 });
    expect(stageOf('Re-Review C1').stage).toBe('Review');
    expect(stageOf('Integ Test C1').stage).toBe('Test');
    expect(stageOf('Publish PR C2').stage).toBe('Wrap up');
    expect(stageOf('Ensure Sprint Branch').stage).toBe(null);
  });

  it('moves a card to In Progress when a helper is on it before its status catches up', () => {
    const s = makeRunState(now) as any;
    s.tree[0].phases[2].events.push({ type: 'activity', id: 'z', data: { id: 'z', type: 'agent', label: 'Streak shop-9x.2.1', member: 'lz-shop-0', isRunning: true, startTime: now } });
    const b = buildBoard({ state: s, live: true, file: '' });
    expect(b.cards.find(c => c.id === 'shop-9x.2.1')!.column).toBe('progress');
  });

  it('shows pipeline stages, bounces and the waiting count', () => {
    expect(card('shop-9x.1.2')).toMatchObject({ stage: 'fixing', bounces: 1 });
    expect(card('shop-9x.1.3').stage).toBe('landing');
    expect(card('shop-9x.1.1').stage).toBeUndefined();
    expect(board.pipeline).toMatchObject({ building: 1, landing: 1, waitingForMember: 1, builders: 3, limit: null });
    expect(board.pipeline!.events[0].kind).toBe('bounce'); // newest first
  });

  it('maps statuses', () => {
    expect(columnFor({ id: 'x', status: 'deferred' })).toBe('blocked');
    expect(columnFor({ id: 'x', status: 'open', ready: false })).toBe('blocked');
    expect(columnFor({ id: 'x', status: 'open' })).toBe('todo');
  });
});

describe('run discovery', () => {
  it('lists sprint runs and ignores other workflows', () => {
    writeRun(makeRunState());
    writeRun({ workflowName: 'Phase Timestamp Test', runId: 'not-a-sprint', status: 'success', tree: [] }, false);
    const runs = listRunFiles();
    expect(runs.map(r => r.state.runId)).toEqual([RUN_ID]);
    expect(runs[0].live).toBe(true);
    const list = listSprints();
    expect(list[0]).toMatchObject({ runId: RUN_ID, title: 'Dark mode for the storefront', working: 2, helpers: 3, progress: { done: 1, total: 7 } });
  });
});

describe('code changes', () => {
  const repo = path.join(tmp, 'repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'Tester');
    fs.writeFileSync(path.join(repo, 'a.css'), 'body { color: #000; }\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    g('checkout', '-qb', 'feat/dark');
    fs.writeFileSync(path.join(repo, 'a.css'), 'body { color: var(--ink); }\n');
    fs.writeFileSync(path.join(repo, 'tokens.css'), ':root { --ink: #000; }\n');
    g('add', '.');
    g('commit', '-qm', 'impl shop-9x.1.1: color tokens');
    g('checkout', '-q', 'main');
  });

  it('lists commits and files on the sprint branch since its base', async () => {
    const c = await codeChanges(repo, 'feat/dark', 'main');
    expect(c.available).toBe(true);
    expect(c.commits.map(x => x.subject)).toEqual(['impl shop-9x.1.1: color tokens']);
    expect(c.files.map(f => f.path).sort()).toEqual(['a.css', 'tokens.css']);
    expect(c.totals).toEqual({ added: 2, removed: 1, files: 2 });
  });

  it('shows one file or commit, and only ones in the sprint', async () => {
    const d = await fileDiff(repo, 'feat/dark', 'main', 'a.css');
    expect(d.diff).toContain('+body { color: var(--ink); }');
    await expect(fileDiff(repo, 'feat/dark', 'main', '../../etc/passwd')).rejects.toThrow(/not part of this sprint/);
    const sha = (await codeChanges(repo, 'feat/dark', 'main')).commits[0].sha;
    expect((await commitDiff(repo, 'feat/dark', 'main', sha)).diff).toContain('tokens.css');
    await expect(commitDiff(repo, 'feat/dark', 'main', 'deadbeef')).rejects.toThrow(/not part of this sprint/);
  });

  it('explains when the branch has no work yet', async () => {
    const c = await codeChanges(repo, 'feat/nothing-yet', 'main');
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/does not exist yet/);
    expect((await codeChanges(repo, '--output=/tmp/x', 'main')).available).toBe(false);
  });
});

describe('launcher', () => {
  it('validates the ask', () => {
    expect(() => launcher.validateLaunch({ repo: 'relative/path', ask: 'do the thing please' })).toThrow(/full path/);
    expect(() => launcher.validateLaunch({ repo: tmp, ask: 'hi' })).toThrow(/sentence/);
    expect(() => launcher.validateLaunch({ repo: tmp, ask: 'add dark mode please', maxHelpers: 0 })).toThrow(/whole number/);
    expect(() => launcher.validateLaunch({ repo: tmp, ask: 'add dark mode please', gateCommand: 'a\nb' })).toThrow(/one line/);
    expect(launcher.validateLaunch({ repo: tmp, ask: 'add dark mode please' }).maxHelpers).toBeUndefined();
    expect(() => launcher.validateLaunch({ repo: tmp, ask: 'add dark mode please', goal: 'P9' as any })).toThrow(/Goal/);
    expect(launcher.titleFromAsk('Add dark mode. Also tests.')).toBe('Add dark mode');
    expect(launcher.helperName('shop', 2)).toBe('lz-shop-2');
  });

  function fakeDeps(opts: { failOn?: string } = {}) {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    let engineArgs: string[] = [];
    let helpers: Array<{ name: string; folder: string }> = [];
    const deps = {
      run: async (cmd: string, args: string[], cwd: string) => {
        calls.push({ cmd, args, cwd });
        const line = `${cmd} ${args.join(' ')}`;
        if (opts.failOn && line.includes(opts.failOn)) throw new Error(`${opts.failOn} broke`);
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${cwd}\n`;
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
        if (cmd === 'git' && args[0] === 'clone') fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
        if (cmd === 'bd' && args[0] === 'create') return JSON.stringify({ id: 'shop-ab1' });
        return '';
      },
      ensureHelpers: async (h: typeof helpers) => { helpers = h; },
      startEngine: (_rec: any, args: string[]) => { engineArgs = args; return { pid: 999999 }; },
      freePort: async () => 45678,
      ensureFleetServer: async () => {},
    };
    return { deps, calls, get engineArgs() { return engineArgs; }, get helpers() { return helpers; } };
  }

  it('starts with two helpers, installs the landing-note hook and runs the engine in pipeline mode', async () => {
    const repo = path.join(tmp, 'shop');
    fs.mkdirSync(repo, { recursive: true });
    const f = fakeDeps();
    const rec = await launcher.launchSprint({ repo, ask: 'Add dark mode with a settings toggle', maxHelpers: 5, gateCommand: 'npm test' }, f.deps as any);
    // launchSprint returns immediately; wait for background setup.
    for (let i = 0; i < 50 && launcher.getRecord(rec.runId)!.setup.state === 'preparing'; i++) await new Promise(r => setTimeout(r, 10));
    const done = launcher.getRecord(rec.runId)!;
    expect(done.setup.state).toBe('started');
    expect(done.rootIssue).toBe('shop-ab1');
    expect(done.helpers).toEqual(['lz-shop-0', 'lz-shop-1']);
    expect(f.helpers.map(h => path.basename(h.folder))).toEqual(['h0', 'h1']);
    const a = f.engineArgs;
    expect(a).toEqual(expect.arrayContaining([
      '--sync', '--pipeline', '--issue', 'shop-ab1', '--members', 'lz-shop-0,lz-shop-1', '--base', 'main',
      '--viewer-port', '45678', '--run-id', rec.runId, '--inbox-file', '.lazyfleet/inbox.txt',
      '--member-pool-file', done.poolFile!, '--max-doers', '5', '--gate-command', 'npm test',
    ]));
    expect(JSON.parse(a[a.indexOf('--role-map') + 1])).toEqual({ orchestrator: ['lz-shop-0'] });
    expect(JSON.parse(fs.readFileSync(done.poolFile!, 'utf-8'))).toEqual(['lz-shop-1']);
    // The user's own checkout is only ever read (cloned from), never written.
    const writes = f.calls.filter(c => c.cwd === repo && !(c.cmd === 'git' && ['rev-parse', 'remote'].includes(c.args[0])));
    expect(writes).toEqual([]);
    // Every clone shares one local task database folder.
    const remotes = new Set(['h0', 'h1'].map(h => fs.readFileSync(path.join(done.workspace, h, '.beads', 'config.yaml'), 'utf-8').trim()));
    expect(remotes.size).toBe(1);
    expect([...remotes][0]).toContain('tasks-remote');
    // The builder's clone carries the landing-note hook, hidden from git.
    const settings = JSON.parse(fs.readFileSync(path.join(done.workspace, 'h1', '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(`node "${path.join(done.workspace, 'inbox-hook.cjs')}"`);
    const exclude = fs.readFileSync(path.join(done.workspace, 'h1', '.git', 'info', 'exclude'), 'utf-8').split('\n');
    expect(exclude).toEqual(expect.arrayContaining(['.beads/', '.lazyfleet/', '.claude/settings.json', '/.claude/agents/']));
    // Every clone carries the role contracts that match this engine, not whatever ~/.claude/agents holds.
    for (const h of ['h0', 'h1']) {
      const agents = path.join(done.workspace, h, '.claude', 'agents');
      expect(fs.readFileSync(path.join(agents, 'plan-reviewer.md'), 'utf-8')).toContain('_shared/GRAPH-SEMANTICS.md');
      expect(fs.existsSync(path.join(agents, '_shared', 'GRAPH-SEMANTICS.md'))).toBe(true);
    }
    expect(listSprints().find(s => s.runId === rec.runId)).toMatchObject({ status: 'stopped' }); // fake pid is not alive
  });

  it('adds builders when the engine reports tasks waiting, within the limit', async () => {
    const repo = path.join(tmp, 'grow');
    fs.mkdirSync(repo, { recursive: true });
    const f = fakeDeps();
    const rec = await launcher.launchSprint({ repo, ask: 'Split this into many small tasks', maxHelpers: 3 }, f.deps as any);
    for (let i = 0; i < 50 && launcher.getRecord(rec.runId)!.setup.state === 'preparing'; i++) await new Promise(r => setTimeout(r, 10));
    const added = await launcher.growOnce(rec.runId, f.deps as any, () => ({ waitingForMember: 5 }));
    expect(added).toBe(2); // limit 3 builders, one already there
    const done = launcher.getRecord(rec.runId)!;
    expect(done.helpers).toEqual(['lz-grow-0', 'lz-grow-1', 'lz-grow-2', 'lz-grow-3']);
    expect(JSON.parse(fs.readFileSync(done.poolFile!, 'utf-8'))).toEqual(['lz-grow-1', 'lz-grow-2', 'lz-grow-3']);
    expect(f.helpers.map(h => h.name)).toEqual(['lz-grow-2', 'lz-grow-3']);
    expect(await launcher.growOnce(rec.runId, f.deps as any, () => ({ waitingForMember: 5 }))).toBe(0);
    expect(await launcher.growOnce(rec.runId, f.deps as any, () => ({ waitingForMember: 0 }))).toBe(0);
  });

  it('grows without a ceiling by default, a few at a time', () => {
    expect(launcher.helpersToAdd({ waitingForMember: 12, builders: 1 })).toBe(4);
    expect(launcher.helpersToAdd({ waitingForMember: 2, builders: 30 })).toBe(2);
    expect(launcher.helpersToAdd({ waitingForMember: 9, builders: 4, maxHelpers: 5 })).toBe(1);
    expect(launcher.helpersToAdd({ waitingForMember: 0, builders: 1 })).toBe(0);
  });

  it('records a readable failure and never starts the engine', async () => {
    const repo = path.join(tmp, 'shop2');
    fs.mkdirSync(repo, { recursive: true });
    const f = fakeDeps({ failOn: 'bd create' });
    const rec = await launcher.launchSprint({ repo, ask: 'Add dark mode with a settings toggle' }, f.deps as any);
    for (let i = 0; i < 50 && launcher.getRecord(rec.runId)!.setup.state === 'preparing'; i++) await new Promise(r => setTimeout(r, 10));
    const done = launcher.getRecord(rec.runId)!;
    expect(done.setup.state).toBe('failed');
    expect(done.setup.error).toContain('bd create broke');
    expect(f.engineArgs).toEqual([]);
    expect(sprintView(rec.runId)!.status).toBe('failed');
  });
});

describe('sprint API', () => {
  let server: http.Server;
  let port = 0;
  const TOKEN = 'sprint-ui-token-0123456789';
  let launched: any = null;

  beforeAll(async () => {
    const probe = http.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    const s = createLazyServer({
      config: { port, upstream: 'http://127.0.0.1:9', detection: { context: true, entropy: true }, helpers: { maxParallel: 3, idleMinutes: 120, askBeforeRemote: true }, uiToken: TOKEN },
      sprints: { launch: async (input: any) => { launched = input; return { runId: 'new-run' } as any; }, stop: async () => true },
    });
    server = s.server;
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
  });
  afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

  async function headers() {
    const r = await fetch(`http://127.0.0.1:${port}/_lazy/?t=${TOKEN}`, { redirect: 'manual' });
    return { cookie: r.headers.get('set-cookie')!.split(';')[0], 'x-lazy': '1', 'content-type': 'application/json' };
  }

  it('needs sign-in, then serves the board and accepts a launch', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints`)).status).toBe(401);
    const h = await headers();
    const list = await (await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints`, { headers: h })).json();
    expect(list.sprints.some((s: any) => s.runId === RUN_ID)).toBe(true);
    const view = await (await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints/${RUN_ID}`, { headers: h })).json();
    expect(view.board.cards.length).toBe(7);
    const task = await (await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints/${RUN_ID}/tasks/shop-9x.1.2`, { headers: h })).json();
    expect(task.acceptance_criteria).toContain('No hex colors');
    const noCsrf = await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const r = await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints`, { method: 'POST', headers: h, body: JSON.stringify({ repo: '/x', ask: 'add dark mode' }) });
    expect((await r.json()).runId).toBe('new-run');
    expect(launched).toEqual({ repo: '/x', ask: 'add dark mode' });
    const code = await (await fetch(`http://127.0.0.1:${port}/_lazy/api/sprints/${RUN_ID}/code`, { headers: h })).json();
    expect(code.available).toBe(false); // started elsewhere: no repo on record
  });
});

describe('plain-language activity', () => {
  it('describes engine steps without engine jargon', async () => {
    const { describeActivity } = await import('../src/lazy/sprints/board.js');
    const title = (id: string) => ({ 'a.1': 'Add toggle', 'a.2': 'Persist it' } as Record<string, string>)[id];
    expect(describeActivity('Streak a.1', ['a.1'], title)).toBe('Working on: Add toggle');
    expect(describeActivity('Streak a.1,a.2', ['a.1', 'a.2'], title)).toBe('Working on: Add toggle (+1 more)');
    expect(describeActivity('Streak Assignment', [], title)).toBe('Splitting the work between helpers');
    expect(describeActivity('Review a.2', ['a.2'], title)).toBe('Reviewing: Persist it');
    expect(describeActivity('Planner: root', [], title)).toBe('Planning the work and creating issues');
    expect(describeActivity('Plan review', [], title)).toBe('Checking the plan');
  });
});

describe('landing-note hook script', () => {
  it('hands the inbox over once and says nothing when it is empty', async () => {
    const { INBOX_HOOK_SCRIPT } = await import('../src/lazy/sprints/launcher.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-hook-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.lazyfleet'));
      const script = path.join(dir, 'hook.cjs');
      fs.writeFileSync(script, INBOX_HOOK_SCRIPT);
      fs.writeFileSync(path.join(dir, '.lazyfleet', 'inbox.txt'), '[landing note for h2] Task a landed.\n');
      const run = (cwd: string) => execFileSync(process.execPath, [script], { input: JSON.stringify({ cwd }), encoding: 'utf-8' });
      const out = JSON.parse(run(path.join(dir, 'src', 'deep')));
      expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: '[landing note for h2] Task a landed.' });
      expect(fs.existsSync(path.join(dir, '.lazyfleet', 'inbox.txt'))).toBe(false);
      expect(run(dir)).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
