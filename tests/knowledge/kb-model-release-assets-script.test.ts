/**
 * The release workflow's model asset script (scripts/model-release-assets.mjs)
 * reads its asset list from profiles.ts, and its --dry-run output names
 * exactly the assets the model store's release source requests, with their
 * pinned sha256. The workflow YAML still parses and wires the script into
 * both the release and the prerelease job.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore, type ModelDownloadFn } from '../../src/services/knowledge/embedding/model-store.js';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'model-release-assets.mjs');
const RELEASE = 'http://release.test/download/v1.2.3';

function dryRun(): Array<{ name: string; sha256: string; path: string }> {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  return out.trim().split('\n').map((l) => {
    const [name, sha256, p] = l.split(' ');
    return { name, sha256, path: p };
  });
}

/**
 * Asset names the model store requests from the release for the default
 * model, captured through its download seam. The store stops at the first
 * file that no source delivers, so each file is requested through a
 * single-file copy of the default profile (same repo, revision and path).
 */
async function requestedByStore(): Promise<string[]> {
  const base = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
  if (base.source.kind !== 'hub') throw new Error('default profile is not a hub profile');
  const names: string[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-assets-'));
  try {
    for (const file of base.source.files) {
      const download = vi.fn<ModelDownloadFn>(async () => { throw new Error('offline'); });
      const profile = { ...base, source: { ...base.source, files: [file] } };
      const state = await new ModelStore({ modelsDir: tmp, download, hubEndpoint: 'http://hub.test', releaseBaseUrl: RELEASE })
        .ensure({ kind: 'enabled', profile });
      expect(state.state).toBe('failed');
      const first = download.mock.calls[0]?.[0] ?? '';
      expect(first.startsWith(`${RELEASE}/`)).toBe(true);
      names.push(first.slice(RELEASE.length + 1));
    }
    return names;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('model release asset script', () => {
  it('dry run lists every pinned file of the default model with its sha256', () => {
    const plan = dryRun();
    const src = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].source;
    if (src.kind !== 'hub') throw new Error('default profile is not a hub profile');
    expect(plan.map((a) => a.path)).toEqual(src.files.map((f) => f.path));
    expect(plan.map((a) => a.sha256)).toEqual(src.files.map((f) => f.sha256));
  });

  it('dry run names are exactly what the release source requests', async () => {
    expect(dryRun().map((a) => a.name)).toEqual(await requestedByStore());
  });
});

describe('ci.yml wiring', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');

  it('parses as YAML', () => {
    expect(() => parseYaml(text)).not.toThrow();
  });

  it('release and prerelease jobs run the script and upload its files', () => {
    const doc = parseYaml(text) as { jobs: Record<string, { steps: Array<{ run?: string; with?: { files?: string } }> }> };
    for (const job of ['release', 'prerelease']) {
      const runs = doc.jobs[job].steps.map((s) => s.run ?? '').join('\n');
      expect(runs).toContain('node --experimental-strip-types scripts/model-release-assets.mjs --out');
    }
    const files = doc.jobs.release.steps.map((s) => s.with?.files ?? '').join('\n');
    expect(files).toContain('release-models/kbmodel-*');
    const prereleaseRuns = doc.jobs.prerelease.steps.map((s) => s.run ?? '').join('\n');
    expect(prereleaseRuns).toMatch(/for m in kbmodel-\*; do .*FILES="\$FILES \$m"/);
  });
});
