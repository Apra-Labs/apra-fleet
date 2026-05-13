import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { brainQuery } from '../src/tools/brain-query.js';
import { brainWrite } from '../src/tools/brain-write.js';

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
// brain_query
// ---------------------------------------------------------------------------

describe('brain_query', () => {
  it('returns brain result for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('The answer is 42');

    const result = await brainQuery({ member_id: agent.id, query: 'what is life?' });

    expect(mockCallTool).toHaveBeenCalledWith('brain_query', { query: 'what is life?' });
    expect(result).toBe('The answer is 42');
  });

  it('passes collection when provided', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('result');

    await brainQuery({ member_id: agent.id, query: 'hello', collection: 'docs' });

    expect(mockCallTool).toHaveBeenCalledWith('brain_query', { query: 'hello', collection: 'docs' });
  });

  it('returns error when member does not have gbrain enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await brainQuery({ member_id: agent.id, query: 'what?' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member has no gbrain field', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    const result = await brainQuery({ member_id: agent.id, query: 'what?' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await brainQuery({ member_id: 'nonexistent-id', query: 'what?' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when gbrain server is unavailable', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    const result = await brainQuery({ member_id: agent.id, query: 'hello' });

    expect(result).toContain('gbrain server is not available');
  });
});

// ---------------------------------------------------------------------------
// brain_write
// ---------------------------------------------------------------------------

describe('brain_write', () => {
  it('writes to brain for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('Stored successfully');

    const result = await brainWrite({ member_id: agent.id, content: 'important knowledge' });

    expect(mockCallTool).toHaveBeenCalledWith('brain_write', { content: 'important knowledge' });
    expect(result).toBe('Stored successfully');
  });

  it('passes collection and metadata when provided', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('ok');

    await brainWrite({
      member_id: agent.id,
      content: 'stuff',
      collection: 'notes',
      metadata: '{"source":"test"}',
    });

    expect(mockCallTool).toHaveBeenCalledWith('brain_write', {
      content: 'stuff',
      collection: 'notes',
      metadata: '{"source":"test"}',
    });
  });

  it('returns error when member does not have gbrain enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await brainWrite({ member_id: agent.id, content: 'stuff' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await brainWrite({ member_id: 'nonexistent-id', content: 'stuff' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when gbrain server is unavailable', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    const result = await brainWrite({ member_id: agent.id, content: 'stuff' });

    expect(result).toContain('gbrain server is not available');
  });
});
