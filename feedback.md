# OS Service Lifecycle -- Plan Review

**Reviewer:** rbnvk
**Date:** 2026-05-19 12:38:29-0400
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## 1. Template Checklist

### 1.1 Does every task have clear "done" criteria?

**PASS.** Every task (T1--T15) has an explicit "Done when" block with testable conditions.
T6 and T10 (test tasks) specify coverage targets and the requirement that `npm test` stays
green. T14 and T15 (docs) specify ASCII-only enforcement. No ambiguity.

### 1.2 High cohesion within each task, low coupling between tasks?

**PASS.** Each task has a single concern: T1 is the shutdown endpoint + constants, T2 is
the interface + factory, T3--T5 are one adapter each, T7 bundles start+stop (these share
the same server.json/PID lifecycle and are natural counterparts), T9 is status, T11 is
install extension, T12 is uninstall extension. Clean boundaries.

### 1.3 Are key abstractions and shared interfaces in the earliest tasks?

**PASS.** The ServiceManager interface (T2) and service constants (T1) land in Phase 1
before any consumer task. The /shutdown endpoint (T1) is also correctly front-loaded since
it is consumed by adapters (T3 Windows stop, T5 macOS stop) and the stop CLI verb (T7).

### 1.4 Is the riskiest assumption validated in Task 1?

**PASS.** Phase 1 front-loads the two riskiest assumptions: (a) per-user service management
without elevation across all three OSes (Tasks 3--5), and (b) cross-platform graceful stop
via the /shutdown endpoint (Task 1). The plan explicitly acknowledges this sequencing in
the Phase 1 preamble: "If schtasks/systemctl/launchctl cannot be called without elevation,
this phase fails immediately."

T1 is the shutdown endpoint + constants (cheap), which is the foundation but not itself the
risky assumption. The risky per-user-no-elevation validation happens in T3--T5. This is
acceptable because the interface (T2) needs to exist before the adapters can be written,
and T1 provides the /shutdown endpoint that T3 and T5 depend on for their stop
implementations.

### 1.5 Later tasks reuse early abstractions (DRY)?

**PASS.** T7 (start/stop CLI) calls `getServiceManager()` from T2. T9 (status) calls
`serviceManager.query()`. T11 (install) calls `serviceManager.register()` +
`serviceManager.start()`. T12 (uninstall) calls `serviceManager.unregister()`. The adapter
pattern is consistently reused throughout.

### 1.6 Phase boundaries at cohesion boundaries?

**PASS.** Phase 1 (adapter layer) is self-contained -- produces a testable service manager
with mocked tests. Phase 2 (CLI verbs) builds on Phase 1 and produces functional commands.
Phase 3 (install/uninstall integration) wires everything together. Phase 4 (docs) is
standalone. Each phase is reviewable and testable independently.

### 1.7 Are tiers monotonically non-decreasing within each phase?

**FAIL (HIGH-1).** Phase 2 tiers are: T7 cheap, T8 cheap, T9 standard, T10 standard.
That is monotonically non-decreasing -- fine. Phase 1 tiers: T1 cheap, T2 standard,
T3 standard, T4 standard, T5 standard, T6 standard -- fine. Phase 3: T11 standard,
T12 standard, T13 standard -- fine. Phase 4: T14 cheap, T15 cheap -- fine.

Actually, on closer inspection this is all compliant. **Changing to PASS.** Retracted.

**PASS.** All phases have monotonically non-decreasing tiers.

### 1.8 Each task completable in one session?

**PASS.** All tasks are scoped to a single file or a small set of related files. The
largest tasks (T3--T5, one adapter each) are well-bounded: a single class implementing a
known interface with 5--6 methods, each method being a shell command wrapper. T7 bundles
start+stop but these are thin CLI modules (~60 lines each). Reasonable for one session.

### 1.9 Dependencies satisfied in order?

**PASS.** T1 has no dependencies. T2 depends on T1 (types file). T3--T5 depend on T2
(interface). T6 depends on T3--T5. T7 depends on Phase 1. T8 depends on T7. T9 depends
on Phase 1. T10 depends on T7--T9. T11 depends on Phase 1. T12 depends on T11. T13
depends on T11--T12. T14--T15 have no code dependencies. All valid.

### 1.10 Any vague tasks that two developers would interpret differently?

**FAIL (HIGH-2).** Task 7 (start command) says: "for dev mode, use process.execPath (node)
with args [dist/index.js, --transport, http]" but does not specify how to determine the
path to dist/index.js in dev mode. In install.ts, the existing code uses `findProjectRoot()`
to locate the project root. T7 needs to specify whether to use the same mechanism or
hardcode a relative path. Two developers would make different choices here.

Additionally, T7's stop command says "POST /shutdown to the URL" but the /shutdown endpoint
is defined in T1 as being added to http-transport.ts. The stop command must also handle
the case where the server is running but the /shutdown endpoint is not yet deployed (e.g.,
an older version of the binary is running from a previous install). The plan does not
address this version-skew scenario. **NOTE** (not blocking): the fallback kill path
covers this, but it should be explicitly called out.

### 1.11 Any hidden dependencies between tasks?

**PASS.** No hidden dependencies found. T7's stop command depends on the /shutdown endpoint
from T1, which is correctly listed as a Phase 1 dependency. T11's service registration
depends on knowing the binary path, which is already computed in install.ts.

### 1.12 Does the plan include a risk register?

**PASS.** The risk register covers 10 risks with impact and mitigation. It addresses:
schtasks /end hard kill, loginctl linger requiring root, non-systemd Linux, Windows batch
job rights, macOS API versions, binary path on update, backward compat, concurrent start
race, /shutdown security, and stale server.json. This is thorough.

### 1.13 Does the plan align with requirements.md intent?

**FAIL (HIGH-3).** The Notes section states "Base branch: main" but requirements.md
explicitly says "Base Branch: feat/mcp-sse-transport" and "Commit directly onto that
branch; no new branch." This is a direct contradiction with the requirements. The
implementation branch line is correct (feat/mcp-sse-transport) but the base branch line
is wrong. This must be fixed to avoid confusion -- a doer might create the PR against
main instead of extending PR #273.

---

## 2. Risk Checklist (from prep)

### Risk 1: Per-user service registration with NO elevation

**PASS.** The plan explicitly addresses all three OSes:
- **Windows:** `schtasks /create ... /rl limited` (no elevation). Risk register notes
  "Log on as a batch job" right restriction on domain-joined machines with mitigation.
- **Linux:** `systemctl --user` (no elevation). loginctl enable-linger attempted with
  non-fatal warning. Non-systemd detection throws actionable error.
- **macOS:** `launchctl bootstrap gui/<uid>` (no elevation, LaunchAgent not LaunchDaemon).

All three are well-specified. The dual-path (service vs. direct) fallback is defined.

### Risk 2: Graceful shutdown on all platforms

**PASS.** The plan introduces a POST /shutdown endpoint (T1) that triggers the existing
SIGINT handler chain. This is the correct solution for Windows where schtasks /end does
TerminateProcess. The risk register explicitly calls out "Never use schtasks /end for
graceful stop." Stop always goes through HTTP /shutdown on all OSes, with a force-kill
fallback after 5s timeout. This ensures server.json and lock cleanup.

The plan correctly configures service managers to NOT restart after clean exit:
- systemd: Restart=on-failure (exit 0 = no restart)
- launchd: KeepAlive.SuccessfulExit=false (exit 0 = no restart)
- Windows: schtasks at-logon trigger only (no restart semantics)

### Risk 3: Interplay with server.json and singleton lock

**PASS.** The plan reuses the existing checkRunningInstance() (validates pid + /health) for
the start command's idempotency check. The stop command cleans up stale server.json and
lock file after the server exits. The risk register notes that the existing stale-file
cleanup mechanism is sufficient. The existing claimStartupLock prevents concurrent starts.

### Risk 4: start with vs. without a service unit installed

**PASS.** The Verb x OS Matrix explicitly defines both columns ("Service Installed" vs.
"No Service Installed") for the start verb. When no service is installed, the binary is
spawned detached with stdout/stderr redirected to LOG_FILE_PATH. T7 spells out both paths
with the `isInstalled()` check determining which path to take.

### Risk 5: Idempotency of every verb x every OS

**PASS.** The plan states idempotency for each verb:
- start: checkRunningInstance() first, exit 0 if running.
- stop: if not running, report and exit 0. Clean up stale files.
- install: schtasks /create uses /f (force/overwrite). systemctl enable is idempotent.
  launchctl bootstrap may need bootout first -- see HIGH-4 below.
- uninstall: each step tolerates "not found" errors.

**FAIL (HIGH-4).** The install verb for macOS calls `launchctl bootstrap gui/<uid>
<plist-path>` but does NOT call `launchctl bootout` first. If the service is already
loaded (e.g., user runs `install` twice), `launchctl bootstrap` will fail with "service
already loaded." The plan must specify that install either (a) calls bootout before
bootstrap, or (b) catches the "already loaded" error and proceeds. This is a real
idempotency gap. Windows schtasks uses /f which handles re-registration. Linux systemctl
enable is inherently idempotent. Only macOS bootstrap has this issue.

### Risk 6: No regression to existing install/uninstall MCP-config behaviour

**PASS.** T11 explicitly states: "after the existing final step (Beads tracker install +
permissions + install-config.json), add a new step." The existing install steps are
unchanged. T12 states service removal is "prepended" to the existing uninstall steps.
The risk register includes "backward compat" and notes service registration is "purely
additive."

### Risk 7: Log file redirection

**PASS.** LOG_FILE_PATH is defined in T1 as `~/.apra-fleet/data/fleet.log`. Per-OS
mechanisms are specified:
- Windows: wrapper.bat handles redirection (schtasks cannot redirect natively).
- Linux: StandardOutput=append:<logPath>, StandardError=append:<logPath>.
- macOS: StandardOutPath=logPath, StandardErrorPath=logPath.
- Direct spawn (no service): stdout/stderr redirect to LOG_FILE_PATH.

**NOTE:** No log rotation strategy is mentioned. The log file will grow unboundedly. This
is not blocking for this sprint but should be tracked as a follow-up.

### Risk 8: Binary path in service units

**PASS.** T11 specifies `serviceManager.register(binaryPath, ...)` where binaryPath is
the installed binary from install.ts (BIN_DIR + binary name). The risk register notes
"install command re-registers the service unit (updates binary path)" and "update command
calls install --force, which also re-registers."

### Risk 9: status command richness with/without a unit installed

**PASS.** T9 specifies the full output format with all required fields (pid, port, url,
version, uptime, sessions, service state). The "Service" line is "always shown regardless
of server state" and covers installed/enabled/disabled/not-installed states. When server
is stopped, pid/port/url/uptime/sessions are omitted. This matches requirements.

### Risk 10: Port fallback interaction

**PASS.** The stop command reads the URL from server.json (which contains the actual port
the server bound to, whether 7523 or a fallback port). The status command also reads
server.json. This correctly handles the port fallback case without assuming the default
port.

---

## 3. Verb x OS Matrix Completeness

**PASS.** The plan includes an explicit Verb x OS Matrix section with tables for start,
stop, restart, status, install, and uninstall. Each cell specifies the exact OS command
or behavior. No "and similarly for X" is used. Each OS is explicitly covered for every
verb. This directly satisfies the requirements.md mandate: "The plan MUST explicitly walk
through all three OSes for every verb."

---

## 4. Acceptance Criteria Mapping

Mapping each acceptance criterion from requirements.md to plan tasks:

1. "install registers a per-user service and server is running immediately" -> T11. **PASS.**
2. "Server comes back after reboot/re-login on all three OSes" -> T3 (at-logon trigger),
   T4 (WantedBy=default.target + linger), T5 (RunAtLoad=true). **PASS.**
3. "start/stop/restart/status work idempotently on all OSes" -> T7, T8, T9. **PASS.**
4. "status reports pid/port/url/version/uptime/sessions and service-unit state" -> T9.
   **PASS.**
5. "uninstall stops server and removes service unit and MCP config" -> T12. **PASS.**
6. "No elevation/admin/root or UAC" -> All adapter tasks (T3--T5) use per-user commands.
   **PASS.**
7. "Tests cover verb logic and per-OS adapter" -> T6, T10, T13. **PASS.**
8. "Docs updated" -> T14, T15. **PASS.**

All acceptance criteria map to at least one task. No gaps.

---

## 5. VERIFY Checkpoint Placement

**PASS.** VERIFY checkpoints are placed at the end of each phase:
- After Phase 1 (T6): run tests, confirm compile, no regressions.
- After Phase 2 (T10): run tests, verify --help, no regressions.
- After Phase 3 (T13): run tests, confirm install/uninstall lifecycle, no regressions.
- After Phase 4 (T15): confirm ASCII-only, docs accurate.

Each checkpoint specifies what to verify and asks for a report. Correct placement.

---

## 6. Additional Findings

### HIGH-5: Linux adapter stop() uses systemctl --user stop, not /shutdown

Task 4 (Linux adapter) defines stop() as: "`systemctl --user stop apra-fleet` (sends
SIGTERM, handled gracefully by existing handler)." However, the Verb x OS Matrix for
`stop` says all OSes use "Read server.json -> POST /shutdown -> wait -> fallback."
Meanwhile, Task 7 (stop CLI verb) always uses the HTTP /shutdown approach regardless of
OS.

There is a contradiction: the Linux adapter's `stop()` method uses `systemctl --user stop`
(which sends SIGTERM), but the CLI stop verb bypasses the adapter entirely and uses HTTP
/shutdown. This means `serviceManager.stop()` on Linux differs from the CLI stop behavior.

This matters because T12 (uninstall) calls the graceful /shutdown approach, but T11
(install) calls `serviceManager.start()` which could later be stopped by either path.

The plan needs to clarify: does the CLI `stop` verb call `serviceManager.stop()` or does
it always go through HTTP /shutdown directly? If the latter, what is
`serviceManager.stop()` used for? If the adapter's stop() is never called by any CLI verb,
it is dead code. If it IS called, then the Linux adapter's use of `systemctl --user stop`
is fine (SIGTERM is handled gracefully), but the Windows adapter's stop() also uses HTTP
/shutdown, creating an inconsistency in the adapter interface contract.

**Resolution needed:** Either (a) make all adapters' stop() use HTTP /shutdown for
consistency and have the CLI call `serviceManager.stop()`, or (b) have the CLI always
bypass the adapter for stop and document that `serviceManager.stop()` is an internal
method for the unregister flow only, or (c) clarify the exact call path in T7 and T12.

---

## Summary

The plan is well-structured with clear task boundaries, proper dependency ordering,
front-loaded risk validation, and a thorough Verb x OS Matrix. The ServiceManager adapter
pattern is sound and the /shutdown endpoint elegantly solves the cross-platform graceful
stop problem. All acceptance criteria map to tasks.

**Three blocking items must be resolved:**

- **HIGH-2:** T7 (start/stop CLI) is underspecified for dev-mode binary path resolution.
  Clarify how dist/index.js is located.
- **HIGH-3:** Notes section says "Base branch: main" -- contradicts requirements.md which
  mandates feat/mcp-sse-transport. Fix the Notes.
- **HIGH-4:** macOS install idempotency gap -- `launchctl bootstrap` will fail if already
  loaded. Must bootout first or handle the error.
- **HIGH-5:** Contradictory stop() semantics between the Linux adapter (systemctl stop),
  the CLI stop verb (HTTP /shutdown), and the Verb x OS Matrix. Clarify the call path.

**Non-blocking notes:**
- No log rotation strategy (track as follow-up).
- Version-skew scenario for /shutdown endpoint not explicitly addressed (fallback kill
  covers it, but should be noted).

---
---

# OS Service Lifecycle -- Plan Re-Review

**Reviewer:** rbnvk
**Date:** 2026-05-19 12:50:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior review: 2026-05-19 12:38:29-0400 -- CHANGES NEEDED with 4 HIGH findings.
> Doer revised PLAN.md in commit 7f712fb to address all findings.

---

## Prior HIGH Findings -- Resolution Verification

### HIGH-2: Task 7 dev-mode binary path resolution

**RESOLVED.** T7 now explicitly specifies: "In dev mode (non-SEA), the command is
`process.execPath` (the Node.js binary) with args
`[path.join(findProjectRoot(), 'dist', 'index.js'), '--transport', 'http']` -- using the
same `findProjectRoot()` function from src/cli/install.ts that walks up from __dirname
looking for version.json. Import `findProjectRoot` from install.ts (it is already exported)
or extract it to a shared util."

This is unambiguous -- two developers would make the same choice. The version-skew concern
from the NOTE is also now addressed: T7 explicitly documents the fallback: "if an older
binary without the /shutdown endpoint is running, the POST will fail (404 or connection
error). The fallback force-kill path handles this correctly."

### HIGH-3: Base branch contradiction

**RESOLVED.** Notes section now reads: "Base branch: feat/mcp-sse-transport (extends
PR #273 -- no new branch)" and "Implementation branch: feat/mcp-sse-transport (commit
directly onto this branch)." This matches requirements.md exactly. No remaining references
to "main" as base branch anywhere in PLAN.md.

### HIGH-4: macOS install idempotency gap

**RESOLVED.** T5 register() now includes: "Before loading, call `launchctl bootout
gui/<uid>/com.apra-fleet.server` and tolerate 'not loaded' / 'no such process' errors --
this makes register() idempotent." The Verb x OS Matrix install row for macOS also
reflects this: "launchctl bootout ... (tolerate 'not loaded' error). Then launchctl
bootstrap ..." Both the adapter task and the matrix are consistent.

### HIGH-5: Contradictory stop() semantics

**RESOLVED.** The Design Summary now includes a dedicated "Stop call path (unified)"
paragraph that clarifies the architecture:

1. The CLI `stop` verb bypasses the adapter entirely and calls POST /shutdown directly
   (since stopping the process is service-agnostic).
2. All three adapters' stop() methods use the same POST /shutdown mechanism (not
   systemctl stop or OS-specific commands) for cross-platform consistency.
3. serviceManager.stop() exists for use within unregister() and for interface
   completeness, but the CLI never routes through it.

T4 (Linux adapter) stop() now reads: "Read server.json for URL. POST /shutdown. Wait up
to 5s for process exit (poll pid). Fallback: kill -TERM <pid>. This matches the Windows
and macOS adapters." The prior contradiction with `systemctl --user stop` is fully
eliminated. All three adapters share the same contract.

---

## Structural Re-Verification

### Task slicing / ordering / dependencies

**PASS.** No changes to task boundaries or ordering. The revisions were surgical --
clarifications within T4, T5, and T7 without altering the phase structure.

### Tier assignments and monotonicity

**PASS.** No tier changes. Phase 1: cheap -> standard (5x). Phase 2: cheap (2x) ->
standard (2x). Phase 3: standard (3x). Phase 4: cheap (2x). All monotonically
non-decreasing within each phase.

### VERIFY checkpoint placement

**PASS.** All four VERIFY blocks remain at phase boundaries. No changes.

### Acceptance criteria mapping

**PASS.** All 8 acceptance criteria from requirements.md still map to tasks. The
revisions did not remove or alter any task's scope. Verified:

1. install -> service running immediately: T11. Covered.
2. Reboot/re-login persistence: T3 (at-logon), T4 (linger), T5 (RunAtLoad). Covered.
3. Verb idempotency on all OSes: T7, T8, T9. Covered.
4. status richness: T9. Covered.
5. uninstall cleanup: T12. Covered.
6. No elevation: T3--T5 per-user commands. Covered.
7. Test coverage: T6, T10, T13. Covered.
8. Docs: T14, T15. Covered.

### Deferred Items section

**PASS.** New "Deferred Items" section exists and tracks: (1) log rotation -- noted as
append-only with no rotation for this sprint, with follow-up approaches listed
(size-based rotation, OS-native logrotate/newsyslog); (2) TLS/auth on HTTP endpoint.
Both are correctly scoped out.

### New problems introduced by revision

**NONE FOUND.** The revisions are clean clarifications that do not introduce new
ambiguity, contradictions, or gaps. The Verb x OS Matrix, risk register, and task
descriptions remain internally consistent after the changes.

---

## Summary

All four HIGH findings from the initial review are fully resolved. The plan is
well-structured with clear task boundaries, proper dependency ordering, front-loaded risk
validation, a complete Verb x OS Matrix, and a unified stop call path. The Deferred Items
section tracks log rotation and TLS/auth as follow-ups. All acceptance criteria map to
tasks. No new issues introduced by the revision.

**Verdict: APPROVED.** The plan is ready for implementation.
