/**
 * T6.5 — Comparative test: gbrain vs no-gbrain mode.
 *
 * Demonstrates the value of gbrain by showing:
 * - WITH gbrain: brain_query returns results, code_def resolves symbols, jobs_submit queues work
 * - WITHOUT gbrain: same operations fail with clear, actionable error messages that guide the user
 *
 * This is the "before and after" story of the feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn<(toolName: string, args: Record<string, unknown>) => Promise<string>>();

vi.mock('../src/services/gbrain-client.js', () => ({
  getGbrainClient: () => ({ callTool: mockCallTool, disconnect: vi.fn() }),
  _resetGbrainClient: vi.fn(),
}));

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
});
afterEach(() => restoreRegistry());

// ---------------------------------------------------------------------------
// WITH gbrain enabled — full workflow succeeds
// ---------------------------------------------------------------------------

describe('WITH gbrain enabled — operations succeed', () => {
  it('brain_query returns meaningful results', async () => {
    const { brainQuery } = await import('../src/tools/brain-query.js');
    const agent = makeTestAgent({ friendlyName: 'alice', gbrain: true });
    addAgent(agent);

    mockCallTool.mockResolvedValue('The captureCorrection function is defined in src/services/course-correction.ts');

    const result = await brainQuery({ member_name: 'alice', query: 'where is captureCorrection defined?' });
    expect(result).toContain('captureCorrection');
    expect(result).toContain('course-correction.ts');
  });

  it('code_def resolves symbol definitions', async () => {
    const { codeDef } = await import('../src/tools/code-def.js');
    const agent = makeTestAgent({ friendlyName: 'alice', gbrain: true });
    addAgent(agent);

    mockCallTool.mockResolvedValue('src/services/course-correction.ts:12 — export async function captureCorrection(...)');

    const result = await codeDef({ member_name: 'alice', symbol: 'captureCorrection' });
    expect(result).toContain('src/services/course-correction.ts');
    expect(result).toContain('captureCorrection');
  });

  it('jobs_submit queues durable async work', async () => {
    const { jobsSubmit } = await import('../src/tools/jobs-submit.js');
    const agent = makeTestAgent({ friendlyName: 'alice', gbrain: true });
    addAgent(agent);

    mockCallTool.mockResolvedValue('Job queued: job_id=abc-123, status=pending');

    const result = await jobsSubmit({ member_name: 'alice', task: 'Run the full test suite and report results' });
    expect(result).toContain('job_id');
    expect(result).toContain('pending');
  });

  it('course_correction_capture stores corrections globally (no gbrain flag needed)', async () => {
    const { courseCorrectionCapture } = await import('../src/tools/course-correction.js');

    // course_correction_capture is global — no member or gbrain check
    mockCallTool.mockResolvedValue('');
    const result = await courseCorrectionCapture({
      attempted: 'using execute_prompt for a long batch job',
      correction: 'use jobs_submit for durable work instead',
      reason: 'execute_prompt does not survive session restarts',
    });
    expect(result).toContain('captured');
  });

  it('course_correction_recall retrieves relevant past corrections', async () => {
    const { courseCorrectionRecall } = await import('../src/tools/course-correction.js');

    mockCallTool.mockResolvedValue(
      'Past correction: avoid using execute_prompt for long-running jobs — use jobs_submit instead for durability.'
    );

    const result = await courseCorrectionRecall({ query: 'long running jobs' });
    expect(result).toContain('jobs_submit');
  });
});

// ---------------------------------------------------------------------------
// WITHOUT gbrain enabled — clear, actionable errors guide the user
// ---------------------------------------------------------------------------

describe('WITHOUT gbrain enabled — errors clearly guide user to enable it', () => {
  const GBRAIN_ENABLE_GUIDANCE = /gbrain is not enabled on this member\. Use update_member to enable it\./i;

  it('brain_query explicitly tells user to enable gbrain via update_member', async () => {
    const { brainQuery } = await import('../src/tools/brain-query.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await brainQuery({ member_name: 'bob', query: 'anything' });
    expect(result).toMatch(GBRAIN_ENABLE_GUIDANCE);
  });

  it('code_def explicitly tells user to enable gbrain via update_member', async () => {
    const { codeDef } = await import('../src/tools/code-def.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await codeDef({ member_name: 'bob', symbol: 'MyClass' });
    expect(result).toMatch(GBRAIN_ENABLE_GUIDANCE);
  });

  it('code_refs explicitly tells user to enable gbrain via update_member', async () => {
    const { codeRefs } = await import('../src/tools/code-refs.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await codeRefs({ member_name: 'bob', symbol: 'MyClass' });
    expect(result).toMatch(GBRAIN_ENABLE_GUIDANCE);
  });

  it('jobs_submit explicitly tells user to enable gbrain (with execute_prompt hint)', async () => {
    const { jobsSubmit } = await import('../src/tools/jobs-submit.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await jobsSubmit({ member_name: 'bob', task: 'run tests' });
    expect(result).toMatch(/gbrain is not enabled/i);
    // jobs_submit also hints the user toward execute_prompt as an alternative
    expect(result).toMatch(/execute_prompt/i);
  });

  it('jobs_list explicitly tells user to enable gbrain via update_member', async () => {
    const { jobsList } = await import('../src/tools/jobs-list.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await jobsList({ member_name: 'bob' });
    expect(result).toMatch(GBRAIN_ENABLE_GUIDANCE);
  });

  it('brain_write explicitly tells user to enable gbrain via update_member', async () => {
    const { brainWrite } = await import('../src/tools/brain-write.js');
    const agent = makeTestAgent({ friendlyName: 'bob', gbrain: false });
    addAgent(agent);

    const result = await brainWrite({ member_name: 'bob', content: 'some knowledge' });
    expect(result).toMatch(GBRAIN_ENABLE_GUIDANCE);
  });

  it('error message is not cryptic — it names the fix action (update_member)', async () => {
    const { codeDef } = await import('../src/tools/code-def.js');
    const agent = makeTestAgent({ friendlyName: 'carol' }); // gbrain omitted (defaults to false-y)
    addAgent(agent);

    const result = await codeDef({ member_name: 'carol', symbol: 'SomeFunction' });

    // Must not be a cryptic error
    expect(result).not.toMatch(/undefined/i);
    expect(result).not.toMatch(/cannot read/i);
    expect(result).not.toMatch(/TypeError/i);

    // Must name the fix
    expect(result).toContain('update_member');
  });
});

// ---------------------------------------------------------------------------
// Comparison side-by-side: same call, two members, two outcomes
// ---------------------------------------------------------------------------

describe('side-by-side comparison: gbrain-on vs gbrain-off', () => {
  it('brain_query returns data for gbrain-on member, error for gbrain-off member', async () => {
    const { brainQuery } = await import('../src/tools/brain-query.js');

    const withGbrain = makeTestAgent({ friendlyName: 'with-gbrain', gbrain: true });
    const withoutGbrain = makeTestAgent({ friendlyName: 'without-gbrain', gbrain: false });
    addAgent(withGbrain);
    addAgent(withoutGbrain);

    mockCallTool.mockResolvedValue('Knowledge: the fleet registry lives in ~/.apra-fleet/registry.json');

    const resultOn = await brainQuery({ member_name: 'with-gbrain', query: 'where is the registry?' });
    const resultOff = await brainQuery({ member_name: 'without-gbrain', query: 'where is the registry?' });

    // with-gbrain: callTool was called, result is the brain response
    expect(mockCallTool).toHaveBeenCalledOnce();
    expect(resultOn).toContain('registry.json');

    // without-gbrain: callTool was NOT called again; result is the guidance error
    expect(mockCallTool).toHaveBeenCalledOnce(); // still only once
    expect(resultOff).toMatch(/gbrain is not enabled on this member\. Use update_member to enable it\./i);
  });
});
