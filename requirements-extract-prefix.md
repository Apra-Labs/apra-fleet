# Requirements — EXTRACT-PREFIX  Extract org-prefix as install-time configuration

## Base Branch
`main` — branch to fork from and merge back to. Sprint branch: `sprint/extract-org-prefix`.

## Goal

Pull the hardcoded `apra-` brand prefix out of the codebase and make it an **install-time configuration value**, so any organization can install fleet under their own prefix (`apra-fleet`, `google-fleet`, or just `fleet`). The codebase ships prefix-less; the installer captures the org's chosen prefix and bakes it into the MCP server name, tool IDs, data directory, env var prefix, and CLI binary name.

This is a deliberate **hard break** with a major version bump — there are no public users today, so this is the cheapest moment to do it.

## Scope

In scope for this PR:

1. **Source code de-branding** — every hardcoded `apra-fleet`, `apra_fleet`, `APRA_FLEET`, and bare `apra` brand reference in `src/`, `tests/`, `scripts/`, `hooks/`, `install.*` is removed and replaced with a single source-of-truth config value (working name: `ORG_PREFIX`, base name: `fleet`).
2. **Templated MCP server name** — the MCP server registers itself as `${prefix}fleet` (or just `fleet` when prefix is empty), so tool IDs auto-namespace as `mcp__${prefix}fleet__list_members`, etc. **This is the highest-risk piece — validate in Task 1.**
3. **Templated data directory** — `~/.${prefix}fleet/` (or `~/.fleet/` when no prefix). All file paths, lock files, ledger writes, and member state read this from the resolved config.
4. **Templated env vars** — `${PREFIX}FLEET_*` (e.g., `APRA_FLEET_DATA_DIR` → `${PREFIX}FLEET_DATA_DIR`, defaulting to `FLEET_DATA_DIR` when no prefix).
5. **Templated CLI binary name** — `package.json` `bin` entry produces a binary named `${prefix}fleet` (or `fleet`). The planner should investigate whether npm `bin` supports a templated/install-time-determined name; if not, propose an indirection (a stable `fleet` binary that reads its prefix from local config and self-identifies in help/version output).
6. **Install scripts** — `install.sh`, `install.cmd`, `install.ps1`, `install.cjs` accept the prefix as a flag (`--prefix=apra`) and as a prompt for interactive installs. CI/non-interactive installs must support the flag form.
7. **npm package name decision** — the planner picks one strategy and documents it. Default recommendation: `@apra-labs/fleet` (scoped to the publishing org; the *installation* prefix is independent of the *package* name). Reject keeping `apra-fleet` as the npm name — defeats the purpose.
8. **Tests** — every existing test continues to pass with sensible test-runner defaults (likely empty prefix or a fixed test prefix). New tests cover: prefix templating logic, install-time capture, MCP server tool registration with a non-empty prefix, data dir resolution.
9. **Docs** — `README.md`, `CONTRIBUTING.md`, `docs/`, examples, and the install README are rewritten so they make sense for both no-prefix users (`fleet status`) and prefixed users (`apra-fleet status`). Pick one canonical convention for examples and apply it consistently.
10. **CHANGELOG + version bump** — major version bump per the project's versioning convention (e.g., `0.1.x → 0.2.0`). CHANGELOG entry documents the breaking change and reinstall instructions.

## Out of Scope

- **GitHub repo rename** — `Apra-Labs/apra-fleet` stays put. Renaming the repo requires separate coordination (redirects, CI, downstream URLs); not part of this PR.
- **Backwards-compat aliases** — no `apra-fleet` shim that proxies to the new names. Users on the old install must reinstall after upgrading. Aliases would double the surface area we have to maintain and contradict the hard-break decision.
- **Migration of `~/.apra-fleet/` for unknown users** — the only known install today is the dev box. User will manually reinstall. We do NOT need general-purpose migration tooling, but see R3 below for the dev box.
- **Skill files outside this repo** — `/home/kashyap/.claude/skills/pm/` and `/home/kashyap/.claude/skills/fleet/` reference `apra-fleet` and `mcp__apra-fleet__*` tool IDs in their instructions. Updating those skill files is **a separate follow-up PR** in the user's `.claude` repo, not this one. This sprint's PR must call this out clearly in the CHANGELOG.
- **Choosing or shipping a "default" prefix** — we are NOT defaulting to `apra-` for backcompat. Empty prefix is the default for fresh installs.

## Constraints

- **Hard break, major version bump.** No silent compatibility shims. CHANGELOG must clearly state the upgrade procedure.
- **All 394 existing tests pass** after the refactor (with whatever default prefix the test runner uses).
- **No regression in any currently working tool** — every MCP tool listed in the server today must still work after rename. The list (from the live server): `fleet_status`, `list_members`, `member_detail`, `register_member`, `update_member`, `remove_member`, `compose_permissions`, `provision_llm_auth`, `provision_vcs_auth`, `revoke_vcs_auth`, `setup_ssh_key`, `setup_git_app`, `update_llm_cli`, `cloud_control`, `execute_command`, `execute_prompt`, `monitor_task`, `send_files`, `receive_files`, `shutdown_server`, `version`. Plus any others discovered in PHASE 0 explore. The MCP server's effective tool IDs become `mcp__${prefix}fleet__<name>` where `<name>` does NOT contain the prefix.
- **Always bash syntax** in any new install scripts; Git Bash on Windows accepts everything.
- **Single source of truth** — exactly one place in the code defines how `ORG_PREFIX` is resolved. Every other consumer reads from that resolver. No scattered `process.env.PREFIX || 'apra-'` checks.
- **Resolution order for `ORG_PREFIX`** (planner to confirm/refine in PHASE 0): (1) explicit CLI flag, (2) env var, (3) install-time config file in `~/.${prefix}fleet/config.json`, (4) empty string default. Whichever order the planner picks must be documented and tested.

## Open architectural questions for the planner

The planner MUST surface decisions on these in PHASE 0 and propose answers in the plan. The reviewer will hold the planner to coherent answers — no hand-waving.

1. **Base name** — internal codebase base name. Default proposal: `fleet`. If the planner prefers something else, justify.
2. **npm package name** — the package itself can't be templated (npm package names are fixed strings). Recommended: `@apra-labs/fleet`. Planner picks and justifies.
3. **MCP server name registration** — does the MCP framework let us pass the server name at runtime (e.g., from `ORG_PREFIX`), or is it baked in at module load? **R1, validate in Task 1.**
4. **CLI binary name** — does npm `bin` support an install-time-templated name, or do we need a stable `fleet` binary that self-identifies via prefix at runtime? **R2.**
5. **Prefix character constraints** — alphanumeric only? Hyphens? Length cap? How does the prefix attach to `fleet` (plain concat → `aprafleet`, vs hyphen → `apra-fleet`)? Default proposal: `[a-z0-9]+` with automatic hyphen attachment, so `apra` → `apra-fleet`.
6. **Install-time capture UX** — interactive prompt + non-interactive `--prefix=` flag + env var (`FLEET_INSTALL_PREFIX`)? Pick the minimum that supports both human and CI installs.

## Risk Register

| ID | Severity | Risk | Mitigation |
|----|----------|------|------------|
| **R1** | **HIGH** | The MCP framework may not allow runtime-templated server names. If tool IDs are statically declared at module load, the entire install-time prefix approach is invalid for tool IDs. | **Validate end-to-end in Task 1**: register one tool with a server name read from a config value at runtime, then call that tool from a downstream agent and confirm the tool ID resolves correctly. If this fails, STOP the sprint and escalate — the architecture needs rethinking. |
| **R2** | MEDIUM | npm `bin` field may not support install-time-templated binary names. | If statically required, ship a stable `fleet` binary that reads its prefix at runtime and self-identifies in `--version` and `--help`. Document in plan as Task 2 if R1 passes. |
| **R3** | MEDIUM | The dev box has live state in `~/.apra-fleet/` (registered members, sessions, ledgers, oauth tokens). A hard break loses all of it on reinstall. | Either: (a) include a one-shot migration helper that copies `~/.apra-fleet/` → `~/.${newprefix}fleet/` when the user runs the new install with their old prefix, or (b) document the manual `mv` step in the CHANGELOG and accept the user re-runs their post-install setup. Planner picks; (a) is cheap insurance. |
| **R4** | MEDIUM | Hidden references to `apra-fleet` outside `src/` — in CI workflows, GitHub Actions, dist artifacts, snapshot tests, fixture data, hooks, statusline, skills. | PHASE 0 explore must `grep -r -i "apra"` across the entire repo (excluding `node_modules/`, `.git/`, `dist/`) and produce a complete inventory before drafting tasks. |
| **R5** | LOW | Documentation churn — every example needs rewriting. High volume, mostly mechanical, but easy to miss. | Phase the docs rewrite as its own task with explicit `grep` verification in the "done" criteria. |
| **R6** | LOW | External skill files (`~/.claude/skills/{pm,fleet}/`) reference `mcp__apra-fleet__*` tool IDs and will silently break for the user after this PR lands. | Out of scope — call out clearly in CHANGELOG and in the PR description. Follow-up PR in the user's `.claude` repo. |

## Acceptance Criteria

- [ ] `grep -r -i "apra" src/ tests/ scripts/ hooks/ install.*` returns empty (or only intentional CHANGELOG/migration references with explicit comments)
- [ ] A fresh `install.sh` with no prefix produces a working `fleet` CLI, `~/.fleet/` data dir, and an MCP server registering tools as `mcp__fleet__list_members` etc.
- [ ] A fresh `install.sh --prefix=test` produces a `test-fleet` CLI, `~/.test-fleet/` data dir, and `mcp__test-fleet__list_members` etc.
- [ ] A fresh `install.sh --prefix=apra` reproduces the *current* user-visible behavior — the user can reinstall to the old name explicitly.
- [ ] All 394 currently-passing tests still pass.
- [ ] New tests cover: ORG_PREFIX resolver, prefix-templated MCP server name, prefix-templated data dir, prefix-templated env vars, install script flag handling.
- [ ] R1 (templated MCP server name) is validated end-to-end in Task 1 with a concrete demo, before any bulk rename work begins.
- [ ] `package.json` major version bumped per project convention.
- [ ] `CHANGELOG.md` entry documents: the breaking change, the upgrade procedure (reinstall with explicit `--prefix=apra` to keep old behavior), the rationale, and the explicit "external skill files in `~/.claude/` will need a separate update" note.
- [ ] `README.md` and `docs/` are coherent for both prefixed and non-prefixed installs, using one canonical example convention.
- [ ] PR description clearly calls out the breaking change and links to the CHANGELOG entry.
