// T1.4.1 acceptance criterion: a sanitation check for secret/credential
// patterns over the committed memory-contract/v1/fixtures/ corpus, discovered
// by the existing vitest include (tests/**/*.test.ts) and therefore already
// executed by the CI job that runs `npm test` (.github/workflows/ci.yml line
// 130) -- no workflow edit needed or permitted here (that file stays solely
// owned by T1.5.1).
//
// Two cases, per the acceptance criterion's own non-vacuity requirement:
//   1. The real committed corpus scans clean.
//   2. A scratch COPY of a real fixture with a planted fake credential fails
//      the same scan, proving the check is not vacuous.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFixtureContent } from './helpers/memory-contract-fixture-sanitation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1', 'fixtures');

function listJsonFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

describe('memory-contract/v1 fixture sanitation', () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed fixture corpus has no credential-shaped strings', () => {
    const files = listJsonFilesRecursive(FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(0);

    const findings = files.flatMap((file) => scanFixtureContent(file, fs.readFileSync(file, 'utf-8')));
    expect(findings).toEqual([]);
  });

  it('detects a deliberately planted fake credential (proves the check is not vacuous)', () => {
    const files = listJsonFilesRecursive(FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(0);
    const sampleFile = files[0];

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-fixture-sanitation-'));
    scratchDirs.push(scratchDir);

    const original = fs.readFileSync(sampleFile, 'utf-8');
    // AKIAIOSFODNN7EXAMPLE is AWS's own documented example access key id --
    // format-realistic, never a real credential -- appended to a scratch COPY
    // only, never to the committed corpus itself.
    const planted = original.replace(
      '"tool":',
      '"planted_fixture_only_do_not_commit": "AKIAIOSFODNN7EXAMPLE", "tool":',
    );
    expect(planted).not.toBe(original);

    const scratchFile = path.join(scratchDir, path.basename(sampleFile));
    fs.writeFileSync(scratchFile, planted, 'utf-8');

    const findings = scanFixtureContent(scratchFile, planted);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.pattern === 'aws-access-key-id')).toBe(true);

    // The real committed fixture that was copied must remain untouched.
    expect(fs.readFileSync(sampleFile, 'utf-8')).toBe(original);
  });
});
