# apra-fleet-client -- Getting Started

This package talks to an already-running `apra-fleet` MCP server -- either
one you spawn yourself (stdio transport) or one already listening on a
port (HTTP+SSE transport, the fleet server's default at
`http://localhost:7523/mcp`). It does not start or manage the server's
lifecycle for you.

## Install

Inside this monorepo, add it as a workspace dependency:

```json
{
  "dependencies": {
    "@apralabs/apra-fleet-client": "*"
  }
}
```

## Connecting over stdio (spawns the server as a child process)

```js
import { StdioTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';

const transport = new StdioTransport('apra-fleet', ['--stdio']);
transport.start();

const mcpClient = new McpClient(transport);

// Standard MCP handshake -- required before issuing tool calls.
await mcpClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'my-tool', version: '1.0.0' }
});
await transport.send({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {}
});

const fleet = new ApraFleet(mcpClient);

const status = await fleet.fleetStatus({ format: 'json' });
console.log(status);

transport.stop();
```

## Connecting over HTTP+SSE (attaches to a running server)

```js
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';

const transport = new StreamableHttpTransport('http://localhost:7523/mcp');

const ready = new Promise((resolve, reject) => {
  transport.once('ready', resolve);
  transport.once('error', reject);
});
transport.start();
await ready;

const mcpClient = new McpClient(transport);
const fleet = new ApraFleet(mcpClient);

const members = await fleet.listMembers({ format: 'json' });
console.log(members);

transport.stop();
```

The HTTP transport performs its own `initialize` handshake internally
during `start()`, so (unlike the stdio example) you do not send
`initialize`/`notifications/initialized` yourself.

## Running a prompt on a member

```js
const result = await fleet.executePrompt({
  member_name: 'doer',
  prompt: 'Summarize the open issues in this repo.',
  model: 'standard',
  timeout_s: 300,       // server-side inactivity timeout
  max_total_s: 600      // server-side hard ceiling
});
```

`timeout_s`/`max_total_s` only bound the server side of the call.
`executePrompt` also derives a client-side `McpClient` timeout from those
same hints (via `deriveTimeoutMs`) plus a 30-second grace margin, so the
client won't give up before the server's own deadline has a chance to
fire. To override that client-side timeout independently, pass
`timeoutMs` explicitly:

```js
await fleet.executePrompt({
  member_name: 'doer',
  prompt: 'Quick status check',
  timeoutMs: 5_000   // client gives up after 5s even if max_total_s is longer
});
```

## Running a shell command on a member

```js
const result = await fleet.executeCommand({
  member_name: 'build-server',
  command: 'npm test',
  timeout_s: 120
});
```

## Cancelling an in-flight call

Every `ApraFleet` method accepts an `AbortSignal`. Aborting stops the
*local* wait -- it rejects the pending promise and frees client-side
bookkeeping -- but it does not cancel a job the server has already
accepted and started running.

```js
const controller = new AbortController();
const promise = fleet.executeCommand({
  member_name: 'build-server',
  command: 'sleep 600',
  signal: controller.signal
});

setTimeout(() => controller.abort(), 5_000);

try {
  await promise;
} catch (err) {
  if (err.code === 'ABORTED') {
    console.log('Gave up waiting locally; the remote command may still be running.');
  } else if (err.code === 'TIMEOUT') {
    console.log('No response within the timeout window.');
  } else {
    throw err;
  }
}
```

## Registering, updating, and removing members

```js
await fleet.registerMember({
  friendly_name: 'build-server',
  work_folder: '/home/akhil/projects/myapp',
  member_type: 'remote',
  host: '192.168.1.10',
  username: 'akhil',
  auth_type: 'key',
  key_path: '/home/akhil/.ssh/id_ed25519'
});

await fleet.updateMember({
  member_name: 'build-server',
  tags: ['ci', 'linux']
});

await fleet.removeMember({ member_name: 'build-server', force: true });
```

## Sending and receiving files

```js
await fleet.sendFiles({
  member_name: 'build-server',
  local_paths: ['./dist/app.tar.gz'],
  dest_subdir: 'releases'
});

await fleet.receiveFiles({
  member_name: 'build-server',
  remote_paths: ['releases/build.log'],
  local_dest_dir: './logs'
});
```

## Error handling

Every `ApraFleet` method rejects rather than throwing synchronously.
Rejections carry a `.code` you can branch on:

- `'TIMEOUT'` -- no response arrived within the client-side timeout window.
- `'ABORTED'` -- the caller's `AbortSignal` fired before a response arrived.
- Anything else -- a plain `Error` whose message is the server's own
  JSON-RPC error message (e.g. an unknown member name, a malformed
  argument, or a failure that happened while the server ran the tool).

```js
try {
  await fleet.executePrompt({ member_name: 'doer', prompt: 'hi' });
} catch (err) {
  switch (err.code) {
    case 'TIMEOUT':
    case 'ABORTED':
      // client-side give-up; the remote job may still be running
      break;
    default:
      // server-reported error (e.g. member not found)
      console.error(err.message);
  }
}
```

## What this package will not do for you

- It does not start, stop, or health-check the `apra-fleet` server
  process itself (beyond spawning it as a child, for the stdio transport).
- It does not retry failed or timed-out requests.
- It does not provide idempotency keys, so retrying a call yourself after a
  client-side timeout can duplicate server-side work if the original
  request was in fact received and is still running.
- It does not implement multi-step orchestration (sprints, phases,
  budgets, doer/reviewer loops). That logic lives in
  `@apralabs/apra-fleet-workflow`, which is built on top of this package.
