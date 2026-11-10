import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordToolError, queryErrorEntries, classifyError, __resetErrorRegistry,
  MAX_ERROR_ENTRIES, MAX_ERROR_AGE_MS,
} from '../src/services/error-registry.js';
import { queryErrors } from '../src/tools/query-errors.js';
import { runWithSessionMember } from '../src/services/tool-scope.js';

// The bounded in-memory error registry (src/services/error-registry.ts) and
// the query_errors tool over it. The wrapTool capture is covered by
// tests/tool-registry-error-capture.test.ts.

let now = 1_000_000_000_000;
const typed = (code: string, reason?: unknown) => Object.assign(new Error(`${code}: boom`), { code, ...(reason !== undefined ? { reason } : {}) });

describe('error registry', () => {
  beforeEach(() => { now = 1_000_000_000_000; __resetErrorRegistry(() => now); });
  afterEach(() => __resetErrorRegistry());

  it('keeps at most MAX_ERROR_ENTRIES, dropping the oldest', () => {
    for (let i = 0; i < MAX_ERROR_ENTRIES + 5; i++) {
      now += 1;
      recordToolError('m-1', `tool_${i}`, new Error('x'));
    }
    const r = queryErrorEntries({ member: 'm-1', sinceSeconds: 3600, limit: MAX_ERROR_ENTRIES });
    expect(r.total).toBe(MAX_ERROR_ENTRIES);
    expect(r.entries[0].tool).toBe('tool_5');
    expect(r.entries[r.entries.length - 1].tool).toBe(`tool_${MAX_ERROR_ENTRIES + 4}`);
  });

  it('drops entries older than 24 hours, even for a window that reaches back further', () => {
    recordToolError('m-1', 'old_tool', new Error('x'));
    now += MAX_ERROR_AGE_MS - 1000;
    recordToolError('m-1', 'new_tool', new Error('x'));
    now += 2000; // old_tool is now 24h + 1s old
    const r = queryErrorEntries({ member: 'm-1', sinceSeconds: 2 * 24 * 3600 });
    expect(r.entries.map(e => e.tool)).toEqual(['new_tool']);
  });

  it('reads never clear it', () => {
    recordToolError('m-1', 'kb_query', typed('E-KB-HTTP-AUTH', 'expired'));
    const first = queryErrorEntries({ member: 'm-1', sinceSeconds: 60 });
    const second = queryErrorEntries({ member: 'm-1', sinceSeconds: 60 });
    expect(first.total).toBe(1);
    expect(second).toEqual(first);
  });

  it('returns only the asked member and only within the window', () => {
    recordToolError('m-1', 'early', new Error('x'));
    now += 30_000;
    recordToolError('m-1', 'late', new Error('x'));
    recordToolError('m-2', 'other', new Error('x'));
    recordToolError(undefined, 'full_session', new Error('x'));
    expect(queryErrorEntries({ member: 'm-1', sinceSeconds: 10 }).entries.map(e => e.tool)).toEqual(['late']);
    expect(queryErrorEntries({ member: 'm-1', sinceSeconds: 60 }).entries.map(e => e.tool)).toEqual(['early', 'late']);
    expect(queryErrorEntries({ member: 'm-2', sinceSeconds: 60 }).entries.map(e => e.tool)).toEqual(['other']);
  });

  it('records a typed code and token reason; anything else as E-UNTYPED; never message text', () => {
    expect(classifyError(typed('E-KB-HTTP-AUTH', 'expired'))).toEqual({ code: 'E-KB-HTTP-AUTH', reason: 'expired' });
    expect(classifyError(typed('E-KB-HTTP-AUTH', 'a reason with spaces in it'))).toEqual({ code: 'E-KB-HTTP-AUTH', reason: null });
    // A code in the message alone is not a typed error.
    expect(classifyError(new Error('E-FORBIDDEN: nope'))).toEqual({ code: 'E-UNTYPED', reason: null });
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toEqual({ code: 'E-UNTYPED', reason: null });
    expect(classifyError('a thrown string')).toEqual({ code: 'E-UNTYPED', reason: null });
  });

  it('counts one error object once, however many catch sites see it', () => {
    const err = typed('E-X');
    recordToolError('m-1', 't', err);
    recordToolError('m-1', 't', err);
    expect(queryErrorEntries({ member: 'm-1', sinceSeconds: 60 }).total).toBe(1);
  });
});

describe('query_errors tool', () => {
  beforeEach(() => { now = 1_000_000_000_000; __resetErrorRegistry(() => now); });
  afterEach(() => __resetErrorRegistry());

  it('filters by code and tool and keeps the most recent `limit`', async () => {
    recordToolError('m-1', 'kb_query', typed('E-KB-HTTP-AUTH', 'expired'));
    now += 1;
    recordToolError('m-1', 'kb_capture', typed('E-KB-HTTP-AUTH', 'rejected'));
    now += 1;
    recordToolError('m-1', 'kb_query', new Error('x'));
    const byCode = JSON.parse(await queryErrors({ member: 'm-1', since_seconds: 60, code: 'E-KB-HTTP-AUTH' }));
    expect(byCode.entries.map((e: { reason: string }) => e.reason)).toEqual(['expired', 'rejected']);
    const byTool = JSON.parse(await queryErrors({ member: 'm-1', since_seconds: 60, tool: 'kb_query' }));
    expect(byTool.entries.map((e: { code: string }) => e.code)).toEqual(['E-KB-HTTP-AUTH', 'E-UNTYPED']);
    const limited = JSON.parse(await queryErrors({ member: 'm-1', since_seconds: 60, limit: 1 }));
    expect(limited).toMatchObject({ member: 'm-1', since_seconds: 60, total: 3 });
    expect(limited.entries.map((e: { tool: string }) => e.tool)).toEqual(['kb_query']);
    expect(limited.entries[0].code).toBe('E-UNTYPED');
  });

  it('a member session reads its own member and is refused any other', async () => {
    recordToolError('m-1', 'kb_query', new Error('x'));
    recordToolError('m-2', 'kb_query', new Error('x'));
    const own = await runWithSessionMember('m-1', () => queryErrors({ member: 'm-1', since_seconds: 60 }));
    expect(JSON.parse(own).total).toBe(1);
    await expect(runWithSessionMember('m-1', () => queryErrors({ member: 'm-2', since_seconds: 60 })))
      .rejects.toMatchObject({ code: 'E-FORBIDDEN' });
  });
});
