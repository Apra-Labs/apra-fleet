# Issue #216 — Redesign apra-fleet auth → secret subcommand

## Background

The existing `apra-fleet auth` subcommand was designed purely as internal plumbing: the server auto-launches it in a new terminal when a tool like `credential_store_set` needs a secret, the user types the value, it sends it back over a named pipe/UDS socket, and exits. Users were never meant to type `apra-fleet auth` directly.

The problems:
1. `--help` describes `auth` as "Provide password for pending member registration" — incorrect. It has three modes (SSH password, API key, network egress confirm) with completely different semantics.
2. There is no user-facing CLI for managing the vault. The only way to set/list/delete secrets is through MCP tool calls — not from a terminal.
3. The naming (`auth`) is confusing. The subsystem manages *secrets*, not authentication in the broad sense.

## New CLI: `apra-fleet secret`

### Synopsis

```
apra-fleet secret --set <name>              Deliver a secret value to a waiting request
apra-fleet secret --set <name> --persist    Deliver and also persist to disk
apra-fleet secret --update <name>           Update metadata of an existing secret
apra-fleet secret --list                    List secret names and metadata (no values)
apra-fleet secret --delete <name>           Delete a named secret
apra-fleet secret --delete --all            Delete all secrets
apra-fleet secret --help                    Show this help
```

### `--set <name>`

Delivers a secret value. The name must match `[a-zA-Z0-9_]{1,64}`.

Valid use cases:
1. **OOB delivery (waiting request exists)** — server has a pending `credential_store_set` call blocked waiting for this name. Value is forwarded over auth socket.
2. **OOB delivery + persist** — same as (1), but `--persist` also writes to `credentials.json`.
3. **Persist only (no waiting request, `--persist` required)** — if no waiter, `--set` requires `--persist`. Without it errors: "No pending request for NAME. Use --persist to store for future use."

The CLI always prompts for the value with no-echo secure input.

Flags:

| Flag | Meaning |
|------|---------|
| `--persist` | Also write to `credentials.json` (survives server restart) |
| `--allow` | Set `network_policy=allow` — always permit without prompting — only applies with `--persist` |
| `--deny` | Set `network_policy=deny` — always block without prompting — only applies with `--persist` |
| `--members <list>` | Comma-separated member names, or `*` (default: `*`) — only applies with `--persist` |
| `--ttl <seconds>` | Expiry in seconds — only applies with `--persist` |

Default network policy (no flag): `deny`.

### `--update <name>`

Updates metadata of an existing secret without re-entering the value.

Flags: `--allow`, `--deny`, `--members <list>`, `--ttl <seconds>`. At least one flag required.

### `--list`

Prints a table of all secrets (session + persistent). Values are never shown.

```
NAME           SCOPE       POLICY    MEMBERS    EXPIRES
github_pat     persistent  allow     *          none
db_password    session     deny      fleet-dev  23m 14s
```

### `--delete <name>` / `--delete --all`

Delete one or all secrets. `--all` requires confirmation: "Delete all secrets? Type yes to confirm: "

## Server-Side: `credential_store_set` OOB flow

When `credential_store_set` starts waiting, fire three parallel signals:
1. **Auto-launch a terminal** — spawn `apra-fleet secret --set <name>`
2. **Print to LLM console** — tool response: "Waiting for secret NAME. Run in any terminal: apra-fleet secret --set NAME"
3. **Log it** — write to `fleet-<pid>.log` at info level

Server records auto-launched terminal PID and kills it when secret received via any path.

## `auth` subcommand

Remove from `--help` entirely. May keep as undocumented alias for server auto-launch path.

## `--help` changes

Top-level `apra-fleet --help` replaces auth line with:
```
  apra-fleet secret --set <name>           Deliver a secret to a waiting request
  apra-fleet secret --list                 List secrets
  apra-fleet secret --delete <name>        Delete a secret
```

## Network policy: `allow` / `deny`

V1 supports two states:
- `allow` — Always permit without prompting
- `deny` — Always block without prompting (default)

## Stretch: `confirm` policy (not in V1)

A third policy `confirm` reserved for future: `execute_command` returns `{status: "confirmation_required", confirmation_id}` early; fleet skill calls `AskUserQuestion` then `credential_confirm(id, choice)`, then retries. For Gemini: `AskUserQuestion` falls back to OOB terminal.

## Forward compatibility with #193

No new CLI flag needed. Hook is `APRA_FLEET_DATA_DIR` env var. Do not hardcode `FLEET_DIR` in new code paths. `credential-store.ts` should derive `CREDENTIALS_PATH` at call time (deferred to #193 sprint).

## Migration

No data migration needed. Vault format (`credentials.json`, session store) is unchanged.

## Out of scope

- `--from-env` — not implemented, not needed.
