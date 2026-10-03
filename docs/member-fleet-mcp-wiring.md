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

The Claude entry is `{type: "http", url, alwaysLoad: true}`. `alwaysLoad` is
required, not cosmetic: with tool search on (the CLI default) a configured
server connects in the background, so a headless `claude -p` dispatch builds
its first request before the server connects and the session sees none of the
member's tools, even though `claude mcp list` (which connects synchronously)
reports it Connected. `alwaysLoad` makes startup wait for the server (capped at
the CLI connect timeout) and puts its tools in context from the first request.
The fleetMcp probe reports an entry without it as `mcp-entry-deferred`; compose
rewrites it.

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
apra-fleet (`update_member` installs or upgrades only on a provider change or when
called with `fleet_install: "auto"`), at least as new as the orchestrator, installed in HTTP member mode
(server and auto-start only). `remove_member` undoes the wiring.

- Version probe on the member's own install; on PowerShell the exit code is read
  from `$LASTEXITCODE`.
- Outdated rule (`isMemberOutdated`): an older version core is always outdated
  and a newer core never is, so a member is never downgraded. At the same core, a
  different build suffix (`v0.4.4_aaaaaa` vs `v0.4.4_bbbbbb`) counts as outdated
  only when the install source is the orchestrator's own executable. A
  release-asset source installs the release build of the core, so treating a
  same-core member as outdated would reinstall on every registration and then
  fail verification as `install-unverified`; there a same-core member is up to
  date. The post-install verification uses the same rule. Versions without a
  suffix keep equal = up to date.
- `update_member` is registered with a strict input schema: an unknown or
  misspelled key is rejected at the MCP layer with an error naming the key,
  before the handler runs, and the member registry is left unchanged. `fleet_install`
  is `auto` (install or upgrade even when nothing else changed, remote members
  only) or `skip` (never install, even on a provider change); omitting it keeps
  the provider-change-only default. The `fleetMcp fix:` lines name
  `update_member {member_id, fleet_install: "auto"}` as the remedy.
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

## Member-install marker: the only ownership signal

`install --member` writes a marker (`~/.apra-fleet/data/member-install.json`)
recording that the install is a member install; a full install clears it.
`install --member --force` stops only a running server whose install carries
the marker, and refuses any other with `E-FULL-INSTALL-RUNNING`.

The fleet treats the marker as the ONLY sign that the apra-fleet at
`<home>/.apra-fleet/bin` (the same path a human full install uses) is its own
(`memberHasInstallMarker` in `src/services/member-fleet-install.ts`; an
existence check, path built in JS from the probed home, `test -f` or
PowerShell `Test-Path -LiteralPath ... -PathType Leaf` per the member's shell):

- An existing install is upgraded (`install --member` run over it) only when
  it carries the marker; an unmarked one is never installed over, even when
  its server is not running (no refusal would fire then). A member with no
  apra-fleet at all is installed normally.
- Self-registration (`register-member --type local --id <uuid>`) runs only
  into a marked install, or right after the fleet's own successful
  `install --member` in the same probe. An unmarked install is never written
  to, so the fleet cannot plant a registry entry in a human's install.
- The fleet never sends `--force-stop-full-install`. A refused member install
  leaves the running server alone.
- Either case records `fleetMcp` `unavailable(full-install-running)` with a
  detail naming the takeover command below.

Why no other signal: an unmarked install is either a human full install or a
member install made by a build older than the marker, and nothing on the member
tells them apart. Builds before stage 6 self-registered into any up-to-date
install, so a LOCAL registry entry for this member's uuid can sit in a human's
install too; `fleetInstalledAt` stays set after a human runs a full install
over a fleet install (which clears the marker). Counting either as ownership
would stop the human server on a core bump, and since the stage 6 build-aware
check, on every same-core orchestrator rebuild. `fleetInstalledAt` is still
recorded (and carried across probes and `compose_permissions` writes) as an
observation only.

One-time takeover: an owner who wants the fleet to manage an unmarked install
(a pre-marker member install on a dogfood host, or a full install they give
up) runs once on the member

    apra-fleet install --member --force --force-stop-full-install

which stops its running server and writes the marker, then calls
`update_member` `{member_id, fleet_install: "auto"}` and `member_detail` with
`refresh: true`. No released build shipped member installs, so only dogfood
hosts can hold an unmarked member install.

## Compose and member lifecycle invariants

- Compose keeps user-authored deny rules (merged with fleet's own), writes the
  permission ledger before syncing the MCP entry, and reports a reason per
  member; stale compose-owned `fleetMcp` statuses are cleared.
- `update_member` re-composes when the member's work folder changes;
  `remove_member` cleans the member side first, then removes credentials and
  the key, and reports anything it could not clean.
- Member-side file checks use `test -f` / `-PathType Leaf` and per-shell path
  quoting, never shell expansion.
