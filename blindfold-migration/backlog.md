# blindfold-migration - Backlog

_(MEDIUM/LOW findings and deferred items land here as the sprint progresses.)_

## Phase 1 in-flight incidents

- **INC-1 (HIGH, resolved):** During Phase 1 verification, `npm test`
  wiped `~/.apra-fleet/data/registry.json` (all 6 live members) and
  replaced it with 86 fake test agents. Root cause: paths.ts captures
  FLEET_DIR at module-load time, but `tests/setup.ts` set
  APRA_FLEET_DATA_DIR via top-level code that ran AFTER its hoisted
  imports (and therefore after some test files' transitive
  paths.ts load). Recovered the 6 members from PM-captured data and
  hardened test isolation in commit `eb65946`: vitest.config.ts now
  sets the env var at config load time AND tests/setup.ts fails fast
  with exit 2 if the env var is not pointing at /tmp.
- **INC-2 (MEDIUM, deferred):** The polluted registry backup is at
  `~/.apra-fleet/data/registry.json.polluted-2026-05-19`. Keep until
  Phase 5 verification; delete during sprint cleanup if not useful
  for forensics.

## Phase 0 review (commit 3918add)

- **BL-1 (MEDIUM):** `npm install` symlinks `node_modules/blindfold -> ../blindfold`
  instead of copying, so blindfold's `prepack` doesn't run on a fresh
  clone. Phase 1+ source imports will fail without `cd blindfold &&
  npm install && npm run build`. Mitigation options:
  (a) add a `postinstall` script to root `package.json` that builds the
  submodule, or (b) document the bootstrap step in README and CI.
  Decision: defer to Phase 6 - pick option (a) since it Just Works for
  contributors and CI.
- **BL-2 (LOW):** `blindfold-migration/progress.json` records commit
  SHA `061bc164` for tasks 0.1/0.V, but the actual HEAD is `2b4150f`
  (chicken-and-egg: progress.json was written inside the commit then
  amended). Cosmetic; branch pointer is authoritative. No action
  unless a future PM relies on progress.json SHA as truth (it should
  not - use `git log` instead).
