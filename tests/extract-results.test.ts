import { describe, it, expect } from 'vitest';

// Inline the core extraction logic from .github/e2e/extract-results.mjs so we
// can unit-test it without spawning a subprocess or touching the filesystem.

function extractTexts(content: string): string[] {
  const allTexts: string[] = [];
  let currentMessage = '';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type === 'result' && obj.result) {
      if (currentMessage) { allTexts.push(currentMessage); currentMessage = ''; }
      allTexts.push(obj.result);
    } else if (obj.type === 'assistant') {
      if (currentMessage) { allTexts.push(currentMessage); currentMessage = ''; }
      for (const block of obj.message?.content ?? []) {
        if (block?.type === 'text' && block.text) allTexts.push(block.text);
      }
    } else if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
      currentMessage += obj.content;
    }
  }
  if (currentMessage) { allTexts.push(currentMessage); }
  return allTexts;
}

function extractCheckpoints(allTexts: string[]): any[] | null {
  let checkpoints: any[] | null = null;
  for (const text of allTexts) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
        .replace(/^[`*_]+/, '').replace(/[`*_]+$/, '').trim();
      const m = line.match(/^CHECKPOINT:\s*/);
      if (!m) continue;
      try {
        const parsed = JSON.parse(line.slice(m[0].length));
        if (Array.isArray(parsed)) checkpoints = parsed;
      } catch {}
    }
  }
  return checkpoints;
}

function parse(content: string) {
  return extractCheckpoints(extractTexts(content));
}

// ── CHECKPOINT in a single result line ────────────────────────────────────────

describe('extract-results: Claude stream-json (result envelope)', () => {
  it('extracts CHECKPOINT from a result line', () => {
    const content = JSON.stringify({
      type: 'result',
      result: 'CHECKPOINT: [{"test":"T1","status":"PASS","notes":"ok"}]',
    });
    const checkpoints = parse(content);
    expect(checkpoints).toEqual([{ test: 'T1', status: 'PASS', notes: 'ok' }]);
  });

  it('extracts CHECKPOINT from an assistant text block', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'CHECKPOINT: [{"test":"T2","status":"PASS","notes":"done"}]' },
        ],
      },
    });
    const checkpoints = parse(content);
    expect(checkpoints).toEqual([{ test: 'T2', status: 'PASS', notes: 'done' }]);
  });
});

// ── Fragmented Gemini chunks ───────────────────────────────────────────────────

describe('extract-results: Gemini fragmented message chunks', () => {
  it('reassembles CHECKPOINT split across two message chunks', () => {
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'CHECKPOINT: [{"test":"T1",' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '"status":"PASS","notes":"ok"}]' }),
    ].join('\n');
    const checkpoints = parse(lines);
    expect(checkpoints).toEqual([{ test: 'T1', status: 'PASS', notes: 'ok' }]);
  });

  it('reassembles CHECKPOINT split across three message chunks', () => {
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'CHECKP' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'OINT: [{"test":"T3",' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '"status":"FAIL","notes":"err"}]' }),
    ].join('\n');
    const checkpoints = parse(lines);
    expect(checkpoints).toEqual([{ test: 'T3', status: 'FAIL', notes: 'err' }]);
  });

  it('flushes accumulated message before a result envelope', () => {
    const checkpoint = 'CHECKPOINT: [{"test":"T1","status":"PASS","notes":""}]';
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: checkpoint }),
      JSON.stringify({ type: 'result', result: 'final answer' }),
    ].join('\n');
    const allTexts = extractTexts(lines);
    expect(allTexts).toContain(checkpoint);
    expect(allTexts).toContain('final answer');
  });

  it('flushes accumulated message before an assistant envelope', () => {
    const checkpoint = 'CHECKPOINT: [{"test":"T2","status":"PASS","notes":""}]';
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: checkpoint }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'next' }] } }),
    ].join('\n');
    const allTexts = extractTexts(lines);
    expect(allTexts).toContain(checkpoint);
  });

  it('uses the latest CHECKPOINT array when multiple appear', () => {
    const lines = [
      JSON.stringify({ type: 'result', result: 'CHECKPOINT: [{"test":"T1","status":"PASS","notes":""}]' }),
      JSON.stringify({ type: 'result', result: 'CHECKPOINT: [{"test":"T1","status":"PASS","notes":""},{"test":"T2","status":"FAIL","notes":"err"}]' }),
    ].join('\n');
    const checkpoints = parse(lines);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints![1].test).toBe('T2');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('extract-results: edge cases', () => {
  it('returns null when no CHECKPOINT line present', () => {
    const lines = [
      JSON.stringify({ type: 'result', result: 'All done, no checkpoint here.' }),
    ].join('\n');
    expect(parse(lines)).toBeNull();
  });

  it('ignores non-JSON lines', () => {
    const lines = [
      'not json at all',
      JSON.stringify({ type: 'result', result: 'CHECKPOINT: [{"test":"T1","status":"PASS","notes":""}]' }),
    ].join('\n');
    expect(parse(lines)).toEqual([{ test: 'T1', status: 'PASS', notes: '' }]);
  });

  it('strips markdown decoration around CHECKPOINT', () => {
    const content = JSON.stringify({
      type: 'result',
      result: '`CHECKPOINT: [{"test":"T1","status":"PASS","notes":""}]`',
    });
    expect(parse(content)).toEqual([{ test: 'T1', status: 'PASS', notes: '' }]);
  });

  it('ignores message chunks from non-assistant roles', () => {
    const lines = [
      JSON.stringify({ type: 'message', role: 'user', content: 'user input' }),
    ].join('\n');
    expect(extractTexts(lines)).toEqual([]);
  });

  it('ignores message chunks where content is not a string', () => {
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 42 }),
    ].join('\n');
    expect(extractTexts(lines)).toEqual([]);
  });
});
