# Requirements -- apra-fleet#258 MCP Transport: stdio -> HTTP+SSE

## Source
GitHub issue: Apra-Labs/apra-fleet#258
Title: "feat: switch MCP transport from stdio to HTTP+SSE for server-push and event-driven workflows"
Labels: enhancement, wishlist, mcp, architecture

## Base Branch
`main` -- branch to fork from and merge back to. Sprint branch: `feat/mcp-sse-transport`.

## Goal
Replace fleet's MCP stdio transport (strict request-response) with HTTP + Server-Sent
Events (SSE), so the fleet server can push unsolicited `notifications/*` events to the LLM
client at any time during a session. This turns fleet from a tool executor into an event
source, eliminating LLM polling for completion, status, and stall signals.

## Full Issue Text

### Background
Fleet currently uses the MCP stdio transport -- the LLM client writes JSON-RPC requests to
the server's stdin and reads responses from stdout. This is strictly request-response: the
server can only speak when spoken to. There is no mechanism for the server to push
unsolicited messages to the LLM.

The MCP spec defines a second transport -- HTTP + Server-Sent Events (SSE) -- where the
client POSTs requests over HTTP and the server maintains an open SSE stream. On that stream
the server can push `notifications/*` events at any time, unprompted, for the lifetime of
the session.

### What needs to change in fleet
| Layer | Change |
|-------|--------|
| MCP server | Replace stdio JSON-RPC handler with an HTTP server (Express or native `node:http`). Expose a POST endpoint for tool calls and an SSE endpoint (`/events`) for push notifications. |
| MCP client config | `mcp.json` changes from `"type": "stdio"` to `"type": "sse"` with a URL pointing to the local HTTP server. |
| Event bus | Internal pub/sub bus inside fleet so any subsystem (auth socket, task monitor, stall detector) can emit events that get forwarded onto the SSE stream. |
| Claude Code client | Claude Code already supports the SSE transport. Whether it surfaces `notifications/message` as LLM conversation injections is a separate Anthropic ask -- but the server side is ready. |

### Immediate motivating use case
`credential_store_set` currently returns immediately with a "Waiting..." message. The LLM
has no way to know when the user completes the OOB entry. With SSE, fleet pushes
`Secret stored: e2e_bb_token` onto the event stream the moment the auth socket delivers the
value -- the LLM sees it without polling.

### Other event-driven workflows this unlocks
- `execute_prompt` completion -- notified when a background prompt finishes, no `monitor_task` loop.
- Member online/offline -- pushed when an SSH keepalive changes state.
- Stall detected -- stall detector emits an event into the LLM conversation.
- CI status flip -- forward GitHub webhook CI pass/fail into an active session.
- Credential expiry warning -- heads-up N minutes before a TTL credential expires.
- File change watch -- notify when a watched build artifact or config changes.

### Suggested approach (from issue)
1. Keep stdio as a fallback (for environments that don't support HTTP) controlled by a `--transport` flag.
2. Default to HTTP+SSE for local fleet servers (localhost, random port, written to a well-known file so `mcp.json` can be auto-generated).
3. File a parallel request to Anthropic to surface MCP `notifications/message` events as LLM conversation injections in Claude Code.

## Deployment Model (user decision 2026-05-19)
The DEFAULT usage is a SINGLETON `apra-fleet` service per computer, running the HTTP+SSE
transport. All LLM client instances on that machine -- every Claude and Gemini session --
connect to that ONE shared fleet service over HTTP. This replaces the stdio model where
each client spawns its own private server process.

Implications the plan must address:
- The HTTP+SSE server is a long-lived singleton process, not a per-client child process.
- It must support MULTIPLE concurrent client sessions over HTTP -- each client gets its
  own SSE stream / session context; tool state is shared via the one fleet process.
- Singleton lifecycle: detect an already-running fleet service (well-known port/PID file)
  and reuse it instead of starting a second one; start it on demand if absent.
- `mcp.json` for every local client points at the same singleton's localhost URL.
- stdio transport REMAINS so existing users can keep the old per-client model -- it is
  pure backward-compat, not removed, never regressed.

## Scope
- HTTP+SSE MCP server: HTTP server (prefer native `node:http` unless Express already a dep)
  exposing a POST endpoint for JSON-RPC tool calls and a `GET /events` SSE endpoint.
  Must handle multiple concurrent client sessions (singleton serving all local clients).
- `--transport` flag: `sse` (default) or `stdio` (backward-compat fallback). Both
  transports fully functional and co-exist in the codebase.
- HTTP+SSE is the DEFAULT transport: singleton service, localhost bind, well-known/random
  port written to a well-known file so `mcp.json` is auto-generated as `"type": "sse"`.
- Singleton detection + lifecycle: reuse a running fleet service if present, start one if not.
- Internal event bus: pub/sub so subsystems can emit events forwarded onto the SSE stream.
- Wire at least the motivating use case -- `credential_store_set` completion -- to push a
  `notifications/message` event when the auth socket delivers the value.
- stdio transport path retained and selectable, no regression.
- Update `mcp.json` generation to emit SSE config by default, stdio when `--transport stdio`.
- Tests for both transports; docs updated.

## Out of Scope
- Anthropic client-side change to surface `notifications/message` as conversation
  injections -- external ask, not fleet code. (Server side must still be spec-correct.)
- The full catalogue of event-driven workflows (member online/offline, CI webhooks,
  file watch, credential expiry). Build the event bus + SSE plumbing and wire ONLY the
  `credential_store_set` completion event as the reference producer. Remaining producers
  are follow-up backlog items.
- Remote/non-localhost server hardening (TLS, auth tokens on the HTTP endpoint) beyond
  what localhost binding provides -- follow-up.

## Transport Decision (user decision 2026-05-19)
Use the MCP SDK's `StreamableHTTPServerTransport`. Verified that BOTH clients support
Streamable HTTP as of 2026-05: Claude Code (`claude mcp add --transport http`, accepts
`streamable-http` alias; Anthropic's recommended transport since Apr 2026, SSE deprecated)
and Gemini CLI (`httpUrl` config -> `StreamableHTTPClientTransport`; `gemini mcp add
--transport http`). The condition "use StreamableHTTPServerTransport only if both Claude
and Gemini support it today" is satisfied.
- Do NOT carry the deprecated `SSEServerTransport` as a compat fallback -- unnecessary
  surface. The transport set is: StreamableHTTP (default singleton) + stdio (backward-compat).
- A task must include a real Gemini-client connection test against the StreamableHTTP
  endpoint -- see open Gemini bug google-gemini/gemini-cli#5268; do not assume it works.

## Constraints
- Cross-platform: Windows / Linux / macOS, Claude + Gemini providers -- no platform or
  provider assumptions. Random-port + well-known-file approach must work on all three OSes.
- ASCII-only in all committed files (pre-commit hook rejects non-ASCII -- no em-dashes,
  smart quotes, emoji, bullets).
- Must remain MCP-spec-compliant for both transports so any MCP client can connect.
- No regression to existing stdio behavior -- it stays as the explicit fallback.
- Localhost-only bind for the HTTP server (no external network exposure by default).

## Acceptance Criteria
- [ ] Fleet runs as a singleton HTTP+SSE service by default; a second launch detects and reuses the running service rather than starting a duplicate.
- [ ] Multiple MCP clients (e.g. two Claude sessions, or Claude + Gemini) connect concurrently to the one fleet service, each with its own SSE stream.
- [ ] `--transport stdio` still selects the legacy per-client path with no regression.
- [ ] `GET /events` serves a valid SSE stream; POST endpoint handles JSON-RPC tool calls per MCP spec.
- [ ] Generated `mcp.json` is `"type": "sse"` by default pointing at the singleton's localhost URL/port; `"type": "stdio"` when `--transport stdio`.
- [ ] An internal event bus exists; subsystems can publish events that reach the SSE stream as `notifications/*`.
- [ ] `credential_store_set` pushes a completion `notifications/message` event when the OOB value is delivered -- no polling required.
- [ ] Both transports pass the existing MCP tool-call test suite; new tests cover SSE streaming and the event bus.
- [ ] Docs updated to describe the `--transport` flag, the default, and the event bus.
- [ ] Full existing test suite green; pre-commit ASCII hook passes.
