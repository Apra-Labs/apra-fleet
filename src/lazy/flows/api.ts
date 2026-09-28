/**
 * The Flows API under /_lazy/api/flows and /_lazy/api/flow-runs. The caller
 * has already checked the sign-in cookie and the CSRF header.
 *
 * Claude writes flows (through `lazyfleet flow save`) and may trial-run them;
 * the person approves them on the Flows page, and only an approved version
 * runs for real or on a schedule.
 */
import http from 'node:http';
import * as sched from '../schedules.js';
import {
  approvalOf, approveFlow, deleteFlow, edgesOf, flowProblems, flowWarnings, getFlow, listFlows, revokeApproval, saveFlow,
  startOf, TIER_MODEL, type Flow,
} from './flow.js';
import { activeRun, getRun, listRuns, startRun, stopRun, type FlowRun } from './runner.js';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 512 * 1024) throw new Error('request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/** The graph as the page draws it: each block with its edges and model, in order. */
export function graphOf(flow: Flow) {
  return {
    start: startOf(flow),
    blocks: flow.blocks.map(b => ({
      ...b,
      kind: b.kind ?? 'agent',
      model: (b.kind ?? 'agent') === 'agent' ? b.model || TIER_MODEL[b.tier ?? 'standard'] : undefined,
      modelLabel: (b.kind ?? 'agent') === 'agent' ? (b.model ? b.model : `${b.tier ?? 'standard'} (${TIER_MODEL[b.tier ?? 'standard']})`) : undefined,
      edges: edgesOf(flow, b),
    })),
  };
}

export function runSummary(r: FlowRun) {
  const { steps, ...rest } = r;
  return { ...rest, stepCount: steps.length, lastStep: steps[steps.length - 1]?.block ?? null };
}

function schedulesFor(flowId: string) {
  return sched.loadSchedules()
    .filter(s => s.source.type === 'flow' && s.source.flow === flowId)
    .map(s => ({ id: s.id, name: s.name, enabled: s.enabled, whenText: sched.describeWhen(s) }));
}

function flowView(flow: Flow, withRuns: number) {
  const runs = listRuns(flow.id);
  return {
    flow,
    graph: graphOf(flow),
    approval: approvalOf(flow),
    problems: flowProblems(flow),
    warnings: flowWarnings(flow),
    schedules: schedulesFor(flow.id),
    running: activeRun(flow.id) ?? null,
    runs: runs.slice(0, withRuns).map(runSummary),
    lastRun: runs[0] ? runSummary(runs[0]) : null,
  };
}

/** Why a scheduled run of this flow cannot start now, or null. */
export function flowBlocker(flowId: string): { text: string; retry: boolean } | null {
  let flow: Flow;
  try {
    flow = getFlow(flowId);
  } catch {
    return { text: `there is no flow called "${flowId}"`, retry: false };
  }
  const p = flowProblems(flow);
  if (p.length) return { text: `the flow cannot run: ${p[0]}`, retry: false };
  const a = approvalOf(flow);
  if (a.state === 'never') return { text: 'the flow is waiting for your approval on the Flows page', retry: false };
  if (a.state === 'changed') return { text: 'the flow changed since you approved it; approve the new version on the Flows page', retry: false };
  if (activeRun(flowId)) return { text: 'the flow is already running', retry: true };
  return null;
}

const ID = '([a-z0-9][a-z0-9-]{0,39})';
const RUN = '([a-z0-9-]{1,80})';

export async function handleFlows(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname.replace(/^\/_lazy\/api/, '');
  const m = req.method ?? 'GET';

  if (p === '/flows' && m === 'GET') {
    send(res, 200, { flows: listFlows().map(f => flowView(f, 0)) });
    return true;
  }
  if (p === '/flows' && m === 'POST') {
    const saved = saveFlow((await body(req)).flow as Flow);
    send(res, 200, { ok: true, ...flowView(saved, 0) });
    return true;
  }
  if (p === '/flows/check' && m === 'POST') {
    const flow = (await body(req)).flow as Flow;
    const problems = flowProblems(flow);
    send(res, 200, { ok: !problems.length, problems, warnings: problems.length ? [] : flowWarnings(flow), graph: problems.length ? null : graphOf(flow) });
    return true;
  }
  let r = new RegExp(`^/flows/${ID}$`).exec(p);
  if (r && m === 'GET') {
    send(res, 200, flowView(getFlow(r[1]), 30));
    return true;
  }
  if (r && m === 'DELETE') {
    if (activeRun(r[1])) throw new Error('Stop the running flow first');
    send(res, deleteFlow(r[1]) ? 200 : 404, { ok: true });
    return true;
  }
  r = new RegExp(`^/flows/${ID}/(approve|revoke|run)$`).exec(p);
  if (r && m === 'POST') {
    const [, id, op] = r;
    const b = await body(req);
    if (op === 'approve') send(res, 200, { ok: true, approval: approveFlow(id, String(b.hash ?? '')) });
    else if (op === 'revoke') { revokeApproval(id); send(res, 200, { ok: true }); }
    else {
      const { run } = startRun(id, { trial: b.trial === true, input: b.input === undefined ? undefined : String(b.input) });
      send(res, 200, { ok: true, runId: run.runId });
    }
    return true;
  }
  r = new RegExp(`^/flow-runs/${RUN}$`).exec(p);
  if (r && m === 'GET') {
    const run = getRun(r[1]);
    send(res, run ? 200 : 404, run ?? { error: 'no such run' });
    return true;
  }
  r = new RegExp(`^/flow-runs/${RUN}/stop$`).exec(p);
  if (r && m === 'POST') {
    send(res, 200, { ok: stopRun(r[1]) });
    return true;
  }
  return false;
}
