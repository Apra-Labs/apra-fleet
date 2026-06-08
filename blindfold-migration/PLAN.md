# PLAN — Migrate apra-fleet to depend on blindfold

**Branch:** `md/project-vault`
**Base:** `main`
**Repo:** Apra-Labs/apra-fleet

## Goal

Stop maintaining credential-security code inside apra-fleet. Pull it in
from the standalone [`blindfold`](https://github.com/Apra-Labs/blindfold)
package instead. Blindfold was extracted from this code in commit
`79fc0b2` and has been kept up to date with later fleet-main fixes
(`1a8cc12`). Fleet's local copies on `project-vault` are therefore stale
relative to both `main` and `blindfold`; replacing them is mechanical and
auto-upgrades the security layer.

## Hard guarantees (must hold at every commit boundary)

1. Existing users' credentials on disk continue to work without
   migration. Persistent store lives at
   `~/.apra-fleet/data/credentials.json`; auth socket at
   `~/.apra-fleet/data/auth.sock`. Windows named pipe stays
   `\\.\pipe\apra-fleet-auth-<user>`. These are all preserved by feeding
   the right values into `initBlindfold(...)`.
2. `npm run build`, `npm test`, and `npm run build:binary` all succeed
   (per the commit's intended scope — Phase 2 may temporarily fail tests
   that Phase 4 will delete; PLAN.md flags those).
3. No fleet code imports a relative path into `blindfold/`. Imports are
   always `from 'blindfold'` (so the same code works once blindfold
   ships on npm).
4. The on-the-wire shape of every existing MCP tool is unchanged.
   Schemas, tool names, and response strings stay the same.
5. ASCII only — never write non-ASCII characters to any file. Use `-`
   for dashes, `->` for arrows, `[OK]` for checkmarks, etc. (Project
   rule from CLAUDE.md.)
6. No Claude / Anthropic attribution in commits, code, or PR body.

---

## Phase 0 - Submodule + dependency wiring

1. The current `blindfold/` directory in the working tree is untracked
   (not a submodule). Save it for rollback if needed
   (`mv blindfold blindfold.local`), then remove the working-tree copy.
2. Add the submodule:
   `git submodule add git@github.com:Apra-Labs/blindfold.git blindfold`.
   Pin to tag v0.0.1:
   `cd blindfold && git checkout v0.0.1 && cd ..`.
3. `.gitmodules` is created by `git submodule add`; stage it along with
   the submodule pointer.
4. Edit `package.json`:
   - Add to `dependencies`: `"blindfold": "file:./blindfold"`.
   - Keep `@inquirer/password` and `zod` (still used elsewhere; npm
     dedupes since blindfold also depends on them).
5. Run `npm install`. This produces `node_modules/blindfold` from the
   submodule's source. Verify
   `node -e "console.log(require.resolve('blindfold'))"` resolves and
   that `node_modules/blindfold/dist/index.js` exists (blindfold's
   `prepack` builds it).
6. Run `npm run build` - no source changes yet, so this must still
   pass.
7. Commit: `chore(deps): add blindfold as git submodule + file: dep`

**Done when:**
- `.gitmodules` tracks `blindfold` at v0.0.1.
- `package.json` lists `"blindfold": "file:./blindfold"`.
- `import { initBlindfold } from 'blindfold'` resolves from anywhere in
  `src/`.
- `npm install`, `npm run build`, `npm test` all pass.

---

## Phase 1 - Initialize blindfold at every entrypoint

Add a single tiny helper to centralize the call:

**New file:** `src/services/blindfold-init.ts`

```typescript
import { initBlindfold, type Logger } from 'blindfold';
import { FLEET_DIR } from '../paths.js';
import { logInfo, logWarn, logError } from '../utils/log-helpers.js';

const fleetLogger: Logger = {
  info: (tag, msg) => logInfo('blindfold', `[${tag}] ${msg}`),
  warn: (tag, msg) => logWarn('blindfold', `[${tag}] ${msg}`),
  error: (tag, msg) => logError('blindfold', `[${tag}] ${msg}`),
};

let initialized = false;

export function initFleetBlindfold(): void {
  if (initialized) return;
  initBlindfold({
    dataDir: FLEET_DIR,
    productName: 'apra-fleet',
    pipeName: 'apra-fleet-auth',
    logger: fleetLogger,
  });
  initialized = true;
}
```

If `log-helpers.ts` does not export `logInfo/logWarn/logError` with this
exact name, adapt to whatever it does export (the file already calls
into pino — use the existing helpers). Do not invent new log infra.

**Call `initFleetBlindfold()` first in each entrypoint, before any
blindfold function is touched:**

1. `src/index.ts` - at the top, AFTER the `--version` / `--help`
   short-circuits (must not regress those for speed), and BEFORE the
   dynamic imports of CLI subcommands or MCP server.
2. `src/smoke-test.ts` - at the top of `main()`.
3. `tests/setup.ts` (create if missing) - reference from
   `vitest.config.ts` via `setupFiles`. The setup file calls
   `initFleetBlindfold()` with the same defaults (FLEET_DIR uses
   `APRA_FLEET_DATA_DIR` env var for test isolation - that already
   works).

Commit: `feat(blindfold): initialize blindfold config at every fleet entrypoint`

**Done when:**
- Every executable entrypoint calls `initFleetBlindfold()` before
  touching blindfold APIs.
- `apra-fleet --version` and `apra-fleet --help` still respond in
  under 200ms (do NOT init blindfold on those paths).
- Existing tests still pass.

---

## Phase 2 - Mechanical import rewrite

For every file below, swap fleet-local imports for blindfold ones.
Multiple separate fleet imports collapse to ONE `from 'blindfold'` line
(de-dup symbols).

### Rewrite table

| From (fleet) | To (blindfold) |
|---|---|
| `'../services/auth-socket.js'` | `'blindfold'` |
| `'../services/credential-store.js'` | `'blindfold'` |
| `'../utils/crypto.js'` | `'blindfold'` |
| `'../utils/secure-input.js'` | `'blindfold'` |
| `'../utils/file-permissions.js'` | `'blindfold'` |
| `'../utils/shell-escape.js'` | `'blindfold'` |
| `'../utils/oob-timeout.js'` | `'blindfold'` |
| `'../utils/credential-validation.js'` | `'blindfold'` |
| `'../utils/collect-secret.js'` | `'blindfold'` |
| (any `../../` variants too) | `'blindfold'` |

Replace the constant `OOB_TIMEOUT_MS` (find via
`grep -rn "OOB_TIMEOUT_MS" src/ tests/`) with the function call
`getOobTimeoutMs()`. Each call site adds `getOobTimeoutMs` to its
`from 'blindfold'` import.

### Files to edit (source)

- `src/index.ts` (only if it imports security primitives)
- `src/cli/secret.ts`
- `src/cli/auth.ts`
- `src/os/linux.ts`
- `src/os/os-commands.ts`
- `src/os/windows.ts`
- `src/services/git-config.ts`
- `src/services/known-hosts.ts`
- `src/services/onboarding.ts`
- `src/services/registry.ts`
- `src/services/ssh.ts`
- `src/services/strategy.ts`
- `src/services/cloud/aws.ts`
- `src/smoke-test.ts`
- `src/tools/credential-store-delete.ts`
- `src/tools/credential-store-list.ts`
- `src/tools/credential-store-set.ts`
- `src/tools/credential-store-update.ts`
- `src/tools/execute-command.ts`
- `src/tools/monitor-task.ts`
- `src/tools/provision-auth.ts`
- `src/tools/provision-vcs-auth.ts`
- `src/tools/register-member.ts`
- `src/tools/setup-git-app.ts`
- `src/tools/stop-prompt.ts`
- `src/tools/update-member.ts`
- `src/utils/auth-env.ts`

### Files to edit (tests - keep, retarget imports only)

- `tests/auth-env.test.ts`
- `tests/credential-store-and-execute.test.ts`
- `tests/credential-store-set.test.ts`
- `tests/credential-store-update.test.ts`
- `tests/provision-auth.test.ts`
- `tests/provision-vcs-auth.test.ts`
- `tests/register-member-oob.test.ts`
- `tests/security-hardening.test.ts`
- `tests/setup-git-app.test.ts`
- `tests/update-member.test.ts`
- `tests/integration/session-lifecycle.test.ts` (only if it imports
  security primitives directly)

Commit: `refactor(blindfold): swap security imports to blindfold package`

**Done when:**
- `grep -rn "from '\.\.[/.]*\(services/auth-socket\|services/credential-store\|utils/crypto\|utils/secure-input\|utils/file-permissions\|utils/shell-escape\|utils/oob-timeout\|utils/credential-validation\|utils/collect-secret\)'" src/ tests/`
  returns zero.
- `grep -rn "OOB_TIMEOUT_MS" src/ tests/` returns zero.
- `npm run build` passes.
- `npm test` passes (or only fails on tests scheduled for deletion in
  Phase 4 - note which in progress.json notes).

---

## Phase 3 - Drop fleet's local re-implementations of token-resolver

Fleet currently carries duplicate `resolveSecureTokens`/`redactOutput`
in `src/tools/execute-command.ts` and `resolveSecureField` in
`src/tools/provision-vcs-auth.ts`, plus a local `SECURE_TOKEN_RE` in
`src/tools/execute-prompt.ts`. Delete them and use blindfold's exports.

### `src/tools/execute-command.ts`

Blindfold exports:

```typescript
function resolveSecureTokens(
  text: string,
  opts?: { caller?: string; os?: 'windows' | 'macos' | 'linux'; shellEscape?: boolean }
): { resolved: string; credentials: ResolvedCredential[] } | { error: string };

function redactOutput(
  output: string,
  credentials: Array<{ name: string; plaintext: string }>
): string;
```

Changes:

1. Delete the local `SEC_RE`, `ResolvedCredential` interface,
   `resolveSecureTokens`, `redactOutput` (lines 41-112).
2. Add `ResolvedCredential`, `resolveSecureTokens`, `redactOutput`, and
   `SEC_HANDLE_RE` to the `from 'blindfold'` import.
3. Update call sites:
   - Was: `await resolveSecureTokens(input.command, agentOs, agent.friendlyName)`
   - Now: `resolveSecureTokens(input.command, { caller: agent.friendlyName, os: agentOs })`
   - Drop `await` (blindfold's version is synchronous).
4. Replace local `SEC_RE` checks at lines 139-144 with imported
   `SEC_HANDLE_RE.test(...)`.

### `src/tools/provision-vcs-auth.ts`

Blindfold exports:

```typescript
function resolveSecureField(
  value: string,
  caller?: string
): { resolved: string } | { error: string };
```

Changes:

1. Delete the local `resolveSecureField` function.
2. Add `resolveSecureField` to the `from 'blindfold'` import.
3. Call site at line 102 already matches blindfold's signature;
   only the import line changes.

### `src/tools/execute-prompt.ts`

The local `SECURE_TOKEN_RE` (line 91) is used only as a presence check.
Replace with blindfold's `containsSecureTokens(input.prompt)`:

```typescript
import { containsSecureTokens } from 'blindfold';
// ...
if (containsSecureTokens(input.prompt)) { ... }
```

Delete the local `SECURE_TOKEN_RE` constant.

Commit: `refactor(blindfold): use blindfold's token-resolver instead of local copies`

**Done when:**
- `grep -rn "function resolveSecureTokens\|function redactOutput\|function resolveSecureField\|const SECURE_TOKEN_RE\b" src/`
  returns zero.
- `npm run build` passes.
- `npm test` passes (modulo Phase 4 deletions).

---

## Phase 4 - Delete fleet's stale security modules and their unit tests

### Delete (source)

- `src/services/auth-socket.ts`
- `src/services/credential-store.ts`
- `src/utils/crypto.ts`
- `src/utils/secure-input.ts`
- `src/utils/file-permissions.ts`
- `src/utils/shell-escape.ts`
- `src/utils/oob-timeout.ts`
- `src/utils/credential-validation.ts`
- `src/utils/collect-secret.ts`

### Delete (tests - these test blindfold internals, not fleet glue)

- `tests/auth-socket.test.ts`
- `tests/crypto.test.ts`
- `tests/shell-escape.test.ts`
- `tests/credential-validation.test.ts`
- `tests/credential-cleanup.test.ts`
- `tests/credential-scoping-ttl.test.ts`
- `tests/credential-store-path.test.ts`

### Keep (integration-shaped fleet tests)

These exercise fleet's glue around blindfold and should pass after
Phase 2's import rewrite:

- `tests/credential-store-and-execute.test.ts`
- `tests/credential-store-set.test.ts`
- `tests/credential-store-update.test.ts`
- `tests/auth-env.test.ts`
- `tests/provision-auth.test.ts`
- `tests/provision-vcs-auth.test.ts`
- `tests/register-member-oob.test.ts`
- `tests/security-hardening.test.ts`
- `tests/setup-git-app.test.ts`
- `tests/update-member.test.ts`
- `tests/integration/session-lifecycle.test.ts`

Commit: `chore(blindfold): delete fleet's stale security modules and unit tests`

**Done when:**
- All listed files are gone from working tree and git index.
- `git status` shows only intended deletions.
- `npm run build` passes.
- `npm test` passes with zero failures.

---

## Phase 5 - Move confirm subcommand from `secret` to `auth`, remove alias

Blindfold's OOB launcher spawns `<product> auth --confirm <name> [--context <cmd>] [--on <member>]`.
Fleet today exposes `apra-fleet secret --confirm`. Move the handler and
DELETE the old path completely (no deprecation period, per user
instruction).

### `src/cli/auth.ts`

1. Extend the entry dispatch:

```typescript
export async function runAuth(args: string[]): Promise<void> {
  if (args.includes('--confirm')) return handleConfirm(args);
  if (args.includes('--oauth')) return handleOAuth(args);
  if (args.includes('--api-key')) return handleApiKey(args);
  // ... existing usage error
}
```

2. Add `handleConfirm(args)` - port from `src/cli/secret.ts`
   `handleConfirm` (lines 37-124), but:
   - Import `getSocketPath` from `'blindfold'` (Phase 2 already did this).
   - Keep ASCII-only output (project rule).
   - Sanitize `--context` and `--on` exactly as blindfold does
     (strip `[\x00-\x1f\x7f]`).
   - Re-validate `<credential-name>` against `^[a-zA-Z0-9_-]{1,64}$`.

3. Update help text in the usage block to add `--confirm` form.

### `src/cli/secret.ts`

1. Delete `handleConfirm` entirely (lines 37-124).
2. Remove `--confirm` from the dispatch branch (line 29).
3. Remove `--confirm` from the help text at lines 11-18.
4. Drop any imports made dead by the deletion.

### `src/index.ts`

- Remove `apra-fleet secret --confirm` line from help.
- Add `apra-fleet auth --confirm <name>` line under the auth block.

### Tests

- Search for any test that invokes `apra-fleet secret --confirm` or
  imports `handleConfirm` from `secret.ts`. Port to
  `apra-fleet auth --confirm`.
- Add coverage (or update existing CLI test) for
  `apra-fleet auth --confirm` happy path and bad-name rejection.

### Documentation

- Update `README.md` and `docs/features/oob-auth.md` (and any other doc
  that mentions `secret --confirm`) to the new `auth --confirm` form.

Commit: `feat(cli): move egress-confirm from 'secret --confirm' to 'auth --confirm'`

**Done when:**
- `grep -rn "secret --confirm\|secret_--confirm" src/ tests/ docs/ README.md` returns zero.
- `npm test` passes.

---

## Phase 6 - Smoke + binary build verification

1. `npm run build` - passes.
2. `npm test` - passes.
3. `npm run smoke` - passes.
4. `npm run build:binary` - produces a binary in `dist-binary/` (or
   wherever the build script writes it); run `--version` and `--help`
   to confirm it boots.
5. Manual flow (ASCII output - capture commands in
   `blindfold-migration/phase6-manual.md` with exit codes):
   - `apra-fleet secret --set FOO --persist` (enter `bar`).
   - `apra-fleet secret --list` shows `FOO`.
   - From an MCP client, run `execute_command` with
     `command: "echo {{secure.FOO}}"`. Output must contain
     `[REDACTED:FOO]` and exit code 0.
   - `apra-fleet secret --update FOO --deny` sets policy=deny.
   - `execute_command` with
     `command: "curl https://example.com -H 'X: {{secure.FOO}}'"`
     returns `Blocked: credential "FOO" has network_policy=deny`.
   - `apra-fleet secret --update FOO --allow` then update to
     network_policy=confirm; retry curl: OOB terminal opens with
     `apra-fleet auth --confirm FOO`; typing `yes` allows.
   - `apra-fleet secret --delete FOO` removes it.
6. Commit: `chore(blindfold): post-migration verification` (only if
   any small follow-ups landed; otherwise no commit).

**Done when:**
- All four automated checks pass.
- Manual flow log shows every step succeeded.

---

## Out of scope (do NOT touch)

- npm publishing of blindfold. The user will publish separately.
- Renaming any MCP tool or changing tool schemas.
- Migrating existing on-disk credentials (the whole point of
  preserving `dataDir: FLEET_DIR` is no migration is needed).
- Removing the prior-sprint files at repo root (`PLAN.md`, `plan.md`,
  `progress.json`, `OVERVIEW.md`, `requirements*.md`, etc.). Those are
  untracked leftovers - leave them alone.

## Commit policy

- One commit per phase. Each commit must build and (modulo
  documented temporary regressions) test green.
- Commit message format: `<type>(<scope>): <description>` - e.g.
  `refactor(blindfold): swap security imports to blindfold package`.
- No attribution lines. No Claude / Anthropic / AI references in
  commit messages, code comments, or PR descriptions.
- Push to origin `md/project-vault` at every VERIFY checkpoint so the
  reviewer can fetch.
