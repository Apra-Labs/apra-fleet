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
// brain_query — delegates to gbrain "search" (BM25 keyword search)
// ---------------------------------------------------------------------------

describe('brain_query', () => {
  it('returns brain result for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('The answer is 42');

    const result = await brainQuery({ member_id: agent.id, query: 'what is life?' });

    expect(mockCallTool).toHaveBeenCalledWith('search', { query: 'what is life?' });
    expect(result).toBe('The answer is 42');
  });

  it('appends collection as tag filter when provided', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('result');

    await brainQuery({ member_id: agent.id, query: 'hello', collection: 'docs' });

    expect(mockCallTool).toHaveBeenCalledWith('search', { query: 'hello tags:docs' });
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
// brain_write — delegates to gbrain "put_page" with slug + frontmatter
// ---------------------------------------------------------------------------

describe('brain_write', () => {
  it('writes to brain for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('Stored successfully');

    const result = await brainWrite({ member_id: agent.id, content: 'important knowledge' });

    expect(mockCallTool).toHaveBeenCalledWith('put_page', expect.objectContaining({
      slug: expect.stringContaining('notes/'),
      content: expect.stringContaining('important knowledge'),
    }));
    expect(result).toBe('Stored successfully');
  });

  it('uses collection as namespace in slug and frontmatter', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('ok');

    await brainWrite({
      member_id: agent.id,
      content: 'stuff',
      collection: 'docs',
      metadata: '{"source":"test"}',
    });

    expect(mockCallTool).toHaveBeenCalledWith('put_page', expect.objectContaining({
      slug: expect.stringContaining('docs/'),
      content: expect.stringContaining('stuff'),
    }));
    const callArgs = mockCallTool.mock.calls[0][1] as { content: string };
    expect(callArgs.content).toContain('tags: [docs]');
    expect(callArgs.content).toContain('{"source":"test"}');
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
