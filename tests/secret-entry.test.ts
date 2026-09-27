import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as logHelpers from '../src/utils/log-helpers.js';
import {
  createSecretEntry,
  getSecretEntryPrompt,
  submitSecretEntry,
  SECRET_ENTRY_TTL_MS,
  __resetSecretEntriesForTest,
} from '../src/services/secret-entry.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;

describe('secret-entry (console-hosted one-time secret-entry registry)', () => {
  beforeEach(() => {
    __resetSecretEntriesForTest();
  });

  afterEach(() => {
    __resetSecretEntriesForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('createSecretEntry', () => {
    it('returns a console-relative path with a 64-hex token and no scheme/host/port', () => {
      const entry = createSecretEntry({ name: 'm1', prompt: 'Enter password', onSubmit: () => ({ ok: true }) });

      expect(entry.token).toMatch(TOKEN_RE);
      expect(entry.path).toBe(`/ui/#/secret-entry/${entry.token}`);
      expect(entry.path).not.toContain('127.0.0.1');
      expect(entry.path).not.toContain('localhost');
      expect(entry.path).not.toMatch(/^[a-z]+:\/\//);
      expect(entry.path).not.toMatch(/:\d+/);
    });

    it('derives expiresAt from now + SECRET_ENTRY_TTL_MS', () => {
      vi.useFakeTimers();
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);

      const entry = createSecretEntry({ name: 'm1', prompt: 'Enter password', onSubmit: () => ({ ok: true }) });

      expect(entry.expiresAt).toBe(new Date(now.getTime() + SECRET_ENTRY_TTL_MS).toISOString());
    });
  });

  describe('submitSecretEntry', () => {
    it('calls onSubmit with the exact value and returns ok on success', () => {
      const onSubmit = vi.fn(() => ({ ok: true }));
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const res = submitSecretEntry(entry.token, 'the-value');

      expect(onSubmit).toHaveBeenCalledWith('the-value');
      expect(res).toEqual({ status: 'ok' });
    });

    it('is single-use: a second submit with the same token returns not_found', () => {
      const onSubmit = vi.fn(() => ({ ok: true }));
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      expect(submitSecretEntry(entry.token, 'first')).toEqual({ status: 'ok' });
      expect(onSubmit).toHaveBeenCalledTimes(1);

      const second = submitSecretEntry(entry.token, 'second');
      expect(second).toEqual({ status: 'not_found' });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('returns not_found for an unknown token and never calls onSubmit', () => {
      const onSubmit = vi.fn(() => ({ ok: true }));
      createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const res = submitSecretEntry('0'.repeat(64), 'value');

      expect(res).toEqual({ status: 'not_found' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('returns not_found after the TTL elapses, and onSubmit is never called', () => {
      vi.useFakeTimers();
      const onSubmit = vi.fn(() => ({ ok: true }));
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      vi.advanceTimersByTime(SECRET_ENTRY_TTL_MS + 1);

      const res = submitSecretEntry(entry.token, 'too-late');
      expect(res).toEqual({ status: 'not_found' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a throwing onSubmit returns { status: "error" } with no derived message, and the token survives for a retry', () => {
      const onSubmit = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error('SENTINEL-THROWN-MESSAGE');
        })
        .mockReturnValueOnce({ ok: true });
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const first = submitSecretEntry(entry.token, 'wrong');
      expect(first).toEqual({ status: 'error' });
      expect(JSON.stringify(first)).not.toContain('SENTINEL-THROWN-MESSAGE');

      // Token still works on a subsequent successful submit -- a throw does
      // not consume the one-time entry.
      const second = submitSecretEntry(entry.token, 'right');
      expect(second).toEqual({ status: 'ok' });
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });

    it('a rejected submission returns { status: "rejected", error } and the token survives for a retry', () => {
      const onSubmit = vi.fn()
        .mockReturnValueOnce({ ok: false, error: 'bad value' })
        .mockReturnValueOnce({ ok: true });
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const first = submitSecretEntry(entry.token, 'wrong');
      expect(first).toEqual({ status: 'rejected', error: 'bad value' });

      // Token still works on a subsequent successful submit.
      const second = submitSecretEntry(entry.token, 'right');
      expect(second).toEqual({ status: 'ok' });
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSecretEntryPrompt', () => {
    it('returns { name, prompt } for a live token', () => {
      const entry = createSecretEntry({ name: 'member-x', prompt: 'Enter the thing', onSubmit: () => ({ ok: true }) });

      expect(getSecretEntryPrompt(entry.token)).toEqual({ name: 'member-x', prompt: 'Enter the thing' });
    });

    it('returns null for an unknown token', () => {
      expect(getSecretEntryPrompt('a'.repeat(64))).toBeNull();
    });

    it('returns null for a consumed token', () => {
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit: () => ({ ok: true }) });
      submitSecretEntry(entry.token, 'value');

      expect(getSecretEntryPrompt(entry.token)).toBeNull();
    });

    it('returns null for an expired token', () => {
      vi.useFakeTimers();
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit: () => ({ ok: true }) });
      vi.advanceTimersByTime(SECRET_ENTRY_TTL_MS + 1);

      expect(getSecretEntryPrompt(entry.token)).toBeNull();
    });
  });

  describe('non-leakage', () => {
    const SENTINEL = 'SENTINEL-SECRET-DO-NOT-LEAK';

    it('never returns or logs the submitted value', () => {
      const logLineSpy = vi.spyOn(logHelpers, 'logLine');
      const logErrorSpy = vi.spyOn(logHelpers, 'logError');
      const logWarnSpy = vi.spyOn(logHelpers, 'logWarn');

      const onSubmit = vi.fn(() => ({ ok: true }));
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const submitResult = submitSecretEntry(entry.token, SENTINEL);
      const promptResult = getSecretEntryPrompt(entry.token);

      // Anti-vacuity: this module (unlike the console route layer) never
      // calls logLine/logError/logWarn at all -- see the module header --
      // so the leak risk a log-content check would catch elsewhere cannot
      // arise here. The equivalent proof that the exercised path actually
      // ran with the sentinel (rather than this sweep passing vacuously on a
      // submitSecretEntry that silently no-ops) is that onSubmit was really
      // invoked with SENTINEL and the call reported success.
      expect(onSubmit).toHaveBeenCalledWith(SENTINEL);
      expect(submitResult).toEqual({ status: 'ok' });

      const haystacks = [
        JSON.stringify(entry),
        JSON.stringify(submitResult),
        JSON.stringify(promptResult),
        ...logLineSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logErrorSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logWarnSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
      ];

      for (const haystack of haystacks) {
        expect(haystack ?? '').not.toContain(SENTINEL);
      }
    });

    it('never returns or logs a thrown onSubmit error message', () => {
      const logLineSpy = vi.spyOn(logHelpers, 'logLine');
      const logErrorSpy = vi.spyOn(logHelpers, 'logError');
      const logWarnSpy = vi.spyOn(logHelpers, 'logWarn');

      const onSubmit = vi.fn(() => {
        throw new Error(SENTINEL);
      });
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const submitResult = submitSecretEntry(entry.token, 'value');
      expect(submitResult).toEqual({ status: 'error' });
      // Anti-vacuity: prove onSubmit was actually invoked (and threw), the
      // equivalent proof-of-exercise this module's non-logging design needs
      // -- see the first non-leakage test's comment above.
      expect(onSubmit).toHaveBeenCalledTimes(1);

      const haystacks = [
        JSON.stringify(entry),
        JSON.stringify(submitResult),
        ...logLineSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logErrorSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logWarnSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
      ];

      for (const haystack of haystacks) {
        expect(haystack ?? '').not.toContain(SENTINEL);
      }
    });

    it('never returns or logs the submitted value on a rejected submission', () => {
      const logLineSpy = vi.spyOn(logHelpers, 'logLine');
      const logErrorSpy = vi.spyOn(logHelpers, 'logError');
      const logWarnSpy = vi.spyOn(logHelpers, 'logWarn');

      const onSubmit = vi.fn(() => ({ ok: false, error: 'nope' }));
      const entry = createSecretEntry({ name: 'm1', prompt: 'p', onSubmit });

      const submitResult = submitSecretEntry(entry.token, SENTINEL);

      // Anti-vacuity: prove the rejection path actually ran with SENTINEL --
      // the equivalent proof-of-exercise this module's non-logging design
      // needs -- see the first non-leakage test's comment above.
      expect(onSubmit).toHaveBeenCalledWith(SENTINEL);
      expect(submitResult).toEqual({ status: 'rejected', error: 'nope' });

      const haystacks = [
        JSON.stringify(entry),
        JSON.stringify(submitResult),
        ...logLineSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logErrorSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
        ...logWarnSpy.mock.calls.flat().map((a) => JSON.stringify(a)),
      ];

      for (const haystack of haystacks) {
        expect(haystack ?? '').not.toContain(SENTINEL);
      }
    });
  });
});
