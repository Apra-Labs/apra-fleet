import { describe, it, expect } from 'vitest';
import { classifyPromptError, isRetryable, authErrorAdvice } from '../src/utils/prompt-errors.js';

describe('classifyPromptError', () => {
  it('classifies auth errors', () => {
    expect(classifyPromptError('Not logged in')).toBe('auth');
  });

  it('classifies server errors', () => {
    expect(classifyPromptError('HTTP 500 Internal Server Error')).toBe('server');
  });

  it('classifies overloaded errors', () => {
    expect(classifyPromptError('HTTP 429 Too Many Requests')).toBe('overloaded');
  });

  it('returns unknown for unrecognized output', () => {
    expect(classifyPromptError('something else went wrong')).toBe('unknown');
  });
});

describe('isRetryable', () => {
  it('returns true for server', () => expect(isRetryable('server')).toBe(true));
  it('returns true for overloaded', () => expect(isRetryable('overloaded')).toBe(true));
  it('returns false for auth', () => expect(isRetryable('auth')).toBe(false));
  it('returns false for unknown', () => expect(isRetryable('unknown')).toBe(false));
});

describe('authErrorAdvice', () => {
  it('includes agent name, /login, and provision_auth', () => {
    const advice = authErrorAdvice('my-agent');
    expect(advice).toContain('my-agent');
    expect(advice).toContain('/login');
    expect(advice).toContain('provision_auth');
  });
});
