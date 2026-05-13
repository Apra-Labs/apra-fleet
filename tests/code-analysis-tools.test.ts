import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { codeDef } from '../src/tools/code-def.js';
import { codeRefs } from '../src/tools/code-refs.js';
import { codeCallers } from '../src/tools/code-callers.js';
import { codeCallees } from '../src/tools/code-callees.js';

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
// code_def
// ---------------------------------------------------------------------------

describe('code_def', () => {
  it('returns definition for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('src/utils/foo.ts:10 — function foo() {}');

    const result = await codeDef({ member_id: agent.id, symbol: 'foo' });

    expect(mockCallTool).toHaveBeenCalledWith('code_def', { symbol: 'foo' });
    expect(result).toBe('src/utils/foo.ts:10 — function foo() {}');
  });

  it('returns error when gbrain is not enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await codeDef({ member_id: agent.id, symbol: 'foo' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await codeDef({ member_id: 'nonexistent-id', symbol: 'foo' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// code_refs
// ---------------------------------------------------------------------------

describe('code_refs', () => {
  it('returns references for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('3 references found');

    const result = await codeRefs({ member_id: agent.id, symbol: 'foo' });

    expect(mockCallTool).toHaveBeenCalledWith('code_refs', { symbol: 'foo' });
    expect(result).toBe('3 references found');
  });

  it('returns error when gbrain is not enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await codeRefs({ member_id: agent.id, symbol: 'foo' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await codeRefs({ member_id: 'nonexistent-id', symbol: 'foo' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// code_callers
// ---------------------------------------------------------------------------

describe('code_callers', () => {
  it('returns callers for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('2 callers found');

    const result = await codeCallers({ member_id: agent.id, symbol: 'bar' });

    expect(mockCallTool).toHaveBeenCalledWith('code_callers', { symbol: 'bar' });
    expect(result).toBe('2 callers found');
  });

  it('returns error when gbrain is not enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await codeCallers({ member_id: agent.id, symbol: 'bar' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// code_callees
// ---------------------------------------------------------------------------

describe('code_callees', () => {
  it('returns callees for a gbrain-enabled member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    mockCallTool.mockResolvedValue('5 callees found');

    const result = await codeCallees({ member_id: agent.id, symbol: 'baz' });

    expect(mockCallTool).toHaveBeenCalledWith('code_callees', { symbol: 'baz' });
    expect(result).toBe('5 callees found');
  });

  it('returns error when gbrain is not enabled', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await codeCallees({ member_id: agent.id, symbol: 'baz' });

    expect(result).toContain('gbrain is not enabled');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns error when member is not found', async () => {
    const result = await codeCallees({ member_id: 'nonexistent-id', symbol: 'baz' });

    expect(result).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
