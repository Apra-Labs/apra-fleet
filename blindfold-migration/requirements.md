# blindfold-migration — Requirements

## Background

The credential-security layer of apra-fleet (auth-socket / credential-store
/ crypto / shell-escape / etc.) was extracted into a standalone package
called **blindfold** (https://github.com/Apra-Labs/blindfold). The
extraction happened in commit `79fc0b2` on this branch. Bug fixes that
later landed on fleet's `main` branch were forward-ported into blindfold
(`1a8cc12`). Today, blindfold is the canonical, up-to-date version of
that code.

The same code still lives inside apra-fleet's `src/services/` and
`src/utils/`. It is stale relative to both fleet `main` and blindfold.
We must remove the in-tree copies and have fleet consume blindfold as a
dependency.

## Functional requirements

1. **Apra-fleet keeps working for existing users.** Every existing user
   has credentials at `~/.apra-fleet/data/credentials.json`, sockets at
   `~/.apra-fleet/data/auth.sock`, and Windows pipes at
   `\\.\pipe\apra-fleet-auth-<user>`. After this sprint these paths
   must be unchanged - no on-disk migration.

2. **MCP tool surface is unchanged.** Every credential_store_* and
   execute_command tool keeps its name, schema, and response format.

3. **CLI surface is mostly unchanged with one intentional move:**
   - `apra-fleet secret --confirm <name>` -> moved to
     `apra-fleet auth --confirm <name>` (with `--context` and `--on`
     options forwarded by blindfold's OOB launcher). The old path is
     deleted - no deprecation alias.
   - All other CLI subcommands stay identical.

4. **`{{secure.NAME}}` token resolution and output redaction continue
   to work** exactly as before, including in restart_command and the
   network egress (confirm/deny) flow.

## Non-functional requirements

1. **Dependency shape:** fleet imports from `'blindfold'` (npm-shaped),
   never from a relative path into `blindfold/`. Today blindfold is
   pulled in via `"blindfold": "file:./blindfold"` with `blindfold/` as
   a git submodule. When the user publishes blindfold to npm, the only
   change is the version spec in package.json.

2. **Build + test:** `npm run build`, `npm test`, and
   `npm run build:binary` (SEA binary) all pass at every commit
   boundary, modulo Phase 4 deletions noted in PLAN.md.

3. **ASCII only.** Project policy: no non-ASCII characters in any
   committed file. Use `-` for dashes, `->` for arrows, `[OK]` for
   checkmarks, etc.

4. **No Claude / AI attribution** in commits, code, comments, or PR
   bodies.

5. **One commit per phase**, with `<type>(<scope>): <description>`
   subject lines.

## Constraints

- Branch: `md/project-vault`. Do not push to `main`. Do not open a PR -
  the user reviews locally first.
- The submodule pointer is pinned to blindfold tag `v0.0.1`.
- Cycle limit per phase: 3 doer-reviewer rounds. If a phase doesn't
  converge in 3, the PM pauses and flags the user.

## Acceptance criteria

- Every file listed in PLAN.md as "delete" is gone.
- `grep -rn "from '\.\./services/auth-socket\|from '\.\./services/credential-store\|from '\.\./utils/crypto\|from '\.\./utils/secure-input\|from '\.\./utils/file-permissions\|from '\.\./utils/shell-escape\|from '\.\./utils/oob-timeout\|from '\.\./utils/credential-validation\|from '\.\./utils/collect-secret" src/ tests/`
  returns zero.
- `grep -rn "secret --confirm" src/ tests/ docs/ README.md` returns
  zero.
- `npm install && npm run build && npm test && npm run smoke && npm run build:binary` all succeed.
- Manual flow log (Phase 6 of PLAN.md) shows credential set/list/delete,
  redaction, deny block, and confirm-allow all work end-to-end.
