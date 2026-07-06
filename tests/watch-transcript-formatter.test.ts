import { describe, it, expect } from 'vitest';
import { formatTranscriptLine } from '../src/services/watch/transcript-formatter.js';

const ts = '2026-07-04T15:02:17.069Z';

function assistant(content: any[]): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content } });
}

describe('formatTranscriptLine (claude, compact)', () => {
  it('returns [] for invalid JSON', () => {
    expect(formatTranscriptLine('claude', 'not json')).toEqual([]);
  });

  it('returns [] for empty lines', () => {
    expect(formatTranscriptLine('claude', '   ')).toEqual([]);
  });

  it('skips empty tool_result events (no content)', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(formatTranscriptLine('claude', line)).toEqual([]);
  });

  it('suppresses thinking blocks by default (verbose-only)', () => {
    expect(formatTranscriptLine('claude', assistant([{ type: 'thinking', thinking: 'hmm' }]))).toEqual([]);
  });

  it('renders assistant prose with no marker and no "assistant:" label', () => {
    const out = formatTranscriptLine('claude', assistant([{ type: 'text', text: 'Now I will implement the change.' }]));
    expect(out).toHaveLength(1);
    expect(out[0].marker).toBe('');
    expect(out[0].text).toBe('Now I will implement the change.');
    expect(out[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('marks edits with * and reads with >', () => {
    const edit = formatTranscriptLine('claude', assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/add.js' } }]));
    expect(edit[0].marker).toBe('*');
    expect(edit[0].text).toBe('Edit add.js');

    const read = formatTranscriptLine('claude', assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/add.js' } }]));
    expect(read[0].marker).toBe('>');
    expect(read[0].text).toBe('Read add.js');
  });

  it('marks Bash with $ and shows the command (not the description) as the body', () => {
    const out = formatTranscriptLine('claude', assistant([
      { type: 'tool_use', name: 'Bash', input: { command: 'node t.js', description: 'Run the test file' } },
    ]));
    expect(out[0].marker).toBe('$');
    expect(out[0].text).toBe('node t.js');
  });

  it('emits one line per block for multi-block messages', () => {
    const out = formatTranscriptLine('claude', assistant([
      { type: 'text', text: 'Doing two things' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/requirements.md' } },
    ]));
    expect(out.map((e) => `${e.marker}|${e.text}`)).toEqual(['|Doing two things', '>|Read requirements.md']);
  });

  it('unknown provider falls back to a compact preview', () => {
    const out = formatTranscriptLine('codex', JSON.stringify({ hello: 'world' }));
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('hello');
  });
});

describe('formatTranscriptLine (claude, default view shows the logs)', () => {
  it('renders an Edit header with a (+added -removed) summary plus the diff, by default', () => {
    const line = assistant([
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a/cart.js', old_string: 'const X = 1;', new_string: 'const X = 2;' } },
    ]);
    const out = formatTranscriptLine('claude', line); // no verbose flag
    expect(out[0]).toMatchObject({ marker: '*', text: 'Edit cart.js (+1 -1)' });
    const del = out.find((e) => e.kind === 'del');
    const add = out.find((e) => e.kind === 'add');
    expect(del).toMatchObject({ detail: true, text: '- const X = 1;' });
    expect(add).toMatchObject({ detail: true, text: '+ const X = 2;' });
  });

  it('renders a Write header with a (N lines) summary plus content, by default', () => {
    const line = assistant([
      { type: 'tool_use', name: 'Write', input: { file_path: '/a/n.md', content: 'line1\nline2' } },
    ]);
    const out = formatTranscriptLine('claude', line);
    expect(out[0]).toMatchObject({ marker: '*', text: 'Write n.md (2 lines)' });
    expect(out.filter((e) => e.kind === 'add').map((e) => e.text)).toEqual(['+ line1', '+ line2']);
  });

  it('shows Bash continuation lines by default', () => {
    const line = assistant([
      { type: 'tool_use', name: 'Bash', input: { command: 'echo one\necho two', description: 'x' } },
    ]);
    const out = formatTranscriptLine('claude', line);
    expect(out[0].text).toBe('echo one'); // header = first line
    expect(out.some((e) => e.detail && e.text === 'echo two')).toBe(true);
  });

  it('renders tool_result output by default', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'All tests passed', is_error: false }] },
    });
    const out = formatTranscriptLine('claude', line);
    expect(out.some((e) => e.kind === 'out' && e.detail && e.text.includes('All tests passed'))).toBe(true);
  });

  it('marks error tool_results as del kind with a ! prefix', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] },
    });
    const out = formatTranscriptLine('claude', line);
    expect(out.some((e) => e.kind === 'del' && e.text === '! boom')).toBe(true);
  });

  it('caps long content (>40 lines) and notes how many lines were hidden', () => {
    const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const line = assistant([{ type: 'tool_use', name: 'Write', input: { file_path: '/a/big.txt', content } }]);
    const out = formatTranscriptLine('claude', line);
    expect(out.some((e) => e.text.includes('more lines'))).toBe(true);
  });

  it('includes thinking (dimmed) only in verbose', () => {
    const line = assistant([{ type: 'thinking', thinking: 'let me consider the options' }]);
    expect(formatTranscriptLine('claude', line, false)).toEqual([]);
    const v = formatTranscriptLine('claude', line, true);
    expect(v[0]).toMatchObject({ kind: 'dim', marker: '' });
    expect(v[0].text).toContain('thinking:');
  });
});
