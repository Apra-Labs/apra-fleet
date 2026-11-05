import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBaseline, baselineImportSpecifier } from '../scripts/check-ascii-only.mjs';

describe('check-ascii-only baseline loading', () => {
  it('loads a baseline module from an absolute path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-baseline-'));
    try {
      const file = path.join(dir, 'baseline with space.mjs');
      fs.writeFileSync(file, 'export default { "a.txt": 2 };\n');
      expect(await loadBaseline(file)).toEqual({ 'a.txt': 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty baseline for a missing file', async () => {
    expect(await loadBaseline(path.join(os.tmpdir(), 'no-such-baseline-xyz.mjs'))).toEqual({});
  });

  it('builds a file URL (with cache-busting query) for a Windows drive path', () => {
    const spec = baselineImportSpecifier('C:\\repo dir\\scripts\\ascii-baseline.mjs', { windows: true }, 123);
    expect(spec).toBe('file:///C:/repo%20dir/scripts/ascii-baseline.mjs?t=123');
  });

  it('never hands import() a raw path', () => {
    expect(baselineImportSpecifier('/abs/x.mjs', undefined, 1)).toBe('file:///abs/x.mjs?t=1');
  });
});
