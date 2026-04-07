# Implementation Plan — Extract Org-Prefix as Install-Time Configuration

Branch: `sprint/extract-org-prefix`
Base: `main`
Requirements: `requirements-extract-prefix.md`
Breaking change: YES — major version bump `0.1.x → 0.2.0`

---

## Pre-Plan Inventory (Verified Codebase State)

The reviewer ran a parallel codebase exploration. All findings verified against source:

| Finding | Location | Detail |
|---------|----------|--------|
| MCP server name registration | `src/index.ts:74-77` | `name: \`apra fleet server ${serverVersion}\`` — runtime string, **one-line change** to template with prefix |
| Tool names are prefix-free | `src/index.ts` (all `server.tool()` calls) | Registered as `list_members`, `fleet_status`, etc. The `mcp__apra-fleet__` prefix comes entirely from the server name. **R1 is LOW risk.** |
| Install name mismatch (bug) | `install.cjs:107` registers as `fleet`; `src/cli/install.ts:425-430` registers as `apra-fleet` | Two install paths produce different MCP server names. Must reconcile. |
| Hardcoded permission glob | `src/cli/install.ts:229` | `'mcp__apra-fleet__*'` — needs templating |
| Data dir + env var | `src/paths.ts:4` | `process.env.APRA_FLEET_DATA_DIR ?? path.join(homedir, '.apra-fleet', 'data')` — single line, single source of truth |
| Gemini config key | `src/cli/install.ts:261` | `settings.mcpServers['apra-fleet']` — hardcoded |
| Copilot config key | `src/cli/install.ts:285` | `settings.mcpServers['apra-fleet']` — hardcoded |
| Codex config key | `src/cli/install.ts:293` | `settings.mcp_servers['apra-fleet']` — hardcoded |
| Install shims | `install.sh`, `install.cmd`, `install.ps1` | All delegate to `node install.cjs`. Real logic in `install.cjs` + `src/cli/install.ts` only. |

### Architectural Decisions (Pre-Plan)

1. **Base name:** `fleet` — the codebase already uses this internally.
2. **npm package name:** `@apra-labs/fleet` — scoped to org, install prefix is independent.
3. **MCP server name:** Runtime-templated. Confirmed: `McpServer({ name })` accepts any string at runtime. Server name = `${prefix}fleet` (e.g., `apra-fleet`, `google-fleet`, or just `fleet`).
4. **CLI binary name:** Ship as `fleet`. The binary reads its prefix from config and self-identifies in `--version`/`--help`. npm `bin` does not support install-time templating — use a stable name with runtime prefix awareness.
5. **Prefix format:** `[a-z0-9]+`, auto-hyphen attachment. `apra` → `apra-fleet`. Empty → `fleet`.
6. **Prefix resolution order:** (1) explicit CLI flag `--prefix=`, (2) env var `FLEET_INSTALL_PREFIX`, (3) config file `~/.fleet/config.json` → `orgPrefix` key, (4) empty string default.
7. **Install-time capture:** Interactive prompt + `--prefix=` flag for CI. Written to config file on install.

---

## Phase 1 — Prefix Resolver & MCP Server Name (R1 validation)

### Task 1: Create ORG_PREFIX resolver module
- **Change:** Create `src/config/org-prefix.ts` — single source of truth for prefix resolution. Reads from: (1) env var `FLEET_ORG_PREFIX`, (2) config file at `<dataDir>/config.json`, (3) empty string default. Exports `getOrgPrefix(): string`, `getServerName(): string`, `getDataDir(): string`, `getEnvVarPrefix(): string`.
- **Files:** `src/config/org-prefix.ts` (new)
- **Tier:** cheap
- **Done when:** Module exists, exports compile, unit test passes with empty and non-empty prefix.
- **Blockers:** none

### Task 2: Template MCP server name with prefix resolver
- **Change:** Replace hardcoded `name: \`apra fleet server ${serverVersion}\`` with `name: \`${getServerName()} ${serverVersion}\`` in `src/index.ts:74-77`.
- **Files:** `src/index.ts`
- **Tier:** cheap
- **Done when:** Server starts with default (empty) prefix → name = `fleet server vX.Y.Z`. With `FLEET_ORG_PREFIX=apra` → name = `apra-fleet server vX.Y.Z`.
- **Blockers:** Task 1

### VERIFY-1: R1 smoke test
- **Check:** Start the MCP server with `FLEET_ORG_PREFIX=test`, call any tool via a downstream agent, confirm tool ID resolves as `mcp__test-fleet__<tool>`. Then start with no prefix, confirm `mcp__fleet__<tool>`.
- **Pass criteria:** Both invocations succeed. If this fails, STOP the sprint and escalate.

---

## Phase 2 — Template All Hardcoded References

### Task 3: Template data dir and env var in `src/paths.ts`
- **Change:** Replace `process.env.APRA_FLEET_DATA_DIR ?? path.join(homedir, '.apra-fleet', 'data')` with resolver-driven values: `process.env[getEnvVarPrefix() + 'FLEET_DATA_DIR'] ?? path.join(homedir, '.' + getServerName(), 'data')`.
- **Files:** `src/paths.ts`
- **Tier:** cheap
- **Done when:** With prefix `apra` → reads `APRA_FLEET_DATA_DIR`, defaults to `~/.apra-fleet/data`. With empty prefix → reads `FLEET_DATA_DIR`, defaults to `~/.fleet/data`.
- **Blockers:** Task 1

### Task 4: Reconcile install paths — unified server name
- **Change:** Both `install.cjs:107` and `src/cli/install.ts:425-430` must derive the MCP server name from the prefix resolver. Currently `install.cjs` uses `fleet` and `install.ts` uses `apra-fleet` — reconcile to `getServerName()`. Also update the Gemini (`install.ts:261`), Copilot (`:285`), and Codex (`:293`) config key references.
- **Files:** `install.cjs`, `src/cli/install.ts`
- **Tier:** medium — multiple call sites, multiple providers
- **Done when:** `grep -n "apra-fleet\|apra_fleet\|APRA_FLEET" src/cli/install.ts install.cjs` returns zero matches (except import of resolver). Both `install.cjs` and `src/cli/install.ts` register the server under the same resolver-derived name.
- **Blockers:** Task 1

### Task 5: Template permission glob in install.ts
- **Change:** Replace `'mcp__apra-fleet__*'` at `src/cli/install.ts:229` with `` `mcp__${getServerName()}__*` ``.
- **Files:** `src/cli/install.ts`
- **Tier:** cheap
- **Done when:** Permission glob matches actual server name under any prefix.
- **Blockers:** Task 1

### VERIFY-2: Full grep sweep
- **Check:** `grep -r -i "apra" src/ tests/ scripts/ hooks/ install.* --include='*.ts' --include='*.js' --include='*.cjs' --include='*.sh' --include='*.json' | grep -v node_modules | grep -v CHANGELOG | grep -v requirements-extract-prefix` returns empty (or only intentional migration/comment references).
- **Pass criteria:** Zero unexpected `apra` references in code.

---

## Phase 3 — Install Flag & Config Capture

### Task 6: Add `--prefix=` flag to install paths
- **Change:** `install.cjs` accepts `--prefix=<value>` CLI arg and writes it to `~/.fleet/config.json` (or `~/.${prefix}fleet/config.json`). `src/cli/install.ts` does the same for the `apra-fleet install` CLI path. Interactive installs prompt for prefix with empty default.
- **Files:** `install.cjs`, `src/cli/install.ts`
- **Tier:** medium
- **Done when:** `node install.cjs --prefix=test` creates `~/.test-fleet/config.json` with `{"orgPrefix": "test"}`. No-flag install creates `~/.fleet/config.json` with `{"orgPrefix": ""}`.
- **Blockers:** Tasks 3, 4

---

## Phase 4 — Tests

### Task 7: Update existing tests + add prefix coverage
- **Change:** (a) Update `tests/setup.ts` and `tests/test-helpers.ts` to use resolver instead of hardcoded `APRA_FLEET_DATA_DIR` / `apra-fleet-test-data`. (b) New test file `tests/org-prefix.test.ts` covering: resolver with empty prefix, resolver with `test` prefix, server name derivation, data dir derivation, env var prefix derivation. (c) Update any test that references `mcp__apra-fleet__*` or `~/.apra-fleet/`.
- **Files:** `tests/setup.ts`, `tests/test-helpers.ts`, `tests/org-prefix.test.ts` (new), any test files with hardcoded `apra` references
- **Tier:** medium
- **Done when:** All 394+ tests pass. New prefix tests pass with both empty and non-empty prefix.
- **Blockers:** Tasks 1-5

### VERIFY-3: Full test suite
- **Check:** `npm test` — all tests pass.
- **Pass criteria:** Zero failures, zero skips that weren't already skipped.

---

## Phase 5 — Docs, Version Bump, Changelog

### Task 8: Update docs and README
- **Change:** Rewrite `README.md`, `CONTRIBUTING.md`, `docs/user-guide.md`, and all `docs/*.md` to use `fleet` as the canonical example, with notes showing how `--prefix=apra` produces `apra-fleet` behavior. Remove or template all `apra-fleet` references.
- **Files:** `README.md`, `CONTRIBUTING.md`, `docs/*.md`
- **Tier:** medium — high volume, mechanical
- **Done when:** `grep -r -i "apra" docs/ README.md CONTRIBUTING.md | grep -v CHANGELOG | grep -v requirements` returns zero matches (or only intentional references explaining the prefix feature).
- **Blockers:** none (can start in parallel with Phase 2-3)

### Task 9: Major version bump + CHANGELOG
- **Change:** Bump `package.json` version `0.1.3 → 0.2.0`. Update `CHANGELOG.md` with breaking change entry documenting: what changed, upgrade procedure (`reinstall with --prefix=apra`), rationale, and explicit callout that external skill files in `~/.claude/skills/` need a separate update.
- **Files:** `package.json`, `CHANGELOG.md`
- **Tier:** cheap
- **Done when:** `node -e "console.log(require('./package.json').version)"` outputs `0.2.0`. CHANGELOG entry exists with all required sections.
- **Blockers:** Tasks 1-7 complete

### Task 10: Update npm package name
- **Change:** Rename `package.json` `name` from `apra-fleet` to `@apra-labs/fleet`. Update any internal references to the package name.
- **Files:** `package.json`
- **Tier:** cheap
- **Done when:** `node -e "console.log(require('./package.json').name)"` outputs `@apra-labs/fleet`.
- **Blockers:** none

### VERIFY-4: Final acceptance
- **Check:** Run full acceptance criteria from requirements:
  1. `grep -r -i "apra" src/ tests/ scripts/ hooks/ install.*` → empty (excluding CHANGELOG/migration)
  2. Fresh install with no prefix → `fleet` CLI, `~/.fleet/`, `mcp__fleet__list_members`
  3. Fresh install with `--prefix=test` → `test-fleet` CLI, `~/.test-fleet/`, `mcp__test-fleet__list_members`
  4. Fresh install with `--prefix=apra` → reproduces current behavior
  5. All tests pass
  6. Version = `0.2.0`
- **Pass criteria:** All 6 checks pass.

---

## Risk Register

| ID | Severity | Risk | Mitigation | Status |
|----|----------|------|------------|--------|
| **R1** | **LOW** | MCP framework may not allow runtime-templated server names | **Confirmed LOW** — `src/index.ts:74-77` passes a template string to `McpServer({ name })` at runtime. Tool names are prefix-free (`server.tool('list_members', ...)`). The `mcp__<server-name>__<tool>` ID is derived entirely from the server name. One-line change. Still validate end-to-end in VERIFY-1. | Pre-flight confirmed |
| **R2** | MEDIUM | npm `bin` does not support install-time-templated binary names | Ship stable `fleet` binary. Self-identifies via prefix in `--version`/`--help`. No dynamic binary renaming needed. | Decision made |
| **R3** | LOW | Dev box has live state in `~/.apra-fleet/` | Document manual `mv ~/.apra-fleet ~/.fleet` (or `~/.${prefix}fleet`) in CHANGELOG. No migration tooling — single known user, manual reinstall acceptable. | Decision made |
| **R4** | MEDIUM | Hidden `apra` references outside `src/` | VERIFY-2 runs a full `grep -r -i "apra"` sweep across all non-vendor files. Task 4 covers install scripts explicitly. Task 8 covers docs. | Mitigated by verify steps |
| **R5** | LOW | Documentation churn — high volume, easy to miss | Task 8 has explicit `grep` verification in done criteria. | Mitigated |
| **R6** | LOW | External skill files (`~/.claude/skills/{pm,fleet}/`) break silently | Out of scope. CHANGELOG callout + PR description. Follow-up PR in user's `.claude` repo. | Accepted — out of scope |

---

## Notes

- The install name mismatch (`fleet` in `install.cjs` vs `apra-fleet` in `install.ts`) is a pre-existing bug. Task 4 fixes it as part of the unification.
- The `legacy-dir-migration` logic in `src/services/registry.ts` (which handles `~/.claude-fleet/` → `~/.apra-fleet/`) should be removed entirely in this sprint — it references a name that predates the current one and will never be relevant again.
- Task ordering is designed so R1 is validated before any bulk work begins (VERIFY-1 gates Phase 2+).
- Tasks 8 and 10 have no code dependencies and can be worked in parallel with Phase 2-3 if desired.
