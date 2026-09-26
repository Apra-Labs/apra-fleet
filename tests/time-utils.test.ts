import { describe, it, expect, vi, afterEach } from 'vitest';
import { toLocalISOString } from '../src/services/stall/time-utils.js';

// F1/D1: two assertions below pin that toLocalISOString shifts ONLY the hour
// component while preserving minutes/seconds/millis. That invariant holds only
// for whole-hour timezone offsets -- on a sub-hour zone (e.g. Asia/Kolkata
// +05:30, the author's zone) toLocalISOString correctly shifts the minutes too,
// so the "minutes preserved" checks legitimately fail. Force a fixed whole-hour
// zone (Asia/Tokyo, +09:00, no DST) for those two tests so they pin the same
// behavior deterministically on any machine, without weakening the assertion.
// Node re-reads process.env.TZ for each new Date(), so vi.stubEnv takes effect.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('toLocalISOString', () => {
  it('should produce a valid ISO 8601 format with timezone offset', () => {
    const now = Date.now();
    const result = toLocalISOString(now);
    // Should match format: YYYY-MM-DDTHH:MM:SS.sss±HH:MM
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });

  it('should convert UTC time to local time with correct offset', () => {
    // Whole-hour zone so the minute component is preserved (see file header).
    vi.stubEnv('TZ', 'Asia/Tokyo');
    // Create a UTC time: 2026-05-05T10:30:00Z
    const utcMs = new Date('2026-05-05T10:30:00Z').getTime();
    const result = toLocalISOString(utcMs);

    // Parse the result to extract hour and offset
    const match = result.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}([\+\-])(\d{2}):(\d{2})$/);
    expect(match).toBeTruthy();

    if (match) {
      const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
      const localHour = parseInt(hour);
      const localMinute = parseInt(minute);
      const offset = parseInt(offsetHours);

      // The hour should be a valid hour (0-23)
      expect(localHour).toBeGreaterThanOrEqual(0);
      expect(localHour).toBeLessThanOrEqual(23);
      expect(localMinute).toBe(30); // Minutes should be preserved
      expect(parseInt(second)).toBe(0); // Seconds should be preserved

      // Offset should be valid (0-14 hours, with some allowing 15)
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(14);
    }
  });

  it('should handle different UTC timestamps consistently', () => {
    const ms1 = new Date('2026-01-15T12:00:00Z').getTime();
    const ms2 = new Date('2026-12-15T12:00:00Z').getTime();
    const ms3 = new Date('2026-06-15T23:45:30Z').getTime();

    const result1 = toLocalISOString(ms1);
    const result2 = toLocalISOString(ms2);
    const result3 = toLocalISOString(ms3);

    // All should be valid ISO strings with offset
    expect(result1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
    expect(result2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
    expect(result3).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });

  it('should preserve minutes and seconds from UTC time', () => {
    // Whole-hour zone so minutes/seconds are preserved (see file header).
    vi.stubEnv('TZ', 'Asia/Tokyo');
    const ms = new Date('2026-05-05T10:45:30.123Z').getTime();
    const result = toLocalISOString(ms);
    expect(result).toContain('45:30.123');
  });

  it('should match the actual local hour from new Date(ms).getHours()', () => {
    const ms = new Date('2026-05-05T10:00:00Z').getTime();
    const result = toLocalISOString(ms);

    const hourMatch = result.match(/T(\d{2}):/);
    expect(hourMatch).toBeTruthy();

    const resultHour = parseInt(hourMatch![1]);
    const expectedHour = new Date(ms).getHours(); // built-in local hour
    expect(resultHour).toBe(expectedHour);
  });

  it('should handle midnight UTC', () => {
    const ms = new Date('2026-05-05T00:00:00Z').getTime();
    const result = toLocalISOString(ms);

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });

  it('should handle end of day UTC', () => {
    const ms = new Date('2026-05-05T23:59:59.999Z').getTime();
    const result = toLocalISOString(ms);

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[\+\-]\d{2}:\d{2}$/);
  });
});
