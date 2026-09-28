/**
 * Flows: jobs made of blocks, run in a fixed order by a plain-code orchestrator.
 *
 * A sprint design shapes the code-sprint engine (plan, build, review...). A
 * flow is for work that does not fit that shape: a daily timesheet, a report,
 * a check that posts somewhere. Each block has a job written in plain words,
 * a model tier (or an exact model), the tools it may use, the earlier blocks
 * whose output it reads, and where to go on pass and on fail. The graph is
 * fixed; the models do the work inside each block (runner.ts).
 *
 * Claude writes flows for the person, who only reviews them. A flow runs for
 * real only after the person approved exactly this version of it on the
 * Flows page; any change needs a fresh approval. A trial run (read-only
 * tools, nothing changed) needs no approval, so Claude can test before
 * showing it.
 *
 * Files: ~/.lazyfleet/flows/<id>.json, approvals in ~/.lazyfleet/flows/approvals.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lazyDir } from '../config.js';

export type Tier = 'cheap' | 'standard' | 'premium';
export type BlockKind = 'agent' | 'command';

export interface FlowBlock {
  /** Lowercase id other blocks use to point here. */
  id: string;
  name?: string;
  /** 'agent' (a model does the job; the default) or 'command' (one shell command). */
  kind?: BlockKind;
  /** The block's job, in plain words. For an agent this is its prompt. */
  purpose: string;
  /** For a command block: the command, run in the flow's folder. */
  command?: string;
  /** Model tier, used unless `model` names one exactly. Default standard. */
  tier?: Tier;
  model?: string;
  /** Tools an agent may use: Read, Grep, Glob, Write, Edit, Bash, WebFetch, WebSearch, optionally with a pattern like Bash(git log:*); mcp:<server> or mcp:<server>/<tool>. */
  tools?: string[];
  /** The part of `tools` that only reads, and so may be used in a trial run. */
  trialTools?: string[];
  /** A command block that only reads, and so runs in a trial run too. */
  runInTrial?: boolean;
  /** Earlier blocks whose output this block receives. */
  input?: string[];
  /** Where to go next: a block id, 'end' (the flow passed) or 'stop' (the flow failed). */
  next?: { pass?: string; fail?: string };
  /** Tries again this many times, with the failure notes, before following `next.fail`. */
  retries?: number;
  timeoutMinutes?: number;
}

export interface Flow {
  id: string;
  name: string;
  /** What the whole flow is for; every block is told. */
  purpose: string;
  /** Folder the blocks work in. Its CLAUDE.md is read by every agent block. */
  folder?: string;
  /** Extra files (relative to `folder`) every agent block is given: preferences, instructions. */
  context?: string[];
  /** First block; default the first in the list. */
  start?: string;
  blocks: FlowBlock[];
  limits?: { usd?: number; maxSteps?: number };
  updatedAt?: string;
}

export const TIER_MODEL: Record<Tier, string> = { cheap: 'haiku', standard: 'sonnet', premium: 'opus' };
export const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];
export const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
export const DEFAULT_TIMEOUT_MINUTES = 15;
export const DEFAULT_MAX_STEPS = 25;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TARGETS = new Set(['end', 'stop']);
const TOOL_RE = /^([A-Z][A-Za-z]+)(\((.{1,200})\))?$/;
const MCP_RE = /^mcp:([A-Za-z0-9_-]{1,64})(\/([A-Za-z0-9_-]{1,100}))?$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,60}$/;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSpec {
  /** As written in the flow. */
  spec: string;
  /** Built-in tool name, when it is one. */
  builtin?: string;
  /** MCP server, when it is one. */
  server?: string;
  /** What Claude Code's --allowedTools takes. */
  allow: string;
}

export function parseTool(spec: string): ToolSpec | null {
  const m = MCP_RE.exec(spec);
  if (m) return { spec, server: m[1], allow: m[3] ? `mcp__${m[1]}__${m[3]}` : `mcp__${m[1]}` };
  const t = TOOL_RE.exec(spec);
  if (t && BUILTIN_TOOLS.includes(t[1])) return { spec, builtin: t[1], allow: spec };
  return null;
}

/** `wide` allows at least everything `narrow` does (Bash covers Bash(x), mcp:s covers mcp:s/t). */
export function toolCovers(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  const a = parseTool(wide), b = parseTool(narrow);
  if (!a || !b) return false;
  if (a.server && b.server) return a.server === b.server && !wide.includes('/');
  return !!a.builtin && a.builtin === b.builtin && a.spec === a.builtin;
}

/** Tools a block may use in this run: everything, or in a trial only what cannot change anything. */
export function toolsFor(block: FlowBlock, trial: boolean): ToolSpec[] {
  const all = (block.tools ?? []).map(parseTool).filter((t): t is ToolSpec => !!t);
  if (!trial) return all;
  const safe = all.filter(t => t.builtin && READ_ONLY_TOOLS.has(t.builtin));
  const extra = (block.trialTools ?? []).map(parseTool).filter((t): t is ToolSpec => !!t);
  return [...safe, ...extra.filter(t => !safe.some(s => s.spec === t.spec))];
}

// ---------------------------------------------------------------------------
// MCP servers: taken from the person's own Claude Code config, by name
// ---------------------------------------------------------------------------

function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** Every MCP server Claude Code would load in `folder`: user scope, the folder's local scope, then its .mcp.json. */
export function knownMcpServers(folder?: string): Record<string, unknown> {
  const j = readJson(claudeJsonPath()) ?? {};
  const out: Record<string, unknown> = { ...(j.mcpServers ?? {}) };
  if (folder) {
    Object.assign(out, j.projects?.[folder]?.mcpServers ?? {});
    Object.assign(out, readJson(path.join(folder, '.mcp.json'))?.mcpServers ?? {});
  }
  return out;
}

/** The --mcp-config for exactly the servers a block names, or null when it names none. */
export function mcpConfigFor(tools: ToolSpec[], folder?: string): { mcpServers: Record<string, unknown> } | null {
  const names = [...new Set(tools.filter(t => t.server).map(t => t.server!))];
  if (!names.length) return null;
  const known = knownMcpServers(folder);
  const mcpServers: Record<string, unknown> = {};
  for (const n of names) {
    if (!known[n]) throw new Error(`The MCP server "${n}" is not set up in Claude Code (see \`claude mcp list\`)`);
    mcpServers[n] = known[n];
  }
  return { mcpServers };
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export function startOf(flow: Flow): string {
  return flow.start || flow.blocks[0]?.id;
}

/** Where a block goes on pass and on fail, with the defaults filled in. */
export function edgesOf(flow: Flow, block: FlowBlock): { pass: string; fail: string } {
  const i = flow.blocks.indexOf(block);
  return {
    pass: block.next?.pass ?? flow.blocks[i + 1]?.id ?? 'end',
    fail: block.next?.fail ?? 'stop',
  };
}

function reachable(flow: Flow): Set<string> {
  const seen = new Set<string>();
  const byId = new Map(flow.blocks.map(b => [b.id, b]));
  const stack = [startOf(flow)];
  while (stack.length) {
    const id = stack.pop()!;
    const b = byId.get(id);
    if (!b || seen.has(id)) continue;
    seen.add(id);
    const e = edgesOf(flow, b);
    stack.push(e.pass, e.fail);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function text(v: unknown, max: number): v is string {
  // Plain text only: it reaches prompts and shell commands.
  return typeof v === 'string' && v.length <= max && /^[\x20-\x7e\n\t]*$/.test(v);
}

function contextFile(folder: string, rel: string): string {
  const full = path.resolve(folder, rel);
  if (full !== folder && !full.startsWith(folder + path.sep)) throw new Error(`the context file ${rel} is outside the folder`);
  return full;
}

/** Everything that stops the flow from running, in words Claude can act on. Empty when it is fine. */
export function flowProblems(flow: Flow): string[] {
  const p: string[] = [];
  if (!flow || typeof flow !== 'object') return ['A flow is a JSON object'];
  if (!ID_RE.test(String(flow.id ?? ''))) p.push('id: lowercase letters, digits and dashes, up to 40 (e.g. "daily-timesheet")');
  if (!text(flow.name, 80) || !flow.name.trim()) p.push('name: up to 80 plain characters');
  if (!text(flow.purpose, 2000) || flow.purpose.trim().length < 10) p.push('purpose: say what the flow is for, in at least a sentence (plain text, up to 2000)');
  if (flow.folder !== undefined) {
    if (typeof flow.folder !== 'string' || !path.isAbsolute(flow.folder)) p.push('folder: a full path');
    else if (!fs.existsSync(flow.folder) || !fs.statSync(flow.folder).isDirectory()) p.push(`folder: ${flow.folder} is not a folder on this machine`);
  }
  if (flow.context !== undefined) {
    if (!Array.isArray(flow.context) || flow.context.length > 10) p.push('context: a list of up to 10 file paths');
    else if (!flow.folder) p.push('context: files are read from the folder, so set folder too');
    else for (const rel of flow.context) {
      try {
        const f = contextFile(flow.folder, String(rel));
        if (!fs.existsSync(f)) p.push(`context: ${rel} does not exist in ${flow.folder}`);
        else if (fs.statSync(f).size > 64 * 1024) p.push(`context: ${rel} is over 64 KB`);
      } catch (e) {
        p.push(`context: ${(e as Error).message}`);
      }
    }
  }
  if (flow.limits !== undefined) {
    const { usd, maxSteps } = flow.limits ?? {};
    if (usd !== undefined && (typeof usd !== 'number' || !(usd >= 0.01 && usd <= 100))) p.push('limits.usd: between 0.01 and 100 (estimated dollars per run)');
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100)) p.push('limits.maxSteps: a whole number from 1 to 100');
  }
  if (!Array.isArray(flow.blocks) || !flow.blocks.length) return [...p, 'blocks: at least one block'];
  if (flow.blocks.length > 30) p.push('blocks: at most 30');
  const ids = new Set<string>();
  for (const [i, b] of flow.blocks.entries()) {
    const who = `blocks[${i}]${b?.id ? ` (${b.id})` : ''}`;
    if (!b || typeof b !== 'object') { p.push(`${who}: a block is an object`); continue; }
    if (!ID_RE.test(String(b.id ?? '')) || TARGETS.has(b.id)) p.push(`${who}.id: lowercase letters, digits and dashes; not "end" or "stop"`);
    else if (ids.has(b.id)) p.push(`${who}.id: used twice`);
    ids.add(b.id);
    if (b.name !== undefined && !text(b.name, 80)) p.push(`${who}.name: up to 80 plain characters`);
    const kind = b.kind ?? 'agent';
    if (kind !== 'agent' && kind !== 'command') p.push(`${who}.kind: "agent" or "command"`);
    if (!text(b.purpose, 4000) || b.purpose.trim().length < 10) p.push(`${who}.purpose: write the block's job in at least a sentence (plain text, up to 4000)`);
    if (kind === 'command') {
      if (!text(b.command, 500) || !b.command.trim() || /\n/.test(b.command)) p.push(`${who}.command: one line, up to 500 characters`);
      if (b.tools?.length || b.trialTools?.length || b.tier || b.model) p.push(`${who}: a command block takes no tools, tier or model`);
    } else {
      if (b.command !== undefined) p.push(`${who}.command: only command blocks run a command`);
      if (b.runInTrial !== undefined) p.push(`${who}.runInTrial: only for command blocks (agents use trialTools)`);
      if (b.tier !== undefined && !(b.tier in TIER_MODEL)) p.push(`${who}.tier: cheap, standard or premium`);
      if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL_RE.test(b.model))) p.push(`${who}.model: a Claude model name like "haiku" or "claude-sonnet-5"`);
      for (const key of ['tools', 'trialTools'] as const) {
        const list = b[key];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.length > 30) { p.push(`${who}.${key}: a list of up to 30 tools`); continue; }
        for (const t of list) if (!parseTool(String(t))) p.push(`${who}.${key}: "${t}" is not a tool; use ${BUILTIN_TOOLS.join(', ')} (optionally like Bash(git log:*)), or mcp:<server> / mcp:<server>/<tool>`);
      }
      for (const t of b.trialTools ?? []) {
        if (parseTool(String(t)) && !(b.tools ?? []).some(w => toolCovers(String(w), String(t)))) p.push(`${who}.trialTools: "${t}" is not in its tools`);
      }
      try {
        mcpConfigFor(toolsFor(b, false), flow.folder);
      } catch (e) {
        p.push(`${who}.tools: ${(e as Error).message}`);
      }
    }
    if (b.input !== undefined && (!Array.isArray(b.input) || b.input.some(x => typeof x !== 'string'))) p.push(`${who}.input: a list of block ids`);
    if (b.retries !== undefined && (!Number.isInteger(b.retries) || b.retries < 0 || b.retries > 3)) p.push(`${who}.retries: 0 to 3`);
    if (b.timeoutMinutes !== undefined && (!Number.isInteger(b.timeoutMinutes) || b.timeoutMinutes < 1 || b.timeoutMinutes > 120)) p.push(`${who}.timeoutMinutes: 1 to 120`);
    if (b.next !== undefined && (typeof b.next !== 'object' || b.next === null)) p.push(`${who}.next: { "pass": ..., "fail": ... }`);
  }
  for (const [i, b] of flow.blocks.entries()) {
    if (!b || typeof b !== 'object') continue;
    const who = `blocks[${i}] (${b.id})`;
    for (const edge of ['pass', 'fail'] as const) {
      const t = b.next?.[edge];
      if (t !== undefined && !TARGETS.has(t) && !ids.has(t)) p.push(`${who}.next.${edge}: "${t}" is not a block id, "end" or "stop"`);
    }
    for (const x of Array.isArray(b.input) ? b.input : []) if (!ids.has(x)) p.push(`${who}.input: "${x}" is not a block id`);
  }
  if (flow.start !== undefined && !ids.has(flow.start)) p.push(`start: "${flow.start}" is not a block id`);
  return p;
}

/** Things that run but that the person reviewing should know about. */
export function flowWarnings(flow: Flow): string[] {
  const w: string[] = [];
  const reach = reachable(flow);
  for (const b of flow.blocks) {
    const who = b.name || b.id;
    if (!reach.has(b.id)) w.push(`"${who}" is never reached from the start.`);
    const tools = b.tools ?? [];
    if (tools.includes('Bash')) w.push(`"${who}" may run any shell command. Narrow it, e.g. Bash(git log:*).`);
    if (tools.some(t => t.startsWith('mcp:')) && !(b.trialTools ?? []).length && (b.kind ?? 'agent') === 'agent') w.push(`"${who}" has no trialTools, so a trial run cannot reach its MCP servers at all.`);
    if (b.kind === 'command' && !b.runInTrial) w.push(`"${who}" is skipped in trial runs (set runInTrial if it only reads).`);
    for (const x of b.input ?? []) if (x === b.id) w.push(`"${who}" reads its own output, which is from its previous visit only.`);
  }
  const loops = flow.blocks.some(b => {
    const e = edgesOf(flow, b);
    const i = flow.blocks.indexOf(b);
    return [e.pass, e.fail].some(t => flow.blocks.findIndex(x => x.id === t) !== -1 && flow.blocks.findIndex(x => x.id === t) <= i);
  });
  if (loops) w.push(`The flow can go round in a loop; it stops after ${flow.limits?.maxSteps ?? DEFAULT_MAX_STEPS} steps.`);
  if (flow.limits?.usd === undefined) w.push('No usage limit per run (limits.usd).');
  return w;
}

export function checkFlow(flow: Flow): void {
  const p = flowProblems(flow);
  if (p.length) throw new Error(p.join('; '));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function flowsDir(): string {
  return path.join(lazyDir(), 'flows');
}

function flowFile(id: string): string {
  if (!ID_RE.test(id)) throw new Error('Not a flow id');
  return path.join(flowsDir(), `${id}.json`);
}

export function listFlows(): Flow[] {
  const dir = flowsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Flow[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'approvals.json').sort()) {
    const j = readJson(path.join(dir, f));
    if (j && typeof j === 'object' && Array.isArray(j.blocks)) out.push({ ...j, id: f.replace(/\.json$/, '') });
  }
  return out;
}

export function getFlow(id: string): Flow {
  const j = ID_RE.test(id) ? readJson(flowFile(id)) : null;
  if (!j) throw new Error(`There is no flow called "${id}"`);
  return { ...j, id };
}

export function saveFlow(input: Flow): Flow {
  const flow: Flow = { ...input, updatedAt: new Date().toISOString() };
  checkFlow(flow);
  fs.mkdirSync(flowsDir(), { recursive: true, mode: 0o700 });
  const tmp = flowFile(flow.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(flow, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, flowFile(flow.id));
  return flow;
}

export function deleteFlow(id: string): boolean {
  const f = flowFile(id);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  const a = loadApprovals();
  delete a[id];
  saveApprovals(a);
  return true;
}

/** The folder a flow's blocks work in: its own, or a scratch folder kept per flow. */
export function workdirOf(flow: Flow): string {
  if (flow.folder) return flow.folder;
  const d = path.join(lazyDir(), 'flow-work', flow.id);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function readContext(flow: Flow): Array<{ file: string; text: string }> {
  if (!flow.folder) return [];
  return (flow.context ?? []).map(rel => ({ file: rel, text: fs.readFileSync(contextFile(flow.folder!, rel), 'utf-8') }));
}

// ---------------------------------------------------------------------------
// Approval: the person approves one exact version
// ---------------------------------------------------------------------------

interface Approval { hash: string; at: string; flow: Flow }

function approvalsFile(): string {
  return path.join(flowsDir(), 'approvals.json');
}

function loadApprovals(): Record<string, Approval> {
  return readJson(approvalsFile()) ?? {};
}

function saveApprovals(a: Record<string, Approval>): void {
  fs.mkdirSync(flowsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(approvalsFile(), JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as any)[k])]));
  return v;
}

/** Fingerprint of everything that decides what the flow does. */
export function flowHash(flow: Flow): string {
  const { updatedAt: _u, ...rest } = flow;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex').slice(0, 16);
}

export interface ApprovalState {
  state: 'approved' | 'changed' | 'never';
  hash: string;
  at?: string;
  /** Blocks added, removed or changed since the approved version. */
  changed?: string[];
}

export function approvalOf(flow: Flow): ApprovalState {
  const hash = flowHash(flow);
  const a = loadApprovals()[flow.id];
  if (!a) return { state: 'never', hash };
  if (a.hash === hash) return { state: 'approved', hash, at: a.at };
  const before = new Map(a.flow.blocks.map(b => [b.id, JSON.stringify(canonical(b))]));
  const now = new Map(flow.blocks.map(b => [b.id, JSON.stringify(canonical(b))]));
  const changed = [...new Set([...before.keys(), ...now.keys()])].filter(id => before.get(id) !== now.get(id));
  const { blocks: _b1, updatedAt: _u1, ...headA } = a.flow;
  const { blocks: _b2, updatedAt: _u2, ...headB } = flow;
  if (JSON.stringify(canonical(headA)) !== JSON.stringify(canonical(headB))) changed.unshift('(flow settings)');
  return { state: 'changed', hash, at: a.at, changed };
}

/** Approve the version the person looked at; refuses when it changed in between. */
export function approveFlow(id: string, hash: string): ApprovalState {
  const flow = getFlow(id);
  checkFlow(flow);
  if (flowHash(flow) !== hash) throw new Error('The flow changed while you were looking at it. Reload and review it again.');
  const a = loadApprovals();
  a[id] = { hash, at: new Date().toISOString(), flow };
  saveApprovals(a);
  return approvalOf(flow);
}

export function revokeApproval(id: string): void {
  const a = loadApprovals();
  delete a[id];
  saveApprovals(a);
}
