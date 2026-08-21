# apra-fleet-client -- API Reference

All modules are ES modules (`"type": "module"` in `package.json`); import
with `import { ... } from '@apralabs/apra-fleet-client'` (or one of the
subpath exports below).

## `src/client/transport.mjs`

A transport is an `EventEmitter` that knows how to move raw JSON-RPC
messages to and from the fleet server. Both transports emit:

- `'message'` -- with a parsed JSON-RPC message object, whenever one arrives.
- `'error'` -- with an `Error`, on a transport-level failure.
- `'close'` -- when the underlying connection/process ends.

Neither transport does JSON-RPC ID bookkeeping, timeouts, or
request/response correlation itself -- that's `McpClient`'s job.

### `class StdioTransport extends EventEmitter`

Spawns a child process and speaks newline-delimited JSON over its stdin/stdout.

- **`new StdioTransport(command, args, options = {})`**
  - `command: string` -- executable to spawn.
  - `args: string[]` -- arguments.
  - `options: object` -- passed through to Node's `child_process.spawn()`.
- **`start()`** -- spawns the process and wires up stdout/stderr/close/error
  handlers. Not async (does not await process startup); it returns
  immediately after calling `spawn()`. stderr output from the child is
  currently discarded silently (no `'error'`/log emission for it).
- **`async send(message)`** -- JSON-stringifies `message`, appends `\n`,
  writes it to the child's stdin. Throws a plain `Error('Transport not
  started')` if `start()` hasn't been called yet (i.e. `this.process` is
  null).
- **`stop()`** -- kills the child process (`SIGTERM` via `.kill()`) and
  clears the internal process handle. Safe to call even if not started.

Incoming stdout data is buffered and split on `\r?\n`; each complete line is
`JSON.parse`d and emitted as `'message'`. A line that fails to parse is
logged to `console.error` and dropped (not emitted, not thrown).

### `class StreamableHttpTransport extends EventEmitter`

Implements the MCP "Streamable HTTP" transport: an initial POST to obtain a
session ID, a long-lived GET that opens a Server-Sent-Events stream for
server-to-client messages, and subsequent POSTs (also answered via SSE) to
send client-to-server messages.

- **`new StreamableHttpTransport(url, options = {})`**
  - `url: string` -- the MCP endpoint URL.
  - `options.headers: object` -- extra HTTP headers merged into every
    request (e.g. for auth).
- **`async start()`**
  1. POSTs a JSON-RPC `initialize` request to `url`.
  2. Reads the `mcp-session-id` response header; throws if it's missing.
  3. Opens a GET request to the same `url` with that session ID and starts
     reading it as an SSE stream in the background.
  4. Emits `'ready'` once the stream is open.
  - Any failure during this sequence is caught and re-emitted as an
    `'error'` event (this method does not throw/reject -- callers must
    listen for `'error'` and/or `'ready'`, not `await` a resolved value
    that indicates failure).
- **`async send(message)`** -- POSTs `message` as JSON to `url` with the
  session ID header, then reads the response body as an SSE stream for the
  reply (the server answers each POST with its own SSE payload rather than
  a plain JSON body). Throws if `start()` hasn't produced a session ID yet,
  or if the POST response is not `ok`.
- **`stop()`** -- aborts the internal `AbortController`, tearing down both
  the open GET stream and any in-flight POST.

Note: `StreamableHttpTransport` generates its own JSON-RPC id for the
`initialize` call internally (via `crypto.randomUUID()`); this happens
before an `McpClient` is attached, so that particular request/response pair
is not visible through `McpClient`.

## `src/client/client.mjs`

### `export const DEFAULT_REQUEST_TIMEOUT_MS`

`15 * 60 * 1000` (15 minutes). The timeout used by `McpClient.request()`
when no `timeoutMs` is given and none can be derived. Documented as
intentionally finite: a server that accepts a request and never replies
(without closing the transport) must not hang the caller forever.

### `class McpClient`

Adds JSON-RPC 2.0 request/response correlation, per-request timeouts, and
abort support on top of a transport.

- **`new McpClient(transport)`** -- subscribes to the transport's
  `'message'`, `'close'`, and `'error'` events. On `'close'` or
  `'error'`, every currently-pending request is rejected (with
  `Error('Transport closed')` or the emitted error, respectively) and the
  pending-request map is cleared.

- **`async request(method, params, opts = {})`** -- sends
  `{ jsonrpc: '2.0', id, method, params }` over the transport and returns a
  `Promise` that resolves with `message.result` when a matching JSON-RPC
  response arrives, or rejects if the response is an error, the request
  times out, or the given signal aborts.
  - `method: string`
  - `params: object`
  - `opts.timeoutMs?: number` -- reject with a `TimeoutError`
    (`.code === 'TIMEOUT'`) if no response arrives in this window. Defaults
    to `DEFAULT_REQUEST_TIMEOUT_MS` when omitted. Passing `Infinity`
    (or `null`) disables the timer.
  - `opts.signal?: AbortSignal` -- if provided and already aborted, rejects
    immediately with an `AbortError` (`.code === 'ABORTED'`); if aborted
    later, rejects the same way and cleans up the pending-request entry.
  - This is a **client-side-only** timeout/abort: it stops the local
    `Promise` from waiting forever and frees local bookkeeping, but it
    cannot cancel work already accepted by the remote fleet-server process.
    A response that arrives after the client has already timed out/aborted
    is silently discarded (no unhandled rejection, no effect on other
    pending requests).
  - Request IDs are simple incrementing integers (`this.nextId++`), unique
    per `McpClient` instance, not globally.

- **`async callTool(name, args, opts = {})`** -- convenience wrapper:
  `request('tools/call', { name, arguments: args }, opts)`. This is what
  `ApraFleet`'s methods call under the hood.

## `src/client/errors.mjs`

- **`class ClientError extends Error`** -- `new ClientError(message, {
  code, details, cause })`. Sets `this.name` to the concrete subclass name,
  `this.code` (defaults to `'CLIENT_ERROR'`), and `this.details`. `cause`
  is passed through to the native `Error` cause chain when provided.
- **`class TimeoutError extends ClientError`** -- always has
  `code === 'TIMEOUT'`. Thrown by `McpClient.request()` on a client-side
  timeout.
- **`class AbortError extends ClientError`** -- always has
  `code === 'ABORTED'`. Thrown by `McpClient.request()` when the caller's
  `AbortSignal` fires before a response arrives.

Callers generally check `err.code` rather than `instanceof`, since a
sibling package (`apra-fleet-workflow`) intentionally recognizes these
codes to re-wrap them into its own error taxonomy (see "Known issues"
below).

## `src/client/api.mjs`

### `export function deriveTimeoutMs(payload = {})`

Derives a client-side `McpClient.request()` timeout, in milliseconds, from
a tool-call payload's own timeout hints, so the client doesn't give up
before the server's own deadline has a chance to fire.

- Looks at `payload.max_total_s` first, falling back to `payload.timeout_s`
  if `max_total_s` is absent (`??`, so `0` in `max_total_s` would NOT fall
  through, but `undefined`/`null` would).
- If the chosen value isn't a finite positive number, returns `undefined`
  (letting `McpClient` fall back to its own `DEFAULT_REQUEST_TIMEOUT_MS`).
- Otherwise returns `hintSeconds * 1000 + 30_000` -- a 30-second grace
  margin (`TIMEOUT_GRACE_MS`) added on top of the server-facing hint.
- This single-budget shape (rather than `max_total_s * 2`) relies on the
  server sharing ONE `max_total_s` deadline across an original dispatch
  attempt and any single retry it runs internally (e.g. a fresh-session
  retry after an SSH inactivity exception) -- a retry's own budget is capped
  to whatever remains of `max_total_s` since the dispatch started, and
  skipped once that remainder is exhausted (`src/tools/execute-prompt.ts`,
  apra-fleet-y8q.1). Without that server-side sharing, a retry could burn a
  second full budget and this client timeout would fire before the server's
  own clean retry-and-report path ever got a chance.

### `class ApraFleet`

Thin, typed wrapper over an MCP-capable client's `callTool(name, args,
opts)` method (normally an `McpClient` instance, but any object with a
compatible `callTool` works -- this is how the unit tests mock it).

- **`new ApraFleet(mcpClient)`** -- stores the client on `this.mcpClient`.

All methods below are `async` and return whatever `mcpClient.callTool()`
resolves to (i.e. the MCP tool's `result`), or reject with whatever it
rejects with (a `TimeoutError`/`AbortError` from `McpClient`, or a plain
`Error` wrapping the server's JSON-RPC error message). None of the methods
validate their arguments locally; validation is the server's job, and an
invalid call surfaces as a rejected promise carrying the server's error
message.

#### `executePrompt(options: ExecutePromptOptions)`

Calls the `execute_prompt` MCP tool -- runs an AI prompt on a fleet member.
`timeoutMs` and `signal` are stripped from `options` before the remaining
fields are sent as the tool payload; `timeoutMs` is passed to
`mcpClient.callTool` as `opts.timeoutMs` (defaulting to
`deriveTimeoutMs(payload)` when not given explicitly), and `signal` as
`opts.signal`.

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` | The prompt to send to the LLM on the remote member. |
| `agent` | `string?` | Optional agent name to activate. |
| `max_total_s` | `number?` | Hard ceiling in seconds. |
| `max_turns` | `number?` | Max turns for `claude -p` (default: 50). |
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `model` | `string?` | Model tier (`"cheap"`, `"standard"`, `"premium"`) or a specific model ID. |
| `resume` | `(boolean \| string)?` | Resume the previous session if one exists, or pass a session ID string directly. At this client/transport layer, an omitted field defaults to `true` server-side. `apra-fleet-workflow`'s `FleetWorkflow.agent()` always sends this field explicitly (defaulting it to `false` for workflow-authored prompts), so workflow callers effectively opt out of this client-level default unless they ask for it. |
| `session_id` | `string?` | Optional explicit session ID to resume (shorthand alias for `resume: "<sessionId>"`). |
| `substitutions` | `Record<string,string>?` | Token-name -> replacement-value map. |
| `timeout_s` | `number?` | Inactivity timeout in seconds (default: 300). |
| `timeoutMs` | `number?` | Client-side request timeout override (ms); not sent to the server. |
| `signal` | `AbortSignal?` | Cancels the client-side wait only; cannot cancel a job already accepted by the server. |

#### `executeCommand(options: ExecuteCommandOptions)`

Calls `execute_command` -- runs a shell command on a member. Same
`timeoutMs`/`signal` handling as `executePrompt`.

| Field | Type | Notes |
|---|---|---|
| `command` | `string` | The shell command to execute. |
| `long_running` | `boolean?` | Run as a background task. Supported on linux and windows (windows launches detached via `Invoke-CimMethod Win32_Process.Create`, session 0); darwin gets an advisory warning only. |
| `max_retries` | `number?` | Max crash retries (long-running only). |
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `restart_command` | `string?` | Command for retry runs, e.g. checkpoint resume. |
| `run_from` | `string?` | Override directory to run from. |
| `timeout_s` | `number?` | Timeout in seconds (default: 120). |
| `timeoutMs` | `number?` | Client-side request timeout override (ms). |
| `signal` | `AbortSignal?` | Client-side cancellation only. |

#### `listMembers(options: ListMembersOptions = {})`

Calls `list_members`. `options` defaults to `{}` if omitted (verified by
the unit tests -- calling with no arguments sends an empty object, not
`undefined`).

| Field | Type | Notes |
|---|---|---|
| `format` | `"compact" \| "json"?` | Output format. |
| `tags` | `string[]?` | Filter members by tags (AND semantics). |

#### `fleetStatus(options: FleetStatusOptions = {})`

Calls `fleet_status` -- status of all fleet members.

| Field | Type | Notes |
|---|---|---|
| `format` | `"compact" \| "json"?` | Output format. |

#### `memberDetail(options)`

Calls `member_detail` -- detailed status for one member: connectivity,
session (`session.id`, the current session ID or `null`), work folder
(`folder`), and provider (`llmProvider`).

| Field | Type | Notes |
|---|---|---|
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `format` | `"compact" \| "json"?` | Output format. |

#### `sendFiles(options: SendFilesOptions)`

Calls `send_files` -- uploads local files to a member.

| Field | Type | Notes |
|---|---|---|
| `local_paths` | `string[]` | Local file paths to upload. |
| `dest_subdir` | `string?` | Destination subdirectory relative to the member's work folder. |
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `substitutions` | `Record<string,string>?` | Token-name -> replacement-value map. |

#### `receiveFiles(options: ReceiveFilesOptions)`

Calls `receive_files` -- downloads files from a member.

| Field | Type | Notes |
|---|---|---|
| `remote_paths` | `string[]` | Paths on the member to download. |
| `local_dest_dir` | `string` | Local directory to write downloaded files into. |
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |

#### `registerMember(options: RegisterMemberOptions)`

Calls `register_member` -- adds a machine to the fleet.

| Field | Type | Notes |
|---|---|---|
| `friendly_name` | `string` | Required. Human-friendly name for this member. |
| `work_folder` | `string` | Required. Working directory on the target machine. For remote members, must be a fully-qualified/absolute path (e.g. `/home/bella/repo` or `C:\Users\bella\repo`) -- `~` and relative paths are rejected. |
| `member_type` | `"local" \| "remote"?` | Default: `"remote"`. |
| `host` | `string?` | IP address or hostname of the remote machine. |
| `username` | `string?` | SSH username. |
| `port` | `number?` | SSH port (default: 22). |
| `auth_type` | `"password" \| "key"?` | Authentication method. |
| `password` | `string?` | SSH password. |
| `key_path` | `string?` | Path to SSH private key. |
| `llm_provider` | `string?` | LLM provider for this member. |
| `category` | `string?` | Optional group label. |
| `tags` | `string[]?` | Optional list of free-form labels. |
| `unattended` | `"false" \| "auto" \| "dangerous"?` | Permission mode for unattended execution. |

#### `updateMember(options: UpdateMemberOptions)`

Calls `update_member` -- changes a member's settings. Same shape as
`RegisterMemberOptions` but every field is optional and semantically means
"new value for this field"; identifies the target member via `member_id`
or `member_name`.

#### `removeMember(options: RemoveMemberOptions)`

Calls `remove_member` -- removes a member from the fleet.

| Field | Type | Notes |
|---|---|---|
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `force` | `boolean?` | Remove even if the member is currently busy. |

## `src/client/server-resolution.mjs`

The single, shared implementation of "how does a client process reach the
apra-fleet MCP server." Both `src/cli/workflow.ts` (the `apra-fleet
workflow` launcher) and `packages/apra-fleet-se/bin/cli.mjs` (auto-sprint)
depend on this module rather than duplicating the resolution logic.
Binding design doc: `docs/adr-workflow-server-resolution.md`.

Resolution order:

1. **Forced transport / explicit stdio request.** `APRA_FLEET_TRANSPORT`
   (`'http'` or `'stdio'`) overrides everything. `'stdio'` (or
   `APRA_FLEET_SERVER_CMD`/`APRA_FLEET_SERVER_BIN` being set while transport
   isn't forced to `'http'`) resolves a stdio command directly, no probe.
   `'http'` probes only -- it never silently falls back to stdio.
2. **HTTP singleton probe** (the product default when unset) --
   `checkRunningInstance()` reads `~/.apra-fleet/data/server.json`
   (`{pid, url}`), checks the pid is alive, then `GET`s a `/health`
   endpoint derived from `url` (2s timeout). A stale/dead entry causes
   `server.json` to be deleted (self-healing). On success, attaches over
   `StreamableHttpTransport` and spawns nothing.
3. **Stdio self-spawn fallback** -- `resolveFleetServerCommand()`'s four
   tiers: `APRA_FLEET_SERVER_CMD` (a full `"<command> <args...>"` string),
   `APRA_FLEET_SERVER_BIN` (resolved via `PATH`, run with `run --transport
   stdio`), a bundled sibling `index.js` next to this module, or (dev
   monorepo layout) `../../../dist/index.js` relative to it.

The launcher/auto-sprint client and the MCP server are always separate
processes; this module only decides the transport, it never merges them.
Every branch takes an injectable `deps` bag (`env`, `readFile`, `unlink`,
`pidAlive`, `health`, `dirname`, `exists`, `checkRunningInstance`) so each
step is independently unit-testable without touching the real
filesystem/network.

#### `getFleetDataDir(env = process.env)`

Returns `~/.apra-fleet/data`, honoring `APRA_FLEET_DATA_DIR` if set (mirrors
`src/paths.ts`).

#### `getServerInfoPath(env = process.env)`

Returns `path.join(getFleetDataDir(env), 'server.json')`.

#### `async checkRunningInstance(deps = {})`

The HTTP-singleton probe (step 2 above). Reads and parses `server.json` via
`deps.readFile`; on any parse failure, or a missing `pid`/`url`, returns
`{ running: false }`. If `deps.pidAlive` (default: a `process.kill(pid, 0)`
liveness check treating `EPERM` as alive) says the pid is dead, deletes
`server.json` via `deps.unlink` and returns `{ running: false }`. If
`deps.health` (default: `GET <url with /mcp replaced by /health>`, 2s
timeout) fails, does the same. Otherwise returns
`{ running: true, url, pid }`. Same semantics as
`src/services/singleton.ts`'s `checkRunningInstance()`, so the client's
probe and the server's own startup dedup never disagree.

#### `resolveFleetServerCommand(deps = {})`

Step 3's stdio command resolution, as a pure function (nothing is spawned).
Returns `{ command: string, args: string[] }`. Throws if
`APRA_FLEET_SERVER_CMD` is set but empty, or if none of the fallback
entry-point tiers exist on disk (`deps.exists`, default `fs.existsSync`) and
neither `APRA_FLEET_SERVER_CMD` nor `APRA_FLEET_SERVER_BIN` is set.

#### `async resolveFleetServerConnection(deps = {})`

The full resolution order above, as a pure descriptor -- nothing is spawned
or connected. Returns either `{ mode: 'http', url, pid, reason }` or
`{ mode: 'stdio', command, args, reason }`. Throws if `APRA_FLEET_TRANSPORT`
is set to anything other than `'http'`/`'stdio'`, or if it's set to
`'http'` and no healthy singleton is found (this case deliberately does not
fall back to stdio).

#### `async connectFleet(deps = {})`

Resolves + connects in one call. Builds a `StreamableHttpTransport` or
`StdioTransport` per `resolveFleetServerConnection`'s result, starts it,
wraps it in `McpClient`, performs the `initialize`/`notifications/initialized`
handshake for stdio connections (the HTTP transport already does its own
`initialize` POST inside `start()`), and returns
`{ transport, mcpClient, fleetApi, mode }` where `fleetApi` is a
`new ApraFleet(mcpClient)`.

`deps.options`, if given, is forwarded to the transport constructor (e.g.
HTTP headers or child-process spawn options).

## `src/client/factory.mjs`

### `async function createWorkflowEngine(config)`

Convenience factory that builds a transport, connects it, wraps it in an
`McpClient` and `ApraFleet`, and (per its current implementation) also
constructs a `FleetWorkflow` and `WorkflowEngine` around that `ApraFleet`.

```
config: {
  transport: 'stdio' | 'http',
  command?: string,     // required if transport === 'stdio'
  args?: string[],      // optional, stdio only
  url?: string,          // required if transport === 'http'
  options?: object,      // transport options (e.g. HTTP headers, spawn options)
  workflowArgs?: object  // passed through as the workflow's initial args
}
```

Behavior:

1. Constructs a `StdioTransport` or `StreamableHttpTransport` per
   `config.transport`; throws a plain `Error` if the required
   `command`/`url` is missing, or if `config.transport` is neither
   `'stdio'` nor `'http'`.
2. `await transport.start()`.
3. Wraps it in `new McpClient(transport)`.
4. For the `stdio` transport only, performs the MCP handshake explicitly:
   sends an `initialize` request (protocol version `'2024-11-05'`) and then
   a `notifications/initialized` notification. (The HTTP transport already
   performs its own `initialize` POST internally inside `start()`, so this
   step is skipped for `'http'`.)
5. Builds `new ApraFleet(mcpClient)`, `new FleetWorkflow(apraFleet,
   config.workflowArgs || {})`, and `new WorkflowEngine(fleetWorkflow)`.
6. Resolves with `{ transport, mcpClient, apraFleet, fleetWorkflow, engine }`.

**Known issue.** Steps 4-5 import `FleetWorkflow` from
`'../workflow/index.mjs'` and `WorkflowEngine` from
`'../workflow/engine.mjs'` -- paths relative to
`packages/apra-fleet-client/src/client/`, which would resolve to
`packages/apra-fleet-client/src/workflow/*`. That directory does not exist
in this package; the real `FleetWorkflow`/`WorkflowEngine` implementation
lives in the separate `@apralabs/apra-fleet-workflow` package
(`packages/apra-fleet-workflow/src/workflow/index.mjs` and `engine.mjs`).
`apra-fleet-workflow` depends on `apra-fleet-client` (see its
`package.json`), not the reverse, so an import in the other direction from
inside `apra-fleet-client` would in any case create a circular package
dependency. As written, calling `createWorkflowEngine()` (or importing
`./factory` at all) will fail to resolve these two imports. There is no
test file covering `factory.mjs` (`test/fleet-client-*.test.mjs` covers
`api.mjs`, `client.mjs`, and `transport.mjs` only), which is consistent
with this path being currently broken/unexercised. The `.`, `./client`,
and `./transport` exports are unaffected -- `ApraFleet`, `McpClient`, and
the transports can be used standalone without going through this factory.

## `src/endpoint/factory.mjs`

### `function makeEndpointApi(config = {})`

Builds a complete `FleetApi` object that talks to an LLM endpoint (OpenAI or
Anthropic) directly, without requiring a running `apra-fleet` MCP server.

The returned object implements the three-method `FleetApi` surface
(`executePrompt`, `executeCommand`, `getMemberModelPricing`) and is accepted
by `new FleetWorkflow(fleetApi)` exactly like an MCP-backed `ApraFleet`.

**Config object:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `provider` | `'openai' \| 'anthropic'` | Yes | Which LLM endpoint shape to use. |
| `baseUrl` | `string` | Yes | Base URL of the LLM endpoint (e.g. `'https://api.openai.com/v1'` or `'https://api.anthropic.com'`). |
| `apiKey` | `string` | Yes | API key for the endpoint (e.g. `'sk-...'` for OpenAI, `'sk-ant-...'` for Anthropic). |
| `model` | `string` | Yes | Model ID to dispatch on every request (e.g. `'gpt-4o'` or `'claude-3-5-sonnet-20241022'`). Since this transport has no member to resolve tier keywords against, `'cheap'`, `'standard'`, and `'premium'` keywords are ignored and this model is used for all tiers. |
| `pricing` | `{promptPrice: number, completionPrice: number}?` | No | Per-token pricing in USD per 1M tokens. If omitted, `getMemberModelPricing()` signals unpriced to the workflow engine. Both must be present if the field is given; a partial object is rejected. |
| `pattern` | `string?` | No | Passed to the OpenAI shape adapter; see its source for accepted patterns. |
| `maxTokens` | `number?` | No | Max output tokens, forwarded to the shape adapter. |
| `headers` | `object?` | No | Extra HTTP headers to merge into every request (e.g. custom auth, provider-specific options). |
| `system` | `string?` | No | System prompt (OpenAI shape only; Anthropic shape ignores this). |
| `anthropicVersion` | `string?` | No | API version header (Anthropic shape only; OpenAI shape ignores this). |
| `fetch` | `function?` | No | Custom fetch implementation (defaults to Node's built-in `fetch`). |

**Important notes:**

- **Config is never read from `process.env`.** All values (baseUrl, apiKey,
  model, pricing) are passed in as-is by the caller. The package does not
  read environment variables, relying instead on the caller to supply
  configuration from their own source of truth (e.g. a cloud function's
  secrets manager, a local config file, or explicit arguments).
- **`executeCommand` always refuses.** This transport has no member, no SSH
  connection, and no work folder, so shell commands cannot be executed.
  Calling `executeCommand()` rejects with a `CommandError` whose `details.reason`
  is `'command_execution_unsupported'`. Use an MCP-backed `ApraFleet` if you
  need command execution.
- **Tier keywords are ignored.** Every dispatch (whether the workflow asks for
  `'cheap'`, `'standard'`, or `'premium'`) uses the single configured `model`.
  Since there is no per-tier resolution, `getMemberModelPricing()` reports the
  same price for all three tiers (the one in `config.pricing`), or signals
  unpriced if `config.pricing` was omitted.

**Returns:**

An object with three async methods:

- **`executePrompt(options)`** -- dispatches a prompt to the configured LLM
  endpoint. Accepts the full `ExecutePromptOptions` shape (see
  `src/client/api.mjs` in api-reference.md above), but ignores the `model`
  tier keyword and always sends the configured model. Returns the same
  structured result as an MCP-backed prompt (content, usage, stop_reason, etc.).
- **`executeCommand(options)`** -- always rejects with a `CommandError`.
- **`getMemberModelPricing(options)`** -- returns pricing for the configured
  model if `config.pricing` was supplied, or an unpriced signal otherwise.
  Returns the standard MCP tool response envelope (`{content: [{type: 'text',
  text: '<json>'}]}`).

**Errors:**

Throws a plain `TypeError` if `config.provider` is not one of `'openai'` or
`'anthropic'`, or if the chosen shape adapter rejects the rest of config
(e.g. missing or empty `baseUrl`, `apiKey`, or `model`).

**Example:**

```js
import { makeEndpointApi } from '@apralabs/apra-fleet-client/endpoint';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';

const fleetApi = makeEndpointApi({
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY_FROM_CONFIG_LAYER,
  model: 'gpt-4o',
  pricing: { promptPrice: 2.5, completionPrice: 10.0 }
});

const workflow = new FleetWorkflow(fleetApi);
const result = await workflow.agent('Write a summary', { timeoutMs: 60_000 });
console.log(result.output);
```
