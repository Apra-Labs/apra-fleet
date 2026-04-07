# extract-org-prefix — Implementation Plan

> Extract the hardcoded `apra-` brand prefix from the fleet codebase and make it an install-time configuration value. After this sprint, any organization can install fleet under their own prefix (`apra-fleet`, `google-fleet`, or bare `fleet`). The codebase ships prefix-less; the installer captures the org's chosen prefix and bakes it into the MCP server registration key, tool IDs, data directory, env var prefix, CLI binary name, and all user-facing strings. This is a deliberate hard break with a major version bump — no backwards-compat shims.

---

## Pre-Plan Inventory

### Reference Counts

| Scope | `apra` hits | Files touched |
|-------|-------------|---------------|
| `src/` | 33 lines | 11 files |
| `tests/` | 20 lines | 8 files |
| `scripts/` | 5 lines | 3 files |
| `hooks/` | 3 lines | 2 files |
| `docs/` + `README.md` | 96 lines | ~15 files |
| `install.*` (root) | 5 lines | 4 files |
| Config (`.mcp.json`, `package.json`) | 2 files | 2 files |
| **Total** | **~164 lines** | **~45 files** |

`APRA_FLEET` env var references (5 locations):
- `src/paths.ts:4` — primary consumer
- `tests/setup.ts:4` — test env setup
- `tests/test-helpers.ts:10` — test helper
- `tests/crypto.test.ts:8` — test data dir
- `scripts/fleet-statusline.sh:11` — statusline file path

### MCP Server Registration — How Tool IDs Are Derived

**Critical finding:** MCP tool IDs (`mcp__apra-fleet__list_members`) are **NOT** derived from the server's `name` field. They come from the **client-side registration key** — the key used in the client's MCP config (e.g., `settings.mcpServers['apra-fleet']`) or the name passed to `claude mcp add <name>`.

Server name declaration (`src/index.ts:74-76`):
```typescript
const server = new McpServer({
  name: `apra fleet server ${serverVersion}`,  // cosmetic display name
  version: versionNum,
});
```
The `McpServer` constructor takes `Implementation` (`{name, version}`) which is used in the MCP `initialize` handshake — it identifies the server to the client but does NOT affect tool ID namespacing.

Client-side registration key (controls tool IDs):
- `src/cli/install.ts:261` — `settings.mcpServers['apra-fleet'] = {...}` (Gemini)
- `src/cli/install.ts:285` — `settings.mcpServers['apra-fleet'] = mcpConfig` (Copilot)
- `src/cli/install.ts:293` — `settings.mcp_servers['apra-fleet'] = {...}` (Codex)
- `src/cli/install.ts:429-430` — `claude mcp add --scope user apra-fleet -- ...` (Claude)
- `.mcp.json:3` — `"apra-fleet": {...}` (dev mode)

**R1 conclusion:** The installer fully controls the tool ID namespace by choosing the registration key. Changing the key from `apra-fleet` to `${prefix}-fleet` (or `fleet` for empty prefix) is a straightforward string substitution in the installer. **R1 is architecturally solvable.** Task 1 will validate this end-to-end.

### Inconsistency Found

The tarball installer (`install.cjs:107`) registers the MCP server as `fleet`:
```javascript
run(`claude mcp add --scope user fleet -- node "${indexJs}"`);
```
While the built-in installer (`src/cli/install.ts:429`) registers as `apra-fleet`:
```typescript
`claude mcp add --scope user apra-fleet -- node "${mcpConfig.args[0]}"`
```
This existing inconsistency means tool IDs currently differ between install methods. This sprint will unify them.

### Env Var Flow

Primary data dir resolution (`src/paths.ts:4`):
```typescript
export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');
```
This is the **single import point** — all other files import `FLEET_DIR` from here. Consumers: `registry.ts`, `auth-socket.ts`, `known-hosts.ts`, `crypto.ts`, `git-config.ts`, `statusline.ts`, and many tools.

`FLEET_PASSWORD` env var (`tests/integration.test.ts:86,151`): used in integration tests only, not prefixed with `APRA_`.

### Data Dir Resolution

Two-level structure:
- **Base dir:** `~/.apra-fleet/` — holds `bin/`, `hooks/`, `scripts/`, `data/` (`src/cli/install.ts:10`)
- **Data dir:** `~/.apra-fleet/data/` — holds member state, keys, salt, auth socket, statusline (`src/paths.ts:4`)

After refactor: `~/.${prefix}-fleet/` (base) and `~/.${prefix}-fleet/data/` (data). Empty prefix → `~/.fleet/` and `~/.fleet/data/`.

### Install Scripts Audit

| Script | Role | Prefix-sensitive locations |
|--------|------|---------------------------|
| `install.sh` (2 lines) | Shell wrapper → delegates to `install.cjs` | Pass-through only |
| `install.cjs` (121 lines) | Tarball installer: copies dist, installs deps, copies PM skill, hooks, statusline, registers MCP | Lines 9,31,36,101-107,115: install dir path, display string, MCP name |
| `install.cmd` (2 lines) | Polyglot wrapper → `install.cjs` | Pass-through only |
| `install.ps1` (1 line) | PowerShell wrapper → `install.cjs` | Pass-through only |
| `src/cli/install.ts` (495 lines) | Built-in installer (SEA + dev): binary copy, hooks, scripts, statusline, MCP registration, skills, permissions | Lines 10,229,261,285,293,361,368,425,429,430,487: FLEET_BASE, permissions glob, MCP keys, binary name, display strings |

### Package.json

- **Name:** `apra-fleet`
- **Version:** `0.1.3` (semver, pre-1.0)
- **No `bin` field** — binary built via SEA process (`scripts/package-sea.mjs`)
- **Major bump:** `0.1.3` → `0.2.0` (pre-1.0 convention: minor = breaking)

### SEA Binary Naming

- `scripts/package-sea.mjs:30` — `apra-fleet-${platform}-${arch}` (hardcoded)
- `src/cli/install.ts:368` — `apra-fleet.exe` / `apra-fleet` (hardcoded at install time)
- `scripts/gen-ico.mjs:25` — `assets/icons/apra-fleet.ico` (hardcoded)

### Intentional `apra` References to Keep

These are NOT brand references and should remain unchanged:
- `src/tools/register-member.ts:37` — `'AWS CLI profile name (e.g. "apra")'` (example value)
- `tests/cloud-provider.test.ts:35,76,206,214` — `profile: 'apra'` (AWS profile test data)
- `tests/cloud-lifecycle-unit.test.ts:134,147,168` — `gitRepos: ['Apra-Labs/apra-fleet']` (GitHub repo URL — repo rename is out of scope)
- `package.json` → `homepage`, `repository`, `bugs` URLs (repo rename out of scope)
- `CHANGELOG.md` (new) — historical references
- `src/services/registry.ts:51` — legacy migration log from `~/.claude-fleet/` (update target path only)

### Test Status

- **40 test files, 602 passing, 3 skipped, 1 file failing** (`tests/install-multi-provider.test.ts`)
- Note: requirements reference "394 tests" — actual count is 602 (requirements stale on this number)
- Pre-existing failing test in `install-multi-provider.test.ts` should be investigated in Task 7

### Verified Assumptions

| # | Assumption | Verified? | Evidence |
|---|-----------|-----------|----------|
| 1 | Tool IDs come from client registration key, not server name | Yes | `McpServer({name})` is cosmetic; `settings.mcpServers[KEY]` determines namespace |
| 2 | `src/paths.ts` is the single source of truth for data dir | Yes | All files import `FLEET_DIR` from `paths.ts` |
| 3 | No `bin` field in package.json — binary via SEA only | Yes | Checked package.json; binary naming in `scripts/package-sea.mjs` |
| 4 | Install scripts are wrappers around `install.cjs` | Yes | `install.sh`, `.cmd`, `.ps1` all just call `install.cjs` |
| 5 | MCP config supports env vars per server | Yes | `.mcp.json` has `"env": {"NODE_ENV": "development"}` |
| 6 | No CHANGELOG.md exists yet | Yes | `ls CHANGELOG.md` → not found |
| 7 | `install.cjs` and `src/cli/install.ts` have inconsistent MCP registration names | Yes | `fleet` vs `apra-fleet` |

### Architectural Decisions

**Q1: Base name** → `fleet`. Already the internal convention (`FLEET_DIR`, `fleet_status`, `FLEET_PASSWORD`).

**Q2: npm package name** → `@apra-labs/fleet`. Scoped to the publishing org; the install-time prefix is independent.

**Q3: MCP server name** → Tool IDs are client-side. The installer writes the registration key as `${prefix}-fleet` (or `fleet`). The server's cosmetic `name` field becomes `${prefix}-fleet server ${version}` (or `fleet server ${version}`). R1 validated architecturally — Task 1 confirms end-to-end.

**Q4: CLI binary name** → SEA binary built as `fleet-{platform}-{arch}`. At install time, copied to `~/.${prefix}-fleet/bin/${prefix}-fleet` (or `~/.fleet/bin/fleet`). For dev mode (non-SEA): the binary is `node dist/index.js`, invoked via CLI dispatch — no binary name needed.

**Q5: Prefix constraints** → `^[a-z0-9]*$` (empty allowed), max 20 chars. Attachment: automatic hyphen separator when prefix is non-empty. `apra` → `apra-fleet`. Empty → `fleet`.

**Q6: Install-time UX** → `--prefix=<value>` flag (non-interactive + CI), `FLEET_INSTALL_PREFIX` env var (CI shorthand). `install.cjs` prompts interactively when neither is given: "Enter org prefix (leave blank for none):". `src/cli/install.ts` accepts the same `--prefix=` flag.

**Q7: ORG_PREFIX resolution order (runtime):**
1. `FLEET_ORG_PREFIX` env var (set by installer in MCP config env block)
2. `~/.fleet/org-prefix` file (single line, written at install time — fixed path, prefix-independent)
3. Empty string default

The installer writes the prefix to both the MCP env block AND the `~/.fleet/org-prefix` file. The env var is the fast path for the MCP server (always set). The file is the fallback for scripts (statusline, hooks) and manual invocations.

---

## Tasks

### Phase 1: Risk Validation & Core Abstraction

#### Task 1: Validate R1 — MCP tool ID namespacing is client-controlled
- **Change:** Write an end-to-end validation test that:
  1. Creates an `McpServer` with an arbitrary `name` field (e.g., `"test-server-xyz"`)
  2. Registers a tool on it
  3. Connects a test `Client` to the server via in-process transport
  4. Calls `client.listTools()` and verifies tool names are exactly as declared (no server name embedded)
  5. Documents the finding: tool ID namespace = f(client registration key), NOT f(server name)
  
  Additionally, verify empirically by temporarily re-registering the live MCP server under `test-fleet` and confirming Claude Code exposes tools as `mcp__test-fleet__*`.
- **Files:** `tests/r1-tool-id-namespace.test.ts` (new)
- **Tier:** premium
- **Done when:** Test passes. Written comment in test documents that tool ID namespacing is a client-side convention (`mcp__<registration_key>__<tool_name>`). If R1 fails → STOP sprint, escalate.
- **Blockers:** If MCP SDK or Claude Code embeds the server's declared `name` into tool IDs (contradicts code review findings), the entire approach needs rethinking.

#### Task 2: Create ORG_PREFIX resolver — single source of truth
- **Change:** New module `src/config.ts` exports:
  - `resolveOrgPrefix()` — reads from: (1) `FLEET_ORG_PREFIX` env var, (2) `~/.fleet/org-prefix` file, (3) empty string default
  - `getServerName(prefix)` → `${prefix}-fleet` or `fleet` — the MCP registration key and cosmetic name base
  - `getDataDir(prefix)` → `~/.${prefix}-fleet/data` or `~/.fleet/data`
  - `getBaseDir(prefix)` → `~/.${prefix}-fleet` or `~/.fleet`
  - `getEnvVarPrefix(prefix)` → `${PREFIX}_FLEET` or `FLEET`
  - `getBinaryName(prefix)` → `${prefix}-fleet` or `fleet`
  - `getPipeName(prefix, username)` → `${prefix}-fleet-auth-${user}` or `fleet-auth-${user}`
  - `getMcpPermissionGlob(prefix)` → `mcp__${prefix}-fleet__*` or `mcp__fleet__*`
  - Prefix validation: must match `^[a-z0-9]*$`, max 20 chars, reject otherwise
  - All derived values auto-insert hyphen between prefix and `fleet` when prefix is non-empty
  - Unit tests for every resolution path and every derived value
- **Files:** `src/config.ts` (new), `tests/config.test.ts` (new)
- **Tier:** standard
- **Done when:** Unit tests pass for: empty prefix, `apra` prefix, `test` prefix, env var override, file fallback, validation rejection of invalid prefixes. Importing the module in existing files compiles without errors.
- **Blockers:** None — this is a pure addition, no existing code modified.

#### VERIFY: Phase 1 — Foundations
- Run full test suite — all 602+ existing tests still pass
- R1 validation test passes with documented evidence
- `src/config.ts` exists with tested resolver
- No existing source files modified yet (Tasks 1-2 are additive only)
- Report: tests passing, regressions, issues found

---

### Phase 2: Source De-branding

#### Task 3: Refactor paths.ts and all non-installer src/ files to use resolver
- **Change:** Replace all hardcoded `apra-fleet` strings in `src/` (except `src/cli/install.ts`, handled in Task 4) with calls to the resolver from Task 2:
  - `src/paths.ts:4` — `FLEET_DIR` uses `getDataDir(resolveOrgPrefix())` instead of hardcoded env var and path
  - `src/index.ts:9,14-24,75,107` — CLI help text and server name use `getBinaryName()` and `getServerName()`
  - `src/cli/auth.ts:72,78,81,134` — usage and error messages use `getBinaryName()`
  - `src/services/auth-socket.ts:33` — Windows pipe name uses `getPipeName()`
  - `src/services/auth-socket.ts:345` — comment updated
  - `src/services/registry.ts:51` — migration log target path uses `getDataDir()`
  - `src/services/known-hosts.ts:19` — error message uses `getDataDir()`
  - `src/utils/crypto.ts:16,36` — comment and machine ID use resolver
  - `src/tools/version.ts:7` — version string uses `getBinaryName()`
  - `src/tools/setup-ssh-key.ts:81` — SSH key comment uses `getBinaryName()`
- **Files:** `src/paths.ts`, `src/index.ts`, `src/cli/auth.ts`, `src/services/auth-socket.ts`, `src/services/registry.ts`, `src/services/known-hosts.ts`, `src/utils/crypto.ts`, `src/tools/version.ts`, `src/tools/setup-ssh-key.ts`
- **Tier:** standard
- **Done when:** `grep -rn "apra" src/ | grep -v install.ts | grep -v register-member.ts` returns empty. All existing tests pass (test setup may need temp env var adjustment — set `FLEET_ORG_PREFIX=apra` in test env to maintain current paths during transition).
- **Blockers:** Task 2 must be complete (resolver exists).

#### Task 4: Refactor installer to accept --prefix and template MCP registrations
- **Change:** Modify `src/cli/install.ts` to:
  1. Parse `--prefix=<value>` flag (alongside existing `--llm=` and `--skill` flags)
  2. Validate prefix with resolver's validation function
  3. Write prefix to `~/.fleet/org-prefix` file (fixed location, prefix-independent bootstrap)
  4. Template `FLEET_BASE` path: `~/.${prefix}-fleet/` or `~/.fleet/`
  5. Template all MCP registration keys: `settings.mcpServers['apra-fleet']` → `settings.mcpServers[getServerName(prefix)]`
  6. Template `claude mcp add` command: use `getServerName(prefix)` instead of `'apra-fleet'`
  7. Template permissions glob: `mcp__apra-fleet__*` → `getMcpPermissionGlob(prefix)`
  8. Template binary name: `'apra-fleet'` → `getBinaryName(prefix)`
  9. Add `FLEET_ORG_PREFIX` to the MCP config env block for all providers
  10. Template display strings: `'Installing Apra Fleet...'` → `'Installing ${getServerName(prefix)}...'`
  11. Before MCP add for Claude: `claude mcp remove` uses old `apra-fleet` AND new name (safe cleanup)
- **Files:** `src/cli/install.ts`
- **Tier:** standard
- **Done when:** `apra-fleet install --prefix=test --llm=claude` registers MCP as `test-fleet` with `FLEET_ORG_PREFIX=test` in env. `apra-fleet install` (no prefix) registers as `fleet`. `grep -n "apra" src/cli/install.ts` returns only intentional references (if any).
- **Blockers:** Task 2 (resolver), Task 3 (paths.ts refactored).

#### VERIFY: Phase 2 — Source De-branding
- Run full test suite — all tests pass
- `grep -rn "apra" src/` returns only intentional references:
  - `register-member.ts:37` (AWS profile example)
  - `registry.ts` (legacy migration — may retain historical path in message)
- MCP server starts and registers tools correctly with default (empty) prefix
- Built-in installer accepts `--prefix` flag (dry-run test)
- Report: tests passing, regressions, issues found

---

### Phase 3: Install Scripts & External Config

#### Task 5: Template install.cjs and shell wrappers
- **Change:**
  - `install.cjs`:
    1. Parse `--prefix=<value>` from argv (also check `FLEET_INSTALL_PREFIX` env var)
    2. If neither given, prompt interactively: `"Enter org prefix (leave blank for none): "`
    3. Validate prefix (alphanumeric, max 20 chars)
    4. Compute `installDir` as `~/.${prefix}-fleet/` or `~/.fleet/`
    5. Write prefix to `~/.fleet/org-prefix`
    6. Template MCP registration: `claude mcp add --scope user ${serverName} -- ...`
    7. Template display strings
    8. Fix existing inconsistency (currently registers as `fleet` while using `~/.apra-fleet/` dir)
  - `install.sh`: Pass through `$@` (no change needed — install.cjs handles everything)
  - `install.cmd`, `install.ps1`: Same pass-through (no change needed)
- **Files:** `install.cjs`, `install.sh` (verify no change needed), `install.cmd`, `install.ps1`
- **Tier:** standard
- **Done when:** `node install.cjs --prefix=test` creates `~/.test-fleet/`, registers `test-fleet` MCP. `node install.cjs` (interactive, enter blank) creates `~/.fleet/`, registers `fleet` MCP. Shell wrappers pass `--prefix` through correctly.
- **Blockers:** None (standalone script, doesn't depend on src/ resolver).

#### Task 6: Template hooks, statusline, .mcp.json, and SEA build scripts
- **Change:**
  - `hooks/hooks-config.json`: The installer must write this config dynamically (matcher: `mcp__${serverName}__register_member`, command path: `~/.${prefix}-fleet/hooks/...`). Convert from static JSON to installer-generated. Or: keep static with `fleet` (no prefix) and let the installer rewrite the matcher at install time.
  - `scripts/fleet-statusline.sh`: Change env var from `APRA_FLEET_DATA_DIR` to read `~/.fleet/org-prefix`, compute data dir path dynamically. Fallback: `FLEET_DATA_DIR` env var → `~/.fleet/data/`.
  - `hooks/post-register-member.sh:2`: Update comment
  - `.mcp.json`: Change key from `apra-fleet` to `fleet` (dev mode uses empty prefix by default)
  - `scripts/package-sea.mjs:30`: Binary name from `apra-fleet-${platform}` to `fleet-${platform}` (SEA builds ship prefix-less; installer renames at install time)
  - `scripts/gen-ico.mjs:25`: Output path from `apra-fleet.ico` to `fleet.ico`
- **Files:** `hooks/hooks-config.json`, `scripts/fleet-statusline.sh`, `hooks/post-register-member.sh`, `.mcp.json`, `scripts/package-sea.mjs`, `scripts/gen-ico.mjs`
- **Tier:** cheap
- **Done when:** All scripts and config files reference `fleet` (no prefix) by default. Statusline script reads org prefix dynamically. SEA build produces `fleet-linux-x64` etc.
- **Blockers:** None.

#### VERIFY: Phase 3 — Install Scripts
- Run full test suite
- `install.cjs --prefix=test` creates correct directory structure and MCP registration
- Statusline script reads correct data dir for both prefixed and non-prefixed installs
- `.mcp.json` uses `fleet` key (dev mode works)
- SEA build script generates correctly-named binary
- Hook config matcher uses unprefixed `fleet` (installer templates at install time)
- Report: tests passing, regressions, issues found

---

### Phase 4: Test Suite Update

#### Task 7: Update test assertions and add prefix-specific tests
- **Change:**
  - Update hardcoded `apra-fleet` strings in test assertions:
    - `tests/setup.ts:4` — env var name: `APRA_FLEET_DATA_DIR` → set `FLEET_ORG_PREFIX` and use new resolver-based env name
    - `tests/test-helpers.ts:10` — same
    - `tests/crypto.test.ts:8` — data dir path
    - `tests/install-multi-provider.test.ts` — all `apra-fleet` MCP key assertions (~8 locations)
    - `tests/auth-socket.test.ts:26` — pipe name assertion
    - `tests/git-config.test.ts:62` — key path
  - Investigate and fix pre-existing failure in `install-multi-provider.test.ts`
  - Add new tests:
    - Prefix resolver: env var override, file fallback, empty default, validation
    - Install with prefix: MCP registration key, data dir, binary name
    - Statusline with prefix: correct file path
    - MCP server start with prefix: server name correct
  - Intentional keeps (no changes needed):
    - `cloud-lifecycle-unit.test.ts` — `Apra-Labs/apra-fleet` is a GitHub repo URL
    - `cloud-provider.test.ts` — `profile: 'apra'` is AWS test data
- **Files:** `tests/setup.ts`, `tests/test-helpers.ts`, `tests/crypto.test.ts`, `tests/install-multi-provider.test.ts`, `tests/auth-socket.test.ts`, `tests/git-config.test.ts`, new test file(s)
- **Tier:** standard
- **Done when:** Full test suite passes (602+ existing + new prefix tests). `grep -rn "apra-fleet" tests/ | grep -v cloud-lifecycle | grep -v cloud-provider` returns empty (only intentional keeps remain).
- **Blockers:** Tasks 3-4 must be complete (source files refactored).

#### VERIFY: Phase 4 — Tests
- Full test suite passes with zero failures
- New prefix-specific tests cover all acceptance criteria test scenarios
- Pre-existing `install-multi-provider.test.ts` failure resolved
- Report: total test count, new tests added, regressions fixed

---

### Phase 5: Docs, Package & Migration

#### Task 8: Package rename, version bump, and CHANGELOG
- **Change:**
  - `package.json`:
    - `name`: `apra-fleet` → `@apra-labs/fleet`
    - `version`: `0.1.3` → `0.2.0`
    - `description`: remove "Apra" branding, make generic
    - `bin` field: add `"fleet": "dist/index.js"` (for npm global install path)
  - `version.json`: `0.1.3` → `0.2.0`
  - `package-lock.json`: regenerate after name change (`npm install`)
  - Create `CHANGELOG.md`:
    - `## 0.2.0 — BREAKING` section
    - Document: the breaking change, upgrade procedure (`install.sh --prefix=apra` to keep old behavior), rationale
    - Note: "External skill files in `~/.claude/skills/{pm,fleet}/` reference `mcp__apra-fleet__*` tool IDs and will need a separate update"
    - List all renamed artifacts: env vars, data dir, binary name, MCP key
- **Files:** `package.json`, `version.json`, `package-lock.json`, `CHANGELOG.md` (new)
- **Tier:** cheap
- **Done when:** `npm version` shows `0.2.0`. CHANGELOG documents all breaking changes and upgrade procedure.
- **Blockers:** None (can run any time after Phase 2).

#### Task 9: De-brand README.md and docs/
- **Change:**
  - `README.md`: Rewrite to use `fleet` (no prefix) as the canonical example. Add "Custom Prefix" section showing `--prefix=apra` usage. Keep `Apra Labs` in credits/authorship.
  - `docs/*.md` (~15 files, 94 references): Replace `apra-fleet` with `fleet` in all examples, commands, and descriptions. Replace `~/.apra-fleet/` with `~/.fleet/`. Replace `APRA_FLEET_*` with `FLEET_*` env vars. Keep `Apra-Labs/apra-fleet` repo URLs (repo rename out of scope).
  - Use one canonical convention: bare `fleet` for all examples, with a note that prefixed installs use `<prefix>-fleet`.
- **Files:** `README.md`, `docs/architecture.md`, `docs/user-guide.md`, `docs/tools-*.md`, `docs/SECURITY-REVIEW.md`, `docs/design-*.md`, `docs/ssh-setup.md`, `docs/cloud-compute.md`, `docs/requirements/*.md`, `deploy.md`
- **Tier:** cheap
- **Done when:** `grep -r "apra-fleet" docs/ README.md deploy.md | grep -v "Apra-Labs/apra-fleet" | grep -v CHANGELOG` returns empty. Docs are coherent for both prefixed and non-prefixed installs.
- **Blockers:** None.

#### Task 10: Dev box migration helper
- **Change:** Add a migration check to the installer (`src/cli/install.ts` and `install.cjs`):
  1. If `--prefix=<X>` is given and `~/.apra-fleet/` exists (old hardcoded path) and `~/.${X}-fleet/` does not exist:
     - Print: `"Found existing data at ~/.apra-fleet/. Copy to ~/.${X}-fleet/? [Y/n]"`
     - If yes: copy `~/.apra-fleet/data/` → `~/.${X}-fleet/data/`
     - If no: skip (user will start fresh)
  2. Non-interactive mode (`FLEET_INSTALL_PREFIX` env var): skip migration prompt, just warn
  3. Also handles: `~/.apra-fleet/` → `~/.fleet/` migration (when no prefix given but old dir exists)
- **Files:** `src/cli/install.ts`, `install.cjs`
- **Tier:** standard
- **Done when:** `install.sh --prefix=apra` on a box with `~/.apra-fleet/` detects existing data, prompts, and copies. `install.sh` (no prefix) on a box with `~/.apra-fleet/` warns about orphaned data. Fresh box: no prompt.
- **Blockers:** Tasks 4, 5 (installers already refactored for prefix).

#### VERIFY: Phase 5 — Docs & Migration
- Full test suite passes
- `package.json` shows `@apra-labs/fleet@0.2.0`
- CHANGELOG is complete and accurate
- README and docs are coherent
- Migration helper works for dev box scenario
- `grep -r -i "apra" src/ tests/ scripts/ hooks/ install.*` returns only intentional references
- Report: tests passing, final grep audit, issues found

---

### Phase 6: Final Acceptance

#### Task 11: Final acceptance validation
- **Change:** Run the complete acceptance criteria checklist:
  1. `grep -r -i "apra" src/ tests/ scripts/ hooks/ install.*` → only intentional references (with explicit comments)
  2. Fresh install with no prefix → `fleet` binary, `~/.fleet/` data dir, `mcp__fleet__list_members` etc.
  3. Fresh install with `--prefix=test` → `test-fleet` binary, `~/.test-fleet/` data dir, `mcp__test-fleet__list_members` etc.
  4. Fresh install with `--prefix=apra` → reproduces current behavior: `apra-fleet`, `~/.apra-fleet/`, `mcp__apra-fleet__list_members`
  5. All tests pass (602+)
  6. New tests cover: ORG_PREFIX resolver, prefix-templated MCP server name, prefix-templated data dir, prefix-templated env vars, install script flag handling
  7. R1 validated end-to-end in Task 1
  8. `package.json` version bumped to `0.2.0`
  9. CHANGELOG documents breaking change and upgrade procedure
  10. README and docs coherent for both modes
  11. PR description drafted with breaking change callout
- **Files:** No source changes — validation and PR prep only
- **Tier:** standard
- **Done when:** All 11 acceptance criteria pass. PR description written. Ready to merge.
- **Blockers:** All previous tasks complete.

#### VERIFY: Phase 6 — Final
- All acceptance criteria from requirements doc are met
- PR is ready for review
- No open blockers
- Report: final status, any caveats for reviewer

---

## Risk Register

| ID | Severity | Risk | Mitigation | Validated In |
|----|----------|------|------------|--------------|
| R1 | **HIGH** | The MCP framework may not allow runtime-templated server names / tool ID namespacing may not follow the client registration key. | Code review shows tool IDs = f(registration key), not f(server name). Task 1 validates end-to-end with MCP client/server test. If it fails → STOP sprint, escalate. | Task 1 |
| R2 | MEDIUM | npm `bin` field may not support install-time-templated binary names. | SEA binary is renamed at install time (no npm `bin` dependency). For npm installs: ship a stable `fleet` binary that reads prefix at runtime. A `bin` entry pointing to `dist/index.js` gives `fleet` as the global command. | Task 4 |
| R3 | MEDIUM | Dev box has live state in `~/.apra-fleet/` — hard break loses it. | Task 10 adds a one-shot migration helper that detects `~/.apra-fleet/` and offers to copy to the new location. | Task 10 |
| R4 | MEDIUM | Hidden `apra-fleet` references outside `src/` — CI workflows, hooks, scripts, snapshot tests, fixture data. | PHASE 0 inventory identified all ~45 files. Each phase has a grep-based VERIFY checkpoint. Final acceptance (Task 11) runs the full audit. | Task 11 |
| R5 | LOW | Documentation churn — every example needs rewriting. High volume, easy to miss. | Task 9 is dedicated to docs with explicit grep verification in "done" criteria. | Task 9 |
| R6 | LOW | External skill files (`~/.claude/skills/{pm,fleet}/`) reference `mcp__apra-fleet__*` tool IDs — will break after this PR. | Out of scope. CHANGELOG (Task 8) and PR description (Task 11) explicitly call this out. Follow-up PR in user's `.claude` repo. | Task 8 |

## Notes
- Each task results in a git commit
- VERIFY tasks are checkpoints — STOP and report after each one
- Base branch: main
- Sprint branch: sprint/extract-org-prefix
- Test baseline: 602 passing, 3 skipped, 1 file failing (pre-existing in install-multi-provider.test.ts)
- The `register-member.ts` AWS profile example (`"apra"`) and `cloud-lifecycle-unit.test.ts` GitHub repo URLs (`Apra-Labs/apra-fleet`) are intentional keeps — not brand references
- `package.json` repo/homepage/bugs URLs (`github.com/Apra-Labs/apra-fleet`) stay unchanged — repo rename is out of scope
