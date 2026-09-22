import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';

let httpProvider: HttpKbProvider | undefined;
let tmpDir: string | undefined;

afterEach(() => {
  httpProvider?.dispose();
  httpProvider = undefined;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('requireSqliteProject', () => {
  it('returns the same SqliteProvider instance, usable without a cast', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'require-sqlite-project-'));
    const dbPath = path.join(tmpDir, 'kb.sqlite');
    const sqlite = new SqliteProvider(dbPath);

    const narrowed = requireSqliteProject(sqlite, 'test-caller');

    expect(narrowed).toBe(sqlite);
    expect(narrowed.dbPath).toBe(dbPath);
  });

  it('throws an Error whose message contains the caller label when given an HttpKbProvider', () => {
    httpProvider = new HttpKbProvider('http://localhost:19999', 'fake-token');

    expect(() => requireSqliteProject(httpProvider!, 'kb_freshness_sweep')).toThrowError(/kb_freshness_sweep/);
  });

  it('throws rather than returning a null/undefined sentinel', () => {
    httpProvider = new HttpKbProvider('http://localhost:19999', 'fake-token');

    let threw = false;
    let result: unknown = 'unset';
    try {
      result = requireSqliteProject(httpProvider, 'kb_reconcile_prefilter');
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(result).toBe('unset');
  });
});
