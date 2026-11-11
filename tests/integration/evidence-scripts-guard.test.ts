import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The evidence scripts under tests/integration run by hand against real
// members. remove_member deletes a member's LLM login files, so no script may
// ever call it: a script removes only what it created and detaches without
// deregistering.

const ROOT = path.resolve(__dirname);

function scripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scripts(p));
    else if (entry.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

describe('evidence scripts', () => {
  it('never call remove_member', () => {
    const found = scripts(ROOT);
    expect(found.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining(['provision-kb-auth/run.mjs', 'kb-auth-keeper/run.mjs']),
    );
    const callers = found.filter((f) => /['"`]remove_member['"`]|removeMember\(/.test(fs.readFileSync(f, 'utf8')));
    expect(callers.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
