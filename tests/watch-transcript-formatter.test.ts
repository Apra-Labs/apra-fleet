import { describe, it, expect } from 'vitest';
import { formatTranscriptLine } from '../src/services/watch/transcript-formatter.js';

const ts = '2026-07-04T15:02:17.069Z';

function assistant(content: any[]): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content } });
}

describe('formatTranscriptLine (claude)', () => {
  it('returns [] for invalid JSON', () => {
    expect(formatTranscriptLine('claude', 'not json')).toEqual([]);
  });

  it('returns [] for empty lines', () => {
    expect(formatTranscriptLine('claude', '   ')).toEqual([]);
  });

  it('suppresses user/tool_result events', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(formatTranscriptLine('claude', line)).toEqual([]);
  });

  it('suppresses thinking blocks', () => {
    expect(formatTranscriptLine('claude', assistant([{ type: 'thinking', text: 'hmm' }]))).toEqual([]);
  });

  it('formats an assistant text block, truncated and prefixed', () => {
    const out = formatTranscriptLine('claude', assistant([{ type: 'text', text: 'Now I will implement the change.' }]));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('assistant: Now I will implement the change.');
    // time is rendered in local tz, so assert format not value
    expect(out[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('formats Read/Edit/Write tool_use as tool + basename', () => {
    const out = formatTranscriptLine('claude', assistant([
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/add.js' } },
    ]));
    expect(out[0].text).toBe('> Edit add.js');
  });

  it('formats Bash tool_use using description when present', () => {
    const out = formatTranscriptLine('claude', assistant([
      { type: 'tool_use', name: 'Bash', input: { command: 'cd /x && node t.js', description: 'Run the test file' } },
    ]));
    expect(out[0].text).toBe('> Bash: Run the test file');
  });

  it('emits one line per block for multi-block messages', () => {
    const out = formatTranscriptLine('claude', assistant([
      { type: 'text', text: 'Doing two things' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/requirements.md' } },
    ]));
    expect(out.map((e) => e.text)).toEqual(['assistant: Doing two things', '> Read requirements.md']);
  });

  it('unknown provider falls back to a compact preview', () => {
    const out = formatTranscriptLine('codex', JSON.stringify({ hello: 'world' }));
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('hello');
  });
});
