# apra-fleet -- Implementation Plan: MCP Transport stdio -> HTTP+SSE

> Replace fleet's stdio MCP transport with an HTTP+SSE singleton server that
> multiple LLM clients share. The server uses the MCP SDK's HTTP transport
> (StreamableHTTPServerTransport preferred, SSEServerTransport as fallback)
> with a per-session McpServer model for multi-client concurrency. An internal
> typed event bus lets subsystems push notifications to all connected clients
> over SSE. The first event producer is credential_store_set completion. stdio
> remains as a backward-compatible fallback via --transport stdio.

---

## Tasks

### Phase 1: Core Abstractions + Risk Validation

Goal: Build the event bus and HTTP transport layer. Validate that
multiple concurrent MCP client sessions can each receive server-push
notifications -- the riskiest assumption in this sprint.

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

#### Task 2: HTTP+SSE Server with Multi-Session Support

- **Change:** Create `src/services/http-transport.ts`. Architecture:
  one `McpServer` instance per client session, each connected to its own
  SDK transport instance. A session manager tracks active
  `{ server, transport }` pairs keyed by session ID and handles cleanup
  on disconnect.

  Implementation details:
  - Use `node:http` to create an HTTP server bound to `127.0.0.1` on
    port 0 (OS-assigned random available port).
  - Route incoming requests to the correct session's transport. For
    `StreamableHTTPServerTransport`: POST /mcp with `initialize` creates
    a new session (new McpServer + transport, tools registered via a
    `registerTools` callback); subsequent POST/GET /mcp with
    `mcp-session-id` header routes to the existing session's
    `transport.handleRequest()`. For `SSEServerTransport` (fallback if
    clients require `"type": "sse"`): GET /sse creates a new session;
    POST /messages?sessionId=X routes to the session's
    `transport.handlePostMessage()`.
  - Subscribe to the event bus (`fleetEvents`). On any event, iterate
    all active sessions and call
    `session.server.server.sendLoggingMessage({ level: 'info',
    logger: 'apra-fleet-events', data: <formatted message> })` to push
    a `notifications/message` to each connected client.
  - Handle session cleanup: when a transport's `onclose` fires, remove
    it from the session map.
  - Export: `createHttpTransport(options: { registerTools: (server) => void })` 
    returning `{ httpServer, port, url, sessions, close() }`.

  Risk validation tests (the riskiest assumption):
  (a) Server starts on a random port, health endpoint responds.
  (b) Two MCP clients connect concurrently with separate sessions.
  (c) Event bus emit reaches BOTH clients as SSE/logging notifications.
  (d) Client disconnect removes the session from the map.

  Decision point: prefer `StreamableHTTPServerTransport` (current MCP
  spec, not deprecated). If during implementation Claude Code or Gemini
  clients do not support `"type": "streamableHttp"` / `"type": "http"`
  in their MCP config, fall back to `SSEServerTransport` with the
  GET /sse + POST /messages pattern. Document the decision in the commit
  message.

- **Files:** `src/services/http-transport.ts` (new),
  `tests/http-transport.test.ts` (new)
- **Tier:** standard
- **Done when:** Tests pass: two concurrent MCP clients on the same HTTP
  server each receive a `notifications/message` when the event bus emits.
  Server binds to 127.0.0.1 only. Port is dynamically assigned. Session
  cleanup works on disconnect.
- **Blockers:** Task 1 (event bus). Risk R1 (SDK transport compatibility
  with target clients -- validated by this task's tests and manual check
  of Claude Code / Gemini MCP client config formats).

#### VERIFY: Core Abstractions + Risk Validation
- Run full test suite (`npm test`)
- Confirm event bus + HTTP transport tests pass
- Confirm multi-session notification broadcast works
- Report: which SDK transport was chosen (StreamableHTTP vs SSE) and why;
  any SDK issues found; test results

---

### Phase 2: Server Refactor + Dual Transport Startup

Goal: Refactor startServer() so both transports share tool registration,
add the --transport flag, implement singleton lifecycle detection.

#### Task 3: Extract Tool Registration into Shared Module

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

#### Task 4: --transport Flag + Dual Startup Paths

- **Change:** Add `--transport <sse|stdio>` CLI flag to `src/index.ts`.
  Default: `sse`. Alias: `--stdio` maps to `--transport stdio` (existing
  `--stdio` flag already in the codebase).

  Refactor `startServer()` into two functions:
  - `startStdioServer()`: existing behavior (McpServer +
    StdioServerTransport). Called when `--transport stdio`.
  - `startHttpServer()`: creates McpServer, calls `registerAllTools()`,
    calls `createHttpTransport()` from Phase 1 Task 2 passing
    `registerAllTools` as the `registerTools` callback, writes
    `server.json` to FLEET_DIR with
    `{ pid, port, url, version, startedAt }`, starts stall detector +
    idle manager + cleanup tasks, registers SIGINT/SIGTERM handlers that
    delete `server.json` and close the HTTP server. Called when
    `--transport sse` (default).

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
- **Blockers:** Task 2 (HTTP transport module), Task 3 (tool registry).

#### Task 5: Singleton Lifecycle Detection

- **Change:** Create `src/services/singleton.ts`. Export
  `checkRunningInstance(): { running: boolean, url?: string, pid?: number }`.
  Logic: read `server.json` from `SERVER_INFO_PATH`. If file exists:
  verify PID is alive via `process.kill(pid, 0)` (cross-platform), then
  verify port responds by sending an HTTP GET to `${url}/health` with a
  2-second timeout. If BOTH checks pass: return `{ running: true, url }`.
  If either fails: delete stale `server.json`, return
  `{ running: false }`.

  Add `GET /health` endpoint to the HTTP server in
  `src/services/http-transport.ts`: returns JSON
  `{ status: "ok", version, pid, uptime, sessions: <count> }`.

  Wire into `startHttpServer()` in `src/index.ts`: before starting the
  HTTP server, call `checkRunningInstance()`. If running: log the URL
  and exit with code 0 ("Fleet already running at <url>"). If not
  running: proceed with startup.

  Tests: (a) stale server.json (dead PID) is cleaned up and startup
  proceeds; (b) health endpoint returns correct JSON; (c) second startup
  detects running instance via health check.

- **Files:** `src/services/singleton.ts` (new),
  `src/services/http-transport.ts` (modify -- add /health route),
  `src/index.ts` (modify -- call singleton check),
  `tests/singleton.test.ts` (new)
- **Tier:** standard
- **Done when:** Starting a second fleet HTTP instance prints the URL of
  the running instance and exits cleanly (exit 0). Stale server.json
  files (dead PID or unresponsive port) are cleaned up. /health endpoint
  responds with status JSON. Tests pass.
- **Blockers:** Task 4 (server.json write/read).

#### VERIFY: Server Refactor + Dual Transport Startup
- Run full test suite
- Manual verification: start fleet (HTTP mode), confirm server.json
  written; start second instance, confirm it detects and exits; kill
  fleet, confirm server.json cleaned up; start fleet --transport stdio,
  confirm it works as before
- Report: both startup paths work, singleton detection works, no
  regressions

---

### Phase 3: Event Wiring + Client Configuration

Goal: Wire the motivating use case (credential_store_set completion
event) and update the install command to register SSE/HTTP transport
config for all providers.

#### Task 6: Wire credential_store_set Completion Event

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

#### Task 7: Update Install Command for SSE/HTTP Config

- **Change:** Modify `src/cli/install.ts` to support SSE/HTTP transport
  registration. Add `--transport <sse|stdio>` flag to the install
  command (default: `sse`).

  When transport is `sse`:
  - Claude: determine URL by reading `server.json` if fleet is running,
    else use a well-known default like `http://localhost:0/mcp` (fleet
    will write actual URL on first start). Use `claude mcp add` with
    the appropriate transport flag (`--transport sse` or
    `--transport http` depending on Task 2's SDK transport decision).
    Remove the old stdio registration first.
  - Gemini: update `mergeGeminiConfig()` to write URL-based config:
    `{ url: "<fleet-url>", transportType: "sse" }` instead of
    `{ command, args }`. Keep old function signature for stdio fallback.
  - Codex: update `mergeCodexConfig()` similarly.
  - Copilot: update `mergeCopilotConfig()` similarly.

  When transport is `stdio`: existing behavior unchanged.

  Handle the chicken-and-egg problem: if fleet is not yet running when
  install runs (first install), the URL is unknown. Options:
  (a) start fleet in the background during install, read server.json;
  (b) use a fixed well-known port (e.g., 17239) with fallback to random;
  (c) write a placeholder and have fleet update the config on first HTTP
  start. Decision: option (b) -- use a default port (configurable via
  APRA_FLEET_PORT env var) so the URL is predictable at install time.
  The HTTP server tries this port first, falls back to random if busy.

- **Files:** `src/cli/install.ts` (modify),
  `src/services/http-transport.ts` (modify -- accept preferred port),
  `src/paths.ts` (add DEFAULT_PORT constant)
- **Tier:** standard
- **Done when:** `apra-fleet install` registers the MCP server with
  SSE/HTTP transport config for the chosen provider (URL-based, not
  command-based). `apra-fleet install --transport stdio` registers with
  stdio config as before. Tests pass.
- **Blockers:** Task 2 (transport type decision), Task 4 (server.json).

#### Task 8: Integration Tests for SSE Transport Path

- **Change:** Write integration tests in `tests/transport-integration.test.ts`
  that exercise the full SSE/HTTP path end-to-end:
  (a) Start HTTP server with tools registered, connect an MCP client
  (using the SDK's client-side transport), call the `version` tool,
  verify correct response.
  (b) Connect a client, trigger a `credential:stored` event on the
  event bus, verify the client receives a `notifications/message`
  notification via the SSE stream.
  (c) Connect two clients concurrently, emit an event, verify BOTH
  receive the notification.
  (d) Start with `--transport stdio` (or simulate), verify tool calls
  work via stdio (regression test).
  (e) Verify server binds to 127.0.0.1 only (not 0.0.0.0).
- **Files:** `tests/transport-integration.test.ts` (new)
- **Tier:** standard
- **Done when:** All integration tests pass. Both transports verified
  end-to-end. Notification broadcast to multiple clients confirmed.
- **Blockers:** All previous tasks.

#### VERIFY: Event Wiring + Client Configuration
- Run full test suite
- Confirm credential_store_set event flows from auth-socket through
  event bus to SSE stream notification
- Confirm install command generates correct config for all providers
  in both transport modes
- Report: integration test results, any provider-specific config issues

---

### Phase 4: Documentation

Goal: Update docs and help text for the new transport, event bus, and
migration path.

#### Task 9: Documentation Updates

- **Change:**
  - Update `README.md`: add a "Transport" section documenting the
    `--transport` flag (`sse` default, `stdio` fallback), the singleton
    model (one fleet service per machine, multiple clients connect),
    the `server.json` file, and the event bus concept.
  - Update `docs/architecture.md`: add a "Transport Layer" section
    describing the HTTP+SSE architecture, session management, event bus
    flow from subsystem -> event bus -> SSE notification.
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
| R1: Claude Code / Gemini MCP clients may not support StreamableHTTP transport type (`"type": "streamableHttp"`), only legacy SSE (`"type": "sse"`) | High | Task 2 validates client compatibility first. If StreamableHTTP is unsupported, fall back to SSEServerTransport with manual per-session routing (GET /sse + POST /messages). The MCP SDK includes an sseAndStreamableHttpCompatibleServer example for dual-protocol support. |
| R2: SSEServerTransport is deprecated in the MCP SDK; future SDK versions may remove it | Med | StreamableHTTPServerTransport is the primary target. SSE is fallback only if R1 forces it. Pin SDK version in package.json if needed; track deprecation timeline. |
| R3: Singleton PID detection unreliable (zombie processes, PID reuse, Windows edge cases) | Med | Double-check: verify PID alive via process.kill(pid, 0) AND verify port responds to /health HTTP endpoint. Both must pass to consider the instance alive. Stale server.json is deleted and a fresh instance started. |
| R4: Port conflict on the default port | Low | Try default port first, fall back to port 0 (OS-assigned random available). APRA_FLEET_PORT env var lets users override. Retry once on EADDRINUSE before falling back. |
| R5: Backward compatibility -- existing stdio users must not be broken | High | stdio code paths are never modified or removed. --transport stdio selects the legacy path. Install --transport stdio preserves current registration behavior. Full regression tests on the stdio path (Task 8d). |
| R6: Notification format may not match MCP spec for notifications/message | Med | Use the McpServer's built-in `server.server.sendLoggingMessage()` which constructs spec-compliant notification messages. Do not hand-roll JSON-RPC notification payloads. Validate format in integration tests. |
| R7: Cross-platform server.json path and PID handling | Med | Use FLEET_DIR (already cross-platform via paths.ts). Use path.join for all paths. process.kill(pid, 0) works cross-platform in Node.js. Auth socket already handles Windows named pipes vs Unix sockets -- same approach for singleton detection. |
| R8: HTTP server security -- localhost-only binding required | High | Bind to 127.0.0.1 explicitly, never 0.0.0.0. Verify in integration tests (Task 8e). No TLS or HTTP auth in this sprint (out of scope per requirements; localhost-only binding is the security boundary). |
| R9: Per-session McpServer model -- memory and CPU overhead of many server instances | Low | McpServer is lightweight (protocol handler + tool map). Tool handlers are stateless functions shared across sessions. Expected concurrency is low (2-5 local LLM clients). No concern at this scale. |
| R10: Chicken-and-egg: install needs fleet URL but fleet may not be running yet | Med | Use a default well-known port (configurable via APRA_FLEET_PORT env var) so the URL is predictable at install time. HTTP server tries this port first, falls back to random if busy. If fallback port is used, server.json records the actual port for clients to discover. |

---

## Phase Sizing Rules

Phase boundaries are by cohesion, not count. Tiers are monotonically
non-decreasing within each phase:

- Phase 1: cheap, standard -- OK
- Phase 2: cheap, standard, standard -- OK
- Phase 3: cheap, standard, standard -- OK
- Phase 4: cheap -- OK

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints -- stop and report after each one
- Base branch: main
- Implementation branch: feat/mcp-sse-transport
