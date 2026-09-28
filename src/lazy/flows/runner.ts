/**
 * The flow orchestrator: plain code that walks a flow's graph.
 *
 * It starts at the first block, runs it, and follows the block's pass or fail
 * edge. It hands each block the outputs of the blocks it names in `input`,
 * retries a failing block as often as the block allows (telling it why the
 * last try failed), and stops at 'end' (passed), 'stop' (failed), the step
 * limit or the usage limit. Nothing here is decided by a model: the models
 * only do the work inside a block, and each one answers with the same small
 * result, { status, output, notes }.
 *
 * An agent block is one headless `claude -p` run with that block's model, its
 * tools and only the MCP servers it names. A command block is one shell
 * command. Runs are recorded step by step in ~/.lazyfleet/flow-runs/, so a
 * run can be reviewed while it is still going.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lazyDir } from '../config.js';
import { ROLE_HEADER } from '../guide.js';
import {
  approvalOf, checkFlow, DEFAULT_MAX_STEPS, DEFAULT_TIMEOUT_MINUTES, edgesOf, getFlow, mcpConfigFor, readContext,
  startOf, TIER_MODEL, toolsFor, workdirOf, type Flow, type FlowBlock,
} from './flow.js';

export interface BlockResult {
  status: 'pass' | 'fail';
  output: string;
  notes?: string;
  cost?: number;
  model?: string;
  /** Not run at all (a command block in a trial). */
  skipped?: boolean;
}

export interface FlowStep {
  block: string;
  attempt: number;
  status: 'running' | 'pass' | 'fail' | 'skipped';
  startedAt: string;
  endedAt?: string;
  output?: string;
  notes?: string;
  error?: string;
  cost?: number;
  model?: string;
  /** Where the orchestrator went after this step. */
  next?: string;
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'error' | 'stopped';

export interface FlowRun {
  runId: string;
  flowId: string;
  flowName: string;
  /** The approval fingerprint of the version that ran. */
  hash: string;
  trial: boolean;
  trigger: 'manual' | 'schedule' | 'trial';
  scheduleId?: string;
  input?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  cost: number;
  steps: FlowStep[];
  error?: string;
  workdir: string;
}

export interface AgentRequest {
  flow: Flow;
  block: FlowBlock;
  prompt: string;
  system: string;
  model: string;
  trial: boolean;
  cwd: string;
  timeoutMs: number;
  /** Most this block may spend, when the run has a limit. */
  budgetUsd?: number;
  signal: AbortSignal;
}

export interface CommandRequest {
  block: FlowBlock;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface Executor {
  agent(req: AgentRequest): Promise<BlockResult>;
  command(req: CommandRequest): Promise<BlockResult>;
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

const KEEP_RUNS_PER_FLOW = 50;
const MAX_TEXT = 20000;

export function runsDir(): string {
  return path.join(lazyDir(), 'flow-runs');
}

function runFile(runId: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(runId)) throw new Error('Not a run id');
  return path.join(runsDir(), `${runId}.json`);
}

function saveRun(run: FlowRun): void {
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  const tmp = runFile(run.runId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, runFile(run.runId));
}

export function getRun(runId: string): FlowRun | null {
  try {
    return JSON.parse(fs.readFileSync(runFile(runId), 'utf-8')) as FlowRun;
  } catch {
    return null;
  }
}

/** Runs, newest first; one flow's only when `flowId` is given. */
export function listRuns(flowId?: string): FlowRun[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];
  const out: FlowRun[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as FlowRun;
      if (!flowId || r.flowId === flowId) out.push(r);
    } catch {
      // A half-written file is skipped; the next save replaces it.
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function prune(flowId: string): void {
  for (const r of listRuns(flowId).slice(KEEP_RUNS_PER_FLOW)) fs.rmSync(runFile(r.runId), { force: true });
}

/** Runs left 'running' by a lazyfleet that stopped mid-run can never finish: say so. */
export function markInterruptedRuns(): number {
  let n = 0;
  for (const r of listRuns()) {
    if (r.status !== 'running' || active.has(r.flowId)) continue;
    r.status = 'error';
    r.error = 'lazyfleet stopped during this run';
    r.endedAt = new Date().toISOString();
    for (const s of r.steps) if (s.status === 'running') { s.status = 'fail'; s.error = r.error; s.endedAt = r.endedAt; }
    saveRun(r);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    output: { type: 'string', description: 'Everything the next blocks need from this one, complete and self-contained.' },
    notes: { type: 'string', description: 'One or two sentences for the person reviewing the run.' },
  },
  required: ['status', 'output', 'notes'],
  additionalProperties: false,
};

function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? s.slice(0, max) + `\n...(${s.length - max} more characters cut)` : s;
}

export function systemPrompt(flow: Flow, block: FlowBlock, trial: boolean): string {
  const parts = [
    `You are one block, "${block.name || block.id}", of the lazyfleet flow "${flow.name}". The flow is for: ${flow.purpose}`,
    'An orchestrator runs the blocks in a fixed order and passes outputs between them. Do only this block\'s job; other blocks do the rest.',
    'Nobody is watching this run, so never ask a question. If something you need is missing or a tool is refused, fail and say what was missing.',
    'Finish with the structured result:',
    '- status "pass" when the job is done (for a checking job: when the check holds), "fail" when it could not be done or the check does not hold.',
    '- output: everything the next blocks need, complete and self-contained. It is all they see from you.',
    '- notes: one or two sentences for the person who reviews the run.',
  ];
  if (trial) {
    parts.push(
      'THIS IS A TRIAL RUN. Change nothing: no writes, no posts, no sends. Only read-only tools are available.',
      'Do everything up to the point where you would change something, then pass, with output saying exactly what you would have done (the rows, the message, the file contents).',
    );
  }
  for (const c of readContext(flow)) parts.push(`\nContext file ${c.file}:\n${clip(c.text, 64 * 1024)}`);
  return parts.join('\n');
}

export function blockPrompt(block: FlowBlock, inputs: Array<{ from: string; output: string }>, runInput: string | undefined, lastFailure: string | undefined, now: Date): string {
  const parts = [`Your job:\n${block.purpose}`, `Now: ${now.toString()}.`];
  if (runInput) parts.push(`Input for this run:\n${runInput}`);
  for (const x of inputs) parts.push(`Output of block "${x.from}":\n${clip(x.output)}`);
  if (lastFailure) parts.push(`Your previous try failed:\n${lastFailure}\nFix that and try again.`);
  return parts.join('\n\n');
}

function modelFor(block: FlowBlock): string {
  return block.model || TIER_MODEL[block.tier ?? 'standard'];
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/** Flows running right now, by flow id: one run per flow at a time. */
const active = new Map<string, { runId: string; abort: AbortController }>();

export function activeRun(flowId: string): string | undefined {
  return active.get(flowId)?.runId;
}

export interface StartOptions {
  trial?: boolean;
  input?: string;
  trigger?: FlowRun['trigger'];
  scheduleId?: string;
  executor?: Executor;
  now?: () => Date;
}

/**
 * Start a run in the background and return its record at once. A real run
 * needs the person's approval of this exact version; a trial does not.
 */
export function startRun(flowId: string, opts: StartOptions = {}): { run: FlowRun; done: Promise<FlowRun> } {
  const flow = getFlow(flowId);
  checkFlow(flow);
  const trial = !!opts.trial;
  const approval = approvalOf(flow);
  if (!trial && approval.state !== 'approved') {
    throw new Error(approval.state === 'never'
      ? `"${flow.name}" is waiting for your approval on the Flows page before it runs for real (a trial run works now)`
      : `"${flow.name}" changed since you approved it (${(approval.changed ?? []).join(', ')}); approve the new version on the Flows page`);
  }
  if (active.has(flow.id)) throw new Error(`"${flow.name}" is already running`);
  if (opts.input !== undefined && (typeof opts.input !== 'string' || opts.input.length > 8000)) throw new Error('The run input is text of up to 8000 characters');
  const now = opts.now ?? (() => new Date());
  const run: FlowRun = {
    runId: `${flow.id}-${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`,
    flowId: flow.id,
    flowName: flow.name,
    hash: approval.hash,
    trial,
    trigger: trial ? 'trial' : opts.trigger ?? 'manual',
    ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    ...(opts.input ? { input: opts.input } : {}),
    status: 'running',
    startedAt: now().toISOString(),
    cost: 0,
    steps: [],
    workdir: workdirOf(flow),
  };
  saveRun(run);
  const abort = new AbortController();
  active.set(flow.id, { runId: run.runId, abort });
  const done = orchestrate(flow, run, opts.executor ?? claudeExecutor, abort.signal, now)
    .catch(e => {
      run.status = 'error';
      run.error = (e as Error).message;
      return run;
    })
    .then(r => {
      r.endedAt = now().toISOString();
      saveRun(r);
      active.delete(flow.id);
      prune(flow.id);
      return r;
    });
  return { run, done };
}

export function stopRun(runId: string): boolean {
  for (const [, a] of active) {
    if (a.runId === runId) {
      a.abort.abort();
      return true;
    }
  }
  return false;
}

async function orchestrate(flow: Flow, run: FlowRun, exec: Executor, signal: AbortSignal, now: () => Date): Promise<FlowRun> {
  const byId = new Map(flow.blocks.map(b => [b.id, b]));
  const outputs = new Map<string, string>();
  const maxSteps = flow.limits?.maxSteps ?? DEFAULT_MAX_STEPS;
  let current = startOf(flow);
  let visits = 0;
  while (current !== 'end' && current !== 'stop') {
    if (signal.aborted) { run.status = 'stopped'; return run; }
    if (++visits > maxSteps) {
      run.status = 'error';
      run.error = `went past its limit of ${maxSteps} steps (it may be looping)`;
      return run;
    }
    const block = byId.get(current);
    if (!block) throw new Error(`the flow points at "${current}", which is not a block`);
    let result: BlockResult | null = null;
    let failure: string | undefined;
    for (let attempt = 1; attempt <= (block.retries ?? 0) + 1; attempt++) {
      if (flow.limits?.usd !== undefined && run.cost >= flow.limits.usd) {
        run.status = 'error';
        run.error = `spent its usage limit ($${run.cost.toFixed(2)} of $${flow.limits.usd.toFixed(2)})`;
        return run;
      }
      const step: FlowStep = { block: block.id, attempt, status: 'running', startedAt: now().toISOString() };
      run.steps.push(step);
      saveRun(run);
      try {
        result = await runBlock(flow, run, block, outputs, failure, exec, signal, now);
      } catch (e) {
        result = null;
        step.error = (e as Error).message;
      }
      if (signal.aborted) {
        step.status = 'fail';
        step.error = 'stopped by you';
        step.endedAt = now().toISOString();
        run.status = 'stopped';
        return run;
      }
      step.endedAt = now().toISOString();
      if (result) {
        step.status = result.skipped ? 'skipped' : result.status;
        step.output = clip(result.output);
        if (result.notes) step.notes = clip(result.notes, 2000);
        if (result.cost) { step.cost = result.cost; run.cost += result.cost; }
        if (result.model) step.model = result.model;
      } else step.status = 'fail';
      if (result?.status === 'pass') break;
      failure = step.error ?? result?.notes ?? result?.output ?? 'no reason given';
      saveRun(run);
    }
    if (result) outputs.set(block.id, result.output);
    const edges = edgesOf(flow, block);
    current = result?.status === 'pass' ? edges.pass : edges.fail;
    run.steps[run.steps.length - 1].next = current;
    saveRun(run);
  }
  run.status = current === 'end' ? 'passed' : 'failed';
  return run;
}

async function runBlock(flow: Flow, run: FlowRun, block: FlowBlock, outputs: Map<string, string>, failure: string | undefined, exec: Executor, signal: AbortSignal, now: () => Date): Promise<BlockResult> {
  const timeoutMs = (block.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60000;
  const inputs = (block.input ?? []).filter(id => outputs.has(id)).map(id => ({ from: id, output: outputs.get(id)! }));
  if ((block.kind ?? 'agent') === 'command') {
    if (run.trial && !block.runInTrial) return { status: 'pass', output: '(trial run: this command was not run)', notes: 'Skipped in the trial.', skipped: true };
    const env: Record<string, string> = { LAZYFLEET_FLOW: flow.id, LAZYFLEET_TRIAL: run.trial ? '1' : '0' };
    if (run.input) env.FLOW_INPUT = run.input;
    for (const x of inputs) env[`FLOW_OUT_${x.from.toUpperCase().replace(/-/g, '_')}`] = x.output;
    return exec.command({ block, command: block.command!, cwd: run.workdir, env, timeoutMs, signal });
  }
  const budgetUsd = flow.limits?.usd !== undefined ? Math.max(0.01, flow.limits.usd - run.cost) : undefined;
  return exec.agent({
    flow, block, model: modelFor(block), trial: run.trial, cwd: run.workdir, timeoutMs, signal,
    system: systemPrompt(flow, block, run.trial),
    prompt: blockPrompt(block, inputs, run.input, failure, now()),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });
}

// ---------------------------------------------------------------------------
// The real executor
// ---------------------------------------------------------------------------

/** The `claude` arguments for one agent block. Exported so tests can see exactly what a block may do. */
export function claudeArgs(req: AgentRequest): string[] {
  const tools = toolsFor(req.block, req.trial);
  const builtins = [...new Set(tools.filter(t => t.builtin).map(t => t.builtin!))];
  const args = [
    '-p', req.prompt,
    '--model', req.model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(RESULT_SCHEMA),
    '--no-session-persistence',
    // Anything not listed below is refused, never asked about: nobody is there to answer.
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', req.system,
    '--tools', builtins.join(','),
    '--strict-mcp-config',
  ];
  if (tools.length) args.push('--allowedTools', ...tools.map(t => t.allow));
  const mcp = mcpConfigFor(tools, req.flow.folder);
  if (mcp) args.push('--mcp-config', JSON.stringify(mcp));
  if (req.budgetUsd !== undefined) args.push('--max-budget-usd', req.budgetUsd.toFixed(2));
  return args;
}

/** The final result out of `claude -p --output-format json` (one object, or a list of events). */
export function parseClaudeResult(stdout: string): BlockResult {
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error(`the model's answer was not JSON: ${stdout.slice(0, 300)}`);
  }
  const r = Array.isArray(j) ? [...j].reverse().find(e => e?.type === 'result') : j;
  if (!r) throw new Error('the model gave no result');
  if (r.is_error) throw new Error(`the model run failed: ${String(r.result ?? r.subtype ?? 'unknown error').slice(0, 500)}`);
  let s = r.structured_output;
  if (!s && typeof r.result === 'string') {
    try { s = JSON.parse(r.result); } catch { /* handled below */ }
  }
  if (!s || (s.status !== 'pass' && s.status !== 'fail') || typeof s.output !== 'string') throw new Error(`the model did not return a result: ${String(r.result ?? '').slice(0, 300)}`);
  const model = r.modelUsage ? Object.keys(r.modelUsage)[0] : undefined;
  return { status: s.status, output: s.output, notes: typeof s.notes === 'string' ? s.notes : undefined, cost: Number(r.total_cost_usd) || 0, ...(model ? { model } : {}) };
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // A block is its own Claude Code session, not a child of whichever one started lazyfleet.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Marks its requests so the proxy does not tell a block to go and design flows.
  env.ANTHROPIC_CUSTOM_HEADERS = [process.env.ANTHROPIC_CUSTOM_HEADERS, `${ROLE_HEADER}: flow`].filter(Boolean).join('\n');
  return env;
}

let claudeBin: Promise<string> | null = null;
/** The claude binary, found on the login shell's PATH when the service's own PATH lacks it. */
function findClaude(): Promise<string> {
  claudeBin ??= (async () => {
    const { findOnPath, helperPath } = await import('../sprints/launcher.js');
    const dir = findOnPath('claude') ?? findOnPath('claude', (await helperPath()) ?? '');
    if (!dir) throw new Error('Claude Code (`claude`) is not on this machine\'s PATH');
    return path.join(dir, 'claude');
  })();
  claudeBin.catch(() => { claudeBin = null; });
  return claudeBin;
}

function run(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal; shell?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, shell: o.shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 4_000_000) child.kill(); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    o.signal.addEventListener('abort', kill, { once: true });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export const claudeExecutor: Executor = {
  async agent(req) {
    const r = await run(await findClaude(), claudeArgs(req), { cwd: req.cwd, env: childEnv(), timeoutMs: req.timeoutMs, signal: req.signal });
    if (r.timedOut) throw new Error(`timed out after ${Math.round(req.timeoutMs / 60000)} minutes`);
    if (req.signal.aborted) throw new Error('stopped by you');
    if (!r.stdout.trim()) throw new Error(`claude exited ${r.code} without an answer: ${r.stderr.trim().slice(-500)}`);
    return parseClaudeResult(r.stdout);
  },
  async command(req) {
    const r = await run(req.command, [], { cwd: req.cwd, env: childEnv(req.env), timeoutMs: req.timeoutMs, signal: req.signal, shell: true });
    if (r.timedOut) throw new Error(`timed out after ${Math.round(req.timeoutMs / 60000)} minutes`);
    const out = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
    return { status: r.code === 0 ? 'pass' : 'fail', output: clip(out.slice(-8000)), notes: `exit code ${r.code}` };
  },
};
