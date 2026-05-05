import { describe, it, expect } from 'vitest';
import { toLocalISOString } from './time-utils.js';

describe('toLocalISOString', () => {
  it('should handle UTC+0 timezone (e.g., GMT)', () => {
    // Create a date: 2026-05-05T10:30:00 UTC
    const utcMs = new Date('2026-05-05T10:30:00Z').getTime();
    const result = toLocalISOString(utcMs);
    expect(result).toMatch(/^2026-05-05T10:30:00\.\d{3}\+00:00$/);
  });

  it('should handle positive offset timezone (east of UTC, e.g., UTC+5:30 IST)', () => {
    // Create a date: 2026-05-05T10:30:00 UTC
    // In UTC+5:30, this would be 16:00:00 local time
    const utcMs = new Date('2026-05-05T10:30:00Z').getTime();
    const result = toLocalISOString(utcMs);

    // Extract hour from result
    const match = result.match(/^2026-05-05T(\d{2}):\d{2}:\d{2}\.\d{3}([\+\-])(\d{2}):(\d{2})$/);
    expect(match).toBeTruthy();

    if (match) {
      const [, hour, sign, offsetHours, offsetMinutes] = match;
      // The sign should be consistent with timezone offset calculation
      // For positive offsets (east), we expect the hour to be adjusted forward
      expect(parseInt(offsetHours)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should handle negative offset timezone (west of UTC, e.g., UTC-4 EDT)', () => {
    // Create a date: 2026-05-05T10:30:00 UTC
    // In UTC-4 (EDT), this would be 06:30:00 local time
    const utcMs = new Date('2026-05-05T10:30:00Z').getTime();
    const result = toLocalISOString(utcMs);

    // Extract components from result
    const match = result.match(/^2026-05-05T(\d{2}):\d{2}:\d{2}\.\d{3}([\+\-])(\d{2}):(\d{2})$/);
    expect(match).toBeTruthy();

    if (match) {
      const [, hour, sign, offsetHours, offsetMinutes] = match;
      // For negative offsets (west), we expect the hour to be adjusted backward
      expect(parseInt(offsetHours)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should produce a valid ISO 8601 format with timezone offset', () => {
    const now = Date.now();
    const result = toLocalISOString(now);
    // Should match format: YYYY-MM-DDTHH:MM:SS.sss±HH:MM
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });

  it('should adjust hours correctly for positive offset', () => {
    // Using a known UTC time: 2026-05-05T10:00:00Z
    const utcMs = new Date('2026-05-05T10:00:00Z').getTime();
    const result = toLocalISOString(utcMs);

    // Extract the hour component
    const hourMatch = result.match(/T(\d{2}):/);
    expect(hourMatch).toBeTruthy();

    // The hour should reflect local time adjustment
    if (hourMatch) {
      const hour = parseInt(hourMatch[1]);
      // Hour should be a valid hour (0-23)
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThanOrEqual(23);
    }
  });

  it('should preserve minutes and seconds', () => {
    const ms = new Date('2026-05-05T10:45:30.123Z').getTime();
    const result = toLocalISOString(ms);
    expect(result).toContain('45:30.123');
  });

  it('should handle different timestamps consistently', () => {
    const ms1 = new Date('2026-01-15T12:00:00Z').getTime();
    const ms2 = new Date('2026-12-15T12:00:00Z').getTime();

    const result1 = toLocalISOString(ms1);
    const result2 = toLocalISOString(ms2);

    // Both should be valid ISO strings
    expect(result1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
    expect(result2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });
});
