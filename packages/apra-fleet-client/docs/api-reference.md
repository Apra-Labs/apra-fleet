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
| `resume` | `boolean?` | Resume the previous session if one exists. At this client/transport layer, an omitted field defaults to `true` server-side. `apra-fleet-workflow`'s `FleetWorkflow.agent()` always sends this field explicitly (defaulting it to `false` for workflow-authored prompts), so workflow callers effectively opt out of this client-level default unless they ask for it. |
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
| `long_running` | `boolean?` | Run as a background task. |
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
| `work_folder` | `string` | Required. Working directory on the target machine. |
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
