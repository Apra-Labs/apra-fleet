import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import type { Confidence, KBEntry } from '../../src/services/knowledge/types.js';

// my-beads-db-0d3.2: confidence_clamped is derived from "stored confidence
// differs from requested confidence". It used to be set only by the CONFIRMED
// clamp, so a user-directive -- quarantined to UNVERIFIED -- reported false.
// Runs the real kb_capture handler against the real providers getKbProviders
// builds for a scratch git repo, and reads each entry back from that provider.

let tmp: string;
let repoPath: string;
// FLEET_DIR (and so the KB config) is shared by every test file in the run, and
// getKbProviders reselects the project provider whenever that config changes.
// Pin the stock sqlite path by removing any config an earlier file left behind,
// and put it back afterwards.
let savedConfig: string | null;

beforeEach(() => {
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-clamp-flag-'));
  const tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: repoPath });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:acme/clamp-${tok}.git`], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function capture(type: 'user-directive' | 'learning', title: string, confidence?: Confidence) {
  return JSON.parse(await kbCapture({
    type,
    title,
    summary: `${title} summary`,
    content: `${title} content`,
    source_files: ['src/fixture.ts'],
    repo_path: repoPath,
    ...(confidence ? { confidence } : {}),
  } as any)) as { id: string; confidence_clamped: boolean };
}

async function storedEntry(id: string): Promise<KBEntry> {
  const { project } = await getKbProviders(repoPath);
  const res = await project.query({ ids: [id] });
  expect(res.results).toHaveLength(1);
  return res.results[0];
}

describe('kb_capture confidence_clamped reflects stored vs requested confidence (my-beads-db-0d3.2)', () => {
  it('a CONFIRMED user-directive reports clamped:true and is stored UNVERIFIED, pending', async () => {
    const out = await capture('user-directive', 'Confirmed directive', 'CONFIRMED');

    expect(out.confidence_clamped).toBe(true);
    const entry = await storedEntry(out.id);
    expect(entry.confidence).toBe('UNVERIFIED');
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.tags).toContain('directive:pending');
  });

  it('a user-directive with no confidence (default INFERRED) is also downgraded, and says so', async () => {
    const out = await capture('user-directive', 'Default directive');

    expect(out.confidence_clamped).toBe(true);
    expect((await storedEntry(out.id)).confidence).toBe('UNVERIFIED');
  });

  it('a CONFIRMED non-directive still reports clamped:true and is stored INFERRED', async () => {
    const out = await capture('learning', 'Confirmed learning', 'CONFIRMED');

    expect(out.confidence_clamped).toBe(true);
    expect((await storedEntry(out.id)).confidence).toBe('INFERRED');
  });

  it('an INFERRED non-directive is not downgraded and reports false', async () => {
    const out = await capture('learning', 'Inferred learning', 'INFERRED');

    expect(out.confidence_clamped).toBe(false);
    expect((await storedEntry(out.id)).confidence).toBe('INFERRED');
  });

  it('an UNVERIFIED non-directive is not downgraded and reports false', async () => {
    const out = await capture('learning', 'Unverified learning', 'UNVERIFIED');

    expect(out.confidence_clamped).toBe(false);
    expect((await storedEntry(out.id)).confidence).toBe('UNVERIFIED');
  });

  it('an UNVERIFIED user-directive keeps its requested confidence and reports false', async () => {
    const out = await capture('user-directive', 'Unverified directive', 'UNVERIFIED');

    expect(out.confidence_clamped).toBe(false);
    expect((await storedEntry(out.id)).confidence).toBe('UNVERIFIED');
  });
});
