// End-to-end cost accounting for a cache-heavy Claude dispatch.
//
// A recorded Claude stream-json transcript whose result usage is dominated by
// prompt-cache reads (cache_read_input_tokens >> input_tokens, the shape of the
// sprint whose report showed ~1/5 of real spend) is fed through every layer
// that touches the figure:
//   ClaudeProvider.parseResponse (real) -> executePrompt structured usage
//   (real) -> FleetWorkflow.agent()/_resolveCost (real; pricing from the real
//   get_member_model_pricing tool, or the pricing.mjs fallback) -> the sprint
//   cost report (buildCostAnalysis, real).
// The expected dollar figure is hand-computed below from Anthropic list
// prices, not taken from the implementation. Reverting the Claude usage
// parsing makes every case fail (cache counts vanish); reverting the
// _resolveCost/pricing.mjs cache pricing makes the matching case fail.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getMemberModelPricing } from '../src/tools/get-member-model-pricing.js';
import type { SSHExecResult } from '../src/types.js';
import { FleetWorkflow } from '../packages/apra-fleet-workflow/src/workflow/index.mjs';
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

// Recorded `claude -p --output-format stream-json` transcript (trimmed to the
// events the parser reads). The result event's usage reports the cache counts
// separately from input_tokens, exactly as the Claude CLI does.
const SESSION_ID = '7c1f2e4a-0b9d-4c55-9a3e-2f6d8b1c0e77';
const RECORDED_STREAM = [
  { type: 'system', subtype: 'init', session_id: SESSION_ID, model: 'claude-sonnet-4-5', tools: ['Bash', 'Read', 'Edit'] },
  { type: 'assistant', session_id: SESSION_ID, message: { content: [{ type: 'text', text: 'Implemented the change and ran the tests.' }] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 412_331,
    num_turns: 57,
    result: 'Implemented the change and ran the tests.',
    session_id: SESSION_ID,
    total_cost_usd: 0.2586,
    usage: {
      input_tokens: 1_200,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 480_000,
      output_tokens: 2_400,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
  },
].map((e) => JSON.stringify(e)).join('\n');

// Hand-computed, standard tier = sonnet, Anthropic list prices ($/1M tokens):
//   prompt 3.00, completion 15.00, cache read 0.30 (0.1x), cache write 3.75 (1.25x)
//   input        1_200 * 3.00 / 1e6 = 0.0036
//   output       2_400 * 15.0 / 1e6 = 0.0360
//   cache read 480_000 * 0.30 / 1e6 = 0.1440
//   cache write 20_000 * 3.75 / 1e6 = 0.0750
//   total                            = 0.2586
// (Input+output only -- the pre-fix figure -- would be 0.0396.)
const EXPECTED_COST = 0.2586;

async function dispatchRecordedResult(memberId: string) {
  mockExecCommand.mockReset();
  mockExecCommand
    .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // writePromptFile
    .mockResolvedValueOnce({ stdout: RECORDED_STREAM, stderr: '', code: 0 })
    .mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  return executePrompt({ member_id: memberId, prompt: 'do the task', resume: false, timeout_s: 5 });
}

describe('cache-heavy Claude result is costed in full from parser to sprint report', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it.each([
    ['real per-member pricing (get_member_model_pricing)', true],
    ['pricing.mjs fallback (no pricing tool)', false],
  ])('%s', async (_label, withPricingTool) => {
    const member = makeTestAgent({ friendlyName: 'cache-e2e', llmProvider: 'claude' });
    addAgent(member);

    vi.useFakeTimers();
    let dispatched;
    try {
      dispatched = await dispatchRecordedResult(member.id);
    } finally {
      vi.useRealTimers();
    }
    expect(dispatched.structuredContent?.isError).toBeFalsy();
    expect(dispatched.structuredContent?.usage).toMatchObject({
      input_tokens: 1_200,
      output_tokens: 2_400,
      cache_read_input_tokens: 480_000,
      cache_creation_input_tokens: 20_000,
    });

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
    const wf = new FleetWorkflow(fleetApi);
    await wf.agent('do the task', { member_id: member.id, model: 'standard' });

    expect(wf.budget.spent()).toBeCloseTo(EXPECTED_COST, 10);
    expect(wf.budget.pricingSummary()).toEqual(withPricingTool ? { real: 1, fallback: 0 } : { real: 0, fallback: 1 });

    const report = buildCostAnalysis(wf.budget);
    expect(report).toContain('Tracked spend (priced dispatches only): $0.2586.');
  });
});
