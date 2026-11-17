import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requireSqliteProject, isSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
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

// my-beads-db-u00.3: kb_stats degrades over a remote provider instead of
// failing fast, and used to ask that type question by catching
// requireSqliteProject's throw. isSqliteProject is the non-throwing
// replacement; these pin that it answers both ways without throwing.
describe('isSqliteProject', () => {
  it('returns true for a real SqliteProvider and narrows it', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-sqlite-project-'));
    const dbPath = path.join(tmpDir, 'kb.sqlite');
    const sqlite = new SqliteProvider(dbPath);

    expect(isSqliteProject(sqlite)).toBe(true);
    if (isSqliteProject(sqlite)) {
      expect(sqlite.dbPath).toBe(dbPath);
    }
  });

  it('returns false for a real HttpKbProvider rather than throwing', () => {
    httpProvider = new HttpKbProvider('http://localhost:19999', 'NOT_A_REAL_KEY');

    let result: boolean | undefined;
    expect(() => { result = isSqliteProject(httpProvider!); }).not.toThrow();
    expect(result).toBe(false);
  });

  it('agrees with requireSqliteProject on both provider kinds', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-sqlite-project-'));
    const sqlite = new SqliteProvider(path.join(tmpDir, 'kb.sqlite'));
    httpProvider = new HttpKbProvider('http://localhost:19999', 'NOT_A_REAL_KEY');

    expect(isSqliteProject(sqlite)).toBe(true);
    expect(requireSqliteProject(sqlite, 'agree')).toBe(sqlite);
    expect(isSqliteProject(httpProvider)).toBe(false);
    expect(() => requireSqliteProject(httpProvider!, 'agree')).toThrowError(/agree/);
  });
});
