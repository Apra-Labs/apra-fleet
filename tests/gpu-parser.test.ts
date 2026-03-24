import { describe, it, expect } from 'vitest';
import { parseGpuUtilization } from '../src/utils/gpu-parser.js';

describe('parseGpuUtilization', () => {
  it('returns the integer percentage for valid numeric output', () => {
    expect(parseGpuUtilization('45')).toBe(45);
    expect(parseGpuUtilization('0')).toBe(0);
    expect(parseGpuUtilization('100')).toBe(100);
  });

  it('handles whitespace around the number', () => {
    expect(parseGpuUtilization('  42  ')).toBe(42);
    expect(parseGpuUtilization('\n78\n')).toBe(78);
  });

  it('returns undefined for empty string', () => {
    expect(parseGpuUtilization('')).toBeUndefined();
    expect(parseGpuUtilization('  ')).toBeUndefined();
  });

  it('returns undefined for non-numeric output', () => {
    expect(parseGpuUtilization('NVSMI LOG')).toBeUndefined();
    expect(parseGpuUtilization('error')).toBeUndefined();
    expect(parseGpuUtilization('N/A')).toBeUndefined();
  });
});
