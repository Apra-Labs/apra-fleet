<!-- llm-context: Plan of action for reviving/landing the SSE/HTTP/JWT/session-registry/send_message/
     service-manager/singleton feature set after the enhancement/skill-reorg rebase onto main (5526fe7).
     Written 2026-07-02 as analysis output; this is a plan, not an implementation. -->

# SSE/HTTP Interactive-Session Revival Plan

Status: post-rebase analysis of `enhancement/skill-reorg` (34 commits rebased onto
`5526fe7`). Build compiles clean. Full test suite: 13 failures, of which 4 are
genuinely caused by this branch and 9 are pre-existing order-dependent flakiness
(main itself fails 21 tests non-deterministically on this Windows machine).

---

## 1. What is solid and can stay as-is

- **HTTP transport core** (`src/services/http-transport.ts`). Per-session McpServer
  instances, /health and /shutdown endpoints, event-bus broadcast to all sessions,
  port fallback on EADDRINUSE, close() cleanup. Tests pass. The JWT-verify-on-POST
  and session-registry hooks in onsessioninitialized/onsessionclosed are correctly
  placed (registration happens only once the McpServer object is live).
- **index.ts wiring**. The `run` verb (HTTP default, stdio via --transport),
  singleton check + startup lock + server.json write, shutdown handlers. Correct
  post-rebase; cli-verbs.test.ts passes.
- **Singleton** (`src/services/singleton.ts`). server.json + PID + health-check
  detection, stale-lock recovery. Tests pass.
- **Service manager** (`src/services/service-manager/{windows,linux,macos}.ts`).
  Scheduled Task / systemd-user / LaunchAgent registration, graceful stop via
  /shutdown with SIGTERM fallback. Tests pass. Install integration
  (install-service.test.ts) passes.
- **Event bus** (`src/services/event-bus.ts`) and the `credential:stored` SSE event.
  Tests pass.
- **JWT service** (`src/services/jwt.ts`). HS256 via node:crypto, no external
  dependency, key persisted at ~/.apra-fleet/fleet.key (0600), 7-day expiry,
  claim-shape validation on verify. Adequate for Phase 1 local single-tenant use.
- **Session registry** (`src/services/session-registry.ts`). Simple in-memory map;
  fine as the Phase 1 volatile layer.
- **send_message tool skeleton** (`src/tools/send-message.ts`) and its registration
  in tool-registry. POC-validated delivery via `notifications/claude/channel`.

## 2. What is broken or incomplete, and why

### 2.1 Branch-caused test failures (deterministic, 4 tests)

- `tests/install-npm.test.ts` (3): npm-mode installs now register the HTTP URL
  (`claude mcp add --transport http ... http://localhost:7523/mcp`) instead of the
  stdio command carrying the npm script path. Main added these tests after the
  branch diverged; they assert stdio registration in npm mode.
- `tests/install-multi-provider.test.ts` (1): opencode MCP entry is written as
  `{type:'remote', url}` under HTTP default; main's test expects `{type:'local',
  command:[...]}`.
- Root cause for both: the branch made HTTP the default install transport for all
  providers and install modes. Main's newer tests encode stdio expectations for
  npm mode and opencode. This is a design collision, not a coding bug (see 4.1).

### 2.2 The "pre-existing flakiness" claim: RETRACTED and root-caused (2026-07-02)

The earlier characterization of 9 branch failures + 21 main-baseline failures as
"pre-existing order-dependent flakiness" was wrong. Evidence-based findings:

- **CI ground truth confirmed.** GitHub API check of ci.yml runs on main: the 3
  most recent runs (including 5526fe7, the exact merge base) all concluded
  `success`, and the build-and-test job matrix includes windows-latest. Main is
  green in CI, including on Windows.
- **Main is green locally too, when run alone.** A fresh tarball checkout of
  main (no git needed) was run 3 consecutive times on this machine:
  - Run 1: 1577 passed, 2 failed -- both failures were artifacts of the invoking
    process's cwd pointing at the parent directory (validate-sprint.test.ts reads
    `.github/e2e/*.json` via `process.cwd()`, and the parent's `.github/` was
    destroyed in the git-loss incident; see RECOVERY.md).
  - Runs 2 and 3 (cwd inside the checkout): **1593 passed / 0 failed**, twice.
  There is no non-determinism and no order-dependence when a single test run
  owns the machine.
- **The actual cause of the earlier failures: two concurrent agent sessions ran
  the test suite simultaneously in this checkout** (documented with fingerprints
  in RECOVERY.md). The shared mutable state they fought over:
  - `tests/setup.ts` points every run at the SAME fixed directory
    `os.tmpdir()/apra-fleet-test-data` (never cleaned between runs).
    vitest.config.ts sets `fileParallelism: false` precisely because "tests
    share registry.json in temp dir" -- which serializes files within ONE run
    but provides zero protection against a second concurrent vitest process.
  - The failing sets observed under concurrency (provision-auth,
    provision-vcs-auth, agent-helpers, register-member-oob, cloud-lifecycle,
    receive-files) are exactly the suites that read/write the shared
    registry.json / credential store in that directory.
  - Additionally, the real `~/.apra-fleet/data/` on this machine contains a
    live member registry (5 members), credentials.json, and onboarding state,
    and a real fleet server flaps on port 7523 (this session's own apra-fleet
    MCP server; observed up at 01:05 and down at 01:10 during investigation).
    Any test path that misses the env override, plus the branch's
    register-member bootstrap (2.3.4), can touch this real state.
  - A stale installed `~/.claude/skills/fleet` from earlier `apra-fleet
    install` runs exists on this machine. It was checked and is NOT implicated
    in these particular failures, but it is the same class of hazard as the
    stale-skills bug already fixed once this session.
- **Conclusion:** there is no evidence of intrinsic test flakiness on main.
  The hard rule going forward: never run two test sessions concurrently in the
  same checkout, and never dispatch two agents into one checkout (see
  RECOVERY.md for what else that caused). Hardening (per-run unique
  APRA_FLEET_DATA_DIR via `os.tmpdir()` + PID/random suffix, cleaned in
  teardown) remains worthwhile -- kept as step 10 in section 5.

### 2.3 Feature-level gaps and bugs (found by code reading)

1. **compose_permissions destroys the member MCP entry.** register_member writes
   `mcpServers['apra-fleet-member']` (with the Bearer JWT) into the member's
   `.claude/settings.local.json`. compose_permissions later rewrites that file
   wholesale via `composePermissionConfig()` -- it merges only `permissions.allow`,
   so the apra-fleet-member entry and token are silently deleted on the first
   compose. Any real sprint flow (register -> compose -> dispatch) breaks the
   interactive channel.
2. **Identity keying is inconsistent.** The JWT carries `member_id = tempAgent.id`
   (UUID) but the URL fallback (`/mcp?member=...`) carries the friendly name. The
   registry is keyed by whichever path won, so send_message callers cannot know
   which key to use. Also the spawn-time registry entry (holding the PID) is keyed
   by agent id and then *replaced* by the connect-time entry, losing the PID --
   kill-before-respawn only works until the first reconnect.
3. **Hardcoded port 7523 in register-member.** Health check and settings URL ignore
   `APRA_FLEET_PORT` and the EADDRINUSE port-fallback; should resolve the actual
   port from server.json (singleton) or DEFAULT_PORT.
4. **register_member side effects run in tests.** The bootstrap does a real HTTP GET
   to 127.0.0.1:7523 and, if a fleet server happens to be running on the dev
   machine, writes settings and spawns a real `claude` process from unit tests
   (model-tiers, onboarding tests register local members). Needs gating/DI.
5. **Unvalidated config surface.** The assumption that Claude Code reads
   `mcpServers` (with `headers`) from `.claude/settings.local.json` is not
   verified; project MCP servers normally live in `.mcp.json` or via
   `claude mcp add`. The `?member=` URL fallback was added precisely because the
   header path was in doubt. Needs a definitive check against Claude Code docs.
6. **No status lifecycle.** send_message sets the member `busy` and nothing ever
   sets it back (`online`/`idle` transitions are missing; there is no response or
   ack path from the member back to PM -- Step 7 of the architecture's Section 6
   is unimplemented).
7. **Zero test coverage for the new pieces.** No tests exist for jwt.ts,
   session-registry.ts, send-message.ts, or the JWT/member-param paths in
   http-transport.
8. **JWT design drift vs architecture doc.** Role is claimed by the registrar
   (hardcoded 'doer'), not looked up from a registry (doc Section 9, R10 requires
   registry-derived roles). project_id is fixed 'default'. 7-day expiry has no
   refresh path -- a long-lived member session dies silently; the token is only
   re-minted on re-register. Acceptable for Phase 1, must be revisited before any
   multi-tenant exposure.
9. **`--dangerously-load-development-channels`** is a dev-channel flag; the whole
   claude/channel injection path is experimental and version-dependent. Fine for
   POC; needs a fallback story (or a minimum-version check) before it is relied on.
10. **execute_prompt does not route interactive members.** Section 6/12 of the
    architecture doc call for execute_prompt to internally route via send_message +
    wait-for-response for connected Claude members. Not started; execute_prompt is
    subprocess-only today.
11. **Session registry is volatile.** Server restart loses all sessions (and PIDs);
    there is no announce_self / reconnect rebuild, no offline grace period. Members
    reconnect only because the MCP client retries; registry state after a fleet
    restart depends entirely on clients re-initializing.

## 3. How much main has moved (context for the fixes)

Since the branch diverged, main landed: opencode as a sixth provider (with
model_tiers validation and its own MCP config shape), the tags/category member
model + tag-aware compose_permissions, `install` as the default CLI action with
`run` as the server verb, bare model aliases, e2e rework (GitHub-hosted runners),
and the pm skill moving out to the vendor/apra-pm submodule. All were reconciled
during the rebase; the remaining friction points are exactly the four install
tests (2.1) and the compose_permissions interplay (2.3.1).

## 4. Design questions -- decisions and remaining opens

Decisions confirmed by the human on 2026-07-02:

1. **Default install transport: DECIDED -- HTTP is the default going forward.**
   (Human's reasoning: opencode also supports it, so there is no real barrier.)
   The tree already implements this (option (a)): tests updated for HTTP-default
   with stdio opt-in via `--transport stdio` (see Addendum A1). No further
   action beyond keeping the tests as they now are.
2. **Member identity key: DECIDED -- agent UUID is the standard.** Canonical key
   for JWT claims, registry keys, and send_message addressing. Implementation
   note (from the original recommendation): registry stores friendlyName
   alongside, send_message accepts either and resolves via the member registry
   (same resolveMember() used by other tools). This is step 3 in section 5.
3. **Hardcoded port 7523: DECIDED -- must be fixed, no hardcoding, full stop.**
   register-member (and any other member-facing URL construction) must resolve
   the live server URL from singleton/server.json. This is step 4 in section 5.

Still open, awaiting a human decision (asked verbatim, not yet answered):

3b. **Where the member MCP entry lives.** settings.local.json mcpServers (current,
   unvalidated) vs .mcp.json vs `claude mcp add --scope project`. Must be resolved
   by testing against current Claude Code; determines fix shape for 2.3.5 and how
   compose_permissions must merge (2.3.1).
4. **Roles and the tags/category system.** Main now has tags (doer/reviewer as
   mode tags). Should the JWT role come from member tags instead of a hardcoded
   'doer'? Recommendation: yes -- derive from tags at token-mint time.
5. **Scope of Phase 1.** Is the goal only local single-tenant (localhost, one
   project) for now? If yes, items 2.3.8/2.3.11 stay as documented limitations and
   the plan below is sufficient. If multi-tenant work starts, jwt/session-registry
   need the tenant-registry layer from architecture Sections 3 and 9 first.

## 5. Sequenced next steps

| # | Step | Scope | Risk |
|---|------|-------|------|
| 1 | DONE -- Q1 decided (HTTP default) and the 4 install tests were fixed in-tree (Addendum A1); suite green | - | - |
| 2 | Fix compose_permissions to deep-merge settings.local.json (preserve mcpServers entries and skillOverrides it does not own) | S-M (compose-permissions.ts + claude provider + tests) | Med -- touches permission delivery for all Claude members |
| 3 | Unify identity keying on agent UUID (JWT claims, URL param, registry key, send_message resolution via resolveMember); preserve PID across registry re-registration (merge, not replace) | M (4 files + new tests) | Med |
| 4 | De-hardcode port: register-member resolves the live server URL from singleton/server.json; single source of truth for the member-facing URL | S | Low |
| 5 | Gate the register-member bootstrap behind an explicit flag (e.g. `interactive: true` input or env), so unit tests and non-interactive registrations never health-check/spawn; inject http+spawn for testability | S-M | Low |
| 6 | Validate the Claude Code config surface (Q3) with a live check; adjust where the member MCP entry is written; document the finding in docs/cloud-fleet-architecture.md | M (investigation + possible rewrite of the settings write) | Med -- external dependency on Claude Code behavior |
| 7 | Add unit tests: jwt (sign/verify/expiry/tamper), session-registry (register/replace/PID-merge), send-message (no-session, no-server, happy path with mock server), http-transport JWT + member-param paths | M (4 new test files) | Low |
| 8 | Status lifecycle + response path: member 'busy' -> 'online' transitions; define how a member reports completion (send_message from member with reply_to, or Stop-hook callback), per architecture Section 6 Step 7 | L (design + impl) | High -- protocol design |
| 9 | execute_prompt interactive routing (send_message + wait-for-response) behind a member capability flag, keeping subprocess path as fallback | L | High |
| 10 | Fix suite-wide test pollution (shared APRA_FLEET_DATA_DIR / registry / credential-store state across files); make full-run green and deterministic on Windows | M-L (test harness) | Med -- pre-existing, unblocks trustworthy CI |

Steps 1-5 are small, independent, and unblock a trustworthy green build; do them
first, in any order. Step 6 gates steps 8-9. Step 10 can proceed in parallel.

## 6. Verification snapshot (updated 2026-07-02, post-investigation)

- `npm run build`: clean.
- Main baseline (fresh tarball of origin/main, this machine, single session):
  3 consecutive runs -- 0 real failures (run 1's two failures were invoking-cwd
  artifacts; runs 2-3 fully green at 1593 passed). See 2.2 for full evidence.
- CI on main: last 3 ci.yml runs `success` via GitHub API, including merge base
  5526fe7; matrix includes windows-latest.
- Branch tree (this working tree, single session): 1756 passed; only failures
  are `.github/` destruction fallout (validate-sprint.test.ts x2 +
  ci-npm-publish.test.ts file error, all reading the deleted `.github/` dir) --
  resolved by RECOVERY.md's dotfile-restore step, not code bugs. The earlier
  4 install-test failures are fixed in-tree (Addendum A1); the earlier "9
  flaky" failures were concurrency artifacts (see 2.2).
- Git state: local history lost in the 2026-07-02 incident (see RECOVERY.md and
  Addendum A4); tree content verified; origin untouched. Nothing pushed.

---

## Addendum (second analysis pass, 2026-07-02 evening)

A second agent session independently performed the same rebase+review in this
checkout (the two sessions ran concurrently without knowing about each other;
see RECOVERY.md for the fallout). Findings that extend the plan above:

### A1. The 4 branch-caused install-test failures are FIXED in the tree

Step 1's test fixes were implemented (choosing option (a) pro tem: keep HTTP
default, update tests): the three install-npm stdio assertions now install
with `--transport stdio` and assert the exact
`"run" "--transport" "stdio"` argument form; a new test asserts the URL
registration for the http default. install-multi-provider's opencode
type:local test now installs with `--transport stdio`, and a new test covers
`{type:'remote', url}` under the http default. mergeOpenCodeConfig gained the
remote-URL form. tool-registry descriptions were synced with main's
tag-aware versions (register_member, list_members, update_member,
compose_permissions). After these fixes a full run was GREEN:
1772 passed / 0 failed / 14 skipped. Q1 (transport default) remains open as
a design decision -- option (b) would flip these tests again.

### A2. Additional defects found (add to section 2.3)

12. **Stale-close unregister race in http-transport.** onsessionclosed
    unregisters by the member_id captured at initialize time. If a member
    reconnects (new sid) and the OLD session closes afterwards, the close
    handler unregisters the NEW session's registry entry. Guard with
    `sessionRegistry.get(member_id)?.sessionId === sid` before unregister.
13. **/shutdown is unauthenticated.** Any local process can POST /shutdown
    and kill the fleet server. Require the JWT or drop the endpoint in favor
    of the service manager.
14. **Sprint-process files at repo root** (PLAN.md, feedback.md,
    progress.json, requirements.md) ride along from early branch history;
    main's convention removes them from final changesets. Drop before PR.
15. **Doc debt from the rebase:** docs/architecture.md and llms-full.txt were
    taken wholesale from main, so the HTTP transport is currently
    undocumented in both (regenerate llms-full.txt via
    scripts/gen-llms-full.mjs after updating docs). The branch's PM-skill
    edits (substitutions doc, dangerously_skip_permissions purge) were
    dropped with the skills/pm deletion -- verify vendor/apra-pm covers
    them, port if not.

### A3. Rebase conflict-resolution record (for re-review or redo)

- index.ts: kept branch's registerAllTools + startHttpServer/startStdioServer
  split; merged main's install-by-default dispatch; `run` gained
  `--transport http|stdio` (default http); kept branch's
  start/stop/restart/status service verbs (main's `start`-as-alias dropped).
- install.ts: branch's http/stdio registration branches kept; stdio arm
  modernized to main's `run` + npm-global + quoting form, now appending
  `--transport stdio`; opencode wired into both arms.
- auth-socket.ts: main's submitPassword refactor kept; branch's
  credential:stored emit moved inside submitPassword's waiter resolution.
- skills/pm/*: main's deletions accepted (PM vendored via apra-pm).
- Toy-suite commit 40619df + its revert 09ea80a: both skipped after
  verifying `git diff 40619df~1 09ea80a` is empty (net zero).
- docs/architecture.md + llms-full.txt: main's versions taken (see A2.15).

### A4. Incident note

Shortly after the rebase and the green test run, this checkout's .git
directory (plus .gitignore/.gitattributes/.gitmodules/.github/.claude/
.fleet-task.md) was destroyed by an external event while two agent sessions
shared the directory. The full rebased TREE survived and is verified green;
the rebased commit HISTORY was lost. origin/enhancement/skill-reorg
(pre-rebase) is untouched. See RECOVERY.md at repo root for evidence and
step-by-step re-commit instructions. Until recovery is done, treat this
working tree as the single source of truth for the rebase result.
