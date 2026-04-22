import { describe, it, expect } from 'vitest';
import { classifySshError } from '../src/utils/ssh-error-messages.js';

describe('classifySshError (#150)', () => {
  it('maps authentication failure to user-friendly message', () => {
    expect(classifySshError('Authentication failed')).toContain('wrong password or key not accepted');
    expect(classifySshError('All configured authentication methods failed')).toContain('wrong password or key not accepted');
  });

  it('maps ECONNREFUSED to connection refused message', () => {
    expect(classifySshError('connect ECONNREFUSED 192.168.1.1:22')).toContain('Connection refused');
    expect(classifySshError('connect ECONNREFUSED 192.168.1.1:22')).toContain('check host and port');
  });

  it('maps ETIMEDOUT to host unreachable message', () => {
    expect(classifySshError('connect ETIMEDOUT')).toContain('Host unreachable');
  });

  it('maps ENOTFOUND to host unreachable message', () => {
    expect(classifySshError('getaddrinfo ENOTFOUND mymachine')).toContain('Host unreachable');
  });

  it('maps EHOSTUNREACH to host unreachable message', () => {
    expect(classifySshError('connect EHOSTUNREACH')).toContain('Host unreachable');
  });

  it('maps OOB/auth-socket error to password prompt message', () => {
    const msg = classifySshError('OOB password prompt could not be opened');
    expect(msg).toContain("password directly via the 'password' field");
  });

  it('returns original error for unknown errors', () => {
    const raw = 'some unexpected ssh2 error message';
    expect(classifySshError(raw)).toBe(raw);
  });

  it('handles empty string gracefully', () => {
    expect(() => classifySshError('')).not.toThrow();
  });
});

describe('onboarding hook gating (#150)', () => {
  it('hook does not fire on SSH connection failure (❌ result)', async () => {
    const { getOnboardingNudge } = await import('../src/services/onboarding.js');
    const result = getOnboardingNudge(
      'register_member',
      { member_type: 'remote', friendly_name: 'testhost' },
      '❌ Failed to connect to 192.168.1.1:22 — Authentication failed — wrong password or key not accepted\nMember was NOT registered.',
    );
    expect(result).toBeNull();
  });
});
