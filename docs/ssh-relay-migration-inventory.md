<!-- llm-context: SSH-to-relay migration inventory (apra-fleet-us9.7). Lists
     exactly what the SSH stack is today, what replaces it once hub-spoke
     relay is production-proven, and the explicit gate before any of this
     is actually deleted. Not a design doc -- see
     docs/hub-spoke-wire-protocol.md and src/services/relay-executor.ts /
     src/services/relay-request.ts for the relay path itself. -->
<!-- keywords: SSH deprecation, RemoteStrategy, relay migration, execute_command -->

# SSH-to-Relay Migration Inventory

Status: inventory only, 2026-07-05. Nothing listed here has been deleted.
Answers apra-fleet-us9.7's second half ("SSH deprecation inventory"); the
first half (proving the hub-relayed execution path) is covered by
`src/services/relay-executor.ts` (apra-fleet-cgg, the FULFILLING side --
a spoke running a relayed `execute_command.request` via LocalStrategy) and
`src/services/relay-request.ts` (this issue's own contribution: the
ORIGINATING side -- submitting a request to a member on a different
machine and awaiting its correlated result).

## The gate: what "proven out" actually requires

apra-fleet-us9.7 says "once proven out, deprecate the SSH stack." That
gate is **not met by this repo alone** and should not be treated as
optional ceremony:

1. **A real `getStrategy()` dispatch decision for relay-addressed
   agents.** `Agent.agentType` (src/types.ts) is `'local' | 'remote'`
   today. Nothing in this session introduces a third value or a
   `RelayStrategy` class -- that is a registry/CLI design question with a
   wide blast radius (agent creation flows, registry validation, the
   dashboard's agent list) that deserves its own scoped pass, not a
   silent addition here.
2. **The local CLI needs an actual spoke-mode entrypoint** that wires
   `src/services/hub-client.ts` (connect/reconnect/heartbeat),
   `src/services/relay-executor.ts` (fulfill requests for hosted members),
   and `src/services/relay-request.ts` (originate requests for
   relay-addressed members) into one running process via
   `composeEnvelopeHandler()`. This does not exist yet -- apra-fleet-us9.6
   built the pieces; nothing runs them together as `apra-fleet.exe`'s main
   loop.
3. **A real member_id <-> local Agent mapping.** relay-executor.ts's
   `getAgentForMember` is caller-supplied precisely because this mapping
   (hub member records vs. this machine's `registry.json` entries) isn't
   built yet (noted as an open gap when apra-fleet-us9.6 closed).
4. **Actual production spoke traffic**, or at minimum a live two-machine
   integration test, proving the relay path handles what the SSH path
   handles today: all 6 providers, all 3 OSes, long-running tasks,
   output-spill-to-file for oversized output, and credential/network-egress
   policy enforcement (execute-command.ts's `resolveSecureTokens`/
   `redactOutput`/network-tool regex, none of which relay-executor.ts
   currently applies -- it is a thinner wrapper than the full
   execute-command.ts tool, matching only its LocalStrategy.execCommand
   call, not its credential/egress/task-wrapper layers).

Until all four are true, deleting the SSH stack would remove the ONLY
working remote-execution path apra-fleet.exe has.

## Inventory: files to remove once the gate above is met

| File | Role today | Relay-era replacement |
|---|---|---|
| `src/services/ssh.ts` | `execCommand`/`testConnection`/`closeConnection` over an SSH2 connection | `relay-executor.ts` + `relay-request.ts` round trip, no direct network hop from the orchestrator |
| `src/services/sftp.ts` | `uploadFiles`/`downloadFiles` over SFTP | apra-fleet-us9.12 (hub-brokered file transfer, not yet built) |
| `src/services/known-hosts.ts` | SSH host-key trust-on-first-use tracking | not needed -- relay traffic never makes a direct TCP connection to the target machine |
| `src/services/strategy.ts`'s `RemoteStrategy` class | `AgentStrategy` implementation dispatching to ssh.ts/sftp.ts | a future `RelayStrategy` (not built, see gate item 1) |
| `src/tools/setup-ssh-key.ts` | Generates/deploys an SSH keypair to a remote agent | not needed -- relay auth is the machine JWT from `apra-fleet join`, not an SSH key |

## Test files that directly exercise the above (verified by grep, not guessed)

- `tests/file-transfer-matrix.test.ts` -- exercises both ssh.ts and sftp.ts across the provider/OS matrix
- `tests/known-hosts.test.ts` -- known-hosts.ts's own unit tests
- `tests/platform.test.ts` -- references ssh.ts in its OS-detection assertions
- `tests/receive-files.test.ts` -- sftp.ts's download path
- `tests/remove-member-decomm.test.ts` -- references known-hosts.ts cleanup during member removal

Additional test files exercise remote-agent flows indirectly (through
`getStrategy()`/`RemoteStrategy` as one of several code paths under test,
not as their primary subject) and would need re-scoping rather than
deletion when this migration lands: `tests/activity.test.ts`,
`tests/cloud-provider.test.ts`, `tests/credential-cleanup.test.ts`,
`tests/find-log-file.test.ts`, `tests/register-member-no-llm.test.ts`,
`tests/register-member-oob.test.ts`, `tests/unattended-mode.test.ts`.
`tests/ssh-error-messages.test.ts` tests `classifySshError` in
`src/utils/ssh-error-messages.ts`, a pure string-classification helper
with no direct ssh.ts/sftp.ts dependency -- likely fine to keep regardless
(SSH may remain a supported fallback transport even after relay ships;
that product decision is out of scope for this inventory).

## What NOT to do based on this document alone

Do not delete any file in the inventory table as a mechanical follow-up to
this doc. Each removal is gated on the four items above, and even then
should go through its own review given the size of what depends on
`RemoteStrategy` today (every existing remote/SSH-based agent in
production, if any are deployed, would break outright).
