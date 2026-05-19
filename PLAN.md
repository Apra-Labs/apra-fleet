# apra-fleet -- Implementation Plan: MCP Transport stdio -> HTTP+SSE

> Replace fleet's stdio MCP transport with a StreamableHTTP singleton
> server that multiple LLM clients share. The server uses the MCP SDK's
> `StreamableHTTPServerTransport` with a per-session McpServer model for
> multi-client concurrency. An internal typed event bus lets subsystems
> push notifications to all connected clients over SSE. The first event
> producer is credential_store_set completion. stdio remains as a
> backward-compatible fallback via --transport stdio.
>
> Transport decision (firm): StreamableHTTPServerTransport only. The
> deprecated SSEServerTransport is NOT carried as a fallback -- the
> transport set is StreamableHTTP (default singleton) + stdio (fallback).
> Both Claude Code (`claude mcp add --transport http`) and Gemini CLI
> (`httpUrl` config / `gemini mcp add --transport http`) support
> Streamable HTTP as of 2026-05.

---

## Deferred Items

- **Per-session event targeting.** The event bus broadcasts all events
  to all connected sessions. For the single producer in this sprint
  (`credential:stored`), broadcast is correct -- any session benefits
  from knowing a credential was stored. Future producers that need
  per-session targeting (e.g., a response to one user's action) can add
  an optional `sessionId` field to event payloads and filter in the
  broadcast loop. Deferred because no current use case requires it and
  adding unused routing code violates YAGNI.

- **Singleton idle-shutdown policy.** When all MCP clients disconnect,
  the singleton HTTP server keeps running until explicitly stopped
  (shutdown_server tool, SIGINT/SIGTERM, or system reboot). This is
  intentional: the singleton is a long-lived service, not a per-request
  process. Restarting it has a cost (tool re-registration, stall detector
  restart, SSH reconnections). Idle shutdown is a follow-up optimization
  if memory pressure on developer laptops proves to be an issue.

---

## Tasks

### Phase 1: Core Abstractions + Risk Validation

Goal: Build the event bus and HTTP transport layer. Validate that
multiple concurrent MCP client sessions can each receive server-push
notifications -- the riskiest assumption in this sprint. Also validate
SEA binary compatibility with the HTTP transport.

#### Task 1: Typed Event Bus

- **Change:** Create `src/services/event-bus.ts` -- a typed EventEmitter
  singleton. Define a `FleetEventMap` interface with event types:
  `credential:stored` (payload: `{ name: string }`), `task:completed`
  (payload: `{ taskId: string, status: string }`),
  `member:status-changed` (payload: `{ memberId: string, status: string }`),
  `stall:detected` (payload: `{ memberId: string, memberName: string }`).
  Only `credential:stored` is wired in this sprint; the others are typed
  placeholders so follow-up producers can emit without changing the bus.
  Export a `fleetEvents` singleton and the `FleetEventMap` type. Write unit
  tests confirming: emit delivers to all subscribers, unsubscribe prevents
  delivery, multiple event types are independent, listeners receive the
  correct typed payload.
- **Files:** `src/services/event-bus.ts` (new), `tests/event-bus.test.ts` (new)
- **Tier:** cheap
- **Done when:** `npm test` passes including new event-bus tests;
  `fleetEvents.emit('credential:stored', { name: 'x' })` delivers to
  all subscribers; `fleetEvents.off(...)` prevents delivery.
- **Blockers:** None.

#### Task 2: HTTP Transport with Multi-Session Support

- **Change:** Create `src/services/http-transport.ts`. Architecture:
  one `McpServer` instance per client session, each connected to its own
  `StreamableHTTPServerTransport` instance. A session manager tracks
  active `{ server, transport }` pairs keyed by session ID and handles
  cleanup on disconnect.

  Implementation details:
  - Use `node:http` to create an HTTP server bound to `127.0.0.1`.
    Accept a `preferredPort` option (default: `DEFAULT_PORT` constant,
    value 7523 -- see paths.ts); if that port is busy (EADDRINUSE), fall
    back to port 0 (OS-assigned random). Add `DEFAULT_PORT = 7523` to
    `src/paths.ts` and `APRA_FLEET_PORT` env var override.
  - Route incoming requests to the correct session's transport:
    - POST /mcp: if body contains an `initialize` JSON-RPC request,
      create a new session (new McpServer + new
      StreamableHTTPServerTransport with
      `sessionIdGenerator: () => randomUUID()`, tools registered via a
      `registerTools` callback). Then delegate to
      `transport.handleRequest(req, res)`.
    - POST /mcp (non-initialize) and GET /mcp: read
      `mcp-session-id` header, look up session, delegate to
      `transport.handleRequest(req, res)`.
    - GET /health: return JSON (see Task 5).
    - All other paths: 404.
  - Subscribe to the event bus (`fleetEvents`). On any event, iterate
    all active sessions and call
    `session.server.server.sendLoggingMessage({ level: 'info',
    logger: 'apra-fleet-events', data: <formatted message> })` to push
    a `notifications/message` to each connected client.
  - Handle session cleanup: when a transport's `onclose` fires, remove
    it from the session map.
  - Export: `createHttpTransport(options: { registerTools, preferredPort? })`
    returning `{ httpServer, port, url, sessions, close() }`.

  Risk validation tests (the riskiest assumption):
  (a) Server starts and binds to 127.0.0.1 only.
  (b) Two MCP clients connect concurrently with separate sessions via
      StreamableHTTPServerTransport.
  (c) Event bus emit reaches BOTH clients as logging notifications.
  (d) Client disconnect removes the session from the map.
  (e) Port fallback: when preferred port is busy, server starts on a
      random port instead.

- **Files:** `src/services/http-transport.ts` (new),
  `src/paths.ts` (add DEFAULT_PORT constant + env var override),
  `tests/http-transport.test.ts` (new)
- **Tier:** standard
- **Done when:** Tests pass: two concurrent MCP clients on the same HTTP
  server each receive a `notifications/message` when the event bus emits.
  Server binds to 127.0.0.1 only. Port fallback works. Session cleanup
  works on disconnect.
- **Blockers:** Task 1 (event bus).

#### Task 3: SEA Binary Compatibility Verification

- **Change:** Verify that the HTTP transport works when fleet runs as a
  Node.js Single Executable Application (SEA). The `StreamableHTTPServerTransport`
  depends on `@hono/node-server` transitively via the MCP SDK. While
  esbuild bundles this into `dist/sea-bundle.cjs` (it is not in the
  `external` list in `scripts/build-sea.mjs`), the HTTP code paths have
  never been exercised from within a SEA binary.

  Steps:
  1. Run `npm run build:sea` to produce `dist/sea-bundle.cjs`.
  2. Verify the bundle includes the HTTP transport code: grep the bundle
     for `StreamableHTTPServerTransport` and `@hono` references.
  3. Run the bundle with `node dist/sea-bundle.cjs --transport sse` (or
     the equivalent flag once Task 4 is done -- for Phase 1, test by
     importing and calling `createHttpTransport()` from the bundle
     directly in a test script).
  4. If the bundle fails: add `@hono/node-server` to the esbuild
     externals and ship it as a side file, or find an alternative
     approach.

  This is a verification task, not a feature task. The expected outcome
  is "it works" (esbuild already bundles the dep). If it does not work,
  this task produces a fix or a blocking escalation before downstream
  tasks build on the HTTP transport.

- **Files:** `tests/sea-http-verify.test.ts` (new -- build + import test),
  `scripts/build-sea.mjs` (modify only if fix needed)
- **Tier:** standard
- **Done when:** SEA bundle builds successfully; HTTP transport code is
  present in the bundle; a test confirms the transport can be
  instantiated and bind a port from the bundled code. If a fix is needed,
  it is committed and the bundle re-verified.
- **Blockers:** Task 2 (HTTP transport module must exist to test).

#### VERIFY: Core Abstractions + Risk Validation
- Run full test suite (`npm test`)
- Confirm event bus + HTTP transport tests pass
- Confirm multi-session notification broadcast works
- Confirm SEA bundle includes HTTP transport and starts correctly
- Report: test results, any SDK issues found, SEA verification status

---

### Phase 2: Server Refactor + Dual Transport Startup

Goal: Refactor startServer() so both transports share tool registration,
add the --transport flag, implement singleton lifecycle detection with
atomic startup claim.

#### Task 4: Extract Tool Registration into Shared Module

- **Change:** Extract the tool registration block from `startServer()` in
  `src/index.ts` (lines 109-265) into a new function
  `registerAllTools(server: McpServer)` in `src/services/tool-registry.ts`.
  Move with it: `wrapTool()`, `sendOnboardingNotification()`,
  `sanitizeToolResult()`, `getOnboardingPreamble()`, and all tool/schema
  imports. The function takes a McpServer instance and registers every
  tool with its schema and wrapped handler. `startServer()` becomes a
  thin shell: create McpServer, call `registerAllTools(server)`, connect
  transport, start subsidiary services. Existing behavior unchanged --
  pure refactor.
- **Files:** `src/services/tool-registry.ts` (new), `src/index.ts` (modify)
- **Tier:** cheap
- **Done when:** `npm run build` succeeds; `npm test` passes; existing
  stdio server starts and responds to tool calls exactly as before the
  refactor. No functional change.
- **Blockers:** None. Pure refactor, no dependency on Phase 1.

#### Task 5: --transport Flag + Dual Startup Paths

- **Change:** Add `--transport <http|stdio>` CLI flag to `src/index.ts`.
  Default: `http`. Alias: `--stdio` maps to `--transport stdio` (existing
  `--stdio` flag already in the codebase).

  Refactor `startServer()` into two functions:
  - `startStdioServer()`: existing behavior (McpServer +
    StdioServerTransport). Called when `--transport stdio`.
  - `startHttpServer()`: calls `createHttpTransport()` from Phase 1
    Task 2 passing `registerAllTools` as the `registerTools` callback,
    writes `server.json` to FLEET_DIR with
    `{ pid, port, url, version, startedAt }`, starts stall detector +
    idle manager + cleanup tasks, registers SIGINT/SIGTERM handlers that
    delete `server.json` and close the HTTP server. Called when
    `--transport http` (default).

  Add `SERVER_INFO_PATH` constant to `src/paths.ts`:
  `path.join(FLEET_DIR, 'server.json')`.

  Update the `shutdown_server` tool: when running in HTTP mode, close
  the HTTP server, delete `server.json`, then exit.

- **Files:** `src/index.ts` (modify), `src/paths.ts` (modify),
  `src/tools/shutdown-server.ts` (modify)
- **Tier:** standard
- **Done when:** `apra-fleet` (no args) starts the HTTP server and writes
  `server.json`; `apra-fleet --transport stdio` starts the stdio server
  (no `server.json`); both paths register all tools and start subsidiary
  services; `server.json` is deleted on SIGINT/SIGTERM or shutdown_server
  tool call; `npm test` passes.
- **Blockers:** Task 2 (HTTP transport module), Task 4 (tool registry).

#### Task 6: Singleton Lifecycle Detection with Atomic Claim

- **Change:** Create `src/services/singleton.ts` with two exports:

  1. `checkRunningInstance(): { running: boolean, url?: string, pid?: number }`
     Read `server.json` from `SERVER_INFO_PATH`. If file exists: verify
     PID is alive via `process.kill(pid, 0)` (cross-platform), then
     verify port responds by sending an HTTP GET to `${url}/health`
     with a 2-second timeout. If BOTH checks pass: return
     `{ running: true, url, pid }`. If either fails: delete stale
     `server.json`, return `{ running: false }`.

  2. `claimStartupLock(): { acquired: boolean, release: () => void }`
     Atomic startup claim to prevent the race condition where two
     processes simultaneously detect "no running instance" and both
     start. Implementation: create a lock file at
     `path.join(FLEET_DIR, 'server.lock')` using
     `fs.openSync(lockPath, 'wx')` (O_CREAT | O_EXCL -- atomic create,
     fails if file already exists). If the open succeeds, the lock is
     acquired; `release()` deletes the lock file. If the open fails
     with EEXIST: read the lock file's mtime; if older than 60 seconds
     (stale lock from a crashed process), delete and retry once; if
     fresh, return `{ acquired: false }`. The lock file contains the
     PID of the claiming process for debugging.

  Wire into `startHttpServer()` in `src/index.ts`:
  1. Call `checkRunningInstance()`. If running: log URL and exit 0.
  2. Call `claimStartupLock()`. If not acquired: log "Another fleet
     instance is starting" and exit 0.
  3. Start HTTP server, write `server.json`.
  4. Call `lock.release()` (lock only needed during the startup window;
     server.json + /health is the long-lived detection mechanism).
  5. SIGINT/SIGTERM handlers also call `lock.release()` as a safety net.

  Add `GET /health` endpoint to the HTTP server in
  `src/services/http-transport.ts`: returns JSON
  `{ status: "ok", version, pid, uptime, sessions: <count> }`.

  Tests: (a) stale server.json (dead PID) is cleaned up and startup
  proceeds; (b) health endpoint returns correct JSON; (c) lock file
  prevents concurrent startup -- second process gets
  `{ acquired: false }`; (d) stale lock file (>60s old) is cleaned up.

- **Files:** `src/services/singleton.ts` (new),
  `src/services/http-transport.ts` (modify -- add /health route),
  `src/index.ts` (modify -- call singleton check + lock),
  `tests/singleton.test.ts` (new)
- **Tier:** standard
- **Done when:** Starting a second fleet HTTP instance prints the URL of
  the running instance and exits cleanly (exit 0). Two simultaneous
  startups are serialized by the lock file -- exactly one wins. Stale
  server.json and stale lock files are cleaned up. /health endpoint
  responds with status JSON. Tests pass.
- **Blockers:** Task 5 (server.json write/read, SIGINT handlers).

#### VERIFY: Server Refactor + Dual Transport Startup
- Run full test suite
- Manual verification: start fleet (HTTP mode), confirm server.json
  written; start second instance, confirm it detects and exits; kill
  fleet, confirm server.json cleaned up; start fleet --transport stdio,
  confirm it works as before
- Report: both startup paths work, singleton detection works, lock
  prevents races, no regressions

---

### Phase 3: Event Wiring + Client Configuration

Goal: Wire the motivating use case (credential_store_set completion
event), update the install command with concrete provider configs, and
validate Gemini client compatibility.

#### Task 7: Wire credential_store_set Completion Event

- **Change:** In `src/services/auth-socket.ts`, import `fleetEvents` from
  `./event-bus.js`. After `waiter.resolve(pending.encryptedPassword)` on
  line 122, add:
  `fleetEvents.emit('credential:stored', { name: msg.member_name });`
  This emits the event at the exact moment the OOB secret is delivered.
  The HTTP transport (from Phase 1 Task 2) already subscribes to
  `credential:stored` and broadcasts a `notifications/message` to all
  connected SSE clients.

  Write a test: mock the event bus, simulate the auth socket receiving a
  password message, verify `fleetEvents.emit` is called with
  `'credential:stored'` and the correct name payload.

- **Files:** `src/services/auth-socket.ts` (modify -- add import + emit),
  `tests/credential-event.test.ts` (new)
- **Tier:** cheap
- **Done when:** When auth-socket delivers a password, the event bus
  emits `credential:stored` with the credential name. Test passes.
  Existing auth-socket tests still pass (no regression).
- **Blockers:** Task 1 (event bus).

#### Task 8: Update Install Command with Provider-Specific Configs

- **Change:** Modify `src/cli/install.ts` to support HTTP transport
  registration. Add `--transport <http|stdio>` flag to the install
  command (default: `http`).

  Default port: 7523 (from `DEFAULT_PORT` in paths.ts, overridable via
  `APRA_FLEET_PORT` env var). The fleet URL used in configs:
  `http://localhost:${port}/mcp` where `port` is read from `server.json`
  if fleet is running, else `DEFAULT_PORT`.

  Concrete provider config changes when `--transport http`:

  **Claude** -- use `claude mcp add` with `--transport http`:
  ```
  claude mcp remove apra-fleet --scope user   (best-effort, ignore error)
  claude mcp add --scope user --transport http apra-fleet http://localhost:7523/mcp
  ```
  This writes to `~/.claude.json` under `mcpServers`:
  ```
  "apra-fleet": {
    "type": "streamable-http",
    "url": "http://localhost:7523/mcp"
  }
  ```

  **Gemini** -- update `mergeGeminiConfig()` to write `httpUrl` format
  to `~/.gemini/settings.json`:
  ```
  "mcpServers": {
    "apra-fleet": {
      "httpUrl": "http://localhost:7523/mcp",
      "trust": true
    }
  }
  ```
  When `--transport stdio`, keep existing format:
  `{ "command": "...", "args": [...], "trust": true }`.

  **Copilot** -- update `mergeCopilotConfig()` to write URL-based format
  to the Copilot settings.json:
  ```
  "mcpServers": {
    "apra-fleet": {
      "url": "http://localhost:7523/mcp",
      "type": "http"
    }
  }
  ```
  When `--transport stdio`, keep existing format:
  `{ "command": "...", "args": [...] }`.

  **Codex** -- update `mergeCodexConfig()` to write URL-based format
  to Codex settings.toml. Codex MCP config uses `url` key in the
  `[mcp_servers.apra-fleet]` TOML table:
  ```
  [mcp_servers.apra-fleet]
  url = "http://localhost:7523/mcp"
  ```
  When `--transport stdio`, keep existing format:
  `{ "command": "...", "args": [...] }`.

  When transport is `stdio`: ALL providers keep existing behavior --
  command+args config format, `claude mcp add` without `--transport`.

- **Files:** `src/cli/install.ts` (modify)
- **Tier:** standard
- **Done when:** `apra-fleet install` registers the MCP server with
  HTTP transport config for the chosen provider (URL-based config
  matching the exact formats above). `apra-fleet install --transport
  stdio` registers with stdio config as before. Unit tests verify the
  correct config shape is written for each provider x transport
  combination.
- **Blockers:** Task 2 (HTTP transport), Task 5 (server.json / port).

#### Task 9: Integration Tests + Gemini Client Verification

- **Change:** Write integration tests in `tests/transport-integration.test.ts`
  that exercise the full HTTP transport path end-to-end:
  (a) Start HTTP server with tools registered, connect an MCP client
  using the SDK's `StreamableHTTPClientTransport`, call the `version`
  tool, verify correct response.
  (b) Connect a client, trigger a `credential:stored` event on the
  event bus, verify the client receives a `notifications/message`
  notification.
  (c) Connect two clients concurrently, emit an event, verify BOTH
  receive the notification.
  (d) Start with `--transport stdio` (or simulate), verify tool calls
  work via stdio (regression test).
  (e) Verify server binds to 127.0.0.1 only (not 0.0.0.0).
  (f) **Gemini client compatibility test:** Connect to the fleet
  StreamableHTTP endpoint using the same client transport that Gemini
  CLI uses (`StreamableHTTPClientTransport` from the MCP SDK). Perform
  an initialize handshake and a tool call. This validates that Gemini's
  client path works against our server, independent of the open Gemini
  bug (google-gemini/gemini-cli#5268). If this test fails, document the
  failure mode and whether it is a fleet-side or Gemini-side issue.
  Log the Gemini bug reference in a code comment on the test.

- **Files:** `tests/transport-integration.test.ts` (new)
- **Tier:** standard
- **Done when:** All integration tests pass. Both transports verified
  end-to-end. Notification broadcast to multiple clients confirmed.
  Gemini-compatible client test passes (or failure is documented as a
  known Gemini-side issue with the bug reference).
- **Blockers:** All previous tasks.

#### VERIFY: Event Wiring + Client Configuration
- Run full test suite
- Confirm credential_store_set event flows from auth-socket through
  event bus to SSE stream notification
- Confirm install command generates correct config for all four
  providers in both transport modes
- Confirm Gemini client compatibility test result
- Report: integration test results, Gemini bug status, any
  provider-specific config issues

---

### Phase 4: Documentation

Goal: Update docs and help text for the new transport, event bus, and
migration path.

#### Task 10: Documentation Updates

- **Change:**
  - Update `README.md`: add a "Transport" section documenting the
    `--transport` flag (`http` default, `stdio` fallback), the singleton
    model (one fleet service per machine, multiple clients connect),
    the `server.json` file, the default port (7523), and the event bus
    concept.
  - Update `docs/architecture.md`: add a "Transport Layer" section
    describing the HTTP+SSE architecture, per-session McpServer model,
    event bus flow from subsystem -> event bus -> notification.
  - Update `--help` text in `src/index.ts` to show the `--transport`
    flag and its values.
  - Add a migration note: existing stdio users need to re-run
    `apra-fleet install` or use `--transport stdio` to keep the old
    behavior.

- **Files:** `README.md` (modify), `docs/architecture.md` (modify),
  `src/index.ts` (modify -- help text)
- **Tier:** cheap
- **Done when:** Docs accurately describe the new transport, singleton
  model, event bus, and migration path. `apra-fleet --help` shows
  `--transport` flag. ASCII-only check passes.
- **Blockers:** None (docs reflect implemented behavior from prior
  phases).

#### VERIFY: Documentation
- Read updated docs for accuracy and completeness
- Run `apra-fleet --help` and verify new flag appears
- Run pre-commit ASCII hook on all changed files
- Run full test suite one final time
- Report: all acceptance criteria checked off

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| R1: StreamableHTTPServerTransport transitive dep on @hono/node-server fails in SEA binary | High | Task 3 validates SEA compatibility in Phase 1. esbuild already bundles the dep (not in external list). If it fails, add to externals and ship as side file, or patch the import. Caught before any downstream work depends on it. |
| R2: Gemini CLI StreamableHTTP client does not work against our server (open bug google-gemini/gemini-cli#5268) | High | Task 9f runs a Gemini-compatible client test. If it fails, document whether the issue is fleet-side (fixable) or Gemini-side (external blocker). Fleet server remains spec-compliant regardless. |
| R3: Singleton startup race -- two processes both detect "no instance" and both start | High | Task 6 uses atomic file creation (`fs.openSync(path, 'wx')` / O_CREAT+O_EXCL) as a startup lock. Exactly one process wins. Stale locks (>60s, crashed process) are cleaned up and retried. |
| R4: Singleton PID detection unreliable (zombie processes, PID reuse, Windows edge cases) | Med | Double-check: verify PID alive via process.kill(pid, 0) AND verify port responds to /health HTTP endpoint. Both must pass. Stale server.json is deleted and fresh instance started. |
| R5: Port conflict on the default port (7523) | Low | Try default port first, fall back to port 0 (OS-assigned random). APRA_FLEET_PORT env var lets users override. server.json records the actual port for discovery. |
| R6: Backward compatibility -- existing stdio users must not be broken | High | stdio code paths are never modified or removed. --transport stdio selects the legacy path. Install --transport stdio preserves current registration. Full regression tests (Task 9d). |
| R7: Notification format may not match MCP spec for notifications/message | Med | Use McpServer's built-in `server.server.sendLoggingMessage()` which constructs spec-compliant notifications. Do not hand-roll JSON-RPC payloads. Validate in integration tests. |
| R8: Cross-platform server.json path and PID handling | Med | Use FLEET_DIR (already cross-platform via paths.ts). process.kill(pid, 0) works cross-platform in Node.js. fs.openSync with 'wx' flag works cross-platform. Auth socket already handles Windows named pipes vs Unix sockets. |
| R9: HTTP server security -- localhost-only binding required | High | Bind to 127.0.0.1 explicitly, never 0.0.0.0. Verify in integration tests (Task 9e). No TLS or HTTP auth in this sprint (out of scope; localhost-only is the security boundary). |
| R10: Per-session McpServer model -- memory overhead of many server instances | Low | McpServer is lightweight (protocol handler + tool map). Tool handlers are stateless shared functions. Expected concurrency: 2-5 local LLM clients. No concern at this scale. |

---

## Phase Sizing Rules

Phase boundaries are by cohesion, not count. Tiers are monotonically
non-decreasing within each phase:

- Phase 1: cheap, standard, standard -- OK
- Phase 2: cheap, standard, standard -- OK
- Phase 3: cheap, standard, standard -- OK
- Phase 4: cheap -- OK

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints -- stop and report after each one
- Base branch: main
- Implementation branch: feat/mcp-sse-transport
