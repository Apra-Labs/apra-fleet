import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureCorrection, recallCorrections } from '../src/services/course-correction.js';
import { courseCorrectionCapture, courseCorrectionRecall } from '../src/tools/course-correction.js';

// Mock the gbrain client singleton
const mockCallTool = vi.fn<(toolName: string, args: Record<string, unknown>) => Promise<string>>();

vi.mock('../src/services/gbrain-client.js', () => ({
  getGbrainClient: () => ({ callTool: mockCallTool }),
  _resetGbrainClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// captureCorrection service
// ---------------------------------------------------------------------------

describe('captureCorrection', () => {
  it('calls brain_write with correctly formatted message', async () => {
    mockCallTool.mockResolvedValue('ok');

    await captureCorrection({
      repo: 'owner/repo',
      attempted: 'use merge',
      correction: 'use rebase',
      reason: 'merge commits clutter the log',
    });

    expect(mockCallTool).toHaveBeenCalledWith('brain_write', expect.objectContaining({
      content: 'On repo owner/repo, approach "use merge" was attempted. User corrected to "use rebase". Because: merge commits clutter the log',
      collection: 'course-corrections',
    }));
  });

  it('is silent no-op when gbrain is unavailable — does not throw', async () => {
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    await expect(captureCorrection({
      attempted: 'bad approach',
      correction: 'good approach',
    })).resolves.toBeUndefined();

    expect(mockCallTool).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// recallCorrections service
// ---------------------------------------------------------------------------

describe('recallCorrections', () => {
  it('calls brain_query and returns result', async () => {
    mockCallTool.mockResolvedValue('past correction: avoid X because Y');

    const result = await recallCorrections({ query: 'rebase strategy' });

    expect(mockCallTool).toHaveBeenCalledWith('brain_query', expect.objectContaining({
      query: expect.stringContaining('rebase strategy'),
      collection: 'course-corrections',
    }));
    expect(result).toBe('past correction: avoid X because Y');
  });

  it('returns empty string when gbrain is unavailable', async () => {
    mockCallTool.mockRejectedValue(new Error('gbrain is not available — is the process running?'));

    const result = await recallCorrections({ query: 'some query' });

    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// course_correction_capture tool
// ---------------------------------------------------------------------------

describe('course_correction_capture tool', () => {
  it('routes to captureCorrection and returns confirmation', async () => {
    mockCallTool.mockResolvedValue('ok');

    const result = await courseCorrectionCapture({
      attempted: 'do X',
      correction: 'do Y',
      reason: 'X breaks CI',
      repo: 'owner/repo',
      member_name: 'alice',
    });

    expect(mockCallTool).toHaveBeenCalledWith('brain_write', expect.objectContaining({
      content: expect.stringContaining('do X'),
      collection: 'course-corrections',
    }));
    expect(result).toBe('Course correction captured.');
  });
});

// ---------------------------------------------------------------------------
// course_correction_recall tool
// ---------------------------------------------------------------------------

describe('course_correction_recall tool', () => {
  it('routes to recallCorrections and returns brain result', async () => {
    mockCallTool.mockResolvedValue('use rebase not merge');

    const result = await courseCorrectionRecall({ query: 'git workflow', repo: 'owner/repo' });

    expect(mockCallTool).toHaveBeenCalledWith('brain_query', expect.objectContaining({
      query: expect.stringContaining('git workflow'),
      collection: 'course-corrections',
    }));
    expect(result).toBe('use rebase not merge');
  });
});
