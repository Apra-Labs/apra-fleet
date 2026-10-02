# Member apra-fleet MCP wiring

How a member's own LLM session reaches the apra-fleet `kb_*` / `code_*` tools,
and how the orchestrator keeps that wiring truthful.

## Per-folder MCP entry

`compose_permissions` writes, besides the permission allow list, a per-folder
`apra-fleet` MCP server entry whose URL carries `?member=<uuid>`. The server
uses the uuid to scope the session to that member (reduced tool list, own work
folder; an unregistered uuid gets 403).

| Provider | Where the entry goes |
|---|---|
| Claude | LOCAL scope (keyed by work folder) in `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`; the path is probed on the member, never shell-expanded |
| OpenCode | `<workFolder>/opencode.json`, which is added to `.git/info/exclude` so it never dirties the checkout |
| agy | no entry (no per-project MCP support); the member is reported `unverified` and gets the injected KB block instead |

Deny rules for Claude and agy are derived from the complement of the shared
member allowlist (`MEMBER_DENIED_TOOLS`), so the allowlist stays the single
source of truth. Legacy `apra-fleet-member` entries and `{disabled:true}`
entries are pruned on compose. Changing a member's provider removes the old
provider's composed config and re-composes for the new one.
The former global endpoint-registration path was deleted; there is exactly one
mechanism.

## Config-file safety

Compose edits files the user may own, so it never destroys them:

- OpenCode: the write is skipped when the entry is already current (no mtime
  churn). A git-tracked `opencode.json` (including an empty or `{}`-only one)
  is never modified; compose fails with `E-OPENCODE-CONFIG-TRACKED`. A JSONC
  file (comments) is not rewritten; it is reported with the typed reason
  `opencode-config-unparseable`.
- Claude: reading the member's config distinguishes "missing" from
  "unreadable" (existence is tested first, and the read's exit code is kept).
  An unreadable `~/.claude.json` raises `MemberConfigUnreadableError` and trust
  seeding never replaces it, so a permission problem cannot turn into data loss.

## Member-side install

`register_member` and `update_member` ensure a remote member runs its own
apra-fleet, at least as new as the orchestrator, installed in HTTP member mode
(server and auto-start only). `remove_member` undoes the wiring.

- Version probe on the member's own install; on PowerShell the exit code is read
  from `$LASTEXITCODE`.
- Install source: copy the running executable (the orchestrator's
  single-executable binary) when the member has the same OS and arch;
  otherwise download the release asset for the orchestrator's version;
  otherwise report `unavailable(<reason>)`. Absence is an observation, never a
  throw: registration still succeeds. There is no GitHub Actions-artifact
  fallback and no node-based fallback. An untagged (dev) build, whose version
  looks like `v0.4.4_abc123`, downloads the asset of the tag its version core
  maps to (`v0.4.4`).
- The release asset download is bounded by a timeout and verified against the
  release's published `SHA256SUMS` before use; a timeout, a checksum mismatch
  or an unavailable checksum is a typed, recoverable `fleetMcp` reason and
  nothing unverified is installed.
- A member install (`install --member`) with `--force` stops only a server a
  previous member install left behind; a running full-install server it did not
  start is refused with `E-FULL-INSTALL-RUNNING` unless `--force-stop-full-install`
  is also given.
- After install the member registers itself, and a MEMBER-session is opened to
  verify the tools are really reachable.
- Self-registration design: the member-side `register-member --id <uuid>`
  (the self-registration form) does NOT run `compose_permissions`. A member
  install carries no fleet skill profiles (`install --member` installs no
  skills), so a member-side compose would fail with "No complete profiles
  directory". Permissions and the per-folder MCP entry are composed by the
  orchestrating server instead: `register_member` composes before it installs
  and runs the self-registration, and the MCP-entry check that follows reads
  what that compose wrote. Running `register-member` without `--id` (a manual
  shell registration) still composes.
- A failed self-registration is recorded in `fleetMcp.detail` with the
  member's error text from its start: the leading `ERROR:` line and its cause
  are kept (capped at 4000 characters, truncating the end, never the head).
- Every member-bound command is built in JavaScript for the member's OS/shell
  from a probed home directory; none relies on shell expansion.

The result is recorded on the member as `fleetMcp`:
`{ state: 'available' | 'unavailable', reason?, version?, checkedAt, detail?, unverified? }`.
Failure reasons are machine-readable and recoverable (for example install too
old, folder taken, MCP entry missing, no per-project MCP). `member_detail` takes
`refresh` to re-probe; `fleet_status` only reads the recorded value and never
probes, so it stays cheap.

## Invariants

- Provider, transport and OS differences live in the install service and
  provider adapters; handlers see one `FleetMcpStatus`.
- `unverified` means "treat as no KB tools": the dispatch layer falls back to
  the injected KB block.
- Any change to the member tools surface must update the client package and the
  memory-contract in the same change.

## Member-install marker and pre-marker members

`install --member` writes a marker (`~/.apra-fleet/data/member-install.json`)
recording that the running server was started by a member install; `--force`
stops only a server that carries it.

A remote member installed by a build that predates the marker (the pre-marker
case) has none, so the fleet's install (`install --member --force`) is refused
with `E-FULL-INSTALL-RUNNING`. The fleet then retries the install exactly once,
pre-marker case only, with `--force-stop-full-install` appended, but only when
one of two ownership signals shows the fleet owns that install (see
`fleetPreviouslyInstalled` and `memberRegistryHoldsId` in
`src/services/member-fleet-install.ts`):

1. `fleetInstalledAt` (fast path, no member command): the member's recorded
   `fleetMcp` carries a timestamp stamped only when this fleet's own install
   run succeeded and carried across later probes, including
   `compose_permissions` writes. A refusal, `member_detail refresh`, or any
   observation-only probe never sets it, and `fleetMcp.version` is not the
   signal (a human full install reports a version at the same path). The
   client `FleetMcpStatus` typedef lists the field.
2. Member registry uuid signal (checked only after a refusal): the member's
   OWN apra-fleet registry, `<home>/.apra-fleet/data/registry.json`, holds a
   LOCAL-type entry whose `id` equals this member's fleet uuid. Only the fleet's
   earlier self-registration (`register-member --type local --id <uuid>`)
   creates that entry; a human full install does not hold the
   orchestrator-assigned uuid. A REMOTE-type entry with the uuid does not count:
   it is the orchestrator's own record of the member, which the read returns when
   the "remote" member is the orchestrator's own host and user -- counting it
   would send the override at the orchestrator itself.
   The file is read directly (path built in JS from the probed home, POSIX or
   PowerShell form per the member's shell, no shell expansion) rather than
   through the installed binary, because a pre-marker build may predate CLI
   subcommands. This is the signal that covers real pre-marker members, whose
   older build never wrote `fleetInstalledAt`.

If the retry fails too, its own typed reason is recorded (the detail notes it
was retried once with `--force-stop-full-install`).

A member with neither signal gets no override: the install is refused once,
recorded as `full-install-running`, and a human full install on that host is
never stopped. A missing, empty, unreadable or unparseable member registry, or
one that lists only other member ids, counts as no signal. For a member the
fleet did not install (or whose registry entry was re-created under a new
uuid, e.g. by `remove_member` + `register_member`), run once on the member
(pre-marker manual override):

    apra-fleet install --member --force --force-stop-full-install

## Compose and member lifecycle invariants

- Compose keeps user-authored deny rules (merged with fleet's own), writes the
  permission ledger before syncing the MCP entry, and reports a reason per
  member; stale compose-owned `fleetMcp` statuses are cleared.
- `update_member` re-composes when the member's work folder changes;
  `remove_member` cleans the member side first, then removes credentials and
  the key, and reports anything it could not clean.
- Member-side file checks use `test -f` / `-PathType Leaf` and per-shell path
  quoting, never shell expansion.
