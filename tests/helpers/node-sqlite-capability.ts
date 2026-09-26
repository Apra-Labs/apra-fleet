// apra-fleet-ytfy.6: node:sqlite (the KB subsystem's storage backend, PR #305)
// is a Node builtin with two separate version gates, both of which must be
// satisfied for the KB to actually work, not just load:
//   1. The module itself: added experimental+flagged in Node 22.5.0; the
//      --experimental-sqlite flag requirement was dropped in 22.13.0 (see
//      https://nodejs.org/api/sqlite.html "History"). Below 22.13.0, even
//      `require('node:sqlite')` throws "No such built-in module".
//   2. FTS5 (full-text search), which src/services/knowledge/sqlite-
//      provider.ts's schema and kb_query both depend on: empirically NOT
//      compiled into node:sqlite until Node 22.16.0 (verified locally --
//      22.13.0/22.14.0/22.15.0 all load node:sqlite fine but throw "no such
//      module: fts5" the moment a query touches the FTS5 virtual table;
//      22.16.0 is the first release where `CREATE VIRTUAL TABLE ... USING
//      fts5(...)` succeeds). This is presumably the "sqlite: enable common
//      flags" change (nodejs/node#57621), which landed in the 22.16.0 line.
// So the real floor for a fully-working KB is Node >=22.16.0 (root
// package.json's engines.node reflects this). CI's setup-node
// `node-version: 22.x` always resolves to a current (>=22.16.0) release, but
// npm does not enforce engines.node by default (no engine-strict), so a dev
// (or sandboxed CI-adjacent runner) on an older/incapable Node needs a way to
// skip exactly the tests that need it rather than fail with a confusing
// runtime error. Shared by vitest.config.ts (whole-file excludes for the
// tests/knowledge/** suite and the handful of root tests that transitively
// import KB-wired modules) and by individual test files that need finer-
// grained (single-test, not whole-file) gating.
import { createRequire } from 'node:module';

let cached: boolean | undefined;

export function hasNodeSqlite(): boolean {
  if (cached === undefined) {
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const db = new DatabaseSync(':memory:');
      try {
        // Probe FTS5 specifically, not just module presence -- see history
        // above. Use a throwaway in-memory DB so this has no side effects.
        db.exec('CREATE VIRTUAL TABLE apra_fleet_fts5_probe USING fts5(x)');
        cached = true;
      } finally {
        db.close();
      }
    } catch {
      cached = false;
    }
  }
  return cached;
}
