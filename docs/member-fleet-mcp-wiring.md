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
- Install source: copy the orchestrator's single-executable binary when the
  member has the same OS and arch; otherwise download the release asset for the
  orchestrator's version; otherwise report `unavailable(<reason>)`. Absence is an
  observation, never a throw: registration still succeeds.
- After install the member registers itself, and a MEMBER-session is opened to
  verify the tools are really reachable.
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
