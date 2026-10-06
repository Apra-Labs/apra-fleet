import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard: every doc example that calls the bearer-guarded supervisor /api/ surface
// (localhost:8787 or 127.0.0.1:8787) must carry an Authorization header, else an
// operator gets a silent 401. Command = the curl/Invoke-RestMethod line plus its
// continuation lines (trailing backslash or backtick).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.beads', '.gitnexus']);
const TARGET = /(localhost|127\.0\.0\.1):8787\/api/;
const CMD = /\b(curl|Invoke-RestMethod|Invoke-WebRequest|iwr|irm)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('sprint-analysis-')) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.md') && !e.name.startsWith('sprint-analysis-')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

export function findBareSupervisorCalls(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const bad: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CMD.test(lines[i]) || lines[i].includes('Bash(')) continue;
    let end = i;
    while (end + 1 < lines.length && /[\\`]\s*$/.test(lines[end])) end++;
    const cmd = lines.slice(i, end + 1).join('\n');
    if (TARGET.test(cmd) && !/Authorization/i.test(cmd)) bad.push(i + 1);
  }
  return bad;
}

describe('docs: supervisor /api/ examples carry an Authorization header', () => {
  it('detector flags a bare curl, including multi-line ones, and accepts authed ones', () => {
    expect(findBareSupervisorCalls('curl -s http://localhost:8787/api/sprints')).toEqual([1]);
    expect(findBareSupervisorCalls('curl -X POST http://127.0.0.1:8787/api/sprints \\\n  -d x')).toEqual([1]);
    expect(findBareSupervisorCalls('curl -s http://localhost:8787/api/sprints \\\n  -H "Authorization: Bearer x"')).toEqual([]);
    expect(findBareSupervisorCalls('Invoke-RestMethod http://localhost:8787/api/health')).toEqual([1]);
  });

  it('no repo markdown has a bare supervisor curl/Invoke-RestMethod', () => {
    const findings: string[] = [];
    for (const f of walk(ROOT)) {
      for (const n of findBareSupervisorCalls(fs.readFileSync(f, 'utf8'))) {
        findings.push(`${path.relative(ROOT, f)}:${n}`);
      }
    }
    expect(findings, `missing Authorization header at: ${findings.join(', ')}`).toEqual([]);
  });
});
