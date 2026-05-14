import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { jobsSubmit } from '../src/tools/jobs-submit.js';
import { jobsList } from '../src/tools/jobs-list.js';
import { jobsStats } from '../src/tools/jobs-stats.js';
import { jobsWork } from '../src/tools/jobs-work.js';

// Mock the gbrain client singleton
const mockCallTool = vi.fn<(toolName: string, args: Record<string, unknown>) => Promise<string>>();

vi.mock('../src/services/gbrain-client.js', () => ({
  getGbrainClient: () => ({ callTool: mockCallTool }),
  _resetGbrainClient: vi.fn(),
}));

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
});
afterEach(() => restoreRegistry());

// ---------------------------------------------------------------------------
// jobs_submit — delegates to gbrain "submit_job" (autopilot-cycle)
// ---------------------------------------------------------------------------

describe('jobs_submit', () => {
  it('submits a job and returns job ID for gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('job_id: abc-123, status: queued');

    const result = await jobsSubmit({ member_id: agent.id, task: 'run the tests' });

    expect(mockCallTool).toHaveBeenCalledWith('submit_job', {
      name: 'autopilot-cycle',
      data: { task: 'run the tests' },
    });
    expect(result).toBe('job_id: abc-123, status: queued');
  });

  it('passes priority when provided', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('queued');

    await jobsSubmit({ member_id: agent.id, task: 'urgent work', priority: 0 });

    expect(mockCallTool).toHaveBeenCalledWith('submit_job', {
      name: 'autopilot-cycle',
      data: { task: 'urgent work' },
      priority: 0,
    });
  });

  it('returns error with fallback suggestion for non-gbrain member', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await jobsSubmit({ member_id: agent.id, task: 'some task' });

    expect(result).toContain('gbrain is not enabled');
    expect(result).toContain('execute_prompt');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await jobsSubmit({ member_id: 'nonexistent-id', task: 'some task' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when gbrain server is unavailable', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    const result = await jobsSubmit({ member_id: agent.id, task: 'some task' });

    expect(result).toContain('gbrain server is not available');
  });
});

// ---------------------------------------------------------------------------
// jobs_list — delegates to gbrain "list_jobs"
// ---------------------------------------------------------------------------

describe('jobs_list', () => {
  it('returns job list for gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('[{"id":"abc","status":"queued"}]');

    const result = await jobsList({ member_id: agent.id });

    expect(mockCallTool).toHaveBeenCalledWith('list_jobs', {});
    expect(result).toContain('queued');
  });

  it('passes status filter when provided', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('[]');

    await jobsList({ member_id: agent.id, status: 'running' });

    expect(mockCallTool).toHaveBeenCalledWith('list_jobs', { status: 'running' });
  });

  it('returns error when member does not have gbrain enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await jobsList({ member_id: agent.id });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jobs_stats — delegates to gbrain "list_jobs" with limit for summary view
// ---------------------------------------------------------------------------

describe('jobs_stats', () => {
  it('returns queue statistics for gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('queued: 3, running: 1, completed: 42');

    const result = await jobsStats({ member_id: agent.id });

    expect(mockCallTool).toHaveBeenCalledWith('list_jobs', { limit: 100 });
    expect(result).toBe('queued: 3, running: 1, completed: 42');
  });

  it('returns error when member does not have gbrain enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await jobsStats({ member_id: agent.id });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await jobsStats({ member_id: 'nonexistent-id' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jobs_work — stores job result as a brain page under jobs/ namespace
// ---------------------------------------------------------------------------

describe('jobs_work', () => {
  it('stores job result for gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('job abc-123 marked complete');

    const result = await jobsWork({ member_id: agent.id, job_id: 'abc-123', result: 'done' });

    expect(mockCallTool).toHaveBeenCalledWith('put_page', {
      slug: 'jobs/abc-123',
      content: expect.stringContaining('done'),
    });
    expect(result).toBe('job abc-123 marked complete');
  });

  it('returns error when member does not have gbrain enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await jobsWork({ member_id: agent.id, job_id: 'abc', result: 'done' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await jobsWork({ member_id: 'nonexistent-id', job_id: 'abc', result: 'done' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when gbrain server is unavailable', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    const result = await jobsWork({ member_id: agent.id, job_id: 'abc', result: 'done' });

    expect(result).toContain('gbrain server is not available');
  });
});
