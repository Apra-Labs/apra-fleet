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

`StreamableHttpTransport` additionally emits `'ready'` once its SSE stream
is open (see below).

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
  3. Starts a self-reconnecting background loop (`_runPersistentStream()`)
     that opens a GET request to the same `url` with that session ID and
     reads it as an SSE stream.
  4. Emits `'ready'` once the loop has been started.
  - Any failure during this sequence is caught and re-emitted as an
    `'error'` event (this method does not throw/reject -- callers must
    listen for `'error'` and/or `'ready'`, not `await` a resolved value
    that indicates failure).
- **`async send(message)`** -- POSTs `message` as JSON to `url` with the
  session ID header, then reads the response body as an SSE stream for the
  reply (the server answers each POST with its own SSE payload rather than
  a plain JSON body). Throws if `start()` hasn't produced a session ID yet,
  or if the POST response is not `ok`. Connection-level rejections where no
  response was produced at all (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`,
  `UND_ERR_SOCKET`, `UND_ERR_CLOSED`, or a bare `fetch failed`) are retried
  twice, after 500 ms and 2000 ms; a non-`ok` status or any other error is
  never retried.
- **`stop()`** -- aborts the internal `AbortController`, tearing down both
  the open GET stream and any in-flight POST. Local only: the server-side
  session stays alive.
- **`async close()`** -- best-effort HTTP `DELETE` of the session
  (`mcp-session-id`, 5 s bound) so the server releases the McpServer and any
  member registry entry, then `stop()`. Use for short-lived sessions.

Both fetches go through `undici`'s own `fetch` with a dedicated `Agent`
(`headersTimeout: 0`, `bodyTimeout: 0`, `keepAliveTimeout: 4000`) rather
than Node's built-in `fetch`. The disabled idle timeouts matter because MCP
streamable-HTTP responses arrive over SSE streams that legitimately stay
silent far longer than Node's ~300 s default body timeout (a long
`execute_prompt` dispatch prints nothing until the member CLI finishes).
`undici` is this package's only runtime dependency.

The persistent GET stream is normally silent -- JSON-RPC replies arrive on
each POST's own SSE response, not here -- so its loop treats a stream end
as an expected, recoverable event: it reopens the stream after an
exponential backoff (capped at 15 s) and only emits `'error'` + `'close'`
after 5 consecutive reconnect failures, or `'close'` alone on a deliberate
`stop()`.

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
  `'error'`, every currently-pending request is rejected (with a
  `TransportClosedError` or the emitted error, respectively) and the
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

- **`async listTools(opts = {})`** -- `request('tools/list', {}, opts)`;
  resolves `{ tools: [{ name, ... }] }`. On a MEMBER session
  (`?member=<uuid>`) this is exactly the member allowlist.

### `connectFleetMember(memberId, deps)` (`server-resolution.mjs`)

Resolves the local HTTP singleton, appends `?member=<memberId>` and connects,
returning `{ transport, mcpClient, mode: 'http', url, close }`. `deps.origin:
'engine'` also appends `origin=engine` (engine-origin session: its kb_/code_
calls are excluded from the member's `session_stats` counts; only memberCall and
`apra-fleet call` set it). `deps.kbMaintainer: true` (only with `origin:
'engine'`, else it throws) also appends `kb_maintainer=1`, the engine's
kb_maintainer grant: the session is additionally served `kb_promote` and
`kb_resolve_contradiction`, which no other member session sees. A member
session is never served `kb_setup` or `kb_export`. Always `await close()` when done: it DELETEs the server session (`transport.stop()` alone leaks it). Refuses a stdio
resolution (a member identity rides on the URL). An unregistered uuid rejects
with `err.status === 403` / `err.code === 'HTTP_403'` (raised by
`StreamableHttpTransport.start()` for any non-OK initialize response as
`HTTP_<status>`). The server accepts a `?member=` session only with its
install's member access secret: `connectFleetMember` reads it from
`<data dir>/member-access.key` (`readMemberAccessSecret(env)`, the same data dir
the server was resolved from) and sends it in the `X-Apra-Fleet-Member-Secret`
header (`MEMBER_SECRET_HEADER`) on every request. A missing or wrong secret
rejects with `err.status === 401` (`HTTP_401`).

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
- **`class TransportClosedError extends ClientError`** -- always has
  `code === 'TRANSPORT_CLOSED'`. The rejection raised for every in-flight
  request when the underlying transport closes: a deliberate `stop()`, or
  the persistent SSE stream dying past its reconnect budget. Typed
  deliberately so callers can classify it as a connectivity event
  (retryable at their discretion) rather than a request-level failure.

`errors.mjs` is not listed in `package.json#exports`; callers reach these
values as rejections rather than by importing the classes.

Convention: when `execute_prompt`/`execute_command` surface a new kind of
failure that downstream code must branch on, add a typed class here
(transport/request-level failures) or a `reason` code on the workflow
layer's `AgentDispatchError` (dispatch-level failures reported via
`structuredContent.isError`) -- never a bare `Error` whose message has to
be sniffed.

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

### `export function parseToolJson(result)`

Extracts the JSON payload from a raw MCP tool-call result. Every
`ApraFleet` wrapper returns the raw `callTool()` result --
`{ content: [{ type: 'text', text }, ...] }` -- not a JSON string, so
`JSON.parse(result)` on it throws. Tool results can also carry
display-only items ahead of the payload, so `content[0]` is not reliable
either. This helper returns the first content item that parses as JSON,
and throws `Error('No JSON payload in tool result')` when none does.

### `export function permissionDenialOf(result)`

Typed read of an `execute_prompt` permission denial. Accepts the raw
`executePrompt()` result or its `structuredContent`; returns the
`PermissionDenied` block -- `actions`, `denials` (`{ action, target? }`),
`suggestedGrants` (compose_permissions `grant` values, primary first), `hint`,
`signals` -- when `reason === "permission_denied"` and the block is
well-formed, else `null`. Only agy members report this today: agy's headless
mode refuses an ungranted tool call and exits 0. Heal by passing the reviewed
`suggestedGrants` to `composePermissions({ grant })` and re-dispatching; see
`docs/agy-provider.md` in the apra-fleet repo.

### `class ApraFleet`

Thin, typed wrapper over an MCP-capable client's `callTool(name, args,
opts)` method (normally an `McpClient` instance, but any object with a
compatible `callTool` works -- this is how the unit tests mock it).

- **`new ApraFleet(mcpClient)`** -- stores the client on `this.mcpClient`.

All methods below are `async` and return whatever `mcpClient.callTool()`
resolves to (i.e. the MCP tool's `result`), or reject with whatever it
rejects with (a `TimeoutError`/`AbortError`/`TransportClosedError` from
`McpClient`, or a plain `Error` wrapping the server's JSON-RPC error
message). None of the methods validate their arguments locally; validation
is the server's job, and an invalid call surfaces as a rejected promise
carrying the server's error message. The `result` is the raw MCP shape
(`{ content: [...] }`); use `parseToolJson()` above to get at the JSON
payload of tools that return one.

**Only `executePrompt()` and `executeCommand()` accept the client-side
`timeoutMs`/`signal` options.** They strip both from the options object
before sending the rest as the tool payload. Every other method forwards
its whole `options` object to the server verbatim, so a `timeoutMs` or
`signal` key passed to e.g. `listMembers()` would be sent as a tool
argument rather than consumed locally. Those calls use `McpClient`'s
`DEFAULT_REQUEST_TIMEOUT_MS`, except `shutdownServer()`, which sets its own
(see below).

#### `executePrompt(options: ExecutePromptOptions)`

Calls the `execute_prompt` MCP tool -- runs an AI prompt on a fleet member.
`timeoutMs` and `signal` are stripped from `options` before the remaining
fields are sent as the tool payload; `timeoutMs` is passed to
`mcpClient.callTool` as `opts.timeoutMs` (defaulting to
`deriveTimeoutMs(payload)` when not given explicitly), and `signal` as
`opts.signal`.

A claude member's dispatched session is started with
`--mcp-config <file>` naming one `apra-fleet` http server at
`http://localhost:<port>/mcp?member=<member uuid>` (this server's port for a
local member, the member install's default port for a remote one), so the
session is member-scoped whatever the folder or user config says; other MCP
servers stay available (`--strict-mcp-config` is not used). A remote member
gets it only while its recorded `fleetMcp` says its own server answers a
member session; otherwise, or when the file cannot be written, the session
runs with its own MCP config (the per-folder entry). The entry carries
`alwaysLoad: true` when the member's claude CLI is at or above the provider's
minimum version (probed per member, cached for 10 minutes), so the session's
`kb_*`/`code_*` tools are loaded from the first turn instead of being deferred
behind tool search. When the CLI is older or its version cannot be read, the
file is written without the key and the dispatch logs a WARN naming the cause.

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
| `fork` | `(boolean \| string)?` | Branch a NEW session seeded from an existing one instead of continuing it in place. `true` = fork from the member's stored last session. A session-id STRING = fork from exactly that session. Mutually exclusive with `resume` (any non-default value) and with `session_id`. |
| `substitutions` | `Record<string,string>?` | Token-name -> replacement-value map. |
| `timeout_s` | `number?` | Inactivity timeout in seconds -- always drives the stall detector's per-dispatch baseline threshold (default: 300). Per-provider, it ALSO arms the exec-level rolling timer against this dispatch's stdout/stderr channel for Codex and Copilot (no pollable transcript); Claude and AGY take that exec-channel ceiling from `max_total_s` instead; OpenCode keeps BOTH signals armed at once (exec-channel timer plus coarse log-directory-mtime polling, OR semantics), since its transcript signal is directory-level only. |
| `expected_context_tokens` | `number?` | Estimate of how many tokens this dispatch adds to the target session's context. When set (or `context_size` is set), the server compares it against the session's remaining context-window headroom BEFORE invoking the LLM: too little headroom rejects the call with `{reason: "insufficient_context_headroom", detail: {demand, headroom, window}}` and no spawn; a fit that lands inside the safety margin still proceeds but attaches a structured `contextWarning`. Wins over `context_size` when both are set. |
| `context_size` | `("S" \| "M" \| "L")?` | Size-bucket shorthand for `expected_context_tokens`, mapping to configured token estimates (fleet defaults, overridable via `config.json`'s `contextAdmission.sizeBucketTokens`). Ignored when `expected_context_tokens` is also set. Omitting both fields disables the headroom check entirely. |
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
| `repo_path` | `string?` | Absolute path to a repo checkout. Adds that repo's code-intelligence index health and its KB scope's bible drift. |

KB health (`kbHealth` in JSON) covers every project KB scope on the server plus the global KB, one entry per scope -- it never depends on the server's working directory.

#### `memberDetail(options)`

Calls `member_detail` -- detailed status for one member: connectivity,
session (`session.id`, the current session ID or `null`), work folder
(`folder`), shell (Windows members only), and LLM provider.

| Field | Type | Notes |
|---|---|---|
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `format` | `"compact" \| "json"?` | Output format (default: `"compact"`). |
| `refresh` | `boolean?` | Re-probe the member's own apra-fleet MCP now and record the new `fleetMcp` status. Without it the recorded status is returned and nothing is probed. |

`fleetMcp` (`{state, reason?, version?, checkedAt, detail?, unverified?, fleetInstalledAt?, installFailure?, beads?, port?, portSource?, replacedFullInstall?, manualInstall?}` or `null`) is the last recorded status of the member's own apra-fleet MCP server; `fleetInstalledAt` is the ISO 8601 time this fleet's own install last succeeded on the member (absent if it never did). `installFailure` (`{reason, detail?}`) is set when a requested upgrade failed before the member was touched and the older install stayed in use (also named in `detail`; `fleetMcpFix` then carries the upgrade fix even when `available`). `fleetMcpFix` (`string` or `null`) is a one-line operator fix, present when `fleetMcp` is `unavailable` or `unverified` and `null` when the member's KB/code tools are usable; the text output prints it as a `fleetMcp fix:` line. `beads` (`{state: "missing"|"broken", detail, fix}`) is present only when the bd CLI is not usable on a remote member (neither on its PATH nor in `<home>/.apra-fleet/bin`); it is independent of `state`, and the text output prints it as `bd=` and `bd fix:` lines. `port` is the remote member install's port from its member-install marker (`portSource` `"marker"`, or `"default"` when the install recorded none). `replacedFullInstall` (`{previousVersion, removed, backupPath}`) is set by the probe that replaced a full install with a member install (`fleet_install` `"replace-full"`): the replaced version, what was removed or moved, and the timestamped backup directory on the member. `manualInstall` (`string`) is set when a requested apra-fleet install/upgrade on the member did not happen (any install reason, e.g. `no-matching-release`): the OS-correct manual steps (anonymous release download URL, SHA-256 check against the release SHA256SUMS, member-mode install, then `update_member`).

Returns a plain multi-line text summary for `"compact"`, or the structured
`MemberDetailResult` object for `"json"` -- `server_version`, `name`, `icon`,
`id`, `type`, `host`, `username?`, `os`, `shell?`, `folder`,
`repo_remote_url?`, `vcsProvider?`, `gitAccess?`, `connectivity`, `offline?`,
`llmProvider`, `agyProjectId?` (agy members: their own agy project id, null until
provisioned), `llm_cli?`, `tokenUsage?`, `session?`, `resources?`,
`branch?`, `cloud?`. `MemberDetailResult`, like `RegisterMemberOptions` and
`UpdateMemberOptions`, is pinned against the server by
`test/client-server-typedef-parity.test.mjs`, which parses the real
`src/tools/*.ts` sources; the typedefs for the other tools are
hand-maintained.

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
| `friendly_name` | `string` | Required. Human-friendly name for this member (1-64 chars, alphanumeric, dots, dashes, underscores only). |
| `work_folder` | `string` | Required. Working directory on the target machine. For remote members, must be a fully-qualified/absolute path (e.g. `/home/bella/repo` or `C:\Users\bella\repo`) -- tilde and relative paths are rejected. A folder may hold at most one LLM member and one LLM-less (llm_provider none) member. |
| `member_type` | `"local" \| "remote"?` | Member type (default: `"remote"`). |
| `host` | `string?` | IP address or hostname of the remote machine. |
| `port` | `number?` | SSH port (default: 22). |
| `username` | `string?` | SSH username. |
| `auth_type` | `"password" \| "key"?` | SSH authentication method. |
| `password` | `string?` | SSH password. Omit for out-of-band entry via terminal prompt. Supports secret variable tokens. |
| `key_path` | `string?` | Path to SSH private key file. |
| `git_access` | `"read" \| "push" \| "admin" \| "issues" \| "full"?` | Git access level for this member. |
| `git_repos` | `string[]?` | Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"]). |
| `vcs_provider` | `"github" \| "bitbucket" \| "azure-devops" \| "none"?` | VCS provider this member pushes to / opens PRs against. Omit to auto-detect from the member's git `origin` remote (registration warns loudly if detection fails); `"none"` declares the member deliberately has no VCS provider. |
| `cloud_provider` | `"aws"?` | Cloud provider name (e.g. "aws"). When set, `cloud_instance_id` and `key_path` are required. |
| `cloud_instance_id` | `string?` | EC2 instance ID (e.g. "i-0abc123def456789a"). Required when `cloud_provider` is set. |
| `cloud_region` | `string?` | AWS region (default: "us-east-1"). |
| `cloud_profile` | `string?` | AWS CLI profile name for cloud instance access. |
| `cloud_idle_timeout_min` | `number?` | Minutes of inactivity before auto-stop (default: 30, min: 1, max: 1440). |
| `cloud_activity_command` | `string?` | Custom shell command for workload detection. Must output "busy" or "idle". Checked after GPU, before process check. |
| `llm_provider` | `"claude" \| "codex" \| "copilot" \| "agy" \| "opencode" \| "none"?` | LLM provider for this member (default: `"claude"`). Use `"none"` for a plain command executor with no LLM. |
| `model_cheap` | `string?` | Custom cheap model choice from configured curated list. |
| `model_standard` | `string?` | Custom standard model choice from configured curated list. |
| `model_premium` | `string?` | Custom premium model choice from configured curated list. |
| `model_tiers` | `{cheap?: string, standard?: string, premium?: string}?` | Per-member model tier map with free-form model IDs (e.g. "ollama/qwen3-coder:30b"). A single model fills all tiers. |
| `unattended` | `"false" \| "auto" \| "dangerous" \| false?` | Permission mode for unattended execution. Omit or pass `false` for interactive (default); `"auto"` for auto-approve safe operations; `"dangerous"` to skip all permission checks. |
| `category` | `string?` | Optional group label (max 64 chars). Used to group members in fleet status output. |
| `tags` | `string[]?` | Optional list of free-form labels (max 10 tags, each max 64 chars). Used for filtering and grouping. |
| `code_intel_provider` | `"codebase-memory" \| "gitnexus" \| "none"?` | Code-intelligence provider for this member. Omit for fleet-wide default. |
| `unreservable` | `boolean?` | Mark this member as never exclusively reservable, so it can be shared by more than one sprint (e.g. fleet-sprint's shared "backlog" role). Default: `false`. |
| `fleet_install` | `"auto" \| "skip" \| "replace-full"?` | Install/update apra-fleet on the member, write its per-folder apra-fleet MCP entry and verify its own MCP (default `"auto"`; local members only get the MEMBER-session probe). `"auto"` never touches a full install (one without the member-install marker). `"replace-full"`: `"auto"` plus an explicit opt-in to replace such a full install with a member install (back up data and fleet.key to a timestamped dir, uninstall, member install, self-register); refused with no destructive command when the marker probe fails. `"skip"` only reports the probe result. Registration succeeds either way; the result reports `fleetMcp` (with `replacedFullInstall` when a full install was replaced), plus a `WARNING` (consequence, exact reason, OS-correct manual install steps; also `fleetMcp.manualInstall`) when a requested install/upgrade did not happen. |
| `shell` | `"gitbash" \| "pwsh7" \| "powershell5"?` | Override the probed Windows shell for this member. Windows members only -- ignored for non-Windows members. |


#### `updateMember(options: UpdateMemberOptions)`

Calls `update_member` -- changes a member's settings. Every field is optional
and means "new value for this field". Unknown input keys are rejected with an
error naming the key (the member is not updated) -- they are no longer silently dropped. Identifies the target member via
`member_id` or `member_name`.

| Field | Type | Notes |
|---|---|---|
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `fleet_install` | `"auto" \| "skip" \| "replace-full"?` | `"auto"`: for a remote member, probe it and install/upgrade its own apra-fleet when missing or older than the orchestrator (build-aware: same-core different builds upgrade, newer cores never downgrade), self-register, write its per-folder apra-fleet MCP entry and verify (for a claude member the entry is only the fallback of the per-session `--mcp-config`, so neither its write nor its check gates `fleetMcp`), even when nothing else changed; the result includes the `fleetMcp` line (then `member_detail` with `refresh: true`); a full install (no member-install marker) is never touched. `"replace-full"`: everything `"auto"` does, plus an explicit opt-in to replace such a full install with a member install (back up data and fleet.key to a timestamped dir, uninstall with the installed binary, stop the linux fleet-supervisor unit, move data aside, member install, self-register); refused with no destructive command when the marker probe fails; `fleetMcp.replacedFullInstall` reports it. `"skip"`: no install. Omitted: install only on a provider change. A requested install/upgrade that cannot happen (no release for the orchestrator build, checksum or download failure, unsupported platform, full install present, ...) never fails the update: the result adds a `WARNING` naming the consequence (no KB/code tools from the member own apra-fleet, or an older version kept), the exact reason and OS-correct manual install steps (also `fleetMcp.manualInstall`). |
| `friendly_name` | `string?` | New friendly name. |
| `work_folder` | `string?` | New working directory. For non-local (remote/relay) members, must be a fully-qualified/absolute path (e.g. `/home/bella/repo` or `C:\Users\bella\repo`) -- tilde and relative paths are rejected. A folder may hold at most one LLM member and one LLM-less (llm_provider none) member. A real change removes what `compose_permissions` wrote in the OLD folder (per-folder `apra-fleet` MCP entry, permission keys, `.git/info/exclude` lines) and re-runs `compose_permissions`, so the new folder gets its `?member=<uuid>` entry at once. |
| `host` | `string?` | New host (remote members only). |
| `port` | `number?` | New SSH port (remote members only). |
| `username` | `string?` | New SSH username (remote members only). |
| `auth_type` | `"password" \| "key"?` | New SSH authentication method (remote members only). |
| `password` | `string?` | New SSH password. Omit for out-of-band entry via terminal prompt. Supports secret variable tokens. |
| `rotate_password` | `boolean?` | Trigger secure out-of-band password re-entry for a member already using password auth. Ignored if `auth_type` is not password. |
| `key_path` | `string?` | New SSH private key path. Used for both regular SSH connections and cloud instance lifecycle. |
| `git_access` | `"read" \| "push" \| "admin" \| "issues" \| "full"?` | Git access level for this member. |
| `git_repos` | `string[]?` | Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"]). |
| `icon` | `string?` | Override the auto-assigned emoji icon. Use named aliases (blue-circle, green-square, red-circle, etc.) or pass raw emoji. |
| `cloud_region` | `string?` | New AWS region for the cloud instance. |
| `cloud_profile` | `string?` | New AWS CLI profile name. |
| `cloud_idle_timeout_min` | `number?` | New minutes of inactivity before auto-stop. |
| `cloud_activity_command` | `string?` | New custom shell command for workload detection. Must output "busy" or "idle". Pass empty string to clear. |
| `llm_provider` | `"claude" \| "codex" \| "copilot" \| "agy" \| "opencode"?` | Change the LLM provider for this member. A real change removes what `compose_permissions` wrote for the OLD provider (its permission file, its per-folder `apra-fleet` MCP entry, its `.git/info/exclude` lines; other MCP servers such as `deepwiki` are kept) and re-runs `compose_permissions` for the new one. Passing the current provider does nothing extra. |
| `model_cheap` | `string?` | Change custom cheap model. |
| `model_standard` | `string?` | Change custom standard model. |
| `model_premium` | `string?` | Change custom premium model. |
| `model_tiers` | `{cheap?: string, standard?: string, premium?: string}?` | Per-member model tier map with free-form model IDs (e.g. "ollama/qwen3-coder:30b"). A single model fills all tiers. |
| `unattended` | `"false" \| "auto" \| "dangerous" \| false?` | Permission mode for unattended execution. Pass `false` to reset to interactive (default); `"auto"` for auto-approve safe operations; `"dangerous"` to skip all permission checks. |
| `category` | `string?` | Group label for this member. Pass empty string to clear. |
| `tags` | `string[]?` | Free-form labels for this member (max 10 tags, each max 64 chars). Empty array clears all tags; non-empty array replaces existing tags. |
| `code_intel_provider` | `"codebase-memory" \| "gitnexus" \| "none"?` | Change the code-intelligence provider for this member. |
| `unreservable` | `boolean?` | Mark/unmark this member as shared or never exclusively reservable. |
| `shell` | `"gitbash" \| "pwsh7" \| "powershell5"?` | Override the probed Windows shell for this member. Windows members only -- ignored for non-Windows members. |
| `vcs_provider` | `"github" \| "bitbucket" \| "azure-devops" \| "none"?` | Directly set (override) this member's VCS provider. An explicit operator value, never auto-detected -- use to correct a wrong auto-detect from `register_member`, or to set the provider without provisioning credentials. `"none"` clears it. |

#### `removeMember(options: RemoveMemberOptions)`

Calls `remove_member` -- removes a member from the fleet. Before the member is deleted (and before the fleet's own SSH key is removed from the member), it removes what `compose_permissions` wrote for the member (per-folder `apra-fleet` MCP entry, permission keys, `.git/info/exclude` lines); anything it could not remove, or could not reach, is reported as a warning in the result. The registration on the member's own apra-fleet install is removed only when that install carries the member-install marker; an unmarked install, or a failed marker probe, is skipped and the warning says so and why. A local member's per-session MCP config file (`session-mcp/<uuid>.json` in the server data dir) is deleted too.

| Field | Type | Notes |
|---|---|---|
| `member_id` | `string?` | UUID of the member. |
| `member_name` | `string?` | Friendly name of the member. |
| `force` | `boolean?` | Remove even if the member is currently busy. |

#### `getMemberModelPricing(options)`

Calls `get_member_model_pricing` -- returns a member's cheap/standard/premium
tier resolved to a concrete model plus its real per-1M-token price, so a
client-side cost tracker can price a dispatch. Options: `member_id?`,
`member_name?`.

#### `provisionLlmAuth(options: ProvisionLlmAuthOptions)`

Calls `provision_llm_auth` -- puts LLM auth on a member. Options:
`member_id?`, `member_name?`, and `api_key?`. Omitting `api_key` copies the
local OAuth session to the member instead. `api_key` supports a
`{{secret.NAME}}` token, resolved from the credential store server-side.

#### `provisionVcsAuth(options: ProvisionVcsAuthOptions)`

Calls `provision_vcs_auth` -- configures git-host auth (GitHub App token or
PAT, Bitbucket API token, or Azure DevOps PAT) on a member. `provider`
(`"github" | "bitbucket" | "azure-devops"`) is required; the rest are
optional and provider-specific: `member_id`, `member_name`, `label`,
`scope_url`, `github_mode` (`"github-app" | "pat"`), `token`, `git_access`,
`repos`, `email`, `api_token`, `workspace`, `org_url`, `pat`, and
`pat_expires_at`. Every secret-bearing field supports a `{{secret.NAME}}`
token. `pat_expires_at` must be parseable by `Date.parse` -- the server
rejects an unparseable value rather than storing it, because a `NaN` expiry
silences the near-expiry warning and makes the credential-cleanup timer
fall back to its default.

#### kb_* scope keys

Every `kb_*` call acts on the calling session's own KB (a member session's
registered work folder; a FULL session's fleet server working folder). The
pre-redesign scope keys `repo_path`, `repo` and `repo_remote_url` are removed:
the server refuses a call carrying any of them with `E-SCOPE-KEY-REMOVED`,
and `kbExport` / `kbBibleCommit` refuse them client-side with the same code
before sending (`assertNoRemovedKbScopeKeys`, `KB_REMOVED_SCOPE_KEYS` are
exported). For direct `callTool` users: `kb_list` accepts `confidence` as a
list or as one tier string, and `kb_context` defaults to
`["CONFIRMED","INFERRED"]`.

Bible-related refusals are part of the closed error vocabulary in
`memory-contract/v1/taxonomy.json`: `E-BIBLE-MALFORMED` (a bible file that is
not valid JSON or not a bible shape; raised by `kb_import` and by a member
session's `kb_query` / `kb_session_prime` / `kb_stats`), `E-MEMBER-VIEW-REMOTE`
(a remote member's checkout bible is unreachable; the same three read tools)
and `E-BIBLE-BASIS-NOT-GIT` (`kb_export` / `kb_bible_commit` in a folder that is
not a git work tree).

#### `kbExport(options?: KbExportOptions)`

Calls `kb_export` -- exports the calling session's CONFIRMED KB entries to the
canonical bible file and auto-commits it locally (never pushed). Options:
`scope?` (`"project" | "global"`), `baseBranch?`, `baseCommit?`. When given,
`baseBranch` (the target base branch the entries merge into) and `baseCommit`
are written to the bible's `provenance.branch` / `provenance.commit`; when
omitted they default to the export folder's HEAD branch and commit. Result
JSON (via `parseToolJson`): `{exported, path, scope, committed}`.

#### `kbBibleCommit(options: KbBibleCommitOptions)`

Calls `kb_bible_commit` -- merges exactly `ids` into the bible at entry level
(only the given ids are added or replaced; every existing entry is kept unless
the KB holds it as superseded or invalidated), writes `baseBranch` /
`baseCommit` into provenance, and makes a local commit scoped to the bible
path. It never pushes. Every bible entry the KB holds as superseded or
invalidated is removed at each call (also with an empty `ids`) and listed in
`removed` as `{id, reason}` (reason `superseded` or `invalidated`) and in the
commit message; an entry unknown to the KB, or CONFIRMED and current, is never
removed, nor is a merely stale one. `kbExport` never removes anything. Ids that are not live CONFIRMED
entries are skipped and listed in `skipped` with reason
`not_confirmed_or_unknown`; a CONFIRMED id that fails the same basis rule
`kb_export` applies (a cited file changed or absent at the repo's HEAD commit --
uncommitted edits never change the verdict -- or no basis) is skipped
with reason `basis_mismatch` and any existing bible entry for it is kept; a
CONFIRMED id citing no source file is skipped with its own reason
`no_source_files` (its existing bible entry is kept too); no mergeable ids or an unchanged
entry set (nothing merged, nothing removed) makes no commit. Re-running with the same ids after resetting to a
newer HEAD re-merges, so a rejected push can be retried without a manual
merge. Result JSON: `{path, merged, skipped, removed, entry_count, committed}`.

#### `composePermissions(options: ComposePermissionsOptions)`

Calls `compose_permissions` -- composes and delivers a scoped permission
profile to a member. On the server host, complete profile directories (with
both `base-dev.json` and `base-reviewer.json`) are checked by most recent
installation date, then by the remaining supported providers in deterministic
order. Options: `member_id?`, `member_name?`, `role?`
(`"doer" | "reviewer"`), `tags?`, `project_folder?`, `grant?`,
`grant_reason?`, `dry_run?`. `dry_run: true` returns the composed allow list
(role/tags + detected stacks, + the ledger when `project_folder` is given) as
JSON text `{"dry_run":true,"mode","stacks","allow"}` and writes nothing.
Provide at least one of `role` or `tags`; `tags` containing
`"doer"`/`"reviewer"` sets the primary mode and wins over `role`. Each
`grant` entry is checked against the `NEVER_AUTO_GRANT` denylist, which is
wildcard-matched (not exact-matched) against a normalized form of the
request: `sudo`/`su`/`doas`, `bash -c`/`sh -c`/`eval`, `env`/`printenv`,
`nc`/`nmap`, `chmod 777`, any catch-all such as `Bash(*)`, and any payload
containing a shell-chaining metacharacter (`|`, `;`, `&&`, backtick, `$()`)
-- rejected outright, for every caller.

Every compose (proactive or `grant`) also wires the member's per-folder
`apra-fleet` MCP entry, whose URL ends in `?member=<member uuid>`: claude
writes it to Claude's local scope (`projects[<workFolder>].mcpServers` in the
member's `~/.claude.json`) for a REMOTE member only (a local claude member gets
the member server per dispatch session through `--mcp-config`, see
`executePrompt`, so no folder entry is written for it; a folder entry an
older compose wrote for that member is removed), opencode to `<workFolder>/opencode.json`, and agy
gets none (it has no per-project MCP config). claude and agy also receive
client-side deny rules for exactly the registered fleet tools outside the
member allowlist; opencode gets none. The retired `apra-fleet-member`
url+bearer entry is pruned wherever compose finds it, `deepwiki` is never
touched, a tracked `.mcp.json` is never written, and work-folder files compose
writes are listed in the clone's `.git/info/exclude` so it stays clean. A
failure to write the entry is returned as a `[FAIL]` result (the permission
files that did land are still recorded in the `project_folder` ledger; the
ledger never records the MCP entry). A member config compose must not edit
-- tracked by git, not strict JSON, or unreadable -- is left untouched and the
otherwise-successful result carries a `Member MCP config NOT edited: <file> is
<why> (fleetMcp unavailable: <reason>)` line; a later successful compose
clears such a recorded fleetMcp status (`fleetMcp: cleared the stale
unavailable status (<reason>)` line). Existing `deny` rules are merged by
union -- a user-authored deny rule is never dropped; only fleet-derived
`apra-fleet` deny rules compose no longer derives are retired.

#### `setupSshKey(options: SetupSshKeyOptions)`

Calls `setup_ssh_key` -- converts a remote member from password to SSH key
authentication. Options: `member_id?`, `member_name?`.

#### `sendEmail(options: SendEmailOptions)`

Calls `send_email`. Provider config is passed inline; secrets resolve
server-side from the credential store (`sendgrid_api_key` /
`smtp_password`) and never travel through the caller. Required: `from`,
`to` (address or array), `subject`, `body`. Optional: `provider`
(`"sendgrid" | "smtp"`, default `"sendgrid"`), `host`, `port` (default 587,
or 465 when `secure` is true), `user`, `secure` (implicit TLS; when false,
STARTTLS is required and plaintext AUTH is refused), `html`, `cc`, `bcc`,
and `attachments` (`{ filename, content, contentType? }[]`, base64 content).
`host`/`user` are required for the `smtp` provider.

#### `credentialStoreSet(options)` / `credentialStoreList()` / `credentialStoreDelete(options)` / `credentialStoreUpdate(options)`

The fleet credential store. `credentialStoreSet({ name, prompt, persist?,
network_policy?, members?, ttl_seconds? })` collects a secret from the user
out-of-band and stores it -- the value never passes through the caller.
`credentialStoreList()` takes no arguments and returns names and metadata
only, never values (a JSON array of `{ name, scope, ... }` entries; extract
it with `parseToolJson()`). `credentialStoreDelete({ name })` removes one.
`credentialStoreUpdate({ name, members?, ttl_seconds?, network_policy? })`
changes metadata without re-entering the secret.

#### `codeReindex()` / `codeStatus()`

Calls `code_reindex` / `code_status` -- index maintenance for the calling
session's own repo (a member session's registered work folder, otherwise the
fleet server's folder; neither takes arguments). `codeReindex()` starts a
detached `gitnexus analyze`, captures its output to
`<data>/code-index/<slug>/analyze.log`, and returns after the first tick; its
`outcome` is `started`, `up-to-date`, `starting`, `already-running` or
`not-started` (with a typed `reason`: `npx-not-found`, `gitnexus-not-found`,
`analyze-failed`, `spawn-failed`, `remote-member`, `gitnexus-too-old` (the installed gitnexus rejects `--index-only`; `detail` names the upgrade fix), `provider-not-supported`); every result also carries `injectedBlockFiles` (agent docs still holding a gitnexus block from an earlier plain analyze run; detection only). Both tools are
gated on the member's code-intel provider: `none` fails with
`E-CODE-INTEL-DISABLED` (nothing is spawned); any non-gitnexus provider (e.g.
`codebase-memory`) returns `{ outcome: 'not-started', reason:
'provider-not-supported', provider, indexedCommit: null, detail }` from both
tools instead of gitnexus readiness. `codeStatus()` returns the
last run (`analyze.phase`, `analyze.result` = `indexed` | `up-to-date` |
`incomplete` | `failed`, `analyze.lastLine`), live `readiness`
(`ready` | `building` | `interrupted` | `inconsistent` | `missing`;
`building` also covers an analyze rewriting an existing index, which is never
served meanwhile; `interrupted` = the index is marked incomplete and no analyze
is running; `inconsistent` = the gitnexus registry or the fleet record of its
last build names a different commit than meta.json), `inconsistency` (that
reason, or `null`), `indexedCommit`, `logPath`
(the last run's `analyze.log`, or `null` when no analyze has written one yet)
and `autoReindexPaused` (`null`, or `{ result, lastLine, logPath, finished }`
of the automatic run that failed: automatic rebuilds of that folder stay
paused until `codeReindex()` or a server restart), `injectedBlockFiles` / `injectedBlockWarning` (agent docs still holding a previously injected gitnexus block and the one-line WARN with the fix; `[]` / `null` when clean) and, on a failed run, `analyze.failureCause` (`gitnexus-too-old`). A code_* call on a local
folder whose index is `missing`, `interrupted` or `inconsistent` requests a
background build automatically (unless `autoReindex.enabled` is false in the
code-intelligence config.json) and fails with `E-CODE-INDEX-NOT-READY` saying
so; an answer during which the index changed is discarded with the same error.
A `code_impact` / `code_context` answer whose resolved symbol is not the one
requested carries `resolution_mismatch` (`{ requested, resolved: { name, id,
filePath } }`) and `confidence: 'LOW'`, and an impact `risk` is moved to
`unverified_risk` with `risk: 'UNKNOWN'`. Extract both with `parseToolJson()`.

#### `doltPushMutex(options)`

Calls `dolt_push_mutex` -- the fleet-server-hosted global dolt push mutex
that serializes cross-sprint `bd dolt push` for sprints launched without a
supervisor to coordinate through. `action` is one of `'acquire'`, `'poll'`,
`'release'`, `'renew'`, `'cancel'`, `'status'`; the rest are optional:
`sprint_id`, `ticket`, `token`, `pid`, `wait_ms`.

`acquire` is ticketed, because an MCP call cannot long-poll: it returns
`{ granted, ticket, token? }` after a bounded wait, and the caller re-`poll`s
the SAME ticket until granted. Polling never dequeues the waiter, so FIFO
order is preserved. Pass the caller's real `pid` so a crashed holder is
reclaimed by the dead-pid probe.

#### `childIdAllocator(options)`

Calls `child_id_allocator` -- the fleet-server-hosted global child-bead-id
allocator. Mints globally-distinct child ids under a shared parent for
sprints launched without a supervisor, so two sprints creating children
under the same parent never derive the same id. `action` is one of
`'allocate'`, `'confirm'`, `'release'`, `'status'`; the rest are optional:
`parent_id`, `token`, `sprint_id`, `pid`, `floor`.

#### `shutdownServer(opts = {})`

Calls `shutdown_server` with an empty payload -- gracefully shuts down the
fleet server this client is connected to. The server self-terminates
(deletes the singleton pointer, closes the HTTP transport and all SSH
connections); it does not touch the OS service-manager layer at all, so
this works even when service registration (systemd/schtasks) never
succeeded.

The server closing its own transport as part of shutting down can race this
very request's response, so callers should treat ANY outcome (resolve,
reject, or timeout) as inconclusive on its own and verify with a direct
status check instead. `opts.timeoutMs` (default `5000`) keeps a lost
response from hanging the caller for the full
`DEFAULT_REQUEST_TIMEOUT_MS`. This is the only method that sets a
client-side timeout itself.

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
3. **Start the shared HTTP server** -- when the singleton is verifiably
   gone (no `server.json`, dead pid, or recorded port refused; never when
   merely unresponsive), run the same `apra-fleet start` a user would
   (`resolveFleetStartCommand()`: the running apra-fleet binary itself; else
   `<dirname>/index.js`, dev `dist/index.js` or repo `dist/index.js` via
   `node`; else `~/.apra-fleet/bin/apra-fleet[.exe]`), wait for `/health`
   (default 45s, `APRA_FLEET_AUTOSTART_TIMEOUT_MS`) and attach over HTTP
   (`mode: 'http'`, `started: true`). The started server is detached and
   outlives the client. Racing clients share
   `<data dir>/client-autostart.lock` (one runs start, others wait for
   `/health`). Loop guard: `<data dir>/client-autostart.json` allows 3
   auto-starts per 10 minutes, then `FleetAutoStartError` `AUTOSTART_LIMIT`
   naming the newest server log. Version match: only a candidate whose
   version equals the apra-fleet version this client ships with
   (`clientServerVersion()`: nearest `version.json`, else
   `workflows/.installed.json` of the install) is started -- the matching
   build is preferred, and with no match the client refuses with
   `AUTOSTART_VERSION_SKEW` naming both versions and `apra-fleet install`
   (`AUTOSTART_VERSION_UNKNOWN` when its own version is unknown); an older
   server can lack guards the client relies on. Inside the test sandbox
   (`APRA_TEST_SANDBOX_ROOT`) an uninjected lookup fails with
   `AUTOSTART_TEST_UNINJECTED`. A server stopped on purpose (`apra-fleet stop`
   wrote `<data dir>/stopped-by-user.json`, see `readStoppedByUser()`) is never
   started: `SERVER_STOPPED_BY_USER` with "apra-fleet was stopped by the user
   at <time> ...; run 'apra-fleet start'" (resolution and the reconnecting
   transport alike; a running server is still attached). The marker is
   re-checked under the start lock, and the spawned `apra-fleet start` runs
   with `APRA_FLEET_AUTOSTART=1` so it refuses (instead of clearing the
   marker) if a stop raced it. With a registered service, `start` runs the
   service's binary, so after /health the server's reported version is
   compared again (`AUTOSTART_VERSION_SKEW` on a mismatch; that server stays up, so the
   error says to `apra-fleet stop` it before `apra-fleet install`). Other codes: `AUTOSTART_TIMEOUT`,
   `AUTOSTART_NO_BINARY`, `SERVER_UNRESPONSIVE`. An unresponsive server gets
   the actionable error and no start. This replaces the old private stdio
   self-spawn fallback; stdio is now only the explicit
   `APRA_FLEET_TRANSPORT=stdio` / `APRA_FLEET_SERVER_CMD`/`_BIN` path
   (`resolveFleetServerCommand()`'s four tiers: CMD string, BIN via `PATH`,
   bundled sibling `index.js`, dev `../../../dist/index.js`).

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

Resolves + connects in one call. Builds a `ReconnectingHttpTransport` (http
mode) or `StdioTransport` per `resolveFleetServerConnection`'s result, starts it,
wraps it in `McpClient`, performs the `initialize`/`notifications/initialized`
handshake for stdio connections (the HTTP transport already does its own
`initialize` POST inside `start()`), and returns
`{ transport, mcpClient, fleetApi, mode }` where `fleetApi` is a
`new ApraFleet(mcpClient)`.

`deps.options`, if given, is forwarded to the transport constructor (e.g.
HTTP headers or child-process spawn options).

`resolveFleetServerConnection` also accepts an injectable
`deps.autoStartFleetServer`.

#### Auto-start and reconnect exports

- `autoStartFleetServer`, `resolveFleetStartCommand`, `lastServerLog`,
  `FleetAutoStartError`, `AUTOSTART_MAX_STARTS`, `AUTOSTART_WINDOW_MS`,
  `AUTOSTART_TIMEOUT_MS` -- step 3 above.
- `createFleetHttpTransport(connection, deps)` -- builds the
  `ReconnectingHttpTransport` for an http connection (used by fleet-sprint's
  `bin/cli.mjs`).
- `ReconnectingHttpTransport` -- on a refused connection (ECONNREFUSED before
  send) or HTTP 404 unknown session (rejected by the router before any tool
  runs) it re-probes (running -> new session; gone -> auto-start unless
  `APRA_FLEET_TRANSPORT=http`; unresponsive -> error) and retries that request
  once. A request that may have reached the server (e.g. an in-flight
  `execute_prompt`/`execute_command` whose response stream died) is rejected
  and never re-sent; the next request reconnects.
- `isNeverDeliveredError(err)` -- the predicate behind that retry rule.
  `StreamableHttpTransport` send errors now carry `.status`.

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

**Access secret.** For `'http'`, `config.options` is passed through
`withFleetAccessSecret(options, config.env || process.env)`, so every request
carries the local install's `X-Apra-Fleet-Member-Secret` header (read from
`<data dir>/member-access.key`; `config.env.APRA_FLEET_DATA_DIR` selects the
data dir). An explicit header in `config.options.headers` wins. Without it the
server refuses the session with HTTP 401.

**Workflow classes.** `FleetWorkflow` and `WorkflowEngine` live in
`@apralabs/apra-fleet-workflow`, which depends on this package. The factory
imports them lazily (dynamic `import()` before `transport.start()`), so
importing `./factory` never needs that package; calling
`createWorkflowEngine()` does. Covered by
`test/factory-access-secret.test.mjs`.
