import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The generator must tolerate harvest landing the push+pr entry in the bible:
// it then stays out of extra-entries.json and needs no authored query.
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/kb-recall-eval');
const ENTRY_ID = '4f54d973-5627-49c3-903a-466695892a45';

function ids(file: string): string[] {
  return (JSON.parse(fs.readFileSync(file, 'utf-8')).entries as { id: string }[]).map(e => e.id);
}

describe('gen-kb-recall-eval with the push+pr entry already in the bible', () => {
  it('does not duplicate the entry and does not demand an authored query', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-gen-'));
    try {
      fs.cpSync(FIXTURES, tmp, { recursive: true });
      const extra = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'extra-entries.json'), 'utf-8')).entries;
      const entry = extra.find((e: { id: string }) => e.id === ENTRY_ID);
      expect(entry).toBeTruthy();
      const snapPath = path.join(tmp, 'bible-snapshot.json');
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
      if (!snap.entries.some((e: { id: string }) => e.id === ENTRY_ID)) snap.entries.push(entry);
      fs.writeFileSync(snapPath, JSON.stringify(snap));
      execFileSync('node', [path.join(ROOT, 'scripts/gen-kb-recall-eval.mjs'), '--keep-snapshot'], {
        env: { ...process.env, APRA_KB_EVAL_FIXTURE_DIR: tmp }, stdio: 'pipe',
      });
      expect(ids(path.join(tmp, 'extra-entries.json'))).toEqual([]);
      const all = [...ids(snapPath), ...ids(path.join(tmp, 'extra-entries.json'))];
      expect(all.filter(i => i === ENTRY_ID)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
