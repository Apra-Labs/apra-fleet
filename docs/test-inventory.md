# Test Suite Inventory and Trim Audit

Status: audit only. Nothing in this document has been applied. No test or source
file was modified while producing it.

Measured on branch `chore/integration-binary-fixes-and-auth-selfheal`, Windows 11,
Node v22.22.1, 2026-08-02/03. Every duration below is a real measurement taken
during this audit unless explicitly labelled as coming from
`integ-suite-status.json` (the 2026-07-31 real-bd run).

---

## 1. Summary

### 1.1 Surfaces, as measured

| Surface | Runner | Files | Tests | Wall clock (measured) | Runs in CI? |
|---|---|---|---|---|---|
| `tests/**` + `packages/fleet-api-contract/tests/` | `vitest run` | 212 | 2930 (36 skipped) | **5m 06s** | Yes (`ci.yml:101`) |
| `packages/apra-fleet-se/test/` | `node --test -c 8` | 166 | 1551 (3 skipped) | **2m 55s** | Yes (`ci.yml:114`) |
| `packages/apra-fleet-se/apra-pm/test/` | `node --test` | 44 | 433 | **4.5s** | **NO -- see 1.3** |
| `packages/apra-fleet-workflow/test/` | `node --test` | 30 | 243 (1 failing) | **10.6s** | Yes (`ci.yml:114`) |
| `packages/apra-fleet-client/test/` | `node --test` | 5 | 31 | **2.4s** | Yes (`ci.yml:114`) |
| **Default-lane total** | | **457** | **5188** | **8m 19s** | |
| `packages/apra-fleet-se/test/slow/` | `npm run test:slow` | 2 | 2 | ~31s | **NO** (currently failing) |
| Real-bd integ lane (`run-integ-suites.mjs`) | `node --test`, `APRA_FLEET_BD_MOCK=off` | 131 | -- | **1691s wall / 9683s cumulative file time** | **NO** (once per sprint, by playbook) |

Grand total across all lanes: **459 test files**, **5188 tests** in the default lanes.

The ~2900-test figure in the audit brief is confirmed accurate *for the root vitest
suite alone* (2930). It is not the whole picture -- the four `node --test` surfaces add
another 2258 tests.

### 1.2 Top-line findings

1. **The single biggest wall-clock win is not deleting tests -- it is the root suite's
   `fileParallelism: false`.** Measured directly: `npx vitest run --fileParallelism`
   completes in **1m 47s vs 5m 06s** -- a **199s (3.2x) saving** -- but 263 tests fail
   because test files share one `registry.json`. See section 7.1. This one change is
   worth more than every deletion in this document combined.
2. **Resolved since this audit: the unwired Dolt recovery ladder (`dolt-recovery.mjs`,
   `dolt-recovery-path-b.mjs`, `dolt-recovery-tier2.mjs`) was retired and deleted on
   branch `fix/dolt-settle-recovery`, replaced by the deterministic
   `settleDoltConflicts()` in `fleet-sprint/dolt-settle.mjs`, which IS wired at both
   divergence terminals in `dolt-sync.mjs`.** See section 6.3.
3. **433 tests in `packages/apra-fleet-se/apra-pm/test/` never run in CI.** `apra-pm` is
   not an npm workspace (`npm query .workspace` returns only the four declared
   packages), so `npm test --workspaces --if-present` never reaches it, and
   `vitest.config.ts:7`'s `packages/*/tests/**` pattern does not match
   `packages/apra-fleet-se/apra-pm/test/`. See section 8.1.
4. **Two real, currently-red tests**, both reproduced during this audit:
   `packages/apra-fleet-workflow/test/deploy-runbook-platform-selection.test.mjs`
   fails deterministically (section 5.1), and
   `packages/apra-fleet-se/test/serve-wiring-integration.test.mjs` fails under
   concurrency but passes in isolation (section 5.2, existing bead `apra-fleet-ryk`).
5. **The mock-sprint family dominates the expensive lane.** 50 `mock-sprint-*` files
   account for **7431s of the real-bd lane's 9683s cumulative file time (77%)**.
   Genuine duplication and subsumption exist within it (sections 3 and 4).
6. **10 coverage gaps identified**, several tied to closed P0/P1 incidents -- notably
   `createLlmAuthSelfHealCallback` (fixed a P0, has zero direct tests) and
   `orphan-recovery.ts` (zero test imports, on the live dispatch path, with two
   *currently open* sprint-death bugs pointing at it). See section 6.
7. **18 safe-removal candidates**, each with a named surviving cover (section 9), and
   **1 candidate rejected on the evidence**. Removals alone save roughly **420s of
   real-bd cumulative time** and ~40s of default-lane time; the larger ~1400s comes from
   the refactors in section 5, which are explicitly *not* deletions. Both items that the
   first pass left conditional have since been traced through `runner.js` and now carry
   final verdicts -- one confirmed removable, one confirmed **not** removable (Tier 3 of
   section 9). Nothing in the cut list is now conditional.
8. **No stray `.only(` anywhere.** Swept all 459 files. This was checked specifically
   because a stray `.only` silently disables the rest of a file; the suite is clean.

### 1.3 What actually runs in CI

`.github/workflows/ci.yml`, job `build-and-test`, 3-OS matrix, on push/PR:

- `ci.yml:101` `npm test` -> vitest -> `tests/**` + `packages/fleet-api-contract/tests/`
- `ci.yml:114` `npm test --workspaces --if-present` -> apra-fleet-se, apra-fleet-workflow, apra-fleet-client

- `ci.yml` "Run apra-pm test suite" -> `npm test --prefix packages/apra-fleet-se/apra-pm`
  (**added 2026-08-03**, closing the 8.1 gap below)

Never run by any workflow: `packages/apra-fleet-se/test/slow/` (2 files), the real-bd integ lane
(`test:integration` / `run-integ-suites.mjs`), and
`packages/apra-fleet-workflow/test/manual/` (the last is deliberate and documented at
`test/manual/README.md:3-11`).

---

## 2. Full inventory table

One row per test file. The "Purpose" column is each file's own top-level `describe`/
`test` title, extracted mechanically -- it is evidence from the file, not a
description invented for this document. Where a file has no top-level title the cell
says so rather than guessing.

Durations: root-vitest rows are per-file times from `vitest --reporter=json` during
the 5m06s serial run. `apra-fleet-se` rows are wall-clock per file from an isolated
8-way concurrent re-run (`tmp_test_audit/se-timing2.json`); these sum to 511s of CPU
across a 71s wall, which is why individual numbers exceed a naive share of the 2m55s
suite time. The three small `node --test` surfaces finish in 4.5s/10.6s/2.4s total and
were not worth per-file instrumentation -- they are marked `(suite-level only)`.

Verdicts are assigned in sections 3-9; this table is the raw index. See section 10
for how to regenerate it.

| Surface | Path | Runner | Tests | Duration | Purpose (from the file's own top-level title) |
|---|---|---|---|---|---|
| root (vitest) | `tests/2cc-win-bd-invocation-integ.test.ts` | vitest | 5 | 18.01s | the shared bd-invocation helper (scripts/lib/exec-bd.mjs) on the host platform |
| root (vitest) | `tests/register-member.test.ts` | vitest | 3 | 16.01s | register_member: auto-runs compose_permissions (apra-fleet-5oo.1 / apra-fleet-5oo.2) |
| root (vitest) | `tests/hub-service/file-transfer-e2e.test.ts` | vitest | 4 | 10.63s | file transfer over relay: sender -> real hub -> receiver (real HTTP + real pg-mem) |
| root (vitest) | `tests/register-member-bootstrap-gate.test.ts` | vitest | 2 | 9.90s | register-member interactive bootstrap gate |
| root (vitest) | `tests/hub-service/relay-queue.test.ts` | vitest | 10 | 9.66s | relay-queue: at-least-once delivery (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/check-sandbox-sync-remote-integ.test.ts` | vitest | 5 | 8.65s | check-sandbox-sync-remote.mjs entrypoint guard actually runs main() when spawned directly as a real CLI (apra-fleet-xuo.8.2) |
| root (vitest) | `tests/check-sandbox-sync-remote.test.ts` | vitest | 54 | 7.38s | defaultSandboxPath |
| root (vitest) | `tests/install-workflows.test.ts` | vitest | 21 | 4.77s | install-config workflowsMode persistence (writeInstallConfig unit test) |
| root (vitest) | `tests/check-sandbox-sync-remote-fetch-integ.test.ts` | vitest | 2 | 4.54s | eft.18.5 wire-before-init Setup: sandbox git origin is fetchable-yet-isolated (apra-fleet-eft.18.7 retarget of apra-fleet-eft.47.2 |
| root (vitest) | `tests/spoke-e2e.test.ts` | vitest | 1 | 3.49s | spoke-to-spoke relayed execute_command (real HTTP + real pg-mem + real child process) |
| root (vitest) | `tests/hub-service/http-server.test.ts` | vitest | 21 | 3.43s | hub http-server (apra-fleet-us9.4) |
| root (vitest) | `tests/strategy-process-tree-kill.test.ts` | vitest | 1 | 3.40s | kills a detached grandchild process after the inactivity timeout fires, not just the shell wrapper |
| root (vitest) | `tests/execute-prompt.test.ts` | vitest | 98 | 3.26s | executePrompt |
| root (vitest) | `tests/integration/session-lifecycle.test.ts` | vitest | 7 | 2.92s | Inactivity timer - integration (T13) |
| root (vitest) | `tests/strategy.test.ts` | vitest | 12 | 2.38s | LocalStrategy |
| root (vitest) | `tests/auth-socket.test.ts` | vitest | 51 (2 skip) | 2.27s | auth-socket |
| root (vitest) | `tests/regression-command-surface.test.ts` | vitest | 2 | 1.73s | command-surface regression: --version and run --transport stdio (apra-fleet-7pm.14) |
| root (vitest) | `tests/execute-prompt-interactive.test.ts` | vitest | 16 | 1.71s | executePrompt -- interactive routing (apra-fleet-2xs.8) |
| root (vitest) | `tests/exec-bd.test.ts` | vitest | 16 | 1.69s | resolveWindowsBdScript |
| root (vitest) | `tests/unit/pid-wrapper.test.ts` | vitest | 22 (5 skip) | 1.62s | pidWrapUnix string structure |
| root (vitest) | `tests/compose-permissions.test.ts` | vitest | 35 | 1.23s | composePermissions -- Claude proactive |
| root (vitest) | `tests/strategy-utf8-chunk-boundary.test.ts` | vitest | 1 | 1.18s | LocalStrategy stdout UTF-8 chunk-boundary handling (apra-fleet-grq) |
| root (vitest) | `tests/relay-executor.test.ts` | vitest | 6 | 1.18s | createRelayExecutor |
| root (vitest) | `tests/update-member.test.ts` | vitest | 25 | 1.17s | updateMember |
| root (vitest) | `tests/install-force.test.ts` | vitest | 16 | 1.17s | install --force (#96) |
| root (vitest) | `tests/transport-integration.test.ts` | vitest | 7 | 1.16s | (a) HTTP server tool call end-to-end |
| root (vitest) | `tests/revoke-vcs-auth.test.ts` | vitest | 8 | 1.16s | revokeVcsAuth |
| root (vitest) | `tests/eft-41-symlinked-entry.test.ts` | vitest | 2 | 1.13s | cli.mjs entry-resolution self-executes through a symlinked invocation path (apra-fleet-eft.41.1) |
| root (vitest) | `tests/hub-service/dashboard-auth.test.ts` | vitest | 17 | 1.11s | dashboard OAuth + RBAC (apra-fleet-us9.16) |
| root (vitest) | `tests/http-transport.test.ts` | vitest | 20 | 1.10s | (a) server binds to 127.0.0.1 |
| root (vitest) | `tests/workspace-isolation.test.ts` | vitest | 17 | 1.02s | (a) JWT workspace_id claim |
| root (vitest) | `tests/provision-vcs-auth.test.ts` | vitest | 20 | 0.92s | provisionVcsAuth |
| root (vitest) | `tests/execute-prompt-substitution.test.ts` | vitest | 8 | 0.87s | execute_prompt -- substitutions surface tests |
| root (vitest) | `tests/update-workflow-lock.test.ts` | vitest | 1 | 0.84s | update-triggered re-install: EBUSY handling on a locked built-in workflow directory |
| root (vitest) | `tests/onboarding.test.ts` | vitest | 69 (1 skip) | 0.83s | loadOnboardingState |
| root (vitest) | `tests/tool-provider.test.ts` | vitest | 27 | 0.79s | executePrompt - provider routing |
| root (vitest) | `tests/registry.test.ts` | vitest | 21 | 0.74s | registry CRUD |
| root (vitest) | `tests/sea-http-verify.test.ts` | vitest | 4 | 0.70s | SEA bundle compatibility: http-transport |
| root (vitest) | `tests/hub-service/users.test.ts` | vitest | 13 | 0.69s | users / dashboard RBAC (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/hub-service/member-view.test.ts` | vitest | 7 | 0.66s | member-view (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/hub-service/projects.test.ts` | vitest | 13 | 0.60s | projects (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/list-members.test.ts` | vitest | 11 | 0.60s | list_members -- tags filter |
| root (vitest) | `tests/execute-prompt-agent.test.ts` | vitest | 11 | 0.59s | execute_prompt -- agent parameter |
| root (vitest) | `tests/category.test.ts` | vitest | 16 | 0.56s | fleet_status -- category grouping |
| root (vitest) | `tests/hub-service/envelope-routes.test.ts` | vitest | 10 | 0.56s | submitEnvelope (apra-fleet-us9.6 slice 1) |
| root (vitest) | `tests/model-tiers.test.ts` | vitest | 21 | 0.53s | resolveModelForTier |
| root (vitest) | `tests/cloud-lifecycle-unit.test.ts` | vitest | 6 | 0.52s | ensureCloudReady - F5 re-provisioning after start |
| root (vitest) | `tests/execute-prompt-provisioning.test.ts` | vitest | 10 | 0.52s | execute_prompt: auto-provision stale remote agent files on dispatch |
| root (vitest) | `tests/member-reservation.test.ts` | vitest | 11 | 0.50s | memberReservation |
| root (vitest) | `tests/platform.test.ts` | vitest | 131 (3 skip) | 0.50s | detectOS |
| root (vitest) | `tests/credential-store-and-execute.test.ts` | vitest | 16 | 0.49s | credential store round-trip |
| root (vitest) | `tests/workflow.test.ts` | vitest | 61 | 0.45s | resolveWorkflowEntry |
| root (vitest) | `tests/auth-oauth-secret.test.ts` | vitest | 28 | 0.45s | parseClaudeOAuthSecret |
| root (vitest) | `tests/install-multi-provider.test.ts` | vitest | 73 | 0.41s | runInstall multi-provider |
| root (vitest) | `tests/provision-auth.test.ts` | vitest | 10 | 0.40s | provisionAuth |
| root (vitest) | `tests/hub-service/presence.test.ts` | vitest | 8 | 0.39s | presence (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/sprint-coordination.test.ts` | vitest | 16 | 0.39s | dolt_push_mutex tool |
| root (vitest) | `tests/hub-service/members.test.ts` | vitest | 7 | 0.38s | members (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/hub-service/project-view.test.ts` | vitest | 5 | 0.38s | project-view (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/check-toy-doer-credentials.test.ts` | vitest | 45 | 0.37s | defaultRegistryPath / defaultCredentialsPath |
| root (vitest) | `tests/hub-service/member-tokens.test.ts` | vitest | 6 | 0.37s | member-tokens (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/cloud-lifecycle.test.ts` | vitest | 11 | 0.37s | execute-command: ensureCloudReady wiring |
| root (vitest) | `tests/unattended-mode.test.ts` | vitest | 10 | 0.37s | register_member: unattended field persistence |
| root (vitest) | `tests/fleet-status-branch.test.ts` | vitest | 9 | 0.36s | fleetStatus branch display |
| root (vitest) | `tests/hub-service/usage.test.ts` | vitest | 6 | 0.36s | usage (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/cloud-integration.test.ts` | vitest | 9 | 0.36s | Cloud lifecycle: execute_command auto-start |
| root (vitest) | `tests/get-member-model-pricing.test.ts` | vitest | 12 | 0.36s | get_member_model_pricing |
| root (vitest) | `tests/vcs-auth.test.ts` | vitest | 25 | 0.34s | GitHub provider |
| root (vitest) | `tests/hub-service/activity.test.ts` | vitest | 7 | 0.34s | activity (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/check-integ-suite-budget.test.ts` | vitest | 12 | 0.33s | BUDGET_MS |
| root (vitest) | `tests/check-watchdog-isolation-integ.test.ts` | vitest | 3 | 0.33s | check-watchdog-isolation.mjs entrypoint guard actually runs main() when spawned directly as a real CLI (apra-fleet-xuo.11) |
| root (vitest) | `tests/execute-command.test.ts` | vitest | 12 | 0.32s | executeCommand |
| root (vitest) | `tests/jwt.test.ts` | vitest | 15 | 0.32s | jwt |
| root (vitest) | `tests/hub-service/enrollment.test.ts` | vitest | 7 | 0.31s | enrollment (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/execute-prompt-idb-busy-lock.test.ts` | vitest | 7 | 0.31s | orphaned busy-lock regression (apra-fleet-idb / apra-fleet-iuc.5) |
| root (vitest) | `tests/send-files-substitution.test.ts` | vitest | 8 | 0.31s | send_files -- substitution surface tests (p, p2) |
| root (vitest) | `tests/agent-detail.test.ts` | vitest | 6 | 0.31s | memberDetail branch display |
| root (vitest) | `tests/remove-member-decomm.test.ts` | vitest | 10 | 0.29s | removeMember - decommissioning |
| root (vitest) | `tests/github-app.test.ts` | vitest | 7 | 0.29s | loadPrivateKey |
| root (vitest) | `tests/hub-service/relay-correlation-e2e.test.ts` | vitest | 1 | 0.26s | relay envelope correlation_id round-trip (real HTTP + real pg-mem, apra-fleet-us9.12 regression) |
| root (vitest) | `tests/fleet-setup-config.test.ts` | vitest | 26 | 0.26s | fleet-setup.mjs config resolution |
| root (vitest) | `tests/agent-helpers.test.ts` | vitest | 16 | 0.25s | getAgentOrFail |
| root (vitest) | `tests/stall-detector-integration.test.ts` | vitest | 9 | 0.22s | StallDetector lifecycle - integration (T13) |
| root (vitest) | `tests/stop-prompt.test.ts` | vitest | 7 | 0.22s | stop_prompt (T8) |
| root (vitest) | `tests/execute-prompt-resume-semantics.test.ts` | vitest | 6 | 0.21s | execute_prompt resume-by-session-id semantics (apra-fleet-eft.78.1) |
| root (vitest) | `tests/hub-service/audit-log.test.ts` | vitest | 4 | 0.20s | audit-log (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/integration/pid-lifecycle.test.ts` | vitest | 3 | 0.19s | PID lifecycle - integration (T12) |
| root (vitest) | `tests/defensive-ux.test.ts` | vitest | 9 | 0.19s | execute-command: long_running OS warning |
| root (vitest) | `tests/stall-any-entry-activity-and-kill.test.ts` | vitest | 3 | 0.19s | stall detection on a tool-heavy turn (apra-fleet-6z8.2) |
| root (vitest) | `tests/hub-service/machines.test.ts` | vitest | 4 | 0.19s | machines (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/integ-test-playbook-teardown.test.ts` | vitest | 2 | 0.19s | integ-test-playbook.md Teardown tilde-resolution regression |
| root (vitest) | `tests/task-cleanup.test.ts` | vitest | 10 | 0.19s | cleanupStaleTasks |
| root (vitest) | `tests/cloud-provider.test.ts` | vitest | 28 | 0.18s | AwsCloudProvider - getInstanceState |
| root (vitest) | `tests/hub-service/jwt-revocation.test.ts` | vitest | 4 | 0.17s | jwt-revocation (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/credential-scoping-ttl.test.ts` | vitest | 17 | 0.17s | credentialResolve: member scoping |
| root (vitest) | `tests/execute-prompt-orphan-recovery.test.ts` | vitest | 7 | 0.17s | execute_prompt orphan lease-of-life recovery (apra-fleet-6z8.1) |
| root (vitest) | `tests/singleton.test.ts` | vitest | 10 | 0.16s | (a) stale server.json is cleaned up |
| root (vitest) | `tests/user-config.test.ts` | vitest | 18 | 0.16s | user-config loader |
| root (vitest) | `tests/install-dev-manifest.test.ts` | vitest | 3 | 0.16s | buildDevManifest -- workflow subsystem sections |
| root (vitest) | `tests/hub-service/workspaces.test.ts` | vitest | 4 | 0.15s | workspaces (pg-mem, real SQL engine, no Docker required) |
| root (vitest) | `tests/register-member-oob.test.ts` | vitest | 8 | 0.15s | register_member: anonymous OOB password (Test 3) |
| root (vitest) | `tests/credential-store-path.test.ts` | vitest | 7 | 0.15s | getCredentialsPath: call-time env var resolution |
| root (vitest) | `tests/member-reservation-e2e.test.ts` | vitest | 2 | 0.14s | member reservation end-to-end (apra-fleet-eft.10.4) |
| root (vitest) | `tests/auth-web.test.ts` | vitest | 10 | 0.14s | auth-web (local browser credential UI) |
| root (vitest) | `tests/agent-provisioner.test.ts` | vitest | 33 | 0.13s | loadCanonicalAgentSet |
| root (vitest) | `tests/register-member-provisioning.test.ts` | vitest | 5 | 0.13s | register_member: agent provisioning integration |
| root (vitest) | `tests/cli-verbs.test.ts` | vitest | 20 | 0.13s | runStart |
| root (vitest) | `tests/opencode-provider.test.ts` | vitest | 55 | 0.12s | OpenCodeProvider registration |
| root (vitest) | `tests/dead-session-detection-contract.test.ts` | vitest | 4 | 0.12s | dead-session detection contract (apra-fleet-iuc.3) |
| root (vitest) | `tests/send-files-collision.test.ts` | vitest | 4 | 0.11s | sendFiles - basename collision detection |
| root (vitest) | `tests/setup-git-app.test.ts` | vitest | 7 | 0.11s | setupGitApp |
| root (vitest) | `tests/pending-responses.test.ts` | vitest | 6 | 0.11s | pending-responses (apra-fleet-2xs.8) |
| root (vitest) | `tests/execute-prompt-phantom-connectback.test.ts` | vitest | 2 | 0.11s | phantom JWT connect-back does not permanently wedge a member (apra-fleet-eft.74.3) |
| root (vitest) | `tests/file-transfer-relay.test.ts` | vitest | 7 | 0.10s | sendFileOverRelay |
| root (vitest) | `tests/known-hosts.test.ts` | vitest | 7 (1 skip) | 0.10s | known-hosts TOFU |
| root (vitest) | `tests/agy-provider.test.ts` | vitest | 10 | 0.09s | AgyProvider parseResponse |
| root (vitest) | `tests/update-npm.test.ts` | vitest | 3 | 0.09s | runUpdate - npm redirect path (T8) |
| root (vitest) | `tests/security-hardening.test.ts` | vitest | 25 (1 skip) | 0.08s | registry file permissions |
| root (vitest) | `tests/install.test.ts` | vitest | 12 | 0.08s | install config persistence (T5) |
| root (vitest) | `tests/statusline.test.ts` | vitest | 2 | 0.08s | writeStatusline - #39 statusline clears after remove_member |
| root (vitest) | `tests/receive-files.test.ts` | vitest | 10 | 0.08s | receiveFiles |
| root (vitest) | `tests/dolt-install.test.ts` | vitest | 17 | 0.07s | resolveDoltAsset (apra-fleet-ire.1) |
| root (vitest) | `tests/cloud-sync.test.ts` | vitest | 7 | 0.07s | syncCloudCache (apra-fleet-aho) |
| root (vitest) | `tests/providers.test.ts` | vitest | 158 | 0.06s | ClaudeProvider |
| root (vitest) | `tests/shutdown-server.test.ts` | vitest | 3 | 0.06s | shutdownServer |
| root (vitest) | `tests/ssh-pool-active-channel-guard.test.ts` | vitest | 3 | 0.06s | SSH connection pool: cleanupEntry never reaps an entry with an active channel (apra-fleet-9zz.2) |
| root (vitest) | `tests/relay-request.test.ts` | vitest | 11 | 0.06s | PendingRelayRequests |
| root (vitest) | `tests/credential-store-update.test.ts` | vitest | 13 | 0.05s | credentialUpdate service |
| root (vitest) | `tests/spoke-sandbox.test.ts` | vitest | 7 | 0.05s | sandboxedWriteFile |
| root (vitest) | `tests/uninstall.test.ts` | vitest | 22 | 0.05s | uninstall |
| root (vitest) | `tests/log-helpers.test.ts` | vitest | 7 | 0.05s | log-helpers |
| root (vitest) | `tests/hub-client.test.ts` | vitest | 12 | 0.05s | computeBackoffMs |
| root (vitest) | `tests/join.test.ts` | vitest | 7 | 0.05s | apra-fleet join <member-jwt> (apra-fleet-6bf) |
| root (vitest) | `tests/find-log-file.test.ts` | vitest | 22 | 0.04s | findLogFile |
| root (vitest) | `tests/secret-cli.test.ts` | vitest | 36 | 0.04s | runSecret: no args |
| root (vitest) | `tests/service-manager.test.ts` | vitest | 40 | 0.04s | WindowsServiceManager |
| root (vitest) | `tests/install-dolt.test.ts` | vitest | 5 | 0.04s | dolt CLI install step wiring (apra-fleet-ire.4) |
| root (vitest) | `tests/stall-detector.test.ts` | vitest | 25 | 0.04s | StallDetector |
| root (vitest) | `tests/delivery-mode.test.ts` | vitest | 7 | 0.04s | getDeliveryMode() |
| root (vitest) | `tests/register-member-no-llm.test.ts` | vitest | 1 | 0.04s | register_member: no-LLM member (apra-fleet-us9.14) |
| root (vitest) | `tests/credential-store-set.test.ts` | vitest | 5 | 0.04s | credentialStoreSet |
| root (vitest) | `tests/update.test.ts` | vitest | 6 | 0.03s | runUpdate (T6) |
| root (vitest) | `tests/install-service.test.ts` | vitest | 13 | 0.03s | install -- service lifecycle (T11) |
| root (vitest) | `tests/git-config.test.ts` | vitest | 5 (1 skip) | 0.03s | git-config |
| root (vitest) | `tests/install-npm.test.ts` | vitest | 14 | 0.03s | isNpmGlobalInstall() detection |
| root (vitest) | `tests/idle-manager.test.ts` | vitest | 15 | 0.03s | IdleManager |
| root (vitest) | `tests/watch-transcript-formatter.test.ts` | vitest | 21 | 0.03s | formatTranscriptLine (claude, compact) |
| root (vitest) | `tests/credential-event.test.ts` | vitest | 3 | 0.03s | credential-event |
| root (vitest) | `tests/ssh-error-messages.test.ts` | vitest | 9 | 0.03s | classifySshError (#150) |
| root (vitest) | `tests/claude-provider-mcp-endpoint.test.ts` | vitest | 3 | 0.03s | ClaudeProvider registerMcpEndpoint (apra-fleet-fnz.1) |
| root (vitest) | `tests/watch-project-resolver.test.ts` | vitest | 10 | 0.03s | normalizeOrigin |
| root (vitest) | `tests/send-message.test.ts` | vitest | 7 | 0.02s | sendMessage |
| root (vitest) | `tests/register-member-cli.test.ts` | vitest | 9 | 0.02s | register-member CLI |
| root (vitest) | `tests/substitution-engine.test.ts` | vitest | 29 | 0.02s | applySubstitutions -- happy path |
| root (vitest) | `tests/ensure-workspace-trusted.test.ts` | vitest | 22 | 0.02s | ClaudeProvider.ensureWorkspaceTrusted (apra-fleet-eft.40.1) |
| root (vitest) | `tests/crypto.test.ts` | vitest | 5 | 0.02s | crypto |
| root (vitest) | `tests/activity.test.ts` | vitest | 15 | 0.02s | checkMemberActivity |
| root (vitest) | `tests/auth-env.test.ts` | vitest | 9 | 0.02s | buildAuthEnvPrefix |
| root (vitest) | `tests/stall-poller.test.ts` | vitest | 24 | 0.02s | pollLogFile |
| root (vitest) | `tests/report-status.test.ts` | vitest | 7 | 0.02s | reportStatus (apra-fleet-2xs.7) |
| root (vitest) | `tests/credential-cleanup.test.ts` | vitest | 10 | 0.02s | scheduleCredentialCleanup |
| root (vitest) | `tests/relay-strategy.test.ts` | vitest | 9 | 0.02s | getStrategy dispatch |
| root (vitest) | `tests/validate-sprint.test.ts` | vitest | 8 | 0.02s | evaluateGates |
| root (vitest) | `tests/file-transfer-matrix.test.ts` | vitest | 20 | 0.02s | File-transfer cross-OS matrix |
| root (vitest) | `tests/hub-service/hub-jwt.test.ts` | vitest | 8 | 0.02s | hub-jwt (apra-fleet-us9.4/us9.5) |
| root (vitest) | `tests/windows-pid-wrap.test.ts` | vitest | 21 | 0.02s | pidWrapWindows: PID output format |
| root (vitest) | `tests/credential-validation.test.ts` | vitest | 12 | 0.02s | validateCredentials |
| root (vitest) | `tests/budget-awareness.test.ts` | vitest | 20 | 0.02s | budget-awareness: no budget configured |
| root (vitest) | `tests/package-sea-postject.test.ts` | vitest | 10 | 0.02s | isBenignPostjectStderrLine / filterPostjectStderr |
| root (vitest) | `tests/gemini-mcp-exclude.test.ts` | vitest | 7 | 0.01s | getAllowedMcpServers |
| root (vitest) | `tests/gen-llms-full.test.ts` | vitest | 7 | 0.01s | gen-llms-full: link parser |
| root (vitest) | `packages/fleet-api-contract/tests/schemas.test.ts` | vitest | 12 | 0.01s | JWTClaims (anchor schema) |
| root (vitest) | `tests/update-check.test.ts` | vitest | 17 | 0.01s | isNewer - version comparison |
| root (vitest) | `tests/session-registry.test.ts` | vitest | 23 | 0.01s | sessionRegistry |
| root (vitest) | `tests/hub-service/session-jwt.test.ts` | vitest | 6 | 0.01s | session-jwt (apra-fleet-us9.16) |
| root (vitest) | `tests/tags.test.ts` | vitest | 7 | 0.01s | tags validation -- updateMemberSchema |
| root (vitest) | `tests/file-chunker.test.ts` | vitest | 6 | 0.01s | chunkFile / FileReassembler |
| root (vitest) | `tests/event-bus.test.ts` | vitest | 11 | 0.01s | event-bus: TypedEventBus |
| root (vitest) | `tests/version.test.ts` | vitest | 9 | 0.01s | resolveVersion -- ESM real-semver path (direct import) |
| root (vitest) | `tests/watch-fleet-log.test.ts` | vitest | 12 | 0.01s | formatFleetLogLine |
| root (vitest) | `tests/backward-compat.test.ts` | vitest | 40 | 0.01s | old /pm commands have equivalents in new pm skill |
| root (vitest) | `tests/onboarding-text.test.ts` | vitest | 21 | 0.01s | BANNER |
| root (vitest) | `tests/log-path-resolver.test.ts` | vitest | 10 | 0.01s | encodeClaudeProjectDir |
| root (vitest) | `tests/opencode-model-validation.test.ts` | vitest | 6 | 0.01s | validateOpenCodeModelTiers |
| root (vitest) | `tests/read-log-tail.test.ts` | vitest | 9 | 0.01s | readLogTail |
| root (vitest) | `tests/install-permissions.test.ts` | vitest | 8 | 0.01s | buildRequiredPerms |
| root (vitest) | `tests/extract-results.test.ts` | vitest | 12 | 0.01s | extract-results: Claude stream-json (result envelope) |
| root (vitest) | `tests/shell-escape.test.ts` | vitest | 14 | 0.01s | escapeShellArg |
| root (vitest) | `tests/ci-npm-publish.test.ts` | vitest | 14 | 0.01s | CI npm-publish job validation |
| root (vitest) | `tests/skill-matrix.test.ts` | vitest | 18 | 0.01s | getRequiredSkills -- skill matrix utility |
| root (vitest) | `tests/integ-playbook-permission-profiles.test.ts` | vitest | 5 | 0.01s | integ-test-playbook.md permission requirements vs fleet profiles |
| root (vitest) | `tests/time-utils.test.ts` | vitest | 7 | 0.01s | toLocalISOString |
| root (vitest) | `tests/pid-helpers.test.ts` | vitest | 5 | 0.01s | isPidAlive |
| root (vitest) | `tests/task-wrapper.test.ts` | vitest | 9 | 0.01s | generateTaskWrapper - python3 removal |
| root (vitest) | `tests/agent-transform.test.ts` | vitest | 8 | 0.01s | transformAgentForOpenCode |
| root (vitest) | `tests/prompt-errors.test.ts` | vitest | 10 | 0.01s | classifyPromptError |
| root (vitest) | `tests/hub-service/installers.contract.test.ts` | vitest | 2 | 0.01s | hub-service contract: GET /installers |
| root (vitest) | `tests/cost.test.ts` | vitest | 12 | 0.01s | isKnownInstanceType |
| root (vitest) | `tests/none-provider.test.ts` | vitest | 3 | 0.01s | NoneProvider (apra-fleet-us9.14) |
| root (vitest) | `tests/respond-to-message.test.ts` | vitest | 3 | 0.01s | respondToMessage (apra-fleet-2xs.8) |
| root (vitest) | `tests/windows-credential-helper.test.ts` | vitest | 8 | 0.01s | Windows gitCredentialHelperWrite |
| root (vitest) | `tests/unit/linux-pipefail-posix-safety.test.ts` | vitest | 3 | 0.00s | durable-tee wrapper is safe on POSIX sh (apra-fleet-8hb.2) |
| root (vitest) | `tests/gen-sea-config.test.ts` | vitest | 4 | 0.00s | gen-sea-config.mjs -- generated SEA manifest |
| root (vitest) | `tests/gpu-parser.test.ts` | vitest | 5 | 0.00s | parseGpuUtilization |
| root (vitest) | `tests/watch-tail-command.test.ts` | vitest | 5 | 0.00s | buildTailCommand (remote transcript tail) |
| root (vitest) | `tests/auth-terminal-wait.test.ts` | vitest | 1 (1 skip) | 0.00s | launchAuthTerminal -- Linux gnome-terminal --wait |
| root (vitest) | `tests/fleet-sprint-bundle-smoke.test.ts` | vitest | 3 (3 skip) | 0.00s | starts and reaches flag parsing instead of dying on a dynamic require |
| root (vitest) | `tests/hub-service/relay-queue.docker.test.ts` | vitest | 4 (4 skip) | 0.00s | a briefly-offline target does not lose a queued envelope, and receives it on reconnect |
| root (vitest) | `tests/integ-test-playbook-reset-portclean.test.ts` | vitest | 5 (5 skip) | 0.00s | fixed Reset port-cleanup snippet frees a scratch port a stray listener holds -- the port itself is verified free by the snippet, w |
| root (vitest) | `tests/smoke-test-flow-e2e-integ.test.ts` | vitest | 5 (5 skip) | 0.00s | the pre-sprint check-sandbox-sync-remote.mjs guard passes with its retargeted (all-remotes-inside-sandbox) assertions |
| root (vitest) | `tests/toy-doer-bare-token-real-cli-integ.test.ts` | vitest | 2 (2 skip) | 0.00s | FAILS against the pre-eft.48.6 bare-token shape (accessToken + expiresAt, no scopes): the real claude CLI rejects it as "Not logge |
| root (vitest) | `tests/toy-doer-envvar-real-cli-integ.test.ts` | vitest | 2 (2 skip) | 0.00s | FAILS against the pre-eft.48.8 state: an unprovisioned member exports no env var, and the real claude CLI rejects the clean-env di |
| apra-fleet-se | `packages/apra-fleet-se/test/dolt-sync-discipline.test.mjs` | node --test | 8 | 63.41s | (a) all three D-pull/D-push brackets fire, including the pre-`bd show` D-pull |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-lifecycle.test.mjs` | node --test | 4 | 18.22s | supervisor lifecycle -- watchdog four statuses over real children |
| apra-fleet-se | `packages/apra-fleet-se/test/serve-wiring-integration.test.mjs` | node --test | 4 | 11.22s | serve.mjs wiring integration (apra-fleet-eft.4.8.3) -- boot the real supervisor process |
| apra-fleet-se | `packages/apra-fleet-se/test/eft-37-boundary-e2e.test.mjs` | node --test | 13 | 7.43s | apra-fleet-eft.37.6: core-vs-se boundary e2e |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-dashboard-integration.test.mjs` | node --test | 8 | 7.10s | dashboard integration (apra-fleet-eft.6.6) -- stack, backlog, launch, live proxy, history |
| apra-fleet-se | `packages/apra-fleet-se/test/run-id-consecutive-launches.test.mjs` | node --test | 4 | 6.93s | apra-fleet-k7b.5: run-id keyed engine run-state across consecutive supervisor sprints |
| apra-fleet-se | `packages/apra-fleet-se/test/fyc3-se-package-json-shipped.test.mjs` | node --test | 3 | 6.83s | fyc.3 regression: packages/apra-fleet-se/package.json ships and installs |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-worklist-resume.test.mjs` | node --test | 4 | 6.50s | mock sprint (mode ii): 4 streaks / 2 doers -> ordered 2-streak worklists; streak 2 resumes streak 1\ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-develop-injection.test.mjs` | node --test | 1 | 6.35s | mock sprint: malicious reviewer newTasks are rejected without aborting the sprint |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-api.test.mjs` | node --test | 54 | 6.29s | api -- POST /api/sprints validation + goal forwarding |
| apra-fleet-se | `packages/apra-fleet-se/test/golden-transcript.test.mjs` | node --test | 3 | 6.25s | mockCmdResult/isSpawnFailure: nonzero exit is non-error data, spawn failure is isError:true |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-replan-short-circuit.test.mjs` | node --test | 3 | 6.09s | mock sprint: replanIds triggers an in-cycle scoped planner + plan-review and re-dispatches the amended bead the SAME cycle |
| apra-fleet-se | `packages/apra-fleet-se/test/golden-transcript-3bead.test.mjs` | node --test | 3 | 6.01s | mockCmdResult/isSpawnFailure: nonzero exit is non-error data, spawn failure is isError:true |
| apra-fleet-se | `packages/apra-fleet-se/test/final-review-auth-self-heal.test.mjs` | node --test | 2 | 5.75s | mock sprint: a successful Final Review LLM-auth self-heal short-circuits -- exactly two attempts, healed verdict preserved |
| apra-fleet-se | `packages/apra-fleet-se/test/budget-live.test.mjs` | node --test | 6 | 5.70s | apra-fleet-unw2.8 (N10): live budget accounting |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-round-resume.test.mjs` | node --test | 2 | 5.57s | mock sprint: round-resume -- reviewer/planner warm within-cycle resume, reset fresh across cycles |
| apra-fleet-se | `packages/apra-fleet-se/test/19o3-newtask-allowlist-resurface-integration.test.mjs` | node --test | 1 | 5.53s | apra-fleet-19o.3: bracketed titles validate and rejected newTasks reappear in the next planning prompt |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-id-allocator.test.mjs` | node --test | 12 | 5.48s | id-allocator -- zero collisions under concurrent same-parent creation (C.4) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns.test.mjs` | node --test | 3 | 5.35s | mock sprint: a max_turns-exhausted doer streak resumes with escalated max_turns instead of blindly retrying or giving up immediate |
| apra-fleet-se | `packages/apra-fleet-se/test/bd-recordings-fidelity.test.mjs` | node --test | 119 | 5.16s | bd recordings fidelity |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-happy-path.test.mjs` | node --test | 3 | 5.14s | mockCmdResult/isSpawnFailure: nonzero exit is non-error data, spawn failure is isError:true |
| apra-fleet-se | `packages/apra-fleet-se/test/doer-global-sequencing.test.mjs` | node --test | 3 | 5.06s | doer streaks assigned to DIFFERENT members execute strictly one-after-another (no overlapping dispatch windows) |
| apra-fleet-se | `packages/apra-fleet-se/test/publish-pr-non-hosted-remote.test.mjs` | node --test | 7 | 4.99s | mock sprint: non-hosted (file://) origin remote skips PR creation and closes the target issue directly |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-childless-target-scope.test.mjs` | node --test | 3 | 4.93s | childless leaf target: bdListScoped(\ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-integ-infra-dispatch-failure.test.mjs` | node --test | 3 | 4.85s | mock sprint: an integ dispatch empty_response is retried via resume and recovered -- never recorded as a FAIL |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-stall-oscillation.test.mjs` | node --test | 1 | 4.85s | mock sprint: close/reopen oscillation drives a high-water-mark stall + reopen-thrash flag (N9) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-worklist-batch.test.mjs` | node --test | 3 | 4.85s | mock sprint (mode i, config-gated): doer_worklist_mode=batch sends ONE dispatch carrying the whole ordered worklist |
| apra-fleet-se | `packages/apra-fleet-se/test/integ-turn-ceiling.test.mjs` | node --test | 2 | 4.68s | mock sprint: the integ-test-runner dispatch pins max_turns to the documented ceiling (300), not the pre-fix 200 |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-integ-passed-summary-log.test.mjs` | node --test | 3 | 4.58s | mock sprint: a passed:true integ cycle emits exactly one PASSED summary log line naming cycle, features closed, and bugs filed |
| apra-fleet-se | `packages/apra-fleet-se/test/gey1-launch-failed-classification.test.mjs` | node --test | 6 | 4.57s | watchdog -- apra-fleet-gey.1: launch-failed classification and auto-release |
| apra-fleet-se | `packages/apra-fleet-se/test/git-sync-brackets.test.mjs` | node --test | 21 | 4.44s | (a) every one of the seven dispatch types is wrapped in a withGitSync(...) bracket |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-publish-push-failure.test.mjs` | node --test | 2 | 4.33s | mock sprint: a persistently failing Publish push keeps the computed verdict (pushed:false), skips gh pr create, and never reports  |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns-verify-bypass.test.mjs` | node --test | 2 | 4.14s | mock sprint: a max_turns-exhausted doer streak whose bead is ALREADY closed is classified success, logs the missed-VERIFY warning, |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-idempotent-pr.test.mjs` | node --test | 1 | 4.05s | mock sprint: re-running finalization against the same branch is idempotent (no throw on existing PR) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-lane-metadata-grouping.test.mjs` | node --test | 2 | 4.05s | mock sprint: lane metadata yields deterministic grouping with no Streak Assignment dispatch |
| apra-fleet-se | `packages/apra-fleet-se/test/full-db-fetch-tripwire.test.mjs` | node --test | 6 | 4.05s | checker: flags a duplicate full-DB fetch within the same phase step |
| apra-fleet-se | `packages/apra-fleet-se/test/pre-sprint-validation-stale-clone.test.mjs` | node --test | 2 | 3.99s | apra-fleet-eft.36: a childless leaf target invisible to a STALE orchestrator `bd list --all` clone is still |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-ledger.test.mjs` | node --test | 30 | 3.94s | ledger -- lockstep claim/release + atomic persistence |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-review-retry.test.mjs` | node --test | 2 | 3.92s | mock sprint: Final Review survives one transient dispatch failure via retry-once |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-reviewer-dispatch-error.test.mjs` | node --test | 2 | 3.88s | mock sprint: Reviewer dispatch failure (AgentDispatchError) is logged distinctly from schema-repair exhaustion |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-stop-restart-integration.test.mjs` | node --test | 4 | 3.84s | Sprint Stack Stop/Restart (apra-fleet-3i3.4) -- end to end against a real supervisor |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-abort-pr.test.mjs` | node --test | 11 | 3.80s | finalizeAbort: >=1 commit beyond base -> branch pushed and [ABORTED] PR created with error evidence in body |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-exit-stale-approval.test.mjs` | node --test | 1 | 3.54s | mock sprint: a stale APPROVED verdict must not back a later cycle\ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-exit-deferred-goalpriority.test.mjs` | node --test | 1 | 3.49s | mock sprint: a deferred goal-priority bead must not allow exit success |
| apra-fleet-se | `packages/apra-fleet-se/test/develop-review-loop-exit-logging.test.mjs` | node --test | 2 | 3.48s | mock sprint: Develop/Review round-cap exit logs a distinct "deferring to next cycle" line as the terminating line, not "Looping ba |
| apra-fleet-se | `packages/apra-fleet-se/test/dolt-sync-brackets.test.mjs` | node --test | 46 | 3.37s | classifyDoltFailure: conflict / non-fast-forward outputs classify as diverged |
| apra-fleet-se | `packages/apra-fleet-se/test/gey3-launch-failure-relaunch-gate-integration.test.mjs` | node --test | 1 | 3.23s | apra-fleet-gey.3: launch-failure fast path and relaunch gate end to end |
| apra-fleet-se | `packages/apra-fleet-se/test/spawner.test.mjs` | node --test | 30 | 3.20s | buildSprintArgv |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-plan-review-acceptable-alternative.test.mjs` | node --test | 1 | 3.04s | mock sprint: R2 names acceptable alternative X, R3 implements X, R3 plan-reviewer APPROVEs (no re-litigation) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-develop-doer-throws.test.mjs` | node --test | 1 | 2.98s | mock sprint: a doer that always throws is isolated; sibling streak still completes |
| apra-fleet-se | `packages/apra-fleet-se/test/reviewer-contract-replan-ids.test.mjs` | node --test | 5 | 2.93s | isReviewerContractViolation: CHANGES_NEEDED with only replanIds is NOT a contract violation |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-exit-goalpriority-p3.test.mjs` | node --test | 1 | 2.92s | mock sprint: an out-of-goal P3 bead does not block P1/P2 goal completion |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-beads-health-gate-empty-remote.test.mjs` | node --test | 2 | 2.92s | apra-fleet-eft.63.2: preflight D-pull against an empty never-pushed Dolt remote (Error 1105 "no branches found") |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns-session-guard.test.mjs` | node --test | 1 | 2.85s | mock sprint: a max_turns-exhausted doer streak resume calls the REAL pre-resume session guard (stop_prompt via callTool) before th |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-streak-assignment-no-duplicate-row.test.mjs` | node --test | 3 | 2.84s | runner.js has no reintroduced raw-JSON duplicate-dump log() call at any of the 10 apra-fleet-eft.69.1 dispatch sites |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-plan-cap-deferral.test.mjs` | node --test | 2 | 2.82s | mock sprint: plan-cap exhaustion confined to one bead defers it and develops the remainder |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-worklist-failure-isolation.test.mjs` | node --test | 1 | 2.81s | mock sprint (mode ii): a failure in streak 2 of 3 keeps streak 1\ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-review-scope-excludes-failed-streak.test.mjs` | node --test | 1 | 2.78s | mock sprint: a mixed develop round (one failed streak, one succeeded streak) sends only the succeeded bead into Review |
| apra-fleet-se | `packages/apra-fleet-se/test/k7b8-dolt-diverged-conflict-integration.test.mjs` | node --test | 1 | 2.78s | apra-fleet-k7b.8: a real sprint whose D-push bracket hits DOLT_DIVERGED surfaces BEADS_SYNC_CONFLICT with a captured conflict dump |
| apra-fleet-se | `packages/apra-fleet-se/test/vcs-auth-preflight.test.mjs` | node --test | 8 | 2.75s | createVcsAuthPreflightCallback |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-parent-child-blocks-cycle-repair.test.mjs` | node --test | 2 | 2.69s | mock sprint: pre-sprint validation auto-repairs a 2-node parent+blocks cycle instead of hard-failing |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-streak-partial-failure-attribution.test.mjs` | node --test | 1 | 2.69s | mock sprint: a 3-bead streak that closes 2 and refuses 1 keeps the 2 closed, re-dispatches only the 1, with an attribution log lin |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-ensure-branch-fetch-failure.test.mjs` | node --test | 2 | 2.68s | mock sprint: a non-"branch doesn\ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-develop-reopen.test.mjs` | node --test | 1 | 2.67s | mock sprint: reviewer reopenIds are applied by the orchestrator, not the reviewer itself |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-develop-orphaned.test.mjs` | node --test | 1 | 2.67s | mock sprint: an orphaned in_progress bead must not be read as sprint success |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-exit-explicit-fail.test.mjs` | node --test | 1 | 2.66s | mock sprint: an explicit final FAIL verdict propagates to status:failed and still publishes the PR |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-all-streaks-failed-no-review.test.mjs` | node --test | 1 | 2.66s | mock sprint: when every doer streak in a round fails, the develop-round Review is never dispatched |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-pr-injection.test.mjs` | node --test | 1 | 2.66s | mock sprint: adversarial final-verdict notes cannot inject into gh pr create |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-gh-failure.test.mjs` | node --test | 1 | 2.61s | mock sprint: an injected gh pr create failure surfaces as a typed error |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-develop-doer-lies.test.mjs` | node --test | 1 | 2.44s | mock sprint: a doer that lies about closing a bead is treated as a failure |
| apra-fleet-se | `packages/apra-fleet-se/test/runner-sprint-id-token-flow.test.mjs` | node --test | 1 | 2.40s | sprint-identity token used for member_reservation matches the token stamped on every real dispatch (apra-fleet-eft.29.2) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-stall-zero-progress.test.mjs` | node --test | 1 | 2.39s | mock sprint: zero-progress every cycle triggers a stall-abort well before max_cycles |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-reservation.test.mjs` | node --test | 11 | 2.35s | reservation e2e -- (a) member overlap -> 409 naming sprint + members |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-git-push-failure.test.mjs` | node --test | 1 | 2.34s | mock sprint: an injected git push failure surfaces as a typed error |
| apra-fleet-se | `packages/apra-fleet-se/test/0j1-watchdog-auto-release.test.mjs` | node --test | 4 | 2.22s | apra-fleet-0j1 / apra-fleet-cvb.1: watchdog auto-releases a still-held reservation on CRASHED/FINISHED classification |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-finalization-probe-failure.test.mjs` | node --test | 1 | 2.17s | mock sprint: a deploy.md probe failure skips Deploy/Integ without throwing |
| apra-fleet-se | `packages/apra-fleet-se/test/k7b7-exit-detail-integration.test.mjs` | node --test | 1 | 2.15s | apra-fleet-k7b.7: spawner exit code/signal/time recorded in ledger and surfaced by watchdog |
| apra-fleet-se | `packages/apra-fleet-se/test/cli-robustness.test.mjs` | node --test | 32 | 2.13s | parseCliArgs (a: strict flag parsing) |
| apra-fleet-se | `packages/apra-fleet-se/test/ou7.3-sprint-log-integration.test.mjs` | node --test | 1 | 2.13s | apra-fleet-ou7.3: every sprint has a traceable stdout/stderr log reachable from the dashboard |
| apra-fleet-se | `packages/apra-fleet-se/test/4ul-terminal-state-runid-keying.test.mjs` | node --test | 3 | 2.12s | apra-fleet-cvb.4: branch-name-shaped runId (with |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-watchdog.test.mjs` | node --test | 32 | 2.08s | watchdog -- four-status classifier |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-skeleton.test.mjs` | node --test | 19 | 2.07s | createSupervisor -- HTTP bootstrap + lifecycle |
| apra-fleet-se | `packages/apra-fleet-se/test/reservation-interop-e2e.test.mjs` | node --test | 10 | 2.07s | reservation interop e2e -- (1) reserve/release bracket, every exit path |
| apra-fleet-se | `packages/apra-fleet-se/test/k7b6-watchdog-finished-integration.test.mjs` | node --test | 3 | 1.97s | apra-fleet-k7b.6: watchdog classifies FINISHED with engine terminalReason and timestamped log lines |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-reconcile.test.mjs` | node --test | 17 | 1.96s | reconcile -- restart PID probe |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-dashboard.test.mjs` | node --test | 23 | 1.94s | dashboard -- statusBadge |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-log-view.test.mjs` | node --test | 19 | 1.92s | log-view -- resolveLogPath (ledger first, history fallback) |
| apra-fleet-se | `packages/apra-fleet-se/test/cli-server-resolution.test.mjs` | node --test | 14 | 1.89s | resolveFleetServerCommand |
| apra-fleet-se | `packages/apra-fleet-se/test/cli-transport-attach.test.mjs` | node --test | 9 | 1.88s | cli.mjs no longer constructs a StdioTransport (apra-fleet-eft.7.1) |
| apra-fleet-se | `packages/apra-fleet-se/test/k7b2-watchdog-finished-terminal-state.test.mjs` | node --test | 17 | 1.87s | apra-fleet-k7b.2: defaultHasTerminalState -- run-id first, legacy branch fallback |
| apra-fleet-se | `packages/apra-fleet-se/test/4ul-run-state-paths-sanitize.test.mjs` | node --test | 8 | 1.83s | apra-fleet-4ul / apra-fleet-cvb.3: sanitizeRunIdForFilename() and its callers |
| apra-fleet-se | `packages/apra-fleet-se/test/viewer-perf-regression-e2e.test.mjs` | node --test | 8 | 1.82s | apra-fleet-eft.27.3: GET /state on a 500+ activity fixture sprint |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-readopt.test.mjs` | node --test | 12 | 1.81s | readopt -- parseViewerPortFromCmdline |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-launch-form.test.mjs` | node --test | 19 | 1.76s | launch-form -- GOAL_OPTIONS |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-backlog.test.mjs` | node --test | 29 | 1.72s | backlog -- parentIdOf / normalizeBead |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-beads-health-gate-diverged.test.mjs` | node --test | 1 | 1.71s | apra-fleet-eft.58.2: a conflict-returning D-pull at the pre-flight beads-health gate aborts BEFORE any |
| apra-fleet-se | `packages/apra-fleet-se/test/error-classification-routing-table.test.mjs` | node --test | 22 | 1.71s | apra-fleet-9ta.7: error-classification routing table -- isTypedAbortError() x isNoMutationDispatchFailure() per class |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-history-view.test.mjs` | node --test | 15 | 1.68s | history-view -- isSafeSprintId / resolveOldSprintPath |
| apra-fleet-se | `packages/apra-fleet-se/test/k7b4-beads-sync-conflict-terminal-reason.test.mjs` | node --test | 12 | 1.66s | apra-fleet-k7b.4: findDoltDivergedCause() |
| apra-fleet-se | `packages/apra-fleet-se/test/0j1-watchdog-reservation-release.test.mjs` | node --test | 4 | 1.65s | watchdog -- apra-fleet-cvb.2: auto-release reservation on mid-run CRASHED/FINISHED classification |
| apra-fleet-se | `packages/apra-fleet-se/test/runner-arg-contract.test.mjs` | node --test | 35 | 1.65s | validateIssueId |
| apra-fleet-se | `packages/apra-fleet-se/test/typed-abort-classification.test.mjs` | node --test | 37 | 1.61s | apra-fleet-9ta.1: isTypedAbortError() -- TRUE for the curated abort set |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-planner-dpush-failure-no-redispatch.test.mjs` | node --test | 2 | 1.58s | unit: isPostDispatchSyncFailure identifies only a completed-dispatch sync failure |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-stall-contract-violation.test.mjs` | node --test | 1 | 1.54s | mock sprint: a self-contradictory CHANGES_NEEDED verdict surfaces as a distinct contract-violation error |
| apra-fleet-se | `packages/apra-fleet-se/test/contracts-schema-observability.test.mjs` | node --test | 5 | 1.51s | whole-directory absence stays quiet (documented fallback state) |
| apra-fleet-se | `packages/apra-fleet-se/test/fleet-members.test.mjs` | node --test | 8 | 1.50s | listFleetMembers (apra-fleet-eft.4.8.7) |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-proxy.test.mjs` | node --test | 14 | 1.43s | proxy -- rewriteChildHtml |
| apra-fleet-se | `packages/apra-fleet-se/test/plan-reviewer-dispatch-failure.test.mjs` | node --test | 2 | 1.39s | mock sprint: plan-reviewer transport failures on every round produce PlanReviewDispatchFailedError, not SprintPlanRejectedError |
| apra-fleet-se | `packages/apra-fleet-se/test/sprint-lock-engine-wiring.test.mjs` | node --test | 2 | 1.39s | runner.js main(): sprint-lock wiring (apra-fleet-eft.75.2) |
| apra-fleet-se | `packages/apra-fleet-se/test/runner-member-reservation.test.mjs` | node --test | 9 | 1.37s | createMemberReservationClient (apra-fleet-eft.26.1) |
| apra-fleet-se | `packages/apra-fleet-se/test/rejected-newtask-resurface.test.mjs` | node --test | 26 | 1.36s | trackRejectedNewTaskForResurfacing |
| apra-fleet-se | `packages/apra-fleet-se/test/contracts-schema-packaging.test.mjs` | node --test | 5 | 1.34s | resolveSchemasDir path-precedence (direct exercise, no real filesystem dependency) |
| apra-fleet-se | `packages/apra-fleet-se/test/contracts-schema-loader.test.mjs` | node --test | 19 | 1.34s | loadSchemaFileFrom (loader primitive) |
| apra-fleet-se | `packages/apra-fleet-se/test/jfo-verify-set-classifier.test.mjs` | node --test | 18 | 1.33s | classifyVerifySet |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-self-log.test.mjs` | node --test | 8 | 1.32s | self-log -- formatLocalTimestamp |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-planner-dispatch-dead-pid.test.mjs` | node --test | 1 | 1.30s | _(no top-level title)_ |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-planner-auth-failure-no-retry.test.mjs` | node --test | 2 | 1.30s | unit: isNonRetryableDispatchError matches auth/trust signatures and nothing else |
| apra-fleet-se | `packages/apra-fleet-se/test/streak-lane-grouping.test.mjs` | node --test | 12 | 1.29s | groupStreaksFromLaneMetadata: fully-laned plan groups by streak id and returns reason:null |
| apra-fleet-se | `packages/apra-fleet-se/test/newtask-body-file-roundtrip.test.mjs` | node --test | 6 | 1.29s | createChildBeadWithAllocatedId / appendRejectedFindingToParentNotes -- member-staged body round-trip (apra-fleet-eft.56.2 / eft.73 |
| apra-fleet-se | `packages/apra-fleet-se/test/vcs-auth-self-heal.test.mjs` | node --test | 10 | 1.29s | parseOwnerRepoFromRemoteUrl |
| apra-fleet-se | `packages/apra-fleet-se/test/cost-analysis-integ-line.test.mjs` | node --test | 4 | 1.28s | buildCostAnalysis reports a DISTINCT integ-test-runner line (not folded into overhead) when the phase dispatched with tracked spen |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-pure-logic.test.mjs` | node --test | 14 | 1.28s | parseBdJson: noisy (non-JSON) bd output produces a diagnostic error, not a bare SyntaxError |
| apra-fleet-se | `packages/apra-fleet-se/test/conflict-ladder-tier2.test.mjs` | node --test | 9 | 1.28s | buildConflictResolutionRunbookPrompt: is ASCII-only and names every conflicted file, the member, and the branch |
| apra-fleet-se | `packages/apra-fleet-se/test/ed4-atomic-rename-retry.test.mjs` | node --test | 10 | 1.27s | apra-fleet-ed4.2: history.mjs createHistory() persist() rename retry |
| apra-fleet-se | `packages/apra-fleet-se/test/eft49-watchdog-interval-reentrancy.test.mjs` | node --test | 3 | 1.26s | watchdog interval reentrancy guard (apra-fleet-eft.4.9.3) |
| apra-fleet-se | `packages/apra-fleet-se/test/newtask-body-member-side-transport.test.mjs` | node --test | 3 | 1.24s | apra-fleet-eft.73.2 -- newTask/notes body reaches member-side without an orchestrator-host path |
| apra-fleet-se | `packages/apra-fleet-se/test/sprint-lock.test.mjs` | node --test | 13 | 1.24s | sprintLockKey |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-scope-overlap.test.mjs` | node --test | 7 | 1.24s | scope-overlap -- live subtree expansion |
| apra-fleet-se | `packages/apra-fleet-se/test/contracts.test.mjs` | node --test | 45 | 1.23s | ROLES |
| apra-fleet-se | `packages/apra-fleet-se/test/runner-role-input-contract.test.mjs` | node --test | 10 | 1.23s | runner role-input contract tripwire (N13; guards N1) |
| apra-fleet-se | `packages/apra-fleet-se/test/mcp-coordination-clients.test.mjs` | node --test | 8 | 1.22s | createMcpDoltPushMutexClient (apra-fleet-f34.2) |
| apra-fleet-se | `packages/apra-fleet-se/test/dolt-remote-unreachable.test.mjs` | node --test | 6 | 1.20s | classifyDoltFailure: remote-unreachable (run-24 abort regression pin) |
| apra-fleet-se | `packages/apra-fleet-se/test/round-session-registry.test.mjs` | node --test | 8 | 1.19s | R1 (no prior round) resumes nothing -- resumeArgFor returns false |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-git-sync-brackets.test.mjs` | node --test | 22 | 1.19s | classifyGitFailure: non-FF / unmerged / conflict outputs classify as diverged |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session.test.mjs` | node --test | 1 | 1.19s | _(no top-level title)_ |
| apra-fleet-se | `packages/apra-fleet-se/test/eft52-goal-placement.test.mjs` | node --test | 12 | 1.19s | partitionByGoalMembership (runner.js): server-side goal membership |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-history.test.mjs` | node --test | 17 | 1.19s | history -- record()/list()/latestFor() basics |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-retry-resume-remote-tip.test.mjs` | node --test | 3 | 1.17s | syncMemberBefore: resetToRemoteTip defaults false, so a non-retry (or non-mutating-retry) call keeps the exact prior ff-only-merge |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-watchdog-timeout-sync-teardown.test.mjs` | node --test | 1 | 1.17s | mock sprint: a watchdog_timeout Planner dispatch failure still runs the post-dispatch sync teardown, publishing the beads the stal |
| apra-fleet-se | `packages/apra-fleet-se/test/member-session-guard.test.mjs` | node --test | 10 | 1.16s | createMemberSessionGuard (apra-fleet-eft.75.1) |
| apra-fleet-se | `packages/apra-fleet-se/test/f34-concurrent-launch-engagement-integration.test.mjs` | node --test | 2 (2 skip) | 1.15s | apra-fleet-f34.3: real concurrent launches engage the HTTP mutex/id-allocator (no silent no-op fallback) |
| apra-fleet-se | `packages/apra-fleet-se/test/mock-sprint-plan-contracts.test.mjs` | node --test | 1 | 1.14s | mock sprint: plan-reviewer that never approves aborts after 3 rounds with zero doer dispatches |
| apra-fleet-se | `packages/apra-fleet-se/test/model-tier-normalization.test.mjs` | node --test | 6 | 1.14s | normalizeTierToken |
| apra-fleet-se | `packages/apra-fleet-se/test/fatal-diagnostics-guard.test.mjs` | node --test | 5 | 1.13s | installFatalDiagnosticsGuard -- doer-dispatch boundary fatal diagnostics |
| apra-fleet-se | `packages/apra-fleet-se/test/contracts-schemas-dir-resolution.test.mjs` | node --test | 5 | 1.11s | resolveSchemasDir |
| apra-fleet-se | `packages/apra-fleet-se/test/worklist-assignment.test.mjs` | node --test | 27 | 1.10s | streakRequiredTier: the MAX (most capable) tier across member beads |
| apra-fleet-se | `packages/apra-fleet-se/test/newtasks-validation.test.mjs` | node --test | 20 | 1.09s | validateNewTask |
| apra-fleet-se | `packages/apra-fleet-se/test/ensure-branch-decision.test.mjs` | node --test | 7 | 1.06s | decideEnsureBranchAction: local-only branch + missing remote ref -> reuse local as-is (commit-preserving) |
| apra-fleet-se | `packages/apra-fleet-se/test/dispatch-watchdog.test.mjs` | node --test | 3 | 1.04s | withDispatchWatchdog: a dispatch that settles within budget passes through unchanged and never logs a timeout |
| apra-fleet-se | `packages/apra-fleet-se/test/doer-prompt-permission-directive.test.mjs` | node --test | 6 | 1.03s | buildDoerPrompt: surface-dont-bypass permission-block directive |
| apra-fleet-se | `packages/apra-fleet-se/test/effort-point-split.test.mjs` | node --test | 4 | 1.03s | constants match the planner.md-documented values |
| apra-fleet-se | `packages/apra-fleet-se/test/sanitize-pr-text.test.mjs` | node --test | 10 | 1.00s | sanitizePrText |
| apra-fleet-se | `packages/apra-fleet-se/test/viewer-extensions.test.mjs` | node --test | 74 | 1.00s | beadsExtension.detailLookup: relocated findBeadById (server-side hook) |
| apra-fleet-se | `packages/apra-fleet-se/test/regression-phase-never-gates.test.mjs` | node --test | 12 | 0.98s | Regression Test phase can never gate or abort the sprint |
| apra-fleet-se | `packages/apra-fleet-se/test/vcs-module.test.mjs` | node --test | 10 | 0.92s | VCSModule.buildCreatePrCommand |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-dolt-mutex.test.mjs` | node --test | 13 | 0.79s | dolt-mutex -- mutual exclusion / non-overlapping push windows |
| apra-fleet-se | `packages/apra-fleet-se/test/dispatch-sync-bracket-coverage.test.mjs` | node --test | 2 | 0.76s | every agent() dispatch call site is either wrapped by withGitSync(...) or is the one documented exemption |
| apra-fleet-se | `packages/apra-fleet-se/test/dolt-settle.test.mjs` | node --test | 20 | ~0.4s | settleDoltConflicts resolves every row-level conflict shape deterministically -- per-field LWW, labels set-union, teardown-before-republish ordering, pinned-dolt install ladder |
| apra-fleet-se | `packages/apra-fleet-se/test/bd-init-templating.test.mjs` | node --test | 1 (1 skip) | 0.69s | apra-fleet-3ei: real-mode `bd init` is templated -- one real spawn serves every scenario setup in this process |
| apra-fleet-se | `packages/apra-fleet-se/test/supervisor-rename-with-retry.test.mjs` | node --test | 12 | 0.65s | renameWithRetry (apra-fleet-ed4.1) |
| apra-fleet-se | `packages/apra-fleet-se/test/dispatch-safety-guard.test.mjs` | node --test | 3 | 0.61s | every command()/agent() call site in runner.js passes member_name or member_id |
| apra-fleet-se | `packages/apra-fleet-se/test/dashboard-tree-grandchild-nesting.test.mjs` | node --test | 1 | 0.60s | renderBeadsHtml: DOM-level nesting of a 3-level parent chain (grandchild) |
| apra-fleet-se | `packages/apra-fleet-se/test/sandbox-seed-guard.test.mjs` | node --test | 6 | 0.56s | validateSandboxSeedPaths |
| apra-fleet-se | `packages/apra-fleet-se/test/scaled-timeout.test.mjs` | node --test | 10 | 0.53s | unit: scaledTimeout(baseMs) === baseMs when concurrency is unset |
| apra-fleet-se SLOW LANE | `packages/apra-fleet-se/test/slow/dispatch-watchdog-timer-ref.test.mjs` | node --test (test:slow) | ? | _(suite-level only)_ | _(no top-level title)_ |
| apra-fleet-se SLOW LANE | `packages/apra-fleet-se/test/slow/mock-sprint-planner-dispatch-stalled-session.test.mjs` | node --test (test:slow) | ? | _(suite-level only)_ | _(no top-level title)_ |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/agent-schema-validation.test.mjs` | node --test | 6 | _(suite-level only)_ | agents/schemas/ is non-empty |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/args-skill-gates.test.mjs` | node --test | 4 | _(suite-level only)_ | evaluateGates: no args-skill gates unless expectArgsSkill is set |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/auto-sprint-args-skill.test.mjs` | node --test | 4 | _(suite-level only)_ | claude permissions include Skill(auto-sprint-args) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/auto-sprint-schemas-drift.test.mjs` | node --test | 3 | _(suite-level only)_ | auto-sprint.js has no real require() call anywhere in its executable script body -- the Workflow tool sandbox has neither filesyst |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/bd-json-warning-tolerance.test.mjs` | node --test | 3 | _(suite-level only)_ | no raw JSON.parse(d) remains -- every bd-json extractor goes through BD_JSON |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/bd-subtree-inventory.test.mjs` | node --test | 5 | _(suite-level only)_ | no bd-graph extractor scrapes every .issues[].id (siblings would leak) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/ci-watcher.test.mjs` | node --test | 12 | _(suite-level only)_ | ci-watcher dispatch is conditioned on prNumber (post-PR ordering) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/cost-extraction.test.mjs` | node --test | 19 | _(suite-level only)_ | auto-sprint.js has PURE_FUNCTIONS_BEGIN marker |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/cycle-checkpoint.test.mjs` | node --test | 7 | _(suite-level only)_ | type:meta JSONL entry is written before the sprint loop |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/develop-progress-log.test.mjs` | node --test | 11 | _(suite-level only)_ | labelTaskIds: single id returns that id |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/doer-jit-close.test.mjs` | node --test | 4 | _(suite-level only)_ | doer.md instructs closing each task with bd close before the next task |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/doer-verify-stop-rule.test.mjs` | node --test | 3 | _(suite-level only)_ | doer.md Step 3 states the ONLY next action after the last bead closes is emitting the VERIFY JSON |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/e2e-heal-seed.test.mjs` | node --test | 4 | _(suite-level only)_ | healDoltSeed is defined and called from teardown |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/e2e-scenario-skip-dolt.test.mjs` | node --test | 2 | _(suite-level only)_ | the auto-sprint e2e scenario instructs skip_dolt_push = true |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/exit-check-leaf-scope.test.mjs` | node --test | 11 | _(suite-level only)_ | leaf-scoped: roots are EXCLUDED even when open; open non-root task IS counted |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/feedback-dispatch.test.mjs` | node --test | 9 | _(suite-level only)_ | dev-path feedback dispatch is NOT awaited (fire-and-forget) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/harvest-dolt-push.test.mjs` | node --test | 10 | _(suite-level only)_ | Harvest section contains a step that invokes bd dolt push |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/harvest-process-cleanup.test.mjs` | node --test | 2 | _(suite-level only)_ | a harvest process-file cleanup dispatch exists and removes feedback.md/requirements.md |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/harvester-analysis.test.mjs` | node --test | 9 | _(suite-level only)_ | harvester prompt instructs writing analysisText to .analysis.md as Step 1 |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/install-permissions.test.mjs` | node --test | 6 | _(suite-level only)_ | claudeOnlyPermissions()[0] === "Bash(*)" |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/install-schemas.test.mjs` | node --test | 4 | _(suite-level only)_ | agents/schemas/ exists in this checkout with at least one schema file |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/install-uninstall.test.mjs` | node --test | 8 | _(suite-level only)_ | uninstall() removes the whole skills/pm directory |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/integ-scope.test.mjs` | node --test | 4 | _(suite-level only)_ | integ tester dispatch does NOT instruct the global `bd list --type=feature --status=open` |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/merged-parser-index.test.mjs` | node --test | 11 | _(suite-level only)_ | parseBlockers reads open list from outputs[rootCount] (single root) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/null-return-recovery.test.mjs` | node --test | 8 | _(suite-level only)_ | null branch does NOT assign abortReason of "doer null" (no sprint abort) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/orphan-reset.test.mjs` | node --test | 8 | _(suite-level only)_ | orphan reset is guarded: dispatch only when inProgressIds.length > 0 |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/parallel-doers-pure.test.mjs` | node --test | 11 | _(suite-level only)_ | computeDoerBatch flattens streaks, dedupes, and caps at maxDoers |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/parallel-harvest.test.mjs` | node --test | 4 | _(suite-level only)_ | parallel() call groups calibration-update and close-sprint-goals dispatches |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/parse-sprint-args.test.mjs` | node --test | 17 | _(suite-level only)_ | null/undefined/empty returns {} |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/plan-commit-cmds.test.mjs` | node --test | 8 | _(suite-level only)_ | planCommitCmds array starts with per-task bd update commands (source check) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/pm-integ-scope.test.mjs` | node --test | 4 | _(suite-level only)_ | integ-test-runner agent has NO unscoped `bd list --type=feature --status=open` command |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/preflight-pure-fns.test.mjs` | node --test | 12 | _(suite-level only)_ | validateSprintArgs: accepts a well-formed object |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/preflight-schema-gate.test.mjs` | node --test | 4 | _(suite-level only)_ | a preflight probe runs a read-only bd command labeled preflight-bd-schema |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/push-sha-dispatch.test.mjs` | node --test | 5 | _(suite-level only)_ | push-sha dispatch uses dispatchShell with both git push and git rev-parse HEAD |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/setup-dispatch.test.mjs` | node --test | 11 | _(suite-level only)_ | setup dispatchShell is labeled "setup-shell" (source check) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/shell-dispatch.test.mjs` | node --test | 19 | _(suite-level only)_ | collectSubtreeIds: unions whitespace-joined ID lists across sprint roots |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/skill-pm-roles.test.mjs` | node --test | 6 | _(suite-level only)_ | SKILL.md does not contain stale "four roles" or "four kinds of subagent" language |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/skill-pm-tags-dispatch.test.mjs` | node --test | 21 | _(suite-level only)_ | SKILL.md R9 uses tags: [\ |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/sprint-cost.test.mjs` | node --test | 54 | _(suite-level only)_ | reviewerModelFor: opus stays opus |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/sprint-execution-summary.test.mjs` | node --test | 24 | _(suite-level only)_ | buildExecutionSummary: returns string containing Sprint Execution Summary heading |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/sprint-log-flush.test.mjs` | node --test | 9 | _(suite-level only)_ | appendNewEntries uses __FLUSH_TS__ placeholder, not the static sprint-start timestamp |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/sprint-meta.test.mjs` | node --test | 6 | _(suite-level only)_ | meta record source contains required fields: type meta, transcriptDir, branch, roots, goal, ts |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/sprint-state-checkpoint.test.mjs` | node --test | 4 | _(suite-level only)_ | auto-sprint.js does not call Buffer (unavailable in the workflow sandbox) |
| apra-pm (nested) | `packages/apra-fleet-se/apra-pm/test/streak-ceiling.test.mjs` | node --test | 4 | _(suite-level only)_ | truncateStreakToCeiling: all-L streak over ceiling is truncated to prefix with sum <= ceiling |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-bead-description.test.mjs` | node --test | 7 | _(suite-level only)_ | apra-fleet-eft.37.4: GET /extensions/:extId/detail/:itemId (generic hook) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-budget-usage.test.mjs` | node --test | 23 | _(suite-level only)_ | apra-fleet-unw.4: honest usage reporting |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-busy-and-empty.test.mjs` | node --test | 8 | _(suite-level only)_ | agent() busy-wait |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-command-output-cap-perf.test.mjs` | node --test | 6 | _(suite-level only)_ | apra-fleet-eft.27.5: many multi-MB command activities, mirroring the eft.27 measured root cause at scale |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-command-output-cap.test.mjs` | node --test | 10 | _(suite-level only)_ | apra-fleet-eft.27.4: capOutputText() |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-concurrency.test.mjs` | node --test | 3 | _(suite-level only)_ | apra-fleet-unw.9: per-run execution context (F11) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-debounced-writer.test.mjs` | node --test | 12 | _(suite-level only)_ | apra-fleet-eft.2.1: DebouncedStateWriter unit behavior |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-ephemeral-ports.test.mjs` | node --test | 3 | _(suite-level only)_ | apra-fleet-eft.13.4: EADDRINUSE regression -- ephemeral viewer ports survive orphaned former-fixed-port holders |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-errors.test.mjs` | node --test | 17 | _(suite-level only)_ | agent() typed error classification |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-examples.test.mjs` | node --test | 2 | _(suite-level only)_ | F1: shipped export-function example scripts load and run under the real ES-module loader |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-hard-kill.test.mjs` | node --test | 2 | _(suite-level only)_ | apra-fleet-eft.2.4 / eft.37.1: continuous persistence survives a real SIGKILL |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-journal.test.mjs` | node --test | 16 | _(suite-level only)_ | apra-fleet-unw.11 (F6): journal writer -- JSONL shape |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-lean-state.test.mjs` | node --test | 18 | _(suite-level only)_ | truncate() |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-phase-timestamps.test.mjs` | node --test | 2 | _(suite-level only)_ | apra-fleet-eft.53.1: GET /state stamps phaseStartedAt for every phase, phaseEndedAt only for exited phases |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-real-pricing.test.mjs` | node --test | 7 | _(suite-level only)_ | apra-fleet-dv5.6: real per-member pricing preferred over tier-band fallback |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-schema-repair.test.mjs` | node --test | 10 | _(suite-level only)_ | apra-fleet-unw.8: robust JSON extraction (greedy-regex failure mode is dead) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-sprint-state.test.mjs` | node --test | 8 | _(suite-level only)_ | apra-fleet-eft.2.3 / eft.37.1: running/ -> old_runs/ layout under the service data dir |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-viewer-generic-row-model.test.mjs` | node --test | 4 | _(suite-level only)_ | viewer source never special-cases an auto-sprint role/phase name (apra-fleet-eft.69 HARD CONSTRAINT) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-viewer-lifecycle.test.mjs` | node --test | 13 | _(suite-level only)_ | apra-fleet-unw.10: engine end event |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow-viewer-more-output-button.test.mjs` | node --test | 12 | _(suite-level only)_ | a REAL capped activity (markers + summary, no inline output field) renders the more-btn |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/apra-fleet-workflow.test.mjs` | node --test | 19 | _(suite-level only)_ | FleetWorkflow.sequential() |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/boundary-no-domain-leakage.test.mjs` | node --test | 3 | _(suite-level only)_ | boundary-no-domain-leakage |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/deploy-runbook-platform-selection.test.mjs` | node --test | 6 | _(suite-level only)_ | deploy.md Deploy-section platform+arch selection (apra-fleet-eft.15.2) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/test-example-sprint-runner.test.mjs` | node --test | 1 | _(suite-level only)_ | examples/02-sprint-runner.js (pipeline-based multi-stage flow) |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/test-runner.test.mjs` | node --test | 12 | _(suite-level only)_ | WorkflowEngine executing fixture scripts against a mock fleet API |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/viewer-heartbeat-quiet-period-dom.test.mjs` | node --test | 3 | _(suite-level only)_ | apra-fleet-36l.2: quiet period (no SSE messages) -- the heartbeat interval alone drives poll() at its configured cadence, which is |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/viewer-phase-duration-dom.test.mjs` | node --test | 3 | _(suite-level only)_ | (a) a completed-phase fixture renders the formatted duration |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/viewer-running-elapsed-dom.test.mjs` | node --test | 4 | _(suite-level only)_ | a running row (isRunning true, has startTime, no duration yet) renders nonzero elapsed since start |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/viewer-stream-list-scroll-dom.test.mjs` | node --test | 4 | _(suite-level only)_ | apra-fleet-eft.43.3: the real template still carries every rung of the bounded flex chain |
| apra-fleet-workflow | `packages/apra-fleet-workflow/test/viewer-template-scroll-perf.test.mjs` | node --test | 7 | _(suite-level only)_ | flex scroll chain carries min-height: 0 down to the stream list |
| apra-fleet-client | `packages/apra-fleet-client/test/fleet-client-api.test.mjs` | node --test | 16 | _(suite-level only)_ | ApraFleet |
| apra-fleet-client | `packages/apra-fleet-client/test/fleet-client-timeout.test.mjs` | node --test | 9 | _(suite-level only)_ | McpClient.request rejects with .code=TIMEOUT when the transport never replies |
| apra-fleet-client | `packages/apra-fleet-client/test/fleet-client-transport.test.mjs` | node --test | 4 | _(suite-level only)_ | McpClient - callTool successfully |
| apra-fleet-client | `packages/apra-fleet-client/test/transport-idle-timeout-guard.test.mjs` | node --test | 1 | _(suite-level only)_ | StreamableHttpTransport disables undici idle timeouts on every fetch |
| apra-fleet-client | `packages/apra-fleet-client/test/transport-reconnect.test.mjs` | node --test | 1 | _(suite-level only)_ | persistent GET stream reconnects after dying instead of emitting close |

---

## 3. Duplicates

Grouped clusters, with the evidence for overlap and a recommended survivor.

### 3.1 `tests/install-dev-manifest.test.ts` is fully duplicated -- strongest case in the repo

`tests/install-dev-manifest.test.ts:30-73` vs `tests/install-workflows.test.ts:470-523`.
Same regression (the `vendor/apra-pm` -> `packages/apra-fleet-se/apra-pm` move), same
unmocked real-repo-root target, same four assertions:

| Assertion | dev-manifest | install-workflows |
|---|---|---|
| all 3 manifest sections non-empty | `:35-44` | `:488-498` |
| `hasWorkflowSubsystemAssets() === true` | `:46` | `:502` |
| every asset path exists on disk | `:49-60` | `:519-522` |
| no path contains `vendor/apra-pm` | `:62-73` | `:504-514` |

`install-workflows.test.ts` is a strict superset -- it additionally pins the
`doer-input.json` / `doer-output.json` key names at `:491-492`.
**Survivor: `install-workflows.test.ts`.**

### 3.2 Busy-lock self-heal block copy-pasted into `execute-prompt.test.ts`

Five scenarios exist verbatim in both files, both citing bead `apra-fleet-idb`:

| Scenario | `tests/execute-prompt.test.ts` | `tests/execute-prompt-idb-busy-lock.test.ts` |
|---|---|---|
| remote pid confirmed dead -> release | `:842-870` | `:68-106` |
| remote pid ALIVE -> stay busy | `:872-898` | `:174-210` |
| local pid dead -> release | `:900-927` | `:108-134` |
| interactive launch pid dead -> release | `:929-964` | `:136-170` |
| no pid captured -> conservative busy | `:792-810` | `:212-241` |

The dedicated file also has two unique cases (`:245-274`, `:276-301`), making it the
broader one. **Survivor: `execute-prompt-idb-busy-lock.test.ts`**; the ~175 duplicated
lines in `execute-prompt.test.ts` are the removable copy.

### 3.3 `tests/cloud-integration.test.ts` is a duplicate sampler

- `cloud-integration.test.ts:125-155` ("execute_command auto-start") equals
  `tests/cloud-lifecycle.test.ts:82-134` -- identical mocks (`strategy.js` +
  `cloud/lifecycle.js`), identical
  `mockEnsureCloudReady.toHaveBeenCalledWith(expect.objectContaining({id}))` and
  `mockExecCommand.toHaveBeenCalledOnce()`, and the same literal error string
  `'Instance i-0abc is terminated'` on both sides (`:149` vs `cloud-lifecycle.test.ts:121-133`).
  `cloud-lifecycle.test.ts` additionally covers execute-prompt (`:136-177`) and
  send-files (`:179-214`) wiring.
- `cloud-integration.test.ts:161-205` ("idle auto-stop") equals
  `tests/idle-manager.test.ts:148-164` -- same mock set, same
  `new IdleManager(); start(60_000); await checkOnce()` sequence, same three
  assertions. `idle-manager.test.ts` also covers GPU-busy, fleet-process-busy,
  already-stopped, mutex, and error paths.

`cloud-integration.test.ts:207-268` (long_running / restart_command wrapper) and
`:270-352` (monitor_task auto-stop) are unique and must stay.
**Survivors: `cloud-lifecycle.test.ts` and `idle-manager.test.ts`** for the duplicated
halves.

### 3.4 Real `bd --version` invocation tested twice

`tests/exec-bd.test.ts:152-159` and
`tests/2cc-win-bd-invocation-integ.test.ts:52-56` both import
`../scripts/lib/exec-bd.mjs`, both shell out to a real `bd --version`, both assert
`/bd version/`. **Survivor: `exec-bd.test.ts`** (the unit-level home of that helper).

Note `tests/2cc-win-bd-invocation-integ.test.ts` is also the slowest file in the root
suite at **18.01s** for 5 tests.

### 3.5 Stall-detector lifecycle duplicated

`tests/stall-detector-integration.test.ts:62-121` (four `add`/`remove`/`update` tests
on a bare `new StallDetector()`) duplicates `tests/stall-detector.test.ts:69-112` --
same unmocked class, same methods, same `getEntry` / `stallCheckList.size`
assertions. Only the narrative framing differs. Lines `:124-236` of the
`-integration` file are genuinely integration (`member_detail` / `fleet_status`
surfacing `lastLlmActivityAt` / `idleSecs`) and must stay.
**Survivor: `stall-detector.test.ts`** for the lifecycle half.

### 3.6 Mis-titled near-empty test with leftover authoring notes

`tests/execute-prompt-substitution.test.ts:59-79` and `:82-95` both exercise the
identical `{{secure.NAME}}` rejection path. The first test's title claims "staged
verbatim" but the body never asserts that; lines `:73-77` contain leftover authoring
commentary ("Actually re-reading: the existing guard rejects this. Let me test
that..."). It only checks that `credentialResolve` was not called, which the second
test covers plus more. **Survivor: `:82-95`.**

### 3.7 `mock-sprint-finalization-git-push-failure.test.mjs` no longer hits its target

`mock-sprint-finalization-git-push-failure.test.mjs:36` injects
`gitGhFailurePattern: /^git push\b/`. The file's own header (`:20-28`) concedes this
no longer reaches the finalization push at all -- the per-dispatch sync bracket's
G-push now matches first. The assertion degraded accordingly: `:41-45` accepts **any
of** `CommandError | GitSyncError | PostDispatchSyncError`. A test accepting three
error types from an unknown call site pins almost nothing.

Still covered after removal:
- finalization push: `mock-sprint-publish-push-failure.test.mjs:36` (precisely
  targeted `/^git push -u origin/`), with far stronger assertions -- `:65`
  `publishPushes.length === 3`, `:50` `result.pushed === false`, `:57` zero ABORTED
  states, `:79` no PR-create dispatched.
- generic typed-error propagation:
  `mock-sprint-finalization-gh-failure.test.mjs:32` (`error instanceof CommandError`).
- the bracket G-push path it now actually hits:
  `mock-sprint-git-sync-brackets.test.mjs:242-252`, in ~0ms.

This was recommendation #4 in the existing `TEST-VALUE-ANALYSIS.md` and was never
executed; the case is stronger now than when that document was written. **80s.**

### 3.8 "Explicit FAIL still publishes a PR" asserted twice

| `mock-sprint-exit-explicit-fail.test.mjs` | `mock-sprint-abort-pr.test.mjs` |
|---|---|
| `:29` `result.status === 'failed'` | `:381` same |
| `:42` `commandLog.find(c => c.startsWith('curl -sS -X POST') && c.includes('/pulls'))` | `:383` identical expression |
| `:47` `/"title":"[^"]*FAIL[^"]*"/ && /Final Verdict: FAIL/` | `:384` `prCmd.includes('FAIL')` (strictly weaker) |
| -- | `:385` `!prCmd.includes('[ABORTED]')` (the only unique assertion) |

**Survivor: `exit-explicit-fail`** (stronger PR-text assertion). Move the one-line
`![ABORTED]` check into it and delete `abort-pr:368-387`. Saves one full sprint.

### 3.9 `mock-sprint-abort-pr.test.mjs:357-366` -- worst cost/value ratio found

This block calls **`runOnce('abortprpass')`** -- the same full 7-role, 5-cycle sprint
the flagship happy-path test uses -- to assert three things: `status === 'success'`
(`:361`), a PR curl exists (`:363`), and `!prCmd.includes('[ABORTED]')` (`:364`).

The first two are already asserted by `mock-sprint-happy-path.test.mjs:52` and
`:145-164` (the finalization-tail sequence check, which pins the exact
`curl .../pulls` command as the last entry). Only the negative substring is new.
**Survivor: `happy-path`**; add the one-line negative beside `happy-path.test.mjs:379`.
That is roughly **120s of `abort-pr`'s 263s** spent on one substring check.

### 3.10 `integ-passed-summary-log` tests 2 and 3 duplicate `integ-infra-dispatch-failure`

Each pair is a separately-run full sprint asserting the same log string:

| Assertion | `integ-passed-summary-log` | `integ-infra-dispatch-failure` |
|---|---|---|
| `'Integration tests FAILED this cycle'` on `passed:false` | `:94` | `:150` |
| `'Integration tests INCONCLUSIVE this cycle'` + `'infra dispatch failure (dispatch_failed)'` | `:125` | `:113` |

Both build the same scenarios (1 cycle, 1 task, `withRunbooks:true`,
`closeAssignedDoer` / `approveReviewer`). The only delta is an added negative
`!logs.some('Integration tests PASSED this cycle')` at `:98` and `:129`.
**Survivor: `integ-infra-dispatch-failure`**; move those two negatives to its `:121`
and `:154` (which already assert the complementary negatives in the same place), and
reduce `integ-passed-summary-log` to its genuinely unique test 1 (`:57-65`). Removes
2 of 3 full sprints from that file.

### 3.11 apra-pm: `sprint-execution-summary.test.mjs` re-tests `sprint-cost.test.mjs`

`sprint-cost.test.mjs:7-24` evals the `PURE_FUNCTIONS_BEGIN/END` block from
`.claude/workflows/auto-sprint.js` and covers all pure functions.
`sprint-execution-summary.test.mjs:31-208` (roughly 14-19 of its 24 tests) re-tests
`buildExecutionSummary` / `buildSprintSummary`, already covered at
`sprint-cost.test.mjs:426-549` and `:561-618` -- same assertion intent, different
fixture data (heading `:31-38` vs `:561-574`; phase breakdown `:42-57` vs `:607-618`;
cycles `:86-91` vs `:569`; `goalMet=false` risks `:111-154` vs `:596-605`).

Unique and worth keeping: `sprint-execution-summary.test.mjs:212-258` (5 wiring tests
against the raw source string). **Survivor: `sprint-cost.test.mjs`** for `:31-208`.

`cost-extraction.test.mjs` is a different subject (install.mjs's extraction
mechanism, `:22-45`, `:82-177`) -- keep it; only `:142-152` duplicates
`sprint-cost.test.mjs:99-105`.

### 3.12 apra-fleet-workflow: duplicated CSS-rung assertion

`viewer-stream-list-scroll-dom.test.mjs:37-46` re-declares the same flex-chain CSS
`rungs` already asserted at `viewer-template-scroll-perf.test.mjs:57`.
**Survivor: either**, but fold to one.

### Clusters checked and found NOT to be duplication

These were suspected up front and cleared with evidence -- recorded so the question
does not get re-litigated:

- **`credential-*` (10 files, 2132 lines):** all distinct layers.
  `credential-store-set` = MCP tool; `credential-store-update` = service + tool;
  `credential-store-path` = `APRA_FLEET_DATA_DIR` resolution;
  `credential-store-and-execute` = round-trip + redaction; `credential-scoping-ttl` =
  `allowedMembers` / TTL / purge; `secret-cli` = CLI layer. TTL is asserted at three
  layers (`credential-store-set.test.ts:96-119`,
  `credential-scoping-ttl.test.ts:124-178`, `secret-cli.test.ts:467-480`) -- three
  different call surfaces, legitimate. Mis-clustered by name only:
  `credential-validation.test.ts` tests OAuth expiry math and
  `windows-credential-helper.test.ts` tests PowerShell escaping in `src/os/index.ts`;
  neither touches the secret store.
- **`register-member*` (6 files):** each mocks a distinct seam -- compose-permissions
  auto-run, bootstrap kill-switch, CLI flag parsing, `llm_provider:'none'`, OOB
  credential collection, agent-file provisioning.
- **`install*` / `update*` (apart from 3.1):** `install-dolt.test.ts` (install.ts
  `_setDoltStepDeps` wiring) vs `dolt-install.test.ts` (zip/tar extraction
  primitives) are split by the code itself. `update.test.ts` (SEA download/spawn) vs
  `update-npm.test.ts` (npm/dev early-return) vs `update-check.test.ts` (service-level
  `isNewer`) share no assertions.
- **`auth-*` / `provision-*` / `vcs-auth` / `revoke-vcs-auth`:** three real layers.
  `auth-socket.test.ts` always injects a fake `launchFn`, so
  `auth-terminal-wait.test.ts` (real `spawn` args) is complementary.
- **`tests/activity.test.ts` vs `tests/hub-service/activity.test.ts`:** name collision
  only. The root file tests `checkMemberActivity` (GPU/idle probing); the hub file
  runs real SQL migrations against `pg-mem` for the audit feed. No shared code path.
- **`check-sandbox-sync-remote` trio:** three real layers -- in-process unit,
  subprocess entrypoint, real `git fetch`. Minor overlap only at `-integ:316` /
  `-fetch-integ:174`.
- **`relay-*` / `watch-*` / `file-transfer-*`:** no duplication found.
- **apra-pm `integ-scope` vs `pm-integ-scope`** (near-identical names, checked
  specifically): NOT duplicates. `integ-scope.test.mjs:13-16` reads
  `.claude/workflows/auto-sprint.js`; `pm-integ-scope.test.mjs:16-18` reads
  `agents/integ-test-runner.md` + `skills/pm/sprint.md`. Two independent
  implementations of the same regression class; `pm-integ-scope.test.mjs:14` says so.
- **apra-pm args/schemas cluster:** four disjoint subjects --
  `auto-sprint-args-skill` -> install.mjs exports; `args-skill-gates` ->
  `e2e/validate-sprint.mjs`; `parse-sprint-args` -> `lib/parse-sprint-args.mjs`;
  `auto-sprint-schemas-drift` -> schema drift + sandbox guard.
- **apra-fleet-client transport cluster (4 files):** orthogonal.
  `fleet-client-transport` is the only file exercising `StdioTransport` (`:50-60`) and
  the real HTTP/SSE happy path (`:62-111`); `transport-reconnect` is the only file
  exercising reconnect-after-stream-death (`:14-49`, `:51-77`); `fleet-client-timeout`
  covers `deriveTimeoutMs` and abort plumbing (`:35-181`).
- **workflow `command-output-cap` vs `-perf`:** not duplicates. The base file tests
  `capOutputText()` / `capCommandActivityMeta()` primitives (`:31-52`); the perf file
  is a scale guard (60 activities x ~1.3MB, `:33-35`) asserting byte-size caps
  (`:184`, `:213`, `:219`, `:237`). It is not a wall-clock assertion, so it is not
  flake-prone in the usual perf-test way.
- **workflow viewer cluster (8 files):** all target `HTML_TEMPLATE` in
  `src/viewer/index.mjs` but exercise disjoint regions (heartbeat cadence, phase
  duration, per-row elapsed, generic-row constraint, more/less button).
  `viewer-lifecycle.test.mjs` (534 lines) is a different subject entirely
  (engine/server lifecycle, `:167-504`).
- **mock-sprint worklist packing-log string** asserted in `worklist-batch:126`,
  `worklist-resume:154`, `worklist-failure-isolation:82`: different N/M with different
  surrounding assertions. Complementary; keep all three.

---

## 4. Subsumption

Merge candidates, not automatic deletions.

### 4.1 `mock-sprint-planner-dispatch-dead-pid` is a strict assertion subset

Every assertion in the smaller file has a stronger counterpart in
`mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session.test.mjs`:

| dead-pid | attempt1-clean-fail-attempt2-dead-session |
|---|---|
| `:64` `check(scenario.error)` | `:124` same |
| `:91` `elapsedMs < FAST_ABORT_CEILING_MS` (180000) | `:168` same constant, same bound |
| `:100` log `'Planner dispatch threw'` | `:192` `threwLines.length === 5` (stronger, exact count) |
| `:104` log `'Retries exhausted'` | `:197` `waitingLines.length === 4` + same string (stronger) |
| `:118` terminal `data.verdict === 'ABORTED'` | `:226` same |
| `:122` terminal message `/dispatch_failed/` | `:230` same |
| `:135` `plannerResumeFlags.every(r => r === false)` | `:179` `length === 5 && every(false)` (stronger) |
| `:133` `plannerDispatches.length > 0` | `:132` `plannerAttempt === 5` (stronger) |
| -- | `:212` `every(m => !m.includes('[dispatch-watchdog]'))` (unique) |
| -- | `:266-279` `realSyncSpawnCount` bounds (unique) |

The larger file's `plannerHandler` fails on every attempt (it only varies payload text
between attempt 1 and 2+), so it exercises the identical ladder.

Caveat worth acting on: the larger file's header claims the mixed-payload ordering
reproduced incident eft.50, but **no assertion distinguishes attempt 1's payload from
attempt 2's** -- so that stated purpose is currently unpinned.

> **RESOLVED (second pass).** Traced through the retry ladder: the mixed ordering is
> **not** load-bearing -- both scenarios classify identically at `runner.js:6413,6420,6424`
> and the `resume` flag is structurally invariant (`:6319`, `:3443`). `dead-pid` is
> **confirmed safe to remove**, subject to updating two script couplings, and the two
> ordering assertions listed there should be added to the survivor so its stated purpose
> is finally pinned. Full evidence and the exact patch: **Tier 3 of section 9**.

### 4.2 `mock-sprint-all-streaks-failed-no-review` -- RESOLVED: not subsumed, keep both

- `all-streaks-failed:58-61` asserts log `'all streaks this round failed with no
  beadIds assigned -- skipping Review dispatch'`.
- `review-scope-excludes-failed-streak:103-106` asserts the identical string (its
  rounds 2-3 are all-failed), and its own header says so.
- `all-streaks-failed:64-67` (bead not closed) and `:44` (`status === 'failed'`) have
  counterparts at `review-scope:110-117` and `:66`.

**Not subsumed:** `all-streaks-failed:50` asserts
`developRoundReviewDispatches.length === 0` -- zero Review dispatches across the
*entire* sprint. `review-scope:76` asserts `=== 1` (round 1 had a surviving streak).

> **RESOLVED (second pass) -- KEEP BOTH.** The trace found what the first pass had
> missed: `dispatchReview()` has **two** call sites, and the second one
> (`runner.js:8308`, gated at `:8285` by `openAtGoal.length === 0 && !reviewedThisCycle`)
> also lands in the `developRoundReviewDispatches` bucket, because the harness labels
> only the Final Review (`mock-sprint-harness.mjs:706-713,744`).
>
> `review-scope`'s round 1 sets `reviewedThisCycle = true` (`runner.js:7667`), making
> that second site **dead by construction** in its scenario; `all-streaks-failed` leaves
> it `false`, so it is the only one of the two that reaches the gate. Weaken `:8285` to
> `if (!reviewedThisCycle)` and `all-streaks-failed:52` fails while `review-scope:77`
> passes. That branch caused a live sprint abort on 2026-08-02
> (`apra-fleet-jfo.3`, documented at `runner.js:8293-8307`).
>
> The coverage **cannot** be folded into the survivor -- the gap is a reachable state,
> not a missing observable. Dropped from the safe-removal list. Full evidence:
> **Tier 3 of section 9**.
>
> Also settled by the same trace: `streakOutcomes` is declared inside the round body
> (`runner.js:7063`), so the "stale beadIds accumulator" regression class hypothesized
> in the first pass is **not** live in the current code.

### 4.3 `mock-sprint-stall-zero-progress` vs `mock-sprint-stall-oscillation` -- keep both

Shared: `error instanceof StalledSprintError` (`zero-progress:40` /
`oscillation:103`), `error.staleCycles === 2` (`:44` / `:108`), and a bound on
`closedCountHistory.length` (`:50` `<=3` / `:117` `<=6`).

Unique to oscillation: `:125` rise-before-plateau, `:132` high-water identity,
`:141` thrash attribution, `:153` filler-never-flagged.

These are two genuinely different detector inputs (flat-zero vs rise-then-plateau).
**Keep both** -- but see 5.3 on shrinking the expensive one.

**Uncertain:** whether the high-water abort and the flat-zero abort share one code
path. If they do, the shared assertions above are redundant. Not traced.

### 4.4 Root-suite subsumptions

- `tests/execute-prompt.test.ts:84-92` (rejects `{{secure.NAME}}` without executing)
  is a subset of `tests/execute-prompt-substitution.test.ts:82-95`, which is part of
  the complete lettered (q-v) matrix.
- `tests/cloud-integration.test.ts:125-205` is a subset of
  `cloud-lifecycle.test.ts:81-214` + `idle-manager.test.ts:148-164` (see 3.3).
- `tests/stall-any-entry-activity-and-kill.test.ts:106-127` and
  `tests/stall-detector.test.ts:165-186` both assert "a stall fires past threshold",
  but under different mechanisms (real `pollLogFile` vs mocked). **Partially**
  redundant, not a clean subsumption -- do not cut.

### 4.5 apra-pm: a source-regex test subsumed by a functional one

`install-schemas.test.mjs:49-61` regex-asserts that `uninstall()`'s *source* contains
`rmSync(schemasDest...)`. `install-uninstall.test.mjs:84-92` proves the same thing
functionally against a real seeded tmp dir (`:18-55`). The regex version is strictly
weaker -- it passes even with a wrong path variable. **Survivor:
`install-uninstall.test.mjs`.** Keep the other 3 source checks in
`install-schemas.test.mjs` (there is no exported `install()` to call; see `:5-9`).

---

## 5. Dead code and stale tests

### 5.1 `deploy-runbook-platform-selection.test.mjs` -- CURRENTLY RED, subject removed

`packages/apra-fleet-workflow/test/deploy-runbook-platform-selection.test.mjs` fails
deterministically, reproduced in isolation during this audit:

```
AssertionError [ERR_ASSERTION]: deploy block must contain the FALLBACK_BUILD if-statement
    at extractSelectionOnly (.../deploy-runbook-platform-selection.test.mjs:61:12)
```

The assertion is at `:60-62`, at module top level (not inside a `test()`), so the
failure takes the entire file down -- node reports `# tests 1` instead of the file's 6.

Root cause: `grep -n "FALLBACK_BUILD" deploy.md` returns **nothing**. The most recent
commit touching that file, `669065a1 "docs(deploy): strip gh/CI dependency, build+install
locally"`, removed the architecture-aware fallback branch this test was written
(for bead `apra-fleet-eft.15.1`) to defend.

This is a **dead test against a removed subject**, not a flake. Note the test itself is
*well built* -- it extracts the `## Deploy` bash fence (`:42-50`) and genuinely
executes it under `bash -c` with `uname` shadowed and `npm`/`gh` stubbed
(`:70-91`, `:137-141`), asserting behavior and permission-prefix coverage
(`:169-190`). It is not prose matching. The decision is whether the darwin-x64
source-build fallback is still a requirement:
- if yes, `deploy.md` regressed and the **test is correct** -- fix the runbook;
- if no, the test is obsolete -- delete it (or the `extractSelectionOnly` half).

Either way this must not be left red. Flagged as a decision, not a removal candidate.

**RESOLVED (2026-08-03):** operator confirmed the `deploy.md` rewrite in `669065a1`
was deliberate (explicit "strip gh/CI entirely, build+install locally" instruction) --
the darwin-x64 source-build fallback is no longer a distinct code path since ALL
platforms now always build from source (no `ARTIFACT`/`FALLBACK_BUILD` selection logic
exists anywhere in `deploy.md` post-rewrite). The subject is genuinely gone, not
regressed. Test file deleted; `apra-fleet-workflow` suite confirmed 238/238 green after
removal.

### 5.2 `serve-wiring-integration.test.mjs` -- concurrency-dependent failure, reproduced

Measured both ways during this audit:
- under the package's default `--test-concurrency=8` run: **FAIL**,
  `timed out waiting for GET / to render the dashboard`, after 45.1s
  (see `serve-wiring-integration.test.mjs :: GET / returns 200 ...` in the suite log).
- in isolation: **PASS** in 11.22s.

This is the sole failure in the 1551-test SE suite and is the reason
`npm test --workspace=@apralabs/apra-fleet-se` currently exits 1. It matches the open
bead **`apra-fleet-ryk`** (P3, "serve-wiring-integration GET / dashboard-render subtest
observed flaky again after apra-fleet-04g.3.2 verified-closed fix"), which itself
follows two earlier closed attempts (`apra-fleet-04g.3`, `apra-fleet-33c.1`).

Per the "reopen, do not duplicate" convention this is fresh evidence for
`apra-fleet-ryk`, not a new bead. Given three failed stabilisation attempts, the
pragmatic fix is the one the closed bead `apra-fleet-04g.3` already proposed: move it
to `test/slow/` so the default suite stays green.

### 5.3 `tests/fleet-sprint-bundle-smoke.test.ts` -- unsatisfiable guard, subject retired

`:32-35`:
```
const bundlePath = path.join(root, 'dist', 'fleet-sprint.mjs');
const bundleExists = existsSync(bundlePath);
describe.skipIf(!bundleExists)('dist/fleet-sprint.mjs -- packaged binary smoke', ...
```

Verified:
- `scripts/bundle-se.mjs` -- **does not exist** anywhere in the repo.
- `dist/fleet-sprint.mjs` -- **does not exist**.
- `build:se` -- **not in `package.json` scripts**.
- `docs/npm-packaging.md:246-249` states explicitly: *"`scripts/bundle-se.mjs` and the
  `build:se` script have been retired -- there is no longer an esbuild step that
  produces `dist/fleet-sprint.mjs`"*. Corroborated at `.github/workflows/ci.yml:708-710`.
- the root `package.json` `bin` no longer has a `fleet-sprint` entry.

The guard can never be satisfied. Its 3 tests are permanently skipped by construction.

### 5.4 Dead runner config

- `vitest.config.ts:8` -- `exclude: ['tests/integration.test.ts']` excludes a file that
  does not exist (verified).
- `package.json` -- `"integration": "tsc && npx tsx tests/integration.test.ts"` points
  at the same missing file. **Dead npm script.**

### 5.5 Empty `describe.todo` stubs

`tests/file-transfer-matrix.test.ts:234-236` -- three `describe.todo(...)` blocks, all
title-only with no body:
```
describe.todo('Windows fleet host -> local Windows member -- needs Windows runner');
describe.todo('Windows fleet host -> remote Linux member (SFTP) -- needs Windows runner');
describe.todo('Windows fleet host -> remote Windows member (SFTP) -- needs Windows runner');
```
The stated blocker is stale: this repo already runs Windows-only suites
(`tests/strategy-process-tree-kill.test.ts:29`,
`tests/2cc-win-bd-invocation-integ.test.ts:63`), so a Windows runner exists. These are
the only `todo` markers in all 459 files.

### 5.6 What is NOT dead (checked, so it does not get re-checked)

- **Zero dead imports across the root suite.** `npx tsc --noEmit` over all 211
  `tests/**/*.test.ts` produced 304 errors but **zero `TS2305` (no exported member),
  zero `TS2724`, zero `TS2307` (cannot find module)**. The 304 are pre-existing
  strictness/narrowing issues in `src/` and fixtures, unrelated to deadness.
- **Zero dead references in the mock-sprint family.** 21 asserted log-strings and
  constants plus 11 directly-imported exports were each resolved against
  `fleet-sprint/runner.js`; all resolve.
- **Zero stray `.only(`** in any of the 459 files.
- **No dead fixtures in apra-fleet-workflow.** All 9 non-`.test.mjs` helpers are
  referenced by `test-runner.test.mjs`: `test-vetting.js` (`:104`, `:115`, `:122`),
  `test-edge-sequential.js` (`:129`), `test-edge-agent-args.js` (`:136`),
  `test-edge-command-fail.js` (`:144`), `test-edge-missing-member.js` (`:152`),
  `test-command.js` (`:159`), `test-schema-pre.js` (`:171`), `test-schema-post.js`
  (`:179`), `test-schema-garbage.js` (`:187`).
- `scripts/sync-agent-docs.mjs.helper.cjs` and `scripts/recovery.sh` appear only at
  `tests/install-workflows.test.ts:419-420`, where the test **writes them itself** into
  a temp fixture root. Not dead.

### 5.7 Tests that are dark by default (contribute zero coverage in a normal run)

| File | Runs in `npm test`? | Guard |
|---|---|---|
| `tests/toy-doer-bare-token-real-cli-integ.test.ts` | **No** | `:92` `describe.skipIf(!REAL_CLI_PROBE_OPTED_IN \|\| !CLAUDE_CLI_AVAILABLE \|\| !REAL_TOKEN)`; opt-in at `:90` = `APRA_FLEET_ALLOW_REAL_CLI_AUTH_PROBE === '1'` |
| `tests/toy-doer-envvar-real-cli-integ.test.ts` | **No** | `:119` same triple guard, opt-in `:117` |
| `tests/smoke-test-flow-e2e-integ.test.ts` | **No, unless `bd` installed** | `:90` `describe.skipIf(!BD_AVAILABLE)`, `BD_AVAILABLE` at `:43-49`. 5 tests / 291 lines skip silently |
| `tests/integ-test-playbook-reset-portclean.test.ts` | **No on Windows** | `:253` `skipIf(!hasLsof)` (`:66`); `lsof` is not a Windows tool -- all 5 tests / 388 lines skip |
| `tests/hub-service/relay-queue.docker.test.ts` | **No on Windows or macOS** | `:34` `skipIf(!dockerAvailable)`; `:26` forces `dockerAvailable = false` on any non-Linux OS |
| `tests/2cc-win-bd-invocation-integ.test.ts` | **Partial, and a landmine** | `:63` guards only *one* of five tests. `:52`, `:110`, `:164`, `:195` are ungated and shell out to real `bd` / `scripts/sandbox-seed-beads.mjs` / `scripts/check-toy-doer-credentials.mjs`. Without `bd` on PATH these **FAIL, they do not skip** |
| `tests/check-sandbox-sync-remote{,-fetch}-integ.test.ts` | **Yes, always** | no guard; hermetic (local `file://` temp repos) but needs a real `git` |
| `tests/check-watchdog-isolation-integ.test.ts` | **Yes, always** | no guard; cheap and hermetic |

**Policy inconsistency worth fixing:** `2cc-win-bd-invocation-integ.test.ts:52` and
`exec-bd.test.ts:152,161,242` hard-fail without `bd`, while
`smoke-test-flow-e2e-integ.test.ts:90` skips on the exact same dependency. Same suite,
two contradictory policies. CI papers over this with an explicit
`npm install -g @beads/bd` step (`ci.yml:79-84`), so it only bites local runs.

Platform-conditional skips that are working as intended (recorded for completeness):
`auth-socket.test.ts:27,241`, `git-config.test.ts:50`, `known-hosts.test.ts:109`,
`onboarding.test.ts:128`, `security-hardening.test.ts:18`,
`unit/pid-wrapper.test.ts:70,79,88,94,136,205` (skipIf win32);
`auth-terminal-wait.test.ts:37`, `platform.test.ts:400,409` (linux-only);
`platform.test.ts:419` (darwin-only); `check-sandbox-sync-remote.test.ts:95` (inverse
-- runs on Windows, skips on CI Linux).

---

## 6. Coverage gaps

Ranked by risk, not size. No coverage tool is configured, so these are inferred from
two signals: whether any test file imports the module, and whether each exported symbol
is named (whole-word) in any test file. A symbol never named anywhere in ~112k lines of
test code is a strong gap signal; every load-bearing claim below was spot-checked by
reading the matching lines.

**Overall the repo is well tested** -- only 18 of ~200 `src/*.ts` files have zero test
imports, and most of those are tiny. These gaps are specific, not systemic.

### 6.1 `runSprintCycle` -- 4,147 lines, unexported, only end-to-end reachable

`packages/apra-fleet-se/fleet-sprint/runner.js` is 9,397 lines.
`async function runSprintCycle(context)` spans **lines 4996-9142 -- 44% of the file** --
and is **not exported** (verified against the export list and an `^export` sweep).

Every phase decision lives inside it: plan/review rounds, doer dispatch, streak
classification, replan short-circuit, exit/continue decisions, and the Regression and
Integ phases. It is reachable **only** through `mock-sprint-harness.mjs` driving
`main()`. The ~50 mock-sprint scenario files are genuinely good black-box coverage, but
no unit test can reach any internal decision predicate -- which is also the direct cause
of the slowness in section 7.

Incident ties:
- `CHANGELOG.md:5-58` (Unreleased): abort classification treated every `WorkflowError`
  subclass as a full sprint abort, so ordinary retryable dispatch errors produced
  spurious `[ABORTED]` PRs (epic `apra-fleet-9ta`).
- `CODE-REVIEW-integ-regression-split.md:21-70` -- a live blocking review finding: the
  new Regression Test phase could abort a *passing* sprint on a Dolt/git sync error
  inside its `withGitSync` bracket, at `runner.js` ~7868-7885, i.e. deep inside
  `runSprintCycle` and unreachable by unit test.
- `apra-fleet-66u` (P1, **open**): stall detection scores progress against stale bead
  state, producing false stalled-aborts.
- `apra-fleet-33c`, `apra-fleet-6z8` (closed): max_turns streak misclassified FAILED;
  coarse Planner retry redid whole LLM turns.

Confidence: high.

### 6.2 `createLlmAuthSelfHealCallback` -- fixed a P0, has zero tests

`runner.js:2420-2474`, wired live at `runner.js:5173`. **No test file imports it.** Its
only appearances in the entire test tree are three *comments* in
`mock-sprint-planner-auth-failure-no-retry.test.mjs:103,108,111`.

The asymmetry is the tell -- its two siblings are properly tested:
`createVcsAuthSelfHealCallback` (2 files) and `createVcsAuthPreflightCallback` has a
dedicated `vcs-auth-preflight.test.mjs:72,80,103`.

Incident tie: **`apra-fleet-391` (P0, closed)** -- "LLM-auth self-heal does not exist --
auth failures detected then blind-aborted, never remediated", across 8/11 dispatch sites
(writeup at `HANDOFF-2026-07-30.md:90-128`). The P0 fix shipped with no direct test.
Also `apra-fleet-spp` (P1, **open**): the `DoltDivergedError` retry ladder still
mislabels a git-credential failure as data divergence.

Confidence: high. This is the highest-value gap to close relative to effort.

### 6.3 Dolt recovery ladder -- resolved: retired and replaced by `settleDoltConflicts()`

Resolved on branch `fix/dolt-settle-recovery`. The 934-line unwired ladder
(`fleet-sprint/dolt-recovery.mjs`, `dolt-recovery-path-b.mjs`, `dolt-recovery-tier2.mjs`,
plus `docs/dolt-tier2-runbook.md` and their three test files) was deleted outright rather
than wired, per the "wire it, or delete it" call below. It is replaced by one
deterministic function, `settleDoltConflicts()` in `fleet-sprint/dolt-settle.mjs`
(tests: `test/dolt-settle.test.mjs`, 20 tests), wired at both divergence terminals in
`dolt-sync.mjs` (`doltPushAfter` and `doltPullBefore`) plus `DoltSync.repair()`. See
`fleet-sprint/docs/dolt-sync-redesign.md` for the design.

Incident tie: **`apra-fleet-vkc` (P1)** named exactly this gap ("doltPushAfter conflict
path reaches the recovery ladder (or ladder is provably absent)") and is closed by this
change.

### 6.4 `src/services/orphan-recovery.ts` -- zero test imports, on the live dispatch path

166 lines. No test imports it. Symbol sweep: `isRemoteProcessAlive` (1 mention),
**`recoverOrphanedDispatch` (0)**, **`readDurableOutput` (0)** -- the two functions that
do the actual recovery.

It is not dead code: `src/tools/execute-prompt.ts:23` imports it and calls
`recoverOrphanedDispatch` at `src/tools/execute-prompt.ts:1155` (verified). So the
*caller* has 21 test files while the recovery logic itself has none.

Incident ties: `apra-fleet-eft.74` (P1, closed) -- phantom pid-less session wedged all
subsequent dispatches to a member; `apra-fleet-3c9` (P1, closed) -- stall detector
killed the remote pid but never cancelled the in-flight MCP dispatch; `apra-fleet-ekm`
(P0, closed) -- dead session burned a 60-min timeout. And **`auto-sprint-4` /
`auto-sprint-6` (P0/P1, open)**: two consecutive real sprints died silently 25-47 min
in, suspected external process kill -- an actively open mystery in precisely this
untested module.

Confidence: high. Top pick among the non-engine gaps.

### 6.5 Runner's HTTP coordination clients + `computeChildFloor`

`runner.js`: `createHttpDoltPushMutexClient` (`:1676-1744`),
`createHttpChildIdAllocatorClient` (`:1745-1812`), `computeChildFloor` (`:2505-2556`)
-- **all three have zero mentions in any test file**. Their MCP counterparts are
tested: `createMcpDoltPushMutexClient` (3 files), `createMcpChildIdAllocatorClient`
(4 files).

Two transports exist for the same safety-critical coordination (push mutex, child-bead
ID allocation) and only one is tested. `computeChildFloor` untested means duplicate
child-bead IDs -- the exact failure mode `apra-fleet-f34` was filed for -- has no unit
guard. Confidence: high.

### 6.6 `src/services/sprint-coordination.ts` -- singletons and lease timing untested

712 lines vs `tests/sprint-coordination.test.ts` (295 lines), the only test importing
it. Symbol sweep: `createDoltMutex` (4), `createIdAllocator` (4), `createTicketedMutex`
(1), `DEFAULT_LEASE_MS` (1) -- but **`getDoltPushMutex` (0), `getChildIdAllocator` (0),
`defaultIdAllocatorPath` (0), `DEFAULT_SWEEP_MS` (0), `DEFAULT_WAIT_MS` (0),
`MAX_WAIT_MS` (0)`**.

The constructors are tested; the process-wide singleton accessors, the allocator's
on-disk path derivation, and every lease sweep/wait/timeout bound are not.

Incident tie: `apra-fleet-k7b.4` / `.8` (P0/P1, closed) DOLT_DIVERGED misclassification.
Confidence: high on the symbol facts, medium on how much the 295-line test exercises
indirectly.

### 6.7 `packages/apra-fleet-client`: `server-resolution.mjs` (265 lines) and `factory.mjs` (65) untested

Client tests import only `api.mjs`, `client.mjs`, `transport.mjs`. Server resolution is
how a client finds and authenticates to the fleet server -- the exact area of
**`apra-fleet-kuh.6` (P1, open)**: npm-installed `apra-fleet workflow fleet-sprint`
cannot resolve `@apralabs/apra-fleet-client`, leaving connectivity permanently
unavailable on that install path (`HANDOFF-2026-07-30.md:130-145`). Confidence: high.

### 6.8 `src/tools/setup-ssh-key.ts` -- zero coverage on key generation and password->key migration

134 lines, zero test imports; `setupSSHKey` and `setupSSHKeySchema` named in no test.
Wired live via `src/services/tool-registry.ts:21,118`. It generates a keypair and
migrates a member off password auth -- it writes private key material to disk.

Related: `src/utils/file-permissions.ts` `enforceOwnerOnly` (12 lines) is **also
untested**, and that is the control keeping the generated key from being
world-readable. Confidence: high on the gap, medium on realized risk.

### 6.9 Small credential/secret surfaces with zero symbol coverage

All with zero mentions in any test: `src/tools/credential-store-list.ts` (29 lines),
`src/tools/credential-store-delete.ts` (18), `src/utils/secure-input.ts` (68),
`src/utils/file-permissions.ts` (12), `src/utils/process-utils.ts` `postShutdown`.
(`isPidAlive` by contrast is well covered -- 14 files.)

Individually small, but this is the delete/list/prompt path for stored secrets, and the
area has a demonstrated history of *silent wrong-value* bugs -- the class unit tests
catch best: `apra-fleet-eft.83` (P1, closed) `secret --set --persist` stored an empty
string; `apra-fleet-vak.1/.2/.3` JSON-shaped `CLAUDE_CODE_OAUTH_TOKEN` silently broke
auth; `apra-fleet-04g.4` stale expired token silently preferred over a fresh one.

**Constraint on any remediation here:** real-CLI credential tests must not be run
locally -- they sandbox `HOME` but not `USERPROFILE` on Windows and have twice rotated
the operator's real token (`eft.48.7`). Any new coverage must be pure-function or
mocked. Confidence: high on gap, medium-high on priority.

### 6.10 `src/services/tool-registry.ts` -- the MCP wiring table has no test

152 lines, zero test imports, `registerAllTools` named in no test. This is the single
place every MCP tool's name, description, and schema is bound to its handler; a dropped
or mis-shaped registration means a tool silently vanishes from the server. This matters
more than usual here because `CLAUDE.md` makes `packages/apra-fleet-client` contractually
required to track these schemas -- a drifted client is exactly the failure this table
would catch. Confidence: high on the fact, medium on severity (type checks catch some).

### Checked and healthy (recorded so these do not get re-audited)

`src/cli/install.ts` (48 test files), `src/tools/execute-prompt.ts` (21),
`src/services/credential-store.ts` (16), `src/services/agent-provisioner.ts` (16),
`src/services/auth-socket.ts` (13), `src/services/http-transport.ts` (7),
`src/services/ssh.ts` (6), `src/services/sftp.ts` (6),
`packages/apra-fleet-workflow/src/workflow/index.mjs` and `viewer/index.mjs` (46 each).

Notably, the **dolt/git sync brackets are heavily covered** despite being the
highest-incident area: `dolt-sync-brackets.test.mjs` (859 lines),
`git-sync-brackets.test.mjs` (573), `dolt-sync-discipline.test.mjs` (530), with
`doltPushAfter` / `doltPullBefore` each named in 10 test files. That surface is well
defended; it is the *recovery* path below it (6.3) that is not.

---

## 7. Disproportionately slow tests

Ranked by time spent per unit of assertion value.

### 7.1 The root suite's serial-file constraint -- 199s, and it is not a test problem

`vitest.config.ts:11` sets `fileParallelism: false`, commented "Tests share
registry.json in temp dir".

Measured directly during this audit:

| Mode | Wall clock | Result |
|---|---|---|
| `npx vitest run` (as configured) | **5m 06s** | 2929/2930 pass |
| `npx vitest run --fileParallelism` | **1m 47s** | 2631 pass, **263 fail** |

Sum of per-file execution time is only **161s**, so roughly **145s of the 306s is
main-process serialization overhead**, not test work.

The 263 failures confirm the comment is accurate -- `tests/global-setup.ts` computes
*one* data dir per `vitest run` and hands it to every worker via `provide`/`inject`
specifically because "tests share registry.json across files within a single run".
Files that mutate the shared registry collide once they run concurrently.

**This is the highest-value item in this document.** It is a real refactor (make
`APRA_FLEET_DATA_DIR` per-file rather than per-run, then delete `fileParallelism:
false`), not a config flip -- but the payoff is measured, not estimated: **199s off
every CI run and every local `npm test`, on 3 OSes.** Worth more than every deletion
here combined.

### 7.2 `dolt-sync-discipline.test.mjs` -- resolved, no longer applies

The 34.1s of this file previously spent driving real dolt binaries through the dead
Path A / Path B / Tier 2 ladder (subtests (d) and (e)) no longer applies: per the
resolution in 6.3, those cases and the real-dolt helper block were removed along with
the ladder. The file now has 4 tests, cases (a)/(b)/(c) only, and no longer needs a
dolt binary.

### 7.3 The mock-sprint family -- 77% of the real-bd lane

From `integ-suite-status.json` (2026-07-31 run, 131 files, 1691s wall, 9683s cumulative
file time): 50 `mock-sprint-*` files account for **7431s cumulative -- 77% of the
suite.**

The cost is `bd`, not the logic. `test/helpers/mock-sprint-harness.mjs` (1,371 lines)
stubs **nothing of `runner.js`** -- `buildMockFleetApi` (`:354`) stubs only the FleetApi
seam; `executeCommand` intercepts `git`/`gh`/`curl .../pulls` and **execs everything
else, all `bd`, for real** (`:669`). Under `APRA_FLEET_BD_MOCK=off` every
`bd init/create/list/show/update/close/link/dolt` is a real Go+Dolt subprocess.
Empirically ~100s is the floor for even a 1-cycle 1-bead scenario, and the ~40
mock-sprint files that assert nothing about bd state still pay it in full.

The existence proof that this is avoidable is already in-repo:
`mock-sprint-git-sync-brackets.test.mjs`, `mock-sprint-retry-resume-remote-tip.test.mjs`,
and `mock-sprint-pure-logic.test.mjs` carry **39 tests in 3 seconds combined** by
importing exported functions directly.

Worst offenders, with a concrete lighter alternative for each:

**(a) `mock-sprint-stall-oscillation` -- 457s, slowest file in the suite.**
Drives 1 oscillator plus 5 filler beads chained by 4 `bd link` edges across ~4-6 real-bd
cycles, to assert four properties of a pure function over `closedCountHistory`.
The stall decision is computed inline in `main()` -- there is no exported entry point
(verified: nothing between `isTypedAbortError:4617` and `withDispatchWatchdog:4887`
covers it). Extract
`export function decideStall({ closedCountHistory, highWaterClosedCount, reopenCounts, staleCycleBudget, thrashThreshold })`
returning `{ stalled, staleCycles, thrashIds }`, then unit-assert
`decideStall({ closedCountHistory: [3,5,5,5], ... })` -- the exact history the file's own
comment (`:34-41`) documents -- plus the K=3 thrash and filler-never-flagged cases. Keep
one mock sprint with a 2-filler chain for wiring. **457s -> ~120s**, protection
unchanged (the history vector is already asserted directly at `:125`/`:132`).

**(b) The worklist/resume family -- 1,012s across 4 files.**
`worklist-resume` 303s + `worklist-batch` 291s + `round-resume` 275s +
`worklist-failure-isolation` 143s. Several assertions are the return values of
**already-exported pure functions**:
- `worklist-resume:289` (`doerPrompts[1].resume === false` after 149000-token usage vs a
  135000 ceiling) -> `hasContextHeadroomForResume` is exported at `runner.js:3598`.
- `worklist-resume:331-336` (tier-homogeneous split) -> `assignDoerWorklists`
  (`runner.js:3662`) + `resolveWorklistTierPolicy` (`:3581`).
- `worklist-batch:162,179` and `:122,124` -> the same two functions.

A `test/worklist-assignment.test.mjs` and a `test/round-session-registry.test.mjs`
already exist for exactly these. Move the packing/tier/headroom *decisions* there and
keep in the mock-sprint files only what needs the real engine -- chiefly
`worklist-resume:189-191` (the sync bracket falling strictly *between* two dispatches of
the same doer, which genuinely needs the merged command+prompt timeline) and
`worklist-failure-isolation:101`. **1,012s -> ~400s.**

**(c) `mock-sprint-finalization-idempotent-pr` -- 204s for two full sprints.**
Both sprints exist solely to populate `prExistsState` so the second run's `curl` returns
HTTP 422. The behavior asserted (`:65`) is already asserted -- from a **direct
`finalizeAbort()` call with no sprint at all** -- at `mock-sprint-abort-pr.test.mjs:334-347`,
which additionally pins `result.reason === 'already-exists'` and the parsed PR URL. The
blocker is that the publish step is inline in `main()`. Extract
`export async function publishPr({ branch, baseBranch, verdict, notes, command, callTool })`,
mirroring the already-exported `finalizeAbort` (`runner.js:4730`), and assert the 422
path directly with a scripted `command` mock exactly as `abort-pr.test.mjs:64-112`
already does. **204s -> ~0s.** The same export also collapses 3.8 and 3.9.

**(d) `mock-sprint-childless-target-scope` -- 236s, 3 direct-engine runs.**
All three tests probe `bdListScoped`'s inclusion rules; `bdListScoped` is **not
exported**. Exporting it turns `:83`, `:153`, `:210`/`:222` into three direct calls with
a stubbed `command`. **236s -> ~0s.**

**(e) `mock-sprint-lane-metadata-grouping` -- 205s, 2 sprints.**
`:82-92` is the literal return value of `groupStreaksFromLaneMetadata`, exported at
`runner.js:3314` and **already unit-tested** in `test/streak-lane-grouping.test.mjs`.
Only `:67` and `:137` (dispatch counts) need the engine. **205s -> ~100s.**

**(f) `mock-sprint-replan-short-circuit` -- 360s, 3 sprints.**
Test 3 (`:255-325`) is an entire extra sprint whose load-bearing assertions are all
*negative* (`:319`, `:322-325`). Its one positive (`:308`) is ordinary reopen behavior
already covered by `mock-sprint-develop-reopen`. Judgment call -- asserting the control
shape does require a run where `replanIds` was not set -- but if kept, drop test 2 from
2 cycles to 1 if the loop guard fires within one cycle. ~120s.

**Accidental asymmetry worth fixing on its own merits:** `buildPlanReviewerPrompt` is
*not* exported while its five sibling `build*Prompt` functions are (`runner.js:2975`,
`3869`, `3909`, `4322`, `4552`). That gap is what forces
`mock-sprint-plan-review-acceptable-alternative` (155s) to run a full sprint to assert
round-3 prompt content.

### 7.4 Slowest files in the default lanes

Root vitest (per-file, from the serial run):

| Duration | Tests | File |
|---|---|---|
| 18.01s | 5 | `tests/2cc-win-bd-invocation-integ.test.ts` |
| 16.01s | 3 | `tests/register-member.test.ts` |
| 10.63s | 4 | `tests/hub-service/file-transfer-e2e.test.ts` |
| 9.90s | 2 | `tests/register-member-bootstrap-gate.test.ts` |
| 9.66s | 10 | `tests/hub-service/relay-queue.test.ts` |
| 8.65s | 5 | `tests/check-sandbox-sync-remote-integ.test.ts` |
| 7.38s | 54 | `tests/check-sandbox-sync-remote.test.ts` |

`2cc-win-bd-invocation-integ` (3.6s/test) and `register-member` (5.3s/test) are the two
worst ratios. Both spawn real subprocesses. Neither is obviously wrong for what it
tests, but they are the first place to look after 7.1 lands.

apra-fleet-se, isolated per-file (see the main table for the full ranking):
`dolt-sync-discipline` 63.4s, `supervisor-lifecycle` 18.2s (4.55s/test),
`serve-wiring-integration` 11.2s, `eft-37-boundary-e2e` 7.4s.

### 7.5 `transport-reconnect.test.mjs` -- 69% of the client suite is one hardcoded sleep

`packages/apra-fleet-client/test/transport-reconnect.test.mjs:66` hardcodes
`setTimeout(r, 1800)`. Measured: that single test is **1887ms of the client suite's
2728ms (~69%)**. It encodes a fixed assumption about reconnect backoff and is both the
suite's runtime and its main flake vector. No fake timers are used anywhere in that
surface. Replace with event-driven waiting.

---

## 8. Structural findings (not deletions, but they change what the suite is worth)

### 8.1 433 apra-pm tests never run in CI -- FIXED (2026-08-03)

**Resolution:** `ci.yml` now has an explicit
`npm test --prefix packages/apra-fleet-se/apra-pm` step immediately after the
`--workspaces --if-present` step, so all three matrix OSes run the suite (418 tests,
~2s, verified green on Windows). Adding apra-pm to the root `workspaces` array was
rejected as the fix: it would churn `package-lock.json` and break the `npm ci` steps
until the lock was regenerated, for no packaging benefit (apra-pm is `private`, and its
only devDependency `ajv` is already hoisted to the root `node_modules` via
apra-fleet-se). The diagnosis below is retained as the record of the gap.

- Root `package.json:15-20` declares four workspaces; `apra-pm` is not among them
  (confirmed by `npm query .workspace`).
- `packages/apra-fleet-se/package.json` has no nested `workspaces` field, so
  `packages/apra-fleet-se/apra-pm` is a workspace of nothing.
  `npm test --workspaces --if-present` (`ci.yml:114`) never reaches it.
- `vitest.config.ts:7` includes `packages/*/tests/**/*.test.ts` -- apra-pm's tests are
  at `packages/apra-fleet-se/apra-pm/test/` (two levels deep, `test/` singular),
  matching neither pattern.
- Grep of `.github/workflows/` for `apra-pm`: only comment/stderr matches in `ci.yml`,
  plus `pm-e2e.yml:134,216,223,234` which runs `install.mjs` and `e2e/run-e2e.mjs`,
  never `npm test`. `pm-e2e.yml:13` is `workflow_dispatch` only.
- `.github/hooks/pre-commit` runs no tests.

44 files / 433 tests currently guard nothing automatically. The fix is small (add the
package to the root `workspaces` array, or add a CI step) but note the suite would then
have to pass on all three matrix OSes.

### 8.2 `test/slow/` is orphaned and currently red

`packages/apra-fleet-se/package.json:17` defines `test:slow`, invoked by no workflow.
Both files are already tracked as failing: `apra-fleet-x1c` (P2, sprint lock held across
invocations) and `apra-fleet-t91` (P2, bd-replay recording drift). This lane is
documented in `regression-test-playbook.md:81-89` as a manual once-per-sprint step.

### 8.3 The real-bd integ lane may not be earning its keep

Existing bead **`apra-fleet-040` (P2, open)**: *"Integ Test phase part 1 (129-file
real-bd suite) runs every cycle for ~55min and has never caught a product regression --
gate to once-per-sprint or C[ut]"*. Also `apra-fleet-p8o` (P3, open): 37 files exceed
the 300s single-file budget.

This audit's data supports that bead: the lane costs 1691s wall / 9683s cumulative, 77%
of it in mock-sprint scenarios whose slowness is a harness artifact (real `bd`
subprocesses) rather than coverage depth. The refactors in 7.3 are the constructive
answer -- they reduce the lane's cost without reducing what it pins.

### 8.4 Stale artifacts that will mislead the next reader

- `packages/apra-fleet-se/test/TEST-VALUE-ANALYSIS.md` (self-dated 2026-07-16) covers
  25 mock-sprint files; there are now **53**. Its entire per-file table (rows #31-#51)
  names files that no longer exist -- its recommendation #1 (split the four >6-min
  files) was executed and those files were renamed away. Its recommendation #4 (delete
  the git-push-failure duplicate) was **not** executed and is section 3.7 here. Its
  headline claim "the waste is in HOW they run, not WHAT they test" is no longer fully
  true: the ~28 files added since it was written contain real duplication.
- `integ-suite-status.json` still records
  `mock-sprint-planner-dispatch-stalled-session.test.mjs` at 463s as a `test/`-root
  file. It now lives in `test/slow/`. Anyone reading that file for "the slowest file"
  gets a wrong answer.

### 8.5 Weak-but-not-removable tests (tighten rather than delete)

- **`tests/backward-compat.test.ts` (157 lines).** `:17-46` generates 11 tests that each
  do `expect(/\/pm init/i.test(concatenatedMarkdown)).toBe(true)` over six markdown
  files joined into one string (`:18-26`); `:50-63` does the same for state-file names.
  This is a grep over docs -- it passes as long as the substring appears anywhere in the
  concatenation. Lowest-signal file in the root suite.
- **`tests/gen-llms-full.test.ts:41`** asserts `llms.txt` extracts "exactly 16" local
  docs -- a hardcoded count that breaks on any doc addition. `:57` asserts a hardcoded
  doc order.
- **`tests/onboarding-text.test.ts` (21 tests)** -- `:13` "contains the ASCII art header
  line", `:17` tagline, `:21` separator lines. Assertions on string constants. `:84`
  (box-border alignment on truncation) is the one test doing real work.
- **apra-pm `skill-pm-tags-dispatch.test.mjs` (21 tests) and `skill-pm-roles.test.mjs`
  (6 tests)** -- assert literal prose: `"### planner"` (`:128-137`), `"Per-role prompt
  templates"` (`:123-126`), the *absence* of the phrase "four roles"
  (`skill-pm-roles:13-18`). ~27 wording-brittle tests. By contrast
  `agent-schema-validation.test.mjs:70-104` (ajv-validates `agents/schemas/*.json` and
  cross-checks each role's `.md` output-schema fence) is a genuine machine contract --
  keep that one.
- **`packages/fleet-api-contract/tests/schemas.test.ts:66-107`** -- 5 tests
  (`Workspace`, `UsageRecord`, `ActivityEvent`, `Installer`, `AdminUser`) are bare
  `Schema.parse(valid)` calls **with no `expect()` at all**. They fail only on a throw,
  so they would not catch a dropped or renamed field. The other ~6 in that file pin real
  contracts (`:16-41`, `:43-64`, `:81`, `:109-140`). Tighten, do not delete.
- **`packages/apra-fleet-client/test/transport-idle-timeout-guard.test.mjs`** -- not a
  behavioral test: it reads `src/client/transport.mjs` as text and regex-asserts wiring
  (`:22-54`). Passes even if the dispatcher is wired but broken; fails on cosmetic
  refactors. Its own comment (`:13-17`) admits it stands in for an impractical 300s live
  test. Acceptable, but the weakest test in that surface.
- **`packages/apra-fleet-workflow/test/viewer-stream-list-scroll-dom.test.mjs:59-82`** --
  `buildStreamListBoxModel` is a hand-invented box-model simulator, not extracted from
  `src/`. It cannot catch a real layout regression.
- **`tests/execute-prompt.test.ts` (2408 lines)** -- large but mostly genuine. It does
  contain parametrizable repetition that would collapse to `it.each` with zero coverage
  loss: `:285-331` (three ~14-line bodies differing only in tier->alias),
  `:237-283` (same shape for `--model`), `:366-390`, `:1737-1834` (four
  `max_turns_exhausted` tests sharing near-identical transcript boilerplate).

---

## 9. Safe-to-remove list

Every entry states what continues to cover the scenario after removal. Ordered by
confidence.

### Tier 1 -- dead or unsatisfiable (no coverage exists to lose)

| # | Remove | Still covered by |
|---|---|---|
| 1 | `tests/fleet-sprint-bundle-smoke.test.ts` (whole file, 3 tests) -- DONE (2026-08-03) | Nothing needs to -- the subject (`dist/fleet-sprint.mjs`, `scripts/bundle-se.mjs`, `build:se`) was retired per `docs/npm-packaging.md:246-249`. The guard at `:35` can never be satisfied; the tests have not executed since the retirement. Section 5.3. |
| 2 | `vitest.config.ts:8` `exclude: ['tests/integration.test.ts']` and the `"integration"` script in `package.json` -- DONE (2026-08-03) | Nothing -- both reference a file that does not exist. Config cleanup, not a test. Section 5.4. |
| 3 | `tests/file-transfer-matrix.test.ts:234-236` (3 empty `describe.todo` stubs) -- DONE (2026-08-03) | Nothing -- they have no bodies. If the Windows matrix is still wanted, file a bead; the stated "needs a Windows runner" blocker is stale (`tests/strategy-process-tree-kill.test.ts:29` already runs Windows-only). Section 5.5. |

### Tier 2 -- duplicates with an established survivor

| # | Remove | Still covered by |
|---|---|---|
| 4 | `tests/install-dev-manifest.test.ts` (whole file, 75 lines) -- DONE (2026-08-03) | `tests/install-workflows.test.ts:470-523`, a strict superset (all four assertions plus the `doer-input.json`/`doer-output.json` key pinning at `:491-492`). Section 3.1. |
| 5 | `tests/execute-prompt.test.ts:792-810` and `:822-965` (~175 lines, 5 tests) -- DONE (2026-08-03) | `tests/execute-prompt-idb-busy-lock.test.ts:68-241`, which has all five scenarios plus two unique ones (`:245-274`, `:276-301`). Section 3.2. |
| 6 | `tests/cloud-integration.test.ts:125-205` (2 describes) -- DONE (2026-08-03) | `tests/cloud-lifecycle.test.ts:82-134` (auto-start, identical mocks and error string) and `tests/idle-manager.test.ts:148-164` (idle auto-stop), both broader. Keep `:207-268` and `:270-352`, which are unique. Section 3.3. |
| 7 | `tests/stall-detector-integration.test.ts:62-121` (4 tests) -- DONE (2026-08-03) | `tests/stall-detector.test.ts:69-112` -- same class, same methods, same assertions. Keep `:124-236`, the genuinely-integration half. Section 3.5. |
| 8 | `tests/exec-bd.test.ts:152-159` **or** `tests/2cc-win-bd-invocation-integ.test.ts:52-56` (1 test) -- DONE (2026-08-03; dropped the 2cc integ copy, kept exec-bd) | Whichever is kept. Recommend keeping the `exec-bd.test.ts` copy (unit-level home of the helper) and dropping it from the integ file, which is the root suite's slowest at 18.01s. Section 3.4. |
| 9 | `tests/execute-prompt-substitution.test.ts:59-79` (1 test) -- DONE (2026-08-03) | `:82-95`, same rejection path with strictly more assertions. The removed test is mis-titled and contains leftover authoring notes at `:73-77`. Section 3.6. |
| 10 | `packages/apra-fleet-se/test/mock-sprint-finalization-git-push-failure.test.mjs` (whole file) -- DONE (2026-08-03) | `mock-sprint-publish-push-failure.test.mjs:36,50,57,65,79` (finalization push, precisely targeted); `mock-sprint-finalization-gh-failure.test.mjs:32` (typed-error propagation); `mock-sprint-git-sync-brackets.test.mjs:242-252` (the bracket G-push path it now actually hits). **~80s real-bd.** Section 3.7. |
| 11 | `mock-sprint-abort-pr.test.mjs:357-366` (a full `runOnce` sprint) -- DONE (2026-08-03; `![ABORTED]` added to happy-path) | `mock-sprint-happy-path.test.mjs:52` and `:145-164`. Requires adding one line -- `!prCmd.includes('[ABORTED]')` -- beside `happy-path.test.mjs:379`. **~120s real-bd.** Section 3.9. |
| 12 | `mock-sprint-abort-pr.test.mjs:368-387` -- DONE (2026-08-03; `![ABORTED]` moved into exit-explicit-fail) | `mock-sprint-exit-explicit-fail.test.mjs:29,42,47` (strictly stronger PR-text assertion). Requires moving the `![ABORTED]` line into `exit-explicit-fail:47`. **~100s real-bd.** Section 3.8. |
| 13 | `mock-sprint-integ-passed-summary-log.test.mjs` tests 2 and 3 (2 of its 3 sprints) -- DONE (2026-08-03; both negatives moved into integ-infra-dispatch-failure) | `mock-sprint-integ-infra-dispatch-failure.test.mjs:150` and `:113`. Requires moving the two one-line negatives (`:98`, `:129`) to `integ-infra-dispatch-failure:121` and `:154`. Keep test 1 (`:57-65`), which is unique. **~2 sprints.** Section 3.10. |
| 14 | `packages/apra-fleet-se/apra-pm/test/sprint-execution-summary.test.mjs:31-208` (~14-19 tests) -- PARTIALLY DONE (2026-08-03: removed the 15 verified duplicates; KEPT 4 that `sprint-cost.test.mjs` does not in fact cover -- per-phase cost formatting `$0.0130`, reviewer CHANGES-NEEDED round, `_None -- goal met._` on goalMet=true, `null` logEntries, plus the `Risks remaining` header/negative) | `sprint-cost.test.mjs:426-549` and `:561-618`, same functions and assertion intent. Keep `:212-258` (5 unique wiring tests). Section 3.11. |
| 15 | `packages/apra-fleet-se/apra-pm/test/install-schemas.test.mjs:49-61` (1 test) -- DONE (2026-08-03) | `install-uninstall.test.mjs:84-92`, which proves the same thing functionally rather than by source regex. Section 4.5. |
| 16 | `packages/apra-fleet-workflow/test/viewer-stream-list-scroll-dom.test.mjs:37-46` -- DONE (2026-08-03; with #17 this emptied the file, so the whole file was removed) | `viewer-template-scroll-perf.test.mjs:57` -- same flex-chain CSS rungs. Section 3.12. |
| 17 | `packages/apra-fleet-workflow/test/viewer-stream-list-scroll-dom.test.mjs:59-82` -- DONE (2026-08-03; see #16 -- whole file removed) | Nothing needs to -- `buildStreamListBoxModel` is a hand-invented simulator not extracted from `src/`, so it cannot catch a real regression. Removing it loses no real coverage. Section 8.5. |

### Tier 3 -- RESOLVED (both items traced through `runner.js`; verdicts final)

Both items in this tier were open questions in the first pass. Both have now been
settled by a real code trace rather than a test-file diff. The two verdicts went in
**opposite directions**, which is why the trace was worth doing.

| # | Item | Verdict |
|---|---|---|
| 18 | `mock-sprint-planner-dispatch-dead-pid.test.mjs` (**19s**) | **CONFIRMED SAFE TO REMOVE** -- promoted to Tier 2 below. Two script couplings must be updated in the same change. -- DONE (2026-08-03: file + its `plannerdeadpid` bd recording removed; the two ordering assertions added to the survivor first; `check-watchdog-isolation.mjs` and `run-integ-suites.mjs` ISOLATED_LANE_FILES both repointed at the survivor, same 180000ms budget) |
| -- | `mock-sprint-all-streaks-failed-no-review.test.mjs` (**81s**) | **CONFIRMED NOT SAFE -- KEEP BOTH.** Dropped from the safe-removal list entirely. |

#### 18. `mock-sprint-planner-dispatch-dead-pid.test.mjs` -- CONFIRMED SAFE TO REMOVE

**Survivor: `mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session.test.mjs`.**

The open question was whether the survivor's mixed-payload ordering (attempt 1
clean-fail, attempts 2-5 dead-session) drives a different code path than the smaller
file's uniform all-attempts-dead-pid sequence. **It does not.** The two scenarios are
byte-identical where it counts:

- `dead-pid.test.mjs:50-56` returns the same
  `structuredContent: { isError: true, reason: 'dispatch_failed' }` on every attempt.
- The survivor's `:94-97` (attempt 1) and `:113-116` (attempts 2-5) return
  **the same `structuredContent`**; only the free-text `content[0].text` differs.

Traced through the retry ladder at `runner.js:6392-6441`, every cross-attempt state
variable is identical in both files:

| Cross-attempt state | Behavior in both files |
|---|---|
| `isPostDispatchSyncFailure(err)` (`runner.js:6413`) | false -- not a sync error |
| `skipPreDispatchSyncNext = isNoMutationDispatchFailure(err)` (`:6420`) | **true after attempt 1 in both.** `runner.js:4686-4693`: an `AgentDispatchError` whose `details.reason` is not in `AGENT_RAN_DISPATCH_REASONS` (`max_turns_exhausted`, `watchdog_timeout`); `dispatch_failed` is not, so both classify identically |
| `isNonRetryableDispatchError(err)` (`:6424`) | false in both. `errors.mjs:291,300-304` -- reason is neither `auth` nor `workspace_not_trusted`, and neither file's text matches `NON_RETRYABLE_DISPATCH_RE`. The survivor's own passing `plannerAttempt === 5` (`:132`) proves it takes the same retryable branch |
| `isAuthDispatchError` -> `onLlmAuthFailure` (`:6428-6433`) | never entered in either |
| `resume` flag | **structurally invariant.** Computed once per planning round at `runner.js:6319`, *outside* the retry loop; can only become truthy via `createRoundSessionRegistry.record()` (`:3418-3432`), fed by `onSessionId`, which `workflow/index.mjs:910-921` fires only *after* the `structured.isError` throw at `:878-894`. No successful dispatch means no recorded session, so `resumeArgFor` returns false (`runner.js:3443`) |

So the resume observable that **both** files assert on is insensitive to the very
distinction they were built around, and the smaller file exercises no branch, state
transition, or classification outcome the survivor does not. The assertion-by-assertion
table in section 4.1 stands: every dead-pid assertion has an equal-or-stronger
counterpart, and the survivor adds two unique ones (`:212` no `[dispatch-watchdog]`
line, `:265-279` `realSyncSpawnCount` bounds).

**Two non-test couplings block a bare `rm`** -- both verified directly, and both will
fail loudly rather than silently:

1. `scripts/check-watchdog-isolation.mjs:36` hardcodes
   `DEAD_PID_FILE = 'mock-sprint-planner-dispatch-dead-pid.test.mjs'` (budget at `:36`,
   180000ms). Its `!rec` branch at `:71-78` returns
   `FAIL: <file> not found in results (run the suite first)` when the file is absent
   from `integ-suite-status.json`. Deleting the test makes this guard fail hard.
2. `scripts/run-integ-suites.mjs:100-103` lists it in `ISOLATED_LANE_FILES`
   (concurrency-1 lane). Note the **survivor is not currently in that lane** -- if the
   isolation guard is meant to keep covering a dolt-heavy planner-retry ladder, point
   both the lane and the guard at the survivor rather than just dropping the entry.

(`dispatch-watchdog.test.mjs:15` and `test/slow/mock-sprint-planner-dispatch-stalled-session.test.mjs:15,59`
also name it, but in comments only -- cosmetic.)

**Assertion to add to the survivor.** The audit's original concern was correct and is
now confirmed: the survivor's stated reason for existing -- the mixed ordering -- is
**pinned by no assertion today**. All five of its assertions (`:132` `plannerAttempt === 5`,
`:191` `threwLines.length === 5`, `:196` `waitingLines.length === 4`, `:178` resume
flags, `:229` terminal `/dispatch_failed/`) would pass byte-identically if the handler
returned the attempt-2+ payload on every attempt -- i.e. if the file were the smaller
file with a longer header.

The distinguishing observable does exist: `runner.js:6439` interpolates `err.message`,
which carries the handler's `content[0].text` verbatim via `workflow/index.mjs:894`, and
the harness pushes every log event into `scenario.logs` in order
(`mock-sprint-harness.mjs:1245`). The file already builds `threwLines` at `:190`. Add,
after `:194`:

```js
check(
    /clean AGENT_DISPATCH_FAILED-class failure/.test(threwLines[0]),
    `Attempt 1 must be the DISTINCT clean pre-condition failure, got: ${threwLines[0]}`
);
check(
    threwLines.slice(1).every((m) => /reused interactive session now targets a dead launch-time process/.test(m)),
    `Attempts 2-5 must each be the dead-session failure: ${JSON.stringify(threwLines.slice(1))}`
);
```

Swap the branches in `plannerHandler` and the test then fails, which is the point.

For the record, two observables that **cannot** carry this: `scenario.dispatched`
entries record only `{agent, label, prompt, member, sprintId, resume, model}`
(`mock-sprint-harness.mjs:744`) with no response payload; and
`scenario.error.details.text` carries only attempt 5's text.

**Net: delete the file, update the two scripts, add the two ordering assertions.** ~19s.

#### `mock-sprint-all-streaks-failed-no-review.test.mjs` -- CONFIRMED NOT SAFE, KEEP BOTH

This reverses the first pass's tentative lean. The file is **not** redundant, and the
reason is a second Review dispatch site that the first pass had not found.

`dispatchReview()` (`runner.js:5507`) has **two** call sites, not one:

1. `runner.js:7657` -- the develop-round Review, inside the `else` of the empty-guard at
   `:7649`.
2. `runner.js:8308` -- a **cycle-level Re-Review**, gated at `:8285` by
   `if (openAtGoal.length === 0 && !reviewedThisCycle)`.

Both go through `buildReviewerPrompt`, so neither carries the
`Final review for sprint scope issue id(s):` prefix that the harness uses to set
`label: 'Final Review'` (`mock-sprint-harness.mjs:706-713,744`; everything else is
`label: null`). **Therefore `developRoundReviewDispatches` -- the array both tests filter
with `d.agent === 'reviewer' && d.label !== 'Final Review'` -- counts the cycle-level
Re-Review too.** It is not "round reviews only", which is what makes the two tests'
counts mean different things.

The two scenarios reach the `:8285` gate in structurally different states:

| | `reviewedThisCycle` at `:8285` | Can the Re-Review site be reached? |
|---|---|---|
| `all-streaks-failed` | **`false`** -- `:7667` is inside the `else`, never executed | **Yes** -- the gate is genuinely evaluated |
| `review-scope` | `true` -- set at `:7667` during its round 1 | **No** -- the branch is dead by construction |

Concrete regression class caught **only** by `all-streaks-failed:52`: weaken `:8285` to
`if (!reviewedThisCycle)` (dropping the `openAtGoal.length === 0` conjunct), or flip
`&&` to `||` -- exactly the kind of condition that gets "simplified" in a refactor.

- `all-streaks-failed`: the Re-Review fires, producing one non-final reviewer dispatch;
  `:52` (`=== 0`) **fails**. Caught.
- `review-scope`: `reviewedThisCycle` is already `true`, so the gate is false under
  either form; the count stays 1 and `:77` **passes**. Regression invisible.
- Nor do the neighbours catch it: `mock-sprint-exit-stale-approval.test.mjs:79`
  (expects 2) and `mock-sprint-round-resume.test.mjs:145,245` each have every cycle
  either running a real round review or firing a legitimate `openAtGoal === 0`
  re-review, so their counts are unchanged under the weakened gate.

This is not a hypothetical site: the comment block at `runner.js:8293-8307` documents
`apra-fleet-jfo.3`, a **live production crash on 2026-08-02** in which this exact branch
dispatched with `beadIds: []`, drew a contract-violation response, and aborted an entire
sprint. `all-streaks-failed:52` is the only negative assertion in the suite pinning "no
review is dispatched when work remains open and nothing was reviewed this cycle".

**The coverage cannot be folded into the survivor by adding an assertion.** The gap is a
*reachable state*, not a missing observable -- making `reviewedThisCycle === false` at
`:8285` requires round 1 itself to be all-failed, which *is* the all-streaks scenario.

Secondary unique coverage, for completeness: `all-streaks-failed` is also the only
scenario where the empty-guard must fire on **round 1** (a regression scoping it to
`devRounds > 1` passes `review-scope:77` and fails `all-streaks-failed:52`), and the only
one exercising `lastReviewVerdict === null` reaching `:8403`.

**Optional hardening** (not a removal). Make the file's unique purpose explicit by
adding alongside `:50`:

```js
check(!scenario.logs.some((m) => m.includes('no review ran THIS cycle')),
  'Re-Review (runner.js:8285) must NOT fire while goal-priority beads remain open');
```

The string comes from `runner.js:8288` and is available from `scenario.logs`
(`mock-sprint-harness.mjs:1245`) -- the same line
`mock-sprint-exit-stale-approval.test.mjs:82` asserts positively.

One scoping note on the trace: `streakOutcomes` is declared inside the round body
(`runner.js:7063`), so there is no cross-round accumulator today -- the "round 1 survivor
poisons later rounds via stale beadIds" regression class considered in the first pass is
**not** live in the current code. The verdict above rests entirely on the `:8285`
re-review site, which is.

### Aggregate

- **18 confirmed safe-removal candidates**: 3 in Tier 1, 14 in Tier 2, plus item 18
  promoted from Tier 3 after the trace. **Zero remain conditional** -- both Tier 3
  questions are now resolved.
- **1 candidate rejected on the evidence**:
  `mock-sprint-all-streaks-failed-no-review.test.mjs` is NOT subsumed and must stay
  (Tier 3 above). Its 81s is the price of the only guard on the cycle-level Re-Review
  site, which caused a live sprint abort on 2026-08-02.
- **Default-lane time saved by removals alone: ~5-10s** (these files are cheap in the
  mocked lane -- the default suite's cost is elsewhere).
- **Real-bd lane time saved by removals alone: ~420s cumulative** (items 10-13 and 18).
- **Real-bd lane time saved by the section 7.3 refactors: ~1,400s further** -- these are
  *not* deletions and carry no coverage loss, but they do require exporting five
  currently-inline functions (`decideStall`, `publishPr`, `bdListScoped`, and for
  symmetry `buildPlanReviewerPrompt`).
- **Combined realistic reduction of the real-bd lane: ~1,800s of 7,431s mock-sprint
  cumulative time (~24%)** with no loss of pinned behavior.
- **The single largest win remains section 7.1: 199s off every CI run**, from fixing
  registry sharing rather than removing anything.

### Explicitly NOT recommended for removal

The clusters listed at the end of section 3 were each suspected and cleared with
evidence. In particular: none of the 10 `credential-*` files, none of the 6
`register-member*` files, neither `activity.test.ts`, and none of the 4 client transport
files should be cut. `stall-any-entry-activity-and-kill.test.ts:106-127` overlaps
`stall-detector.test.ts:165-186` only partially (different mechanism under test) and
should stay.

---

## 10. Keeping this current

The measurement steps are cheap and scripted. Re-run them after any major test-suite
change, and at minimum before acting on any deletion in section 9 (line numbers drift).

The helper scripts used to produce this document are in `tmp_test_audit/`. Note that
directory is **untracked but not gitignored** -- either add it to `.gitignore`, move the
four scripts somewhere durable under `scripts/`, or delete it; do not let it get
committed by accident. Recreate it if absent:

1. **Static inventory** -- `node tmp_test_audit/inv.mjs` walks all six test roots and
   emits `inventory.txt` with per-file line/byte counts, `describe`/`test` counts, and
   `skip` / `only` / `todo` counts. **The `only` column must always be zero** -- a stray
   `.only(` silently disables the rest of its file.
2. **Root suite timing** --
   `npx vitest run --reporter=json --outputFile=tmp_test_audit/root-vitest.json`, then
   sort `testResults` by `endTime - startTime`.
3. **Root parallelism check** -- `npx vitest run --fileParallelism` and compare wall
   clock. Once section 7.1 is fixed this should pass; until then the failure count
   (currently 263) is the size of the remaining registry-sharing problem and is a useful
   progress metric.
4. **Per-file timing for `node --test` surfaces** --
   `node tmp_test_audit/time-se.mjs packages/apra-fleet-se/test tmp_test_audit/se-timing.json 8`
   runs each file in its own process at the same concurrency the package uses and
   records wall clock plus pass/fail counts. Run it **without another suite running
   concurrently** -- an overlapping run inflated the first pass of this audit by up to
   3x before it was redone.
5. **Regenerate the inventory table** -- `node tmp_test_audit/gen-table.mjs` rebuilds
   section 2 from the JSON outputs above, deriving each file's purpose from its own
   top-level title.
6. **Real-bd lane** -- do not re-run it for inventory purposes; read
   `integ-suite-status.json` from the most recent `scripts/run-integ-suites.mjs` pass
   (per `packages/apra-fleet-se/test/INTEG-SUITE.md`). Check its `startedAt` first --
   the copy read for this audit (2026-07-31) was already stale in two ways (section 8.4).
   `node scripts/check-integ-suite-budget.mjs` reports files over the 300s budget
   automatically.

Two maintenance notes specific to this repo:

- **Re-date or delete `packages/apra-fleet-se/test/TEST-VALUE-ANALYSIS.md`** when acting
  on this document. Two overlapping, differently-stale analyses is worse than one
  (section 8.4).
- **The mock-sprint family will keep growing** -- it gains files faster than any other
  surface, one per bug fixed, and each new file costs ~100s of real-bd time by default.
  The cheap pattern already exists in-repo (`mock-sprint-pure-logic.test.mjs`,
  `mock-sprint-git-sync-brackets.test.mjs`, `mock-sprint-retry-resume-remote-tip.test.mjs`
  -- 39 tests in 3 seconds). Prefer it whenever the thing being pinned is the return
  value of a function rather than an emergent property of a multi-cycle run.

---

## 11. Confidence and limits

Stated plainly so this document is not over-trusted:

- **Measured, high confidence:** every duration, test count, file count, pass/fail
  result, the parallelism experiment (7.1), the two red tests (5.1, 5.2), the CI wiring
  (1.3, 8.1), the now-retired-and-replaced dolt-recovery modules (6.3), the absence of any `.only` and the
  three `describe.todo` stubs.
- **Verified by reading both sides, high confidence:** every duplicate and subsumption
  cluster in sections 3 and 4 carries file:line evidence on both sides.
- **Inferred, medium-high confidence:** the coverage gaps in section 6. There is no
  coverage tool; these come from import graphs plus whole-word symbol sweeps across
  ~112k lines of test code. A symbol never named anywhere is strong evidence of a gap,
  but barrel re-exports (for example `src/services/stall/index.js`) can hide real
  coverage, and a symbol being *named* does not prove assertion depth. Every
  load-bearing claim was spot-checked by reading the lines; the ranking is a judgment.
- **Resolved in the second pass (were open in the first):** both Tier 3 items were
  traced through `runner.js` and now carry final verdicts -- item 18 confirmed
  removable (the retry ladder classifies both scenarios identically at
  `runner.js:6413,6420,6424` and the `resume` flag is structurally invariant per
  `:6319`/`:3443`), and `all-streaks-failed` confirmed **not** removable (the
  cycle-level Re-Review site at `runner.js:8285,8308` is reachable only from its
  scenario). See the Tier 3 section of 9. Confidence: high on both -- each rests on
  named call sites and gate conditions that were read directly, not inferred.
- **Explicitly unresolved -- do not act without checking:**
  1. Whether the stall detector's high-water abort and flat-zero abort share one code
     path. If they do, the shared assertions in 4.3 are redundant. Not traced.
  2. Whether the darwin-x64 source-build fallback is still a product requirement
     (determines whether 5.1 is a runbook regression or an obsolete test).
  3. Whether any module *other* than `runner.js` reachable from `runSprintCycle`
     dispatches with `agent: 'reviewer'`. The two `dispatchReview()` call sites plus the
     Final Review site were found by an exhaustive `agentType: 'reviewer'` sweep of
     `runner.js`, which is sound for that file; a sibling-module dispatcher would only
     strengthen the keep-both verdict, never weaken it.
- **Not audited:** `tests/hub-service/` (24 files) was inventoried and timed but not
  swept for internal duplication. Within `tests/execute-prompt.test.ts` (2408 lines),
  bodies were read for lines 1-410 and 777-965 only -- a duplicate inside 1976-2408
  cannot be ruled out. Same for `tests/execute-prompt-interactive.test.ts` (691 lines).
  21 of the 44 apra-pm files were checked by name and import only, not pairwise-read.
- **Deliberately not run:** `tests/toy-doer-bare-token-real-cli-integ.test.ts` and
  `tests/toy-doer-envvar-real-cli-integ.test.ts`. They touch real CLI credentials; they
  self-skip by default and were left that way.
