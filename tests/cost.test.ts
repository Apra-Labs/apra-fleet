import { describe, it, expect } from 'vitest';
import {
  costWarning, uptimeWarning, isKnownInstanceType,
  COST_WARNING_THRESHOLD, RATE_WARNING_THRESHOLD, UPTIME_WARNING_THRESHOLD_HRS,
} from '../src/services/cloud/cost.js';

describe('isKnownInstanceType', () => {
  it('returns true for known instance types', () => {
    expect(isKnownInstanceType('g5.2xlarge')).toBe(true);
    expect(isKnownInstanceType('t3.micro')).toBe(true);
    expect(isKnownInstanceType('p3.8xlarge')).toBe(true);
  });

  it('returns false for unknown instance types', () => {
    expect(isKnownInstanceType('unknown.type')).toBe(false);
    expect(isKnownInstanceType('g99.32xlarge')).toBe(false);
    expect(isKnownInstanceType('')).toBe(false);
  });
});

describe('costWarning', () => {
  it('returns null for known cheap instance with low uptime', () => {
    // t3.micro: $0.0104/hr × 1h = $0.01 — well below threshold
    expect(costWarning('t3.micro', 1)).toBeNull();
  });

  it('returns high-cost warning when session cost exceeds threshold', () => {
    // g5.2xlarge: $1.212/hr × 20h = $24.24 — above $10 threshold
    const w = costWarning('g5.2xlarge', 20);
    expect(w).not.toBeNull();
    expect(w).toContain('High cost');
    expect(w).toContain('$24.24');
  });

  it('high-cost warning references dollar amount (consistent with COST_WARNING_THRESHOLD)', () => {
    // Verify the threshold is 10 so we know what to test against
    expect(COST_WARNING_THRESHOLD).toBe(10);
    const w = costWarning('g5.2xlarge', 20);
    expect(w).toMatch(/\$\d+\.\d{2}/);
  });

  it('returns rate warning for expensive instance types', () => {
    // p4d.24xlarge: $32.77/hr — above $5/hr threshold
    expect(RATE_WARNING_THRESHOLD).toBe(5);
    const w = costWarning('p4d.24xlarge', 1);
    expect(w).not.toBeNull();
    expect(w).toContain('Expensive instance');
    expect(w).toContain('/hr');
  });

  it('returns unknown pricing warning for unknown instance type', () => {
    const w = costWarning('unknown.type', 1);
    expect(w).not.toBeNull();
    expect(w).toContain('Unknown pricing');
    expect(w).toContain('unknown.type');
  });

  it('returns null when instanceType is undefined', () => {
    expect(costWarning(undefined, 5)).toBeNull();
  });
});

describe('uptimeWarning', () => {
  it('returns null for short uptime', () => {
    expect(uptimeWarning(2)).toBeNull();
    expect(uptimeWarning(0)).toBeNull();
  });

  it('returns anomaly warning for long sessions', () => {
    expect(UPTIME_WARNING_THRESHOLD_HRS).toBe(12);
    const w = uptimeWarning(15);
    expect(w).not.toBeNull();
    expect(w).toContain('Long session');
    expect(w).toContain('15h');
    expect(w).toContain('idle detection');
  });

  it('returns null at exactly the threshold', () => {
    // > threshold, not >=
    expect(uptimeWarning(UPTIME_WARNING_THRESHOLD_HRS)).toBeNull();
  });

  it('returns warning just above the threshold', () => {
    expect(uptimeWarning(UPTIME_WARNING_THRESHOLD_HRS + 0.1)).not.toBeNull();
  });
});
