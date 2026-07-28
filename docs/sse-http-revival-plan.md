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
  Tests pass. SCOPE CAVEAT (added after the Q5 decision, see section 4): the
  event bus itself is fine, but http-transport's broadcast of fleet events to
  ALL connected sessions is a single-project assumption -- under Phase 1
  multi-project scope it leaks events across project boundaries and must
  become project-scoped routing. Downgraded from "stays as-is" to "needs a
  scoping layer".
- **JWT service** (`src/services/jwt.ts`). HS256 via node:crypto, no external
  dependency, key persisted at ~/.apra-fleet/fleet.key (0600), 7-day expiry,
  claim-shape validation on verify. Adequate for Phase 1 local single-tenant use.
- **Session registry** (`src/services/session-registry.ts`). Simple in-memory map;
  fine as the Phase 1 volatile layer. SCOPE CAVEAT (Q5 decision): keying and
  accessors must become project-aware -- see revised 2.3.11. Data shape is fine;
  access paths are not.
- **send_message tool skeleton** (`src/tools/send-message.ts`) and its registration
  in tool-registry. POC-validated delivery via `notifications/claude/channel`.
  SCOPE CAVEAT (Q5 decision): must enforce sender-project == target-project
  before delivery (promoted into Phase 1; see section 4 Q5).

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
- **The actual cause of the earlier failures: two OVERLAPPING agent processes
  from a SINGLE orchestrator ran test suites simultaneously in this checkout.**
  (Corrected attribution, confirmed by the orchestrator 2026-07-02: there was no
  second human or independent session. A prior dispatch hit the orchestrator's
  600-second inactivity timeout and was reported "failed" -- but that timeout
  only meant the watcher gave up, NOT that the spawned claude process on this
  machine was killed. The next dispatch, resuming the same session, started a
  second process against the same working directory while the first was still
  alive mid-work. One orchestrator, two overlapping process trees, one
  directory. The orchestrator verified post-incident that no stray processes
  remain: no orphaned claude.exe, nothing bound to port 7523, nothing else
  touching this directory.) The shared mutable state the two process trees
  fought over:
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
  The operational lesson for the orchestrator: a dispatch-watcher timeout is
  not proof the dispatched process died -- before re-dispatching (especially
  with resume) into the same working directory, verify the previous process is
  actually gone (see RECOVERY.md for what else the overlap caused). Hardening
  (per-run unique APRA_FLEET_DATA_DIR via `os.tmpdir()` + PID/random suffix,
  cleaned in teardown) remains worthwhile -- kept as step 10 in section 5.

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
8. **JWT design drift vs architecture doc -- now partially IN scope for Phase 1
   (per Q4/Q5 decisions, section 4).** Role is claimed by the registrar
   (hardcoded 'doer') -- DECIDED: derive from member tags at token-mint time.
   project_id is fixed 'default' -- DECIDED: real project identity becomes
   first-class in Phase 1 (multi-project on one machine). 7-day expiry still
   has no refresh path -- a long-lived member session dies silently; the token
   is only re-minted on re-register; still acceptable for Phase 1, revisit for
   multi-machine. The claim SHAPE {member_id, project_id, role, work_folder}
   is location-agnostic and needs no breaking change for multi-machine later.
9. **`--dangerously-load-development-channels`** is a dev-channel flag; the whole
   claude/channel injection path is experimental and version-dependent. Fine for
   POC; needs a fallback story (or a minimum-version check) before it is relied on.
10. **execute_prompt does not route interactive members.** Section 6/12 of the
    architecture doc call for execute_prompt to internally route via send_message +
    wait-for-response for connected Claude members. Not started; execute_prompt is
    subprocess-only today.
11. **Session registry is volatile AND single-project-keyed.** Server restart
    loses all sessions (and PIDs); there is no announce_self / reconnect
    rebuild, no offline grace period. Members reconnect only because the MCP
    client retries; registry state after a fleet restart depends entirely on
    clients re-initializing. Volatility stays acceptable for Phase 1. What is
    NOT acceptable under the decided Phase 1 scope (multi-project, section 4
    Q5): the registry is keyed by bare member id with project_id as a passive
    field -- keying/accessors must become project-aware ((project_id, uuid)
    composite or project-filtered views), and list()/send_message consumers
    must never see cross-project sessions. The SessionState shape already
    carries project_id, so this is an access-path change, not a data-model
    break -- and the same structure extends to multi-machine later without
    redesign (a machine/endpoint field can be added additively).

## 3. How much main has moved (context for the fixes)

Since the branch diverged, main landed: opencode as a sixth provider (with
model_tiers validation and its own MCP config shape), the tags/category member
model + tag-aware compose_permissions, `install` as the default CLI action with
`run` as the server verb, bare model aliases, e2e rework (GitHub-hosted runners),
and the pm skill moving out to the packages/apra-fleet-se/apra-pm submodule. All were reconciled
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
4. **Roles and the tags/category system: DECIDED (2026-07-02) -- derive the JWT
   role from member tags at token-mint time**, exactly as recommended. No
   hardcoded 'doer'.
5. **Scope of Phase 1: DECIDED (2026-07-02) -- single machine (localhost), but
   MULTI-project.** One MCP instance / one session registry serves multiple
   projects/repos concurrently on the same machine. Additionally, the
   underlying architecture (JWT claims, session-registry keying, HTTP
   transport) must NOT bake in single-machine or single-client assumptions
   that would force a breaking redesign for a FUTURE phase where multiple
   clients connect to one MCP instance from separate devices/machines. Phase 1
   does not implement multi-machine support, but the data model (session keys,
   JWT claims such as project_id, registry keying) must be forward-compatible.
   Concrete implications:
   - **project_id becomes first-class NOW.** JWT claims already carry
     project_id (good), but register-member mints it as the literal 'default'
     and nothing validates or scopes by it. Token minting must bind a real
     project identity (derivable from the work_folder/repo), and every
     consumer (session registry views, send_message routing) must respect it.
   - **Session-registry key: (project_id, member_id-UUID) composite**, or
     member-UUID key with mandatory project_id field + project-filtered
     accessors. Plain member-name/UUID-only keying is a single-project
     assumption -- eliminate it in step 3 of section 5 (identity unification),
     which now includes project scoping in its scope.
   - **send_message must enforce project boundaries.** With multiple projects
     on one instance, an unscoped send_message lets project A's PM message
     project B's members. Sender project (from the caller's session/JWT) must
     match the target member's project. Promoted from "later" to Phase 1.
   - **Event broadcast must be project-scoped.** http-transport currently
     broadcasts fleet events (credential:stored, task:completed, ...) to ALL
     connected sessions -- a cross-project information leak under Phase 1
     scope. Needs per-project routing (see revised solidity note, section 1).
   - **Known single-MACHINE assumptions that are acceptable for Phase 1 but
     flagged for the multi-machine future** (no breaking data-model change
     expected): 127.0.0.1-only bind in http-transport (future: configurable
     bind + TLS); HS256 shared-secret fleet.key readable only on this machine
     (future: per-member tokens minted by the server it connects to, or an
     asymmetric keypair -- claim SHAPE stays the same, so not breaking);
     localhost URL written into member settings (future: server URL comes from
     member registration). The JWT claim set {member_id(UUID), project_id,
     role, work_folder} is already location-agnostic and survives multi-machine
     unchanged.

## 5. Sequenced next steps

| # | Step | Scope | Risk |
|---|------|-------|------|
| 1 | DONE -- Q1 decided (HTTP default) and the 4 install tests were fixed in-tree (Addendum A1); suite green | - | - |
| 2 | Fix compose_permissions to deep-merge settings.local.json (preserve mcpServers entries and skillOverrides it does not own) | S-M (compose-permissions.ts + claude provider + tests) | Med -- touches permission delivery for all Claude members |
| 3 | Unify identity keying on agent UUID (JWT claims, URL param, registry key, send_message resolution via resolveMember); preserve PID across registry re-registration (merge, not replace); make registry keying/accessors project-aware, bind real project_id at token mint, derive role from tags (Q2/Q4/Q5 decisions), enforce project match in send_message, project-scope the event broadcast | M-L (6 files + new tests) | Med |
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

A second agent process performed the same rebase+review in this checkout,
overlapping the first (corrected attribution: both were dispatched by the SAME
orchestrator -- a watcher timeout on the first dispatch was mistaken for
process death, and the follow-up dispatch overlapped the still-running first
process; see 2.2 and RECOVERY.md). Findings that extend the plan above:

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

12. **Stale-close unregister race in http-transport.** [RESOLVED
    2026-07-04, apra-fleet-2xs.10] onsessionclosed unregisters by the
    member_id captured at initialize time. If a member reconnects (new sid)
    and the OLD session closes afterwards, the close handler unregisters the
    NEW session's registry entry. Fixed by guarding both the JWT and
    URL-param fallback unregister paths with
    `sessionRegistry.get(workspace_id, member_id)?.sessionId === sid` before
    unregistering -- see `src/services/http-transport.ts`. This is a general
    invariant for any future session-keyed cleanup: never unregister a
    registry entry from a close/timeout handler without first confirming the
    entry still points at the session that is closing.
13. **/shutdown is unauthenticated.** [RESOLVED 2026-07-04,
    apra-fleet-2xs.11] Any local process could POST /shutdown and kill the
    fleet server. Now requires the local admin key (same guard used for
    other privileged local-only endpoints) -- see
    `src/services/http-transport.ts` and `src/tools/shutdown-server.ts`.
14. **Sprint-process files at repo root** (PLAN.md, feedback.md,
    progress.json, requirements.md) ride along from early branch history;
    main's convention removes them from final changesets. Drop before PR.
15. **Doc debt from the rebase:** docs/architecture.md and llms-full.txt were
    taken wholesale from main, so the HTTP transport is currently
    undocumented in both (regenerate llms-full.txt via
    scripts/gen-llms-full.mjs after updating docs). The branch's PM-skill
    edits (substitutions doc, dangerously_skip_permissions purge) were
    dropped with the skills/pm deletion -- verify packages/apra-fleet-se/apra-pm covers
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
.fleet-task.md) was destroyed by an external event while two overlapping
agent processes (same orchestrator; see 2.2) shared the directory. The full
rebased TREE survived and was verified green; the rebased commit HISTORY was
lost. RECOVERY EXECUTED 2026-07-02 (human-approved): git re-initialized in
this directory only, dotfiles restored from origin/main, the tree committed
as 24a6a2a (+ 9dff057 for README/llms-full.txt) on branch
enhancement/skill-reorg-rebased atop origin/main 5526fe7, submodule
re-vendored at the pinned SHA, and the suite re-verified at 1772 passed /
0 failed. origin was never touched; nothing pushed.
origin/enhancement/skill-reorg (pre-rebase) remains as it was.
