import { describe, it, expect } from 'vitest';
import { classifyPromptError, isRetryable, authErrorAdvice, workspaceNotTrustedAdvice } from '../src/utils/prompt-errors.js';

describe('classifyPromptError', () => {
  it('classifies auth errors', () => {
    expect(classifyPromptError('Not logged in')).toBe('auth');
  });

  // apra-fleet-eft.40.3
  it('classifies the workspace-not-trusted stderr signature', () => {
    expect(classifyPromptError('Ignoring 17 permissions.allow entries -- this workspace has not been trusted')).toBe('workspace_not_trusted');
  });

  it('classifies workspace-not-trusted case-insensitively and independent of surrounding noise', () => {
    expect(classifyPromptError('warning: THIS WORKSPACE HAS NOT BEEN TRUSTED, skipping project permissions')).toBe('workspace_not_trusted');
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
  it('returns true only for server/overloaded categories', () => {
    expect(isRetryable('server')).toBe(true);
    expect(isRetryable('overloaded')).toBe(true);
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('unknown')).toBe(false);
  });

  // apra-fleet-eft.40.3: workspace-not-trusted is an actionable, non-transient
  // condition (retrying without seeding trust just repeats the same degraded
  // dispatch) -- it must never be classified as retryable.
  it('returns false for workspace_not_trusted', () => {
    expect(isRetryable('workspace_not_trusted')).toBe(false);
  });
});

describe('authErrorAdvice', () => {
  it('includes member name, /login, and provision_llm_auth', () => {
    const advice = authErrorAdvice('my-member');
    expect(advice).toContain('my-member');
    expect(advice).toContain('/login');
    expect(advice).toContain('provision_llm_auth');
  });
});

describe('workspaceNotTrustedAdvice', () => {
  it('includes member name and names ensureWorkspaceTrusted as the remediation', () => {
    const advice = workspaceNotTrustedAdvice('my-member');
    expect(advice).toContain('my-member');
    expect(advice).toContain('ensureWorkspaceTrusted');
  });
});
