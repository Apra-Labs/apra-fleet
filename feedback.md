# HTTP+SSE Transport (#258) -- Plan Review

**Reviewer:** lx635
**Date:** 2026-05-19 02:30:00-04:00
**Verdict:** CHANGES NEEDED

> First plan review for issue #258. No prior feedback.md versions for this sprint.

---

## 1. Clear "Done" Criteria

PASS. Every task has explicit, testable done criteria. Task 1 specifies exact method calls (`emit`, `off`) and observable behavior. Task 2 specifies concurrent client count, notification delivery, bind address, and cleanup behavior. Tasks 3-9 follow the same pattern. No task ends with "works correctly" or similar vagueness.

---

## 2. Cohesion and Coupling

PASS. Tasks are well-scoped. Task 1 (event bus) is a pure standalone abstraction. Task 2 (HTTP transport) is large but cohesive -- everything in it relates to "HTTP server that routes MCP sessions." Task 3 (tool registry extraction) is a clean refactor. Task 4 (dual startup) bundles the CLI flag with startup refactoring, which is reasonable since neither is useful without the other. Task 6 (credential event wiring) is a surgical two-line change plus test.

One minor concern: Task 7 touches three things -- install CLI, http-transport.ts (preferred port), and paths.ts (DEFAULT_PORT). The http-transport.ts change is a cross-phase coupling back to Phase 1's module. Acceptable but worth noting.

---

## 3. Key Abstractions in Earliest Tasks

PASS. The event bus (Task 1) and HTTP transport with session management (Task 2) are both in Phase 1. The tool registry (Task 3) is first in Phase 2, before anything that needs it (Task 4). All downstream tasks reuse these abstractions.

---

## 4. Riskiest Assumption First

PASS. Task 2 explicitly validates the riskiest assumption: "Two MCP clients connect concurrently with separate sessions" and "Event bus emit reaches BOTH clients." The decision point about StreamableHTTP vs SSE client compatibility is also surfaced in Task 2 with a clear fallback strategy.

---

## 5. Later Tasks Reuse Early Abstractions (DRY)

PASS. Task 4's `startHttpServer()` calls Task 2's `createHttpTransport()` with Task 3's `registerAllTools` as a callback. Task 6 uses Task 1's `fleetEvents`. Task 8 exercises the full stack built in Tasks 1-7. No duplication observed.

---

## 6. Phase Boundaries at Cohesion Boundaries

PASS. Phase 1 (core abstractions + risk validation) is a coherent unit -- the two things you need before anything else. Phase 2 (server refactor + lifecycle) is cohesive around "make the server start in both modes." Phase 3 mixes credential event wiring (domain) with install config (CLI) and integration tests, but these all share the theme of "connect the new transport to the outside world." Phase 4 (docs) is standalone. Each phase produces a reviewable, testable increment.

---

## 7. Tier Monotonicity

PASS. Explicitly verified in the plan:
- Phase 1: cheap, standard
- Phase 2: cheap, standard, standard
- Phase 3: cheap, standard, standard
- Phase 4: cheap

All non-decreasing.

---

## 8. Each Task Completable in One Session

PASS, with a note. Task 2 is the largest: HTTP server with multi-session routing, event bus subscription, cleanup, and risk validation tests. It is substantial but the scope is well-defined, the SDK provides examples to follow (`sseAndStreamableHttpCompatibleServer.js`), and the done criteria are concrete. Completable in one session by an experienced developer.

---

## 9. Dependencies Satisfied in Order

PASS. Dependency graph is clean:
- Task 1: none
- Task 2: Task 1
- Task 3: none (could run parallel with Phase 1)
- Task 4: Tasks 2, 3
- Task 5: Task 4
- Task 6: Task 1 (could start before Phase 2)
- Task 7: Tasks 2, 4
- Task 8: all previous
- Task 9: none (docs reflect implemented behavior)

No circular or backwards dependencies.

---

## 10. Vague Tasks

FAIL. Task 7 has significant ambiguity in provider-specific MCP configuration formats.

**Finding HIGH-1: Task 7 provider config formats are underspecified.** The task says "Use `claude mcp add` with the appropriate transport flag" but does not specify what that flag is. Does `claude mcp add` support `--transport sse` or `--transport http`? Or does the developer need to write the JSON config directly (bypassing the CLI)? For Gemini, the task shows `{ url: "<fleet-url>", transportType: "sse" }` but this format is not verified against Gemini's actual schema. For Codex and Copilot, the task says "update similarly" with no concrete format. Two developers would produce different configs. The task must include concrete config examples for each provider (at minimum Claude and Gemini), verified against each provider's actual config schema.

Additionally, Task 7 says "use a default port (e.g., 17239)" without committing to an actual value. The parenthetical "e.g." means the developer picks. This should be a specific number.

---

## 11. Hidden Dependencies

PASS. No hidden dependencies found beyond what is explicitly declared. The cross-phase touch in Task 7 (modifying http-transport.ts to accept a preferred port) is acknowledged in the task's file list.

---

## 12. Risk Register

The risk register covers 10 risks and is generally well-constructed. However, it has gaps against the 10 risks identified during prep:

**Finding HIGH-2: Startup race condition unaddressed.** Task 5 describes singleton detection as: read server.json -> check PID -> check /health -> proceed or exit. But two processes can simultaneously read server.json, find no running instance (or a stale one), delete it, and both proceed to start. The second one may succeed on a different random port, overwrite server.json, and orphan the first. The risk register does not mention this race. Mitigation options: (a) advisory file lock on server.json using `fs.open` with `O_EXCL` during the startup window; (b) try to listen on the well-known port first (EADDRINUSE fails fast); (c) re-check after acquiring the port but before writing server.json. At least one of these should be specified.

**Finding HIGH-3: SEA (Single Executable Application) compatibility unaddressed.** Fleet ships as a Node.js SEA binary (`node:sea` is used in install.ts). The plan introduces `node:http` server + `StreamableHTTPServerTransport` which depends on `@hono/node-server` (a transitive dependency of the MCP SDK). While `node:http` works in SEA, the question is whether the `@hono/node-server` module (and its import chain) is correctly bundled into the SEA. This is already a dependency today for stdio (since the MCP SDK imports it), so it may be fine -- but the plan should explicitly acknowledge SEA compatibility as a constraint and add a verification step (e.g., "build SEA binary, start HTTP server from SEA, confirm it works"). If this is not verified and it breaks, the entire sprint is blocked post-merge.

**Finding MED-1: Broadcast vs. per-session event routing.** The plan says event bus notifications are broadcast to ALL active sessions via `sendLoggingMessage`. But `credential:stored` events are only meaningful to the session whose user just entered the credential. Other sessions receive noise. For the single-producer scope of this sprint (credential:stored only), broadcast is tolerable. But the event bus design should at least acknowledge this limitation and include a `sessionId` field in event payloads so future producers can target specific sessions. This is not blocking but should be documented as a known limitation in the event bus design.

**Finding MED-2: No singleton idle-shutdown policy.** When all MCP clients disconnect from the singleton HTTP server, the server keeps running forever. This is different from stdio where the process exits when the client disconnects (stdin closes). The plan should state whether the singleton is intended to be long-lived (run until explicitly stopped or system reboot) or should auto-exit after a period with zero connected sessions. Either choice is valid, but the plan should make an explicit decision and document it in Task 4 or Task 5.

---

## 13. Alignment with Requirements

PASS. Every acceptance criterion in requirements.md maps to at least one task:

| Acceptance Criterion | Task(s) |
|---|---|
| Singleton HTTP+SSE by default; second launch reuses | Tasks 4, 5 |
| Multiple concurrent clients, own SSE stream | Task 2 |
| --transport stdio, no regression | Tasks 4, 8 |
| GET /events (or equivalent) SSE; POST JSON-RPC | Task 2 |
| mcp.json "type": "sse" default, "type": "stdio" fallback | Task 7 |
| Internal event bus; subsystems publish events | Task 1 |
| credential_store_set pushes completion notification | Task 6 |
| Both transports pass tests; new tests for SSE + event bus | Tasks 2, 8 |
| Docs updated | Task 9 |
| Full test suite green; ASCII hook passes | VERIFY checkpoints |

The plan solves the right problem: singleton HTTP+SSE server with event-driven push, not just "HTTP instead of stdio."

---

## Risk Prep Checklist (10 Identified Risks)

| # | Risk | Plan Coverage |
|---|---|---|
| 1 | SSE vs StreamableHTTP choice + client support | Addressed: Task 2 decision point + R1/R2 in risk register. Prefer StreamableHTTP, fall back to SSE. |
| 2 | Singleton lifecycle (port/PID, start races, shutdown, idle, ownership) | Partially addressed: PID + health double-check is good (Task 5). **Startup race unaddressed (HIGH-2). Idle policy unaddressed (MED-2).** |
| 3 | Multi-session state isolation | Addressed: per-session McpServer model (Task 2). capturedClientInfo is per-McpServer instance. sendLoggingMessage targets session. **Broadcast vs per-session routing noted (MED-1).** |
| 4 | credential_store_set completion event / spec compliance | Addressed: Task 6 uses `fleetEvents.emit` at the right point. Task 2 uses SDK's `sendLoggingMessage` which emits `notifications/message` per MCP spec. |
| 5 | mcp.json SSE config format across providers | **Partially addressed: formats underspecified (HIGH-1).** |
| 6 | No regression on stdio | Addressed: Task 3 pure refactor, Task 4 preserves stdio path, Task 8d regression test. |
| 7 | Cross-platform singleton detection | Addressed: `process.kill(pid, 0)` is cross-platform in Node.js. FLEET_DIR handles path differences. R7 in risk register. |
| 8 | SEA compatibility | **Not addressed (HIGH-3).** |
| 9 | HTTP framework choice | Addressed: plan uses `node:http`. `StreamableHTTPServerTransport` uses `@hono/node-server` internally (transitive dep of MCP SDK, already installed). No Express needed. |
| 10 | Transport-level test coverage gap | Addressed: Task 2 risk validation tests, Task 8 integration tests covering both transports. |

---

## VERIFY Checkpoint Placement

PASS. VERIFY checkpoints appear at the end of each phase (after Tasks 2, 5, 8, 9). Each includes full test suite run + phase-specific manual checks. Phase 1 VERIFY specifically asks for the transport decision rationale, which is critical for downstream tasks.

---

## Summary

The plan is well-structured with clean task ordering, proper abstraction layering, and good risk identification. The per-session McpServer model is the right architecture. The event bus design is clean. The risk register covers most concerns.

**Three blocking findings must be resolved before implementation begins:**

1. **HIGH-1:** Task 7 provider-specific MCP config formats are underspecified. Add concrete config examples for each provider (Claude, Gemini, Codex, Copilot) in SSE mode, verified against each provider's schema. Commit to a specific default port number.
2. **HIGH-2:** Startup race condition in Task 5. Two processes can simultaneously detect "no running instance" and both start, orphaning one. Add a specific mitigation (file lock, port-claim-first, or re-check).
3. **HIGH-3:** SEA compatibility not addressed. Add a verification step confirming the HTTP server works when fleet runs as a SEA binary. Acknowledge `@hono/node-server` as a transitive dependency that must bundle correctly.

**Two non-blocking findings for awareness:**

- **MED-1:** Event bus broadcasts to all sessions. Add sessionId to event payloads for future per-session routing.
- **MED-2:** No idle-shutdown policy for singleton with zero clients. Make an explicit decision.

---
---

# HTTP+SSE Transport (#258) -- Plan Re-Review

**Reviewer:** lx635
**Date:** 2026-05-19 03:15:00-04:00
**Verdict:** APPROVED

> Re-review of PLAN.md after doer revision in commit 96bab55. Prior review
> raised 3 HIGH findings and 2 MED findings. See git history of this file
> for the original review.

---

## Prior HIGH Findings -- Resolution Verification

### HIGH-1: Provider config formats underspecified

RESOLVED. Task 8 now includes concrete, copy-pasteable config examples for
all four providers in HTTP transport mode:

- **Claude:** `claude mcp add --scope user --transport http apra-fleet
  http://localhost:7523/mcp` producing
  `"type": "streamable-http", "url": "http://localhost:7523/mcp"`. Verified
  against Claude Code's `--transport http` flag (confirmed in
  requirements.md Transport Decision section).
- **Gemini:** `"httpUrl": "http://localhost:7523/mcp", "trust": true` in
  `~/.gemini/settings.json`. Matches Gemini's `httpUrl` config key
  (confirmed in Transport Decision).
- **Copilot:** `"url": "http://localhost:7523/mcp", "type": "http"`.
  Concrete format specified.
- **Codex:** TOML table with `url = "http://localhost:7523/mcp"`. Concrete
  format specified.

Default port committed to 7523 (not "e.g."). `DEFAULT_PORT` constant
defined in Task 2's paths.ts changes, with `APRA_FLEET_PORT` env var
override. No ambiguity remains -- two developers would produce identical
configs.

### HIGH-2: Startup race condition unaddressed

RESOLVED. Task 6 now includes `claimStartupLock()` with atomic file
creation via `fs.openSync(lockPath, 'wx')` (O_CREAT | O_EXCL). This is
a genuinely atomic operation on POSIX and NTFS -- exactly one of two
concurrent processes will succeed; the other gets EEXIST and exits cleanly.

The flow is sound:
1. `checkRunningInstance()` -- fast path if already running.
2. `claimStartupLock()` -- atomic claim; fails fast if another process
   is starting.
3. Start HTTP server, write `server.json`.
4. `lock.release()` -- lock only held during the startup window.
5. SIGINT/SIGTERM handlers also release as a safety net.

Stale lock handling is correct: if lock file mtime > 60 seconds (crashed
process), delete and retry once. The 60-second threshold is generous
enough to avoid false positives on slow machines, short enough that a
crash doesn't permanently block restarts.

Risk R3 in the risk register now explicitly covers this scenario.

### HIGH-3: SEA compatibility unaddressed

RESOLVED. New Task 3 "SEA Binary Compatibility Verification" added to
Phase 1 (after Task 2, before any downstream work depends on HTTP
transport). The task:

1. Builds the SEA bundle via `npm run build:sea`.
2. Greps the bundle for `StreamableHTTPServerTransport` and `@hono`
   references to confirm they are included.
3. Tests that the HTTP transport can be instantiated and bind a port from
   the bundled code.
4. If it fails: fix (e.g., esbuild externals adjustment) or escalate as
   a blocker.

This is correctly positioned in Phase 1 so a failure is caught before
Tasks 4-10 build on the assumption that HTTP transport works in SEA.
Risk R1 now explicitly covers `@hono/node-server` bundling in SEA.

Verified: `@hono/node-server` is already a transitive dependency of
`@modelcontextprotocol/sdk` (listed in its package.json dependencies)
and is already installed in node_modules. esbuild's current config does
not list it in externals, so it should be bundled. Task 3 confirms this
empirically.

---

## Prior MED Findings -- Deferral Verification

### MED-1: Broadcast vs per-session event routing

Explicitly deferred in the "Deferred Items" section at the top of
PLAN.md. Rationale is sound: for `credential:stored`, broadcast is
correct (any session benefits from knowing a credential was stored).
Per-session targeting is a YAGNI concern for this sprint. The deferral
notes that future producers can add an optional `sessionId` field to
event payloads.

### MED-2: Singleton idle-shutdown policy

Explicitly deferred in "Deferred Items" with a clear decision: the
singleton is intentionally long-lived, running until explicitly stopped.
Rationale: restart cost (tool re-registration, stall detector, SSH
reconnections). Idle shutdown is a follow-up optimization if memory
pressure proves real. This is the right default for a developer-laptop
service.

---

## Transport Decision Compliance

The plan fully applies the transport decision from requirements.md:

- **StreamableHTTPServerTransport only.** The deprecated
  `SSEServerTransport` fallback that was in the original plan (Task 2's
  "Decision point" and SSE routing code) is completely removed. No
  mention of SSEServerTransport remains in any task description.
- **CLI flag is `--transport http`** (not `--transport sse`), consistent
  throughout Tasks 5, 8, 10, and the plan summary.
- **Risk register updated.** Old R1 (SSE client compat fallback) and R2
  (SSE deprecation) are gone. New R1 is SEA compatibility; new R2 is
  Gemini client compatibility with the google-gemini/gemini-cli#5268
  reference.
- **Gemini client test exists.** Task 9f explicitly tests a
  StreamableHTTPClientTransport connection against the fleet server,
  with the Gemini bug reference in a code comment. The test's done
  criteria correctly allow for documenting a Gemini-side failure rather
  than treating it as a fleet blocker.

---

## Structural Re-Verification

### Task slicing and ordering

Task count increased from 9 to 10 (new Task 3: SEA verification). The
insertion does not disrupt dependency order:

- Task 3 (SEA verify) depends on Task 2 (HTTP transport must exist).
  Correct.
- Task 4 (tool registry) has no deps. Unchanged.
- Tasks 5-10 renumbered from old 4-9. All blocker references updated
  correctly.
- No circular dependencies. No hidden dependencies introduced.

### Tier monotonicity

Phase 1: cheap, standard, standard -- OK (Task 3 is standard, matching
its verification + potential fix scope).
Phase 2: cheap, standard, standard -- OK.
Phase 3: cheap, standard, standard -- OK.
Phase 4: cheap -- OK.

### VERIFY checkpoints

Four VERIFY checkpoints, one per phase. Phase 1 VERIFY now includes
"Confirm SEA bundle includes HTTP transport and starts correctly." All
other VERIFYs unchanged and still appropriate.

### Cross-phase coupling

The original review noted Task 7 (old) touching http-transport.ts to add
preferred port support. The revision moved `DEFAULT_PORT` and preferred
port handling into Task 2 itself, eliminating the cross-phase coupling.
Clean.

### Acceptance criteria mapping

All ACs from requirements.md still map to tasks. Two ACs use terminology
from the pre-transport-decision era ("GET /events", "type: sse") but the
intent is satisfied by the StreamableHTTP equivalents (GET /mcp, type:
streamable-http). The Transport Decision section in requirements.md
supersedes the older wording.

| Acceptance Criterion | Task(s) |
|---|---|
| Singleton HTTP service by default; second launch reuses | Tasks 5, 6 |
| Multiple concurrent clients, own SSE stream | Task 2 |
| --transport stdio, no regression | Tasks 5, 9d |
| SSE/HTTP endpoint serves notifications; POST handles JSON-RPC | Task 2 |
| Generated config is HTTP-based by default, stdio when --transport stdio | Task 8 |
| Internal event bus; subsystems publish events | Task 1 |
| credential_store_set pushes completion notification | Task 7 |
| Both transports pass tests; new tests for HTTP + event bus | Tasks 2, 9 |
| Docs updated | Task 10 |
| Full test suite green; ASCII hook passes | VERIFY checkpoints |

---

## New Issues Check

No new blocking issues introduced by the revision. The plan is tighter
than the original: fewer decision points deferred to implementation,
clearer task boundaries, and the SEA verification task catches a
potential showstopper before downstream work depends on it.

One minor note (not blocking): Task 9f's Gemini client test uses
`StreamableHTTPClientTransport` from the MCP SDK, which is the same
transport Gemini CLI uses internally. This is a good proxy test but is
not identical to running actual `gemini` CLI against fleet. The task's
done criteria correctly acknowledge this by saying "or failure is
documented as a known Gemini-side issue" -- adequate for this sprint.

---

## Summary

All three blocking findings from the initial review are fully resolved:
provider configs are concrete and verified, the startup race is handled
by atomic file lock, and SEA compatibility has a dedicated Phase 1
verification task. Both non-blocking items are explicitly deferred with
sound rationale. The transport decision (StreamableHTTP only, no SSE
fallback) is cleanly applied throughout. Task slicing, ordering, tiers,
and VERIFY checkpoints remain sound. Every acceptance criterion maps to
a task.

The plan is ready for implementation.
