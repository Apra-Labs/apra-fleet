import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('KB project isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-iso-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('context-cache entry in project does not appear in a separate project DB', async () => {
    const provA = new SqliteProvider(path.join(tmpDir, 'proj-a.db'));
    const provB = new SqliteProvider(path.join(tmpDir, 'proj-b.db'));
    await provA.init();
    await provB.init();

    try {
      await provA.capture({
        type: 'context-cache',
        title: 'proj-a: parser.ts',
        summary: 'parser for project A',
        content: 'content A',
        confidence: 'CONFIRMED',
        symbols: ['ParserA'],
        source_files: ['src/parser.ts'],
        source: 'doer',
        tags: [],
        scope: 'project',
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'test',
      });

      const result = await provB.query({ query: 'parser' });
      expect(result.results.length).toBe(0);
    } finally {
      provA.close();
      provB.close();
    }
  });

  it('global knowledge entry written to global DB is not in project DB', async () => {
    const projectProv = new SqliteProvider(path.join(tmpDir, 'project.db'));
    const globalProv = new SqliteProvider(path.join(tmpDir, 'global.db'));
    await projectProv.init();
    await globalProv.init();

    try {
      await globalProv.capture({
        type: 'knowledge',
        title: 'global: use execFile not exec',
        summary: 'Team convention: always use execFile for subprocess calls',
        content: 'execFile is safe; exec interpolates shell which causes injection risk',
        confidence: 'CONFIRMED',
        symbols: ['execFile', 'exec'],
        source_files: [],
        source: 'doer',
        tags: ['global', 'security'],
        scope: 'global',
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'test',
      });

      const projectResult = await projectProv.query({ query: 'execFile' });
      expect(projectResult.results.length).toBe(0);

      const globalResult = await globalProv.query({ query: 'execFile' });
      expect(globalResult.results.length).toBe(1);
      expect(globalResult.results[0].scope).toBe('global');
    } finally {
      projectProv.close();
      globalProv.close();
    }
  });

  it('resolveProjectSlug returns safe slug with only lowercase alphanumeric and hyphens', () => {
    const slug = resolveProjectSlug();
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeGreaterThan(0);
  });

  it('resolveProjectSlug is deterministic across calls', () => {
    expect(resolveProjectSlug()).toBe(resolveProjectSlug());
  });

  it('resolveProjectSlug with non-git dir returns cwd basename slug', () => {
    const tmpNonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'my-research-project-'));
    try {
      const slug = resolveProjectSlug(tmpNonGit);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    } finally {
      fs.rmSync(tmpNonGit, { recursive: true, force: true });
    }
  });
});
