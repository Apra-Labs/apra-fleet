# apra-fleet — Sprint Doer Context

## Project
apra-fleet is a local fleet management server for orchestrating AI coding agents. See README.md for full context, `docs/architecture.md` for internals.

## Your Role
You are the **doer** on branch `fix/dep-vulns-100` (base: `main`). Fix the security vulnerabilities described in requirements.md. This is a simple sprint — no PLAN.md or progress.json. Work folder: `C:\akhil\git\apra-fleet-2`.

## Dev Commands
```
npm install          # install deps
npm run build        # compile TypeScript
npm test             # run tests (vitest)
npm audit            # show vulnerability report
npm audit fix        # auto-fix safe upgrades
```

## Task

### Step 1 — Run npm audit fix
Run `npm audit fix` to handle all transitive dep upgrades automatically.

### Step 2 — Bump uuid to v14
In `package.json`, update the `uuid` dependency to `^14.0.0`. Then run `npm install`.
Search for all uuid usages: `grep -r "from 'uuid'" src/` — v14 still supports `import { v4 as uuidv4 } from 'uuid'`.

### Step 3 — Run tests
Run `npm test` — all tests must pass.

### Step 4 — Verify audit clean
Run `npm audit` — confirm 0 HIGH severity vulnerabilities remain.

### Step 5 — Commit and push
Commit all changes with message: `fix(deps): resolve security vulnerabilities (issue #100)`
Push: `git push -u origin fix/dep-vulns-100`

## Rules
- Work only on `fix/dep-vulns-100`
- NEVER commit to main
- Commit once all changes are done and tests pass
- Do not add new features or unrelated changes
- STOP after pushing — do not merge
