import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDocument, checkFiles } from '../scripts/check-bible-entry-count.mjs';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-bible-entry-count.mjs');

function bible(entryCount: number, n: number) {
  return {
    version: 3,
    provenance: { commit: null, branch: null, entry_count: entryCount },
    entries: Array.from({ length: n }, (_, i) => ({ id: `id-${i}` })),
  };
}

describe('bible entry_count check', () => {
  it('passes on the repo bible (this is the npm test gate)', () => {
    expect(checkFiles()).toEqual([]);
  });

  it('fails a fixture with entry_count 124 and 127 entries', () => {
    const problems = checkDocument(bible(124, 127), 'fixture');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('124');
    expect(problems[0]).toContain('127');
  });

  it('passes a consistent document and skips the legacy bare array', () => {
    expect(checkDocument(bible(3, 3))).toEqual([]);
    expect(checkDocument([{ id: 'a' }])).toEqual([]);
  });

  it('CLI exits 1 on a drifted file and 0 on a good one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bible-count-'));
    try {
      const bad = path.join(dir, 'bad.json');
      const good = path.join(dir, 'good.json');
      fs.writeFileSync(bad, JSON.stringify(bible(124, 127)));
      fs.writeFileSync(good, JSON.stringify(bible(2, 2)));
      expect(spawnSync(process.execPath, [SCRIPT, bad]).status).toBe(1);
      expect(spawnSync(process.execPath, [SCRIPT, good]).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
