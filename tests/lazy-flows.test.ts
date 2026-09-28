import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-flows-'));
const prev = { lazy: process.env.LAZYFLEET_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
process.env.LAZYFLEET_DIR = path.join(tmp, 'lazy');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
  mcpServers: { timesheet: { command: 'ts-server', args: [] }, slack: { type: 'http', url: 'https://x.invalid' } },
}));

const F = await import('../src/lazy/flows/flow.js');
const R = await import('../src/lazy/flows/runner.js');
const sched = await import('../src/lazy/schedules.js');
const { flowBlocker } = await import('../src/lazy/flows/api.js');

afterAll(() => {
  process.env.LAZYFLEET_DIR = prev.lazy;
  process.env.CLAUDE_CONFIG_DIR = prev.claude;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Flow = import('../src/lazy/flows/flow.js').Flow;
type BlockResult = import('../src/lazy/flows/runner.js').BlockResult;

function timesheet(over: Partial<Flow> = {}): Flow {
  return {
    id: 'daily-timesheet',
    name: 'Daily timesheet',
    purpose: 'Log what I worked on today to the timesheet.',
    blocks: [
      { id: 'gather', tier: 'cheap', purpose: 'Summarise what I did today from git history.', tools: ['Read', 'Bash(git log:*)'] },
      { id: 'log', tier: 'cheap', purpose: 'Write today\'s timesheet rows, unless they are already there.', input: ['gather'], tools: ['mcp:timesheet'], trialTools: ['mcp:timesheet/get_today_entries'], retries: 1 },
    ],
    limits: { usd: 1 },
    ...over,
  };
}

/** An executor that answers from a script, per block, and remembers what it was asked. */
function fake(script: Record<string, Array<Partial<BlockResult>>>) {
  const calls: Array<{ block: string; prompt?: string; trial?: boolean; env?: Record<string, string>; tools?: string[] }> = [];
  const next = (id: string): BlockResult => {
    const r = (script[id] ?? []).shift() ?? { status: 'pass', output: `${id} done` };
    return { status: 'pass', output: '', cost: 0.01, ...r } as BlockResult;
  };
  return {
    calls,
    exec: {
      agent: async (req: any) => { calls.push({ block: req.block.id, prompt: req.prompt, trial: req.trial, tools: R.claudeArgs(req) }); return next(req.block.id); },
      command: async (req: any) => { calls.push({ block: req.block.id, env: req.env }); return next(req.block.id); },
    },
  };
}

beforeEach(() => {
  fs.rmSync(path.join(process.env.LAZYFLEET_DIR!, 'flows'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.LAZYFLEET_DIR!, 'flow-runs'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.LAZYFLEET_DIR!, 'schedules.json'), { force: true });
});

describe('checking a flow', () => {
  it('accepts a good flow and fills in the edges', () => {
    const f = timesheet();
    expect(F.flowProblems(f)).toEqual([]);
    expect(F.edgesOf(f, f.blocks[0])).toEqual({ pass: 'log', fail: 'stop' });
    expect(F.edgesOf(f, f.blocks[1])).toEqual({ pass: 'end', fail: 'stop' });
  });

  it('names every problem so Claude can fix it', () => {
    const p = F.flowProblems({
      id: 'Bad Id', name: 'x', purpose: 'short',
      blocks: [
        { id: 'a', purpose: 'Do a thing well.', tools: ['Rm', 'mcp:nowhere'], trialTools: ['Write'], next: { pass: 'zzz' } },
        { id: 'a', kind: 'command', purpose: 'Run the tests now.', command: 'npm test', tools: ['Read'] },
      ],
    } as Flow);
    const all = p.join('\n');
    expect(all).toMatch(/^id: lowercase/m);
    expect(all).toMatch(/purpose: say what the flow is for/);
    expect(all).toMatch(/"Rm" is not a tool/);
    expect(all).toMatch(/MCP server "nowhere" is not set up/);
    expect(all).toMatch(/trialTools: "Write" is not in its tools/);
    expect(all).toMatch(/next.pass: "zzz" is not a block id/);
    expect(all).toMatch(/id: used twice/);
    expect(all).toMatch(/a command block takes no tools/);
  });

  it('warns about wide tools, loops and missing limits', () => {
    const w = F.flowWarnings(timesheet({
      limits: undefined,
      blocks: [
        { id: 'do', purpose: 'Do the whole job carefully.', tools: ['Bash'] },
        { id: 'check', purpose: 'Check the job was done right.', next: { fail: 'do' } },
      ],
    }));
    expect(w.join('\n')).toMatch(/may run any shell command/);
    expect(w.join('\n')).toMatch(/go round in a loop; it stops after 25 steps/);
    expect(w.join('\n')).toMatch(/No usage limit/);
  });

  it('knows which tools cover which', () => {
    expect(F.toolCovers('Bash', 'Bash(git log:*)')).toBe(true);
    expect(F.toolCovers('Bash(git log:*)', 'Bash')).toBe(false);
    expect(F.toolCovers('mcp:timesheet', 'mcp:timesheet/get_today_entries')).toBe(true);
    expect(F.toolCovers('mcp:timesheet/a', 'mcp:timesheet')).toBe(false);
  });
});

describe('what a block may do', () => {
  const flow = timesheet();
  const base = { flow, prompt: 'p', system: 's', model: 'haiku', cwd: tmp, timeoutMs: 1000, signal: new AbortController().signal };

  it('gets only its own tools and only the MCP servers it names', () => {
    const args = R.claudeArgs({ ...base, block: flow.blocks[1], trial: false });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__timesheet');
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { timesheet: { command: 'ts-server', args: [] } } });
  });

  it('in a trial run keeps only read-only tools and the trial tools', () => {
    const gather = R.claudeArgs({ ...base, block: flow.blocks[0], trial: true });
    expect(gather[gather.indexOf('--tools') + 1]).toBe('Read');
    expect(gather).not.toContain('Bash(git log:*)');
    const log = R.claudeArgs({ ...base, block: flow.blocks[1], trial: true });
    expect(log[log.indexOf('--allowedTools') + 1]).toBe('mcp__timesheet__get_today_entries');
    expect(R.systemPrompt(flow, flow.blocks[1], true)).toMatch(/THIS IS A TRIAL RUN/);
  });

  it('reads the structured result, in either output shape', () => {
    const one = { type: 'result', is_error: false, total_cost_usd: 0.02, structured_output: { status: 'fail', output: 'o', notes: 'n' }, modelUsage: { 'claude-haiku-4-5': {} } };
    expect(R.parseClaudeResult(JSON.stringify(one))).toEqual({ status: 'fail', output: 'o', notes: 'n', cost: 0.02, model: 'claude-haiku-4-5' });
    expect(R.parseClaudeResult(JSON.stringify([{ type: 'system' }, one])).status).toBe('fail');
    expect(() => R.parseClaudeResult(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))).toThrow(/boom/);
    expect(() => R.parseClaudeResult('not json')).toThrow(/not JSON/);
  });
});

describe('approval', () => {
  it('runs for real only the version the person approved', async () => {
    F.saveFlow(timesheet());
    expect(() => R.startRun('daily-timesheet')).toThrow(/waiting for your approval/);
    expect(flowBlocker('daily-timesheet')?.text).toMatch(/waiting for your approval/);
    const a = F.approvalOf(F.getFlow('daily-timesheet'));
    expect(() => F.approveFlow('daily-timesheet', 'wrong')).toThrow(/changed while you were looking/);
    expect(F.approveFlow('daily-timesheet', a.hash).state).toBe('approved');
    expect(flowBlocker('daily-timesheet')).toBeNull();

    const f = F.getFlow('daily-timesheet');
    f.blocks[1].tier = 'premium';
    F.saveFlow(f);
    const after = F.approvalOf(F.getFlow('daily-timesheet'));
    expect(after).toMatchObject({ state: 'changed', changed: ['log'] });
    expect(() => R.startRun('daily-timesheet')).toThrow(/changed since you approved it \(log\)/);
  });

  it('lets a trial run without approval', async () => {
    F.saveFlow(timesheet());
    const { exec, calls } = fake({});
    const { done } = R.startRun('daily-timesheet', { trial: true, executor: exec });
    const run = await done;
    expect(run).toMatchObject({ status: 'passed', trial: true, trigger: 'trial' });
    expect(calls.every(c => c.trial)).toBe(true);
  });
});

describe('the orchestrator', () => {
  function approved(f: Flow) {
    F.saveFlow(f);
    F.approveFlow(f.id, F.approvalOf(F.getFlow(f.id)).hash);
  }

  it('runs the blocks in order and hands each the outputs it asked for', async () => {
    approved(timesheet());
    const { exec, calls } = fake({ gather: [{ status: 'pass', output: '3h on the parser' }] });
    const run = await R.startRun('daily-timesheet', { executor: exec, input: 'office day' }).done;
    expect(run.status).toBe('passed');
    expect(run.steps.map(s => [s.block, s.status, s.next])).toEqual([['gather', 'pass', 'log'], ['log', 'pass', 'end']]);
    expect(calls[1].prompt).toMatch(/Output of block "gather":\n3h on the parser/);
    expect(calls[1].prompt).toMatch(/Input for this run:\noffice day/);
    expect(run.cost).toBeCloseTo(0.02);
    expect(R.getRun(run.runId)?.status).toBe('passed');
  });

  it('retries with the reason, then follows the fail edge', async () => {
    approved(timesheet());
    const { exec, calls } = fake({ log: [{ status: 'fail', output: '', notes: 'sheet locked' }, { status: 'fail', output: '', notes: 'still locked' }] });
    const run = await R.startRun('daily-timesheet', { executor: exec }).done;
    expect(run.status).toBe('failed');
    expect(run.steps.map(s => `${s.block}#${s.attempt}:${s.status}`)).toEqual(['gather#1:pass', 'log#1:fail', 'log#2:fail']);
    expect(calls[2].prompt).toMatch(/Your previous try failed:\nsheet locked/);
    expect(run.steps[2].next).toBe('stop');
  });

  it('can loop back, and stops a loop at the step limit', async () => {
    approved(timesheet({
      id: 'fix-loop', limits: { maxSteps: 5 },
      blocks: [
        { id: 'write', purpose: 'Write the weekly summary.' },
        { id: 'check', purpose: 'Check the summary names every project.', input: ['write'], next: { fail: 'write' } },
      ],
    }));
    const { exec } = fake({ check: [{ status: 'fail', output: '', notes: 'missing X' }, { status: 'pass', output: 'ok' }] });
    const ok = await R.startRun('fix-loop', { executor: exec }).done;
    expect(ok.steps.map(s => s.block)).toEqual(['write', 'check', 'write', 'check']);
    expect(ok.status).toBe('passed');

    const always = fake({ check: Array(10).fill({ status: 'fail', output: '' }) });
    const loop = await R.startRun('fix-loop', { executor: always.exec }).done;
    expect(loop).toMatchObject({ status: 'error', error: expect.stringMatching(/limit of 5 steps/) });
  });

  it('stops at the usage limit', async () => {
    approved(timesheet({ limits: { usd: 0.5 } }));
    const { exec } = fake({ gather: [{ status: 'pass', output: 'x', cost: 0.6 }] });
    const run = await R.startRun('daily-timesheet', { executor: exec }).done;
    expect(run).toMatchObject({ status: 'error', error: expect.stringMatching(/usage limit/) });
    expect(run.steps.map(s => s.block)).toEqual(['gather']);
  });

  it('skips command blocks in a trial unless they only read, and passes outputs as env', async () => {
    approved(timesheet({
      id: 'with-commands',
      blocks: [
        { id: 'draft', purpose: 'Draft the standup note for today.' },
        { id: 'lint', kind: 'command', purpose: 'Check the note format.', command: 'true', runInTrial: true, input: ['draft'] },
        { id: 'post', kind: 'command', purpose: 'Post the note to the team.', command: 'post-note' },
      ],
    }));
    const { exec, calls } = fake({ draft: [{ status: 'pass', output: 'Did X' }] });
    const run = await R.startRun('with-commands', { executor: exec, trial: true }).done;
    expect(run.steps.map(s => `${s.block}:${s.status}`)).toEqual(['draft:pass', 'lint:pass', 'post:skipped']);
    expect(calls.map(c => c.block)).toEqual(['draft', 'lint']);
    expect(calls[1].env).toMatchObject({ FLOW_OUT_DRAFT: 'Did X', LAZYFLEET_TRIAL: '1' });
  });

  it('runs one at a time per flow', async () => {
    approved(timesheet());
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = { agent: async () => { await gate; return { status: 'pass', output: '' } as BlockResult; }, command: async () => ({ status: 'pass', output: '' }) as BlockResult };
    const first = R.startRun('daily-timesheet', { executor: slow });
    expect(() => R.startRun('daily-timesheet', { executor: slow })).toThrow(/already running/);
    expect(flowBlocker('daily-timesheet')).toMatchObject({ retry: true });
    release();
    await first.done;
  });
});

describe('scheduling a flow', () => {
  const at = new Date(2026, 8, 28, 18, 31);

  function deps(started: string[]) {
    return {
      now: () => at,
      listSprints: () => [],
      launch: async () => { throw new Error('no sprints here'); },
      recommend: () => ({ designId: 'solo' }),
      githubToken: async () => null,
      listIssues: async () => [],
      comment: async () => '',
      repoIsClean: async () => true,
      sprintedIssues: () => new Set<string>(),
      reportedRuns: () => new Set<string>(),
      markReported: () => {},
      startFlow: async ({ flowId }: { flowId: string }) => { started.push(flowId); return { runId: `${flowId}-run` }; },
      flowRuns: (id: string) => R.listRuns(id),
      flowBlocker,
    };
  }

  it('needs no project folder and starts the flow when due and approved', async () => {
    F.saveFlow(timesheet());
    const s = sched.saveSchedule({ name: 'Timesheet', repo: '', source: { type: 'flow', flow: 'daily-timesheet' }, when: { type: 'daily', time: '18:30', days: [1, 2, 3, 4, 5] } });
    expect(s).toMatchObject({ repo: '', design: 'flow', requireClean: false });
    const list = sched.loadSchedules();
    list[0].lastFiredAt = new Date(2026, 8, 27, 19, 0).toISOString();
    fs.writeFileSync(path.join(process.env.LAZYFLEET_DIR!, 'schedules.json'), JSON.stringify(list));

    const started: string[] = [];
    await sched.tick(deps(started) as any);
    expect(started).toEqual([]);
    expect(sched.loadSchedules()[0].log.at(-1)?.text).toMatch(/waiting for your approval/);

    F.approveFlow('daily-timesheet', F.approvalOf(F.getFlow('daily-timesheet')).hash);
    const again = sched.loadSchedules();
    again[0].lastFiredAt = new Date(2026, 8, 27, 19, 0).toISOString();
    fs.writeFileSync(path.join(process.env.LAZYFLEET_DIR!, 'schedules.json'), JSON.stringify(again));
    await sched.tick(deps(started) as any);
    expect(started).toEqual(['daily-timesheet']);
    expect(sched.loadSchedules()[0].log.at(-1)).toMatchObject({ action: 'started', runId: 'daily-timesheet-run' });
  });

  it('never lets Run now skip the approval', async () => {
    F.saveFlow(timesheet());
    const s = sched.saveSchedule({ name: 'Timesheet', repo: '', source: { type: 'flow', flow: 'daily-timesheet' }, when: { type: 'interval', hours: 24 } });
    const started: string[] = [];
    expect(await sched.fire(s, deps(started) as any, { override: true, manual: true })).toBeNull();
    expect(started).toEqual([]);
  });
});
