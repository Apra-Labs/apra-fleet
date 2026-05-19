# blindfold-migration - Backlog

_(MEDIUM/LOW findings and deferred items land here as the sprint progresses.)_

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
