// End-to-end cost accounting for a Claude dispatch, from a REAL recorded CLI
// result -- not a synthetic one priced with the implementation's own formula.
//
// Fixture: tests/fixtures/claude-cost/opus-5-5-result.json, a Claude Code CLI
// 2.1.291 result event recorded on fleet-win1 on 2026-10-05 (session
// 4b474d36-1c4c-4edb-9c29-6454f9ba9ec9, sprint run
// apra-fleet-b4g.117-467ad932 in ~/.apra-fleet/data/old_runs/). Verbatim except
// one em dash in the CLI's `result` text, replaced with `--` (ASCII-only repo).
// Its total_cost_usd 0.1380048 equals modelUsage["claude-opus-5-5"].costUSD
// (costBasis "list"), and every cache write in it is ephemeral_1h. That
// dispatch ended in a 529 overload, so the success cases reuse its usage and
// cost fields with the outcome fields switched to success.
//
// Layers exercised: ClaudeProvider.parseResponse (real) -> executePrompt
// structured usage.cost_usd (real, per-dispatch delta of the cumulative CLI
// figure) -> FleetWorkflow.agent()/_resolveCost (real) -> the sprint cost
// report (buildCostAnalysis, real). The reported cost must be used as-is:
// the token formula is only the fallback for results that report no cost.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getMemberModelPricing } from '../src/tools/get-member-model-pricing.js';
import { estimateDispatchCost } from '../src/services/budget-awareness.js';
import { getProvider } from '../src/providers/index.js';
import { _resetSessionCostCache } from '../src/services/session-cost.js';
import type { SSHExecResult } from '../src/types.js';
import { FleetWorkflow } from '../packages/apra-fleet-workflow/src/workflow/index.mjs';
import { calculateCost } from '../packages/apra-fleet-workflow/src/workflow/pricing.mjs';
import { buildCostAnalysis } from '../packages/apra-fleet-se/fleet-sprint/sprint-report.mjs';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-cost', 'opus-5-5-result.json'), 'utf-8'));
const RECORDED_COST = 0.1380048;

/** The recorded event with its outcome switched to success, for session `sid`
 *  and a cumulative session cost of `cumulative`. Usage is the recorded one. */
function successEvent(sid: string, cumulative = RECORDED.total_cost_usd) {
  const { api_error_status: _a, terminal_reason: _t, ...rest } = RECORDED;
  return JSON.stringify({
    ...rest,
    is_error: false,
    subtype: 'success',
    stop_reason: 'end_turn',
    result: 'Implemented the change and ran the tests.',
    session_id: sid,
    total_cost_usd: cumulative,
  });
}

/** Echoes the session the CLI was told to use (--session-id or --resume). */
function sessionOf(cmd: string): string | undefined {
  return /--(?:session-id|resume) "([^"]+)"/.exec(cmd)?.[1];
}

/** Mocks the member: the dispatch command returns `eventFor(sessionId)`. */
function mockMember(eventFor: (sid: string) => string) {
  mockExecCommand.mockReset();
  mockExecCommand.mockImplementation(async (cmd: string) => {
    const sid = sessionOf(cmd);
    if (sid && /claude/.test(cmd)) return { stdout: eventFor(sid), stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

async function dispatch(memberId: string, resume: boolean) {
  vi.useFakeTimers();
  try {
    return await executePrompt({ member_id: memberId, prompt: 'do the task', resume, timeout_s: 5, model: 'premium' });
  } finally {
    vi.useRealTimers();
  }
}

function workflowFor(dispatched: any, withPricingTool: boolean) {
  const fleetApi = {
    async executePrompt() {
      return { content: [{ text: dispatched.text }], structuredContent: dispatched.structuredContent };
    },
    async executeCommand(payload: { command: string }) {
      return { content: [{ text: payload.command }], isError: false };
    },
    async getMemberModelPricing(args: { member_id?: string; member_name?: string }) {
      if (!withPricingTool) throw new Error('Unknown tool: get_member_model_pricing');
      return { content: [{ text: await getMemberModelPricing(args) }] };
    },
  };
  return new FleetWorkflow(fleetApi);
}

describe('Claude dispatch cost: the CLI-reported figure from a real recorded result', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    _resetSessionCostCache();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it.each([
    ['with real per-member pricing available', true],
    ['with only the pricing.mjs fallback', false],
  ])('the reported $0.1380048 is the dispatch cost (%s) -- no recompute', async (_label, withPricingTool) => {
    const member = makeTestAgent({ friendlyName: 'cost-e2e', llmProvider: 'claude' });
    addAgent(member);
    mockMember((sid) => successEvent(sid));

    const dispatched: any = await dispatch(member.id, false);
    expect(dispatched.structuredContent?.isError).toBeFalsy();
    expect(dispatched.structuredContent?.usage).toMatchObject({
      input_tokens: 2,
      output_tokens: 99,
      cache_read_input_tokens: 12_564,
      cache_creation_input_tokens: 16_688,
      total_tokens: 101,
      cost_usd: RECORDED_COST,
    });

    const wf = workflowFor(dispatched, withPricingTool);
    await wf.agent('do the task', { member_id: member.id, model: 'premium' });
    expect(wf.budget.spent()).toBe(RECORDED_COST);
    // Charged from the reported figure, never from a pricing table.
    expect(wf.budget.pricingSummary()).toEqual({ real: 1, fallback: 0 });
    expect(buildCostAnalysis(wf.budget)).toContain('Tracked spend (priced dispatches only): $0.1380.');
  });

  it('a resumed dispatch is charged only its own share of the cumulative session cost', async () => {
    const member = makeTestAgent({ friendlyName: 'cost-resume', llmProvider: 'claude' });
    addAgent(member);

    mockMember((sid) => successEvent(sid, RECORDED_COST));
    const first: any = await dispatch(member.id, false);
    expect(first.structuredContent.usage.cost_usd).toBe(RECORDED_COST);
    const sid = first.structuredContent.sessionId;
    expect(getAgent(member.id)?.sessionId).toBe(sid);

    // The CLI continues the saved total on --resume: the second result's
    // total_cost_usd already includes the first dispatch.
    mockMember((s) => successEvent(s, 0.2));
    const second: any = await dispatch(member.id, true);
    expect(mockExecCommand.mock.calls.some(([cmd]) => String(cmd).includes(`--resume "${sid}"`))).toBe(true);
    expect(second.structuredContent.usage.cost_usd).toBeCloseTo(0.2 - RECORDED_COST, 10);
  });

  it('a resume of a session whose earlier total was never seen falls back to pricing the tokens', async () => {
    const member = makeTestAgent({ friendlyName: 'cost-unknown', llmProvider: 'claude', sessionId: 'f0f0f0f0-0000-4000-8000-000000000001' });
    addAgent(member);
    mockMember((s) => successEvent(s, 5));
    const dispatched: any = await dispatch(member.id, true);
    expect(dispatched.structuredContent.usage.cost_usd).toBeUndefined();
    const wf = workflowFor(dispatched, false);
    await wf.agent('do the task', { member_id: member.id, model: 'premium' });
    // The fallback table prices the same usage at Opus 5.5 list price.
    expect(wf.budget.spent()).toBeCloseTo(RECORDED_COST, 10);
    expect(wf.budget.pricingSummary()).toEqual({ real: 0, fallback: 1 });
  });

  it('the parser reads the recorded (failed, exit 1) result verbatim: cumulative cost and usage', () => {
    const p = getProvider('claude').parseResponse({ stdout: JSON.stringify(RECORDED), stderr: '', code: 1 });
    expect(p.isError).toBe(true);
    expect(p.sessionCostUsd).toBe(RECORDED_COST);
    expect(p.usage).toEqual({ input_tokens: 2, output_tokens: 99, cache_read_input_tokens: 12_564, cache_creation_input_tokens: 16_688 });
  });

  it('fallback rates are Anthropic list prices: the token formula reproduces the CLI figure exactly', () => {
    const u = RECORDED.usage;
    const usage = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    };
    // Client fallback table (pricing.mjs): opus = Opus 5.5.
    expect(calculateCost('opus', usage)).toBeCloseTo(RECORDED_COST, 10);
    expect(calculateCost('premium', usage)).toBeCloseTo(RECORDED_COST, 10);
    // Server fallback table (model-pricing.ts) via the budget estimator.
    const agent = makeTestAgent({ llmProvider: 'claude' });
    expect(estimateDispatchCost(agent, getProvider('claude'), 'premium', usage, 'dollars')).toBeCloseTo(RECORDED_COST, 10);
  });
});
