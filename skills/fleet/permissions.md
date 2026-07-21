# Member Permissions

## Before dispatching work

Call `compose_permissions` with the member and specify a **primary mode** (how to set this is described in [Primary Mode](#primary-mode)). The tool detects the project stack (Node.js, Python, Go, etc.) from the member's `work_folder`, loads the corresponding permission profiles, merges optional ledger grants, and delivers the right provider-native config to the member. Same call works across all agentic providers.

### Primary Mode

Specify the primary mode via either `role` (legacy, Phase 1) or `tags` (Phase 2+). When both are supplied, `tags` wins.

#### Via role (legacy)
```
"Compose permissions for java-dev1 as doer, project folder ./my-project"
```

- `role` must be `doer` or `reviewer`
- Maps to the base-dev or base-reviewer profile
- **Deprecated**: use `tags` for new members; `role` remains supported for backward compatibility

#### Via tags (Phase 2+)
```
"Compose permissions for gpu-builder with tags: gpu, devops, doer, project folder ./my-project"
```

Tags determine the primary mode and grant additional tool scopes:

- **Reserved tags** control primary mode:
  - `doer` -> loads base-dev profile (broad build/test permissions)
  - `reviewer` -> loads base-reviewer profile (read + feedback + test permissions)
  - Default: `doer` if neither tag is present
  - When both are present, one is silently discarded; prefer exactly one

- **Custom tags** (e.g., `gpu`, `devops`, `database`) each load a tag-specific profile (tag-<name>.json) and merge permissions additively
  - Unknown tags (no matching tag-<name>.json file) are silently ignored
  - Custom tags grant permission additively - all matching profiles contribute to the final allow list

### Profile Composition

1. Load **base profile**: base-dev or base-reviewer depending on primary mode
2. Load **stack profiles**: detect package.json, requirements.txt, go.mod, etc.; merge matching profiles keyed by the primary mode
3. Load **custom tag profiles**: for each non-mode tag, load tag-<name>.json and merge its permissions for the primary mode
4. Load **ledger grants**: merge any permissions previously granted in project_folder/permissions.json

All merges are additive (Set-based) - order is independent, duplicates discarded. The final allow list is delivered to the member's provider (Claude, Gemini, etc.) in the provider's native config format.

### Example

Member tags: `["gpu", "devops", "doer"]`

Detected stack: `node`

Ledger grants: `["Bash(grpcurl:*)"]`

Profile composition:

1. base-dev.json (primary mode = doer)
2. node.json[dev] (stack-specific)
3. tag-gpu.json[dev] (custom tag)
4. tag-devops.json[dev] (custom tag)
5. ledger: Bash(grpcurl:*)

Final allow list: union of all above.

## Permission denial during execution

When `execute_prompt` output contains a permission denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: integration tests, project folder ./my-project"

The tool validates (blocks dangerous tools like sudo/env), expands co-occurrences (docker -> docker-compose), delivers the updated config, and appends to the project ledger for future use.

## Role switch

When a member's primary mode changes (e.g., from doer to reviewer), re-run `compose_permissions` with the updated `role` or `tags`.

## Never auto-granted

`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` - the tool rejects these. Escalate to user.

## Workspace trust (Claude)

Composed permissions only take effect in a **trusted** workspace. Claude gates
`permissions.allow` entries on `projects[<work_folder>].hasTrustDialogAccepted` in the
member-side `~/.claude.json` - if that flag is unset, the CLI silently **drops** every
project-scoped allow entry it was just handed by `compose_permissions` (not merely a
cosmetic warning), so an unattended member's dispatches get denied tools instead of the
permissions it was configured with.

Normally a human accepts this trust dialog interactively the first time they open a
folder in Claude. An unattended, fleet-managed member can never click that dialog, and
its work folder is fleet-managed by definition - it is never opened by a human first -
so trust has to be seeded programmatically instead of relying on that interactive flow.

The `ensureWorkspaceTrusted(workFolder)` provider-adapter hook does this: for Claude, it
performs an idempotent, atomic read-merge-write of the member-side `~/.claude.json`,
setting `projects[<work_folder>].hasTrustDialogAccepted = true` scoped **strictly** to
that exact work folder (never a parent directory, never blanket) - delivered over the
same channel `compose_permissions` already uses, so it works uniformly for local and
remote (SSH) members. It logs distinctly whether it just seeded trust or found it
already present. Other providers no-op: Gemini and OpenCode have their own trust gates
but already bypass them per-dispatch (`--skip-trust`, `--dangerously-skip-permissions`);
AGY has no per-project trust concept (machine-global config); Codex/Copilot have no
known equivalent gate.

If `execute_prompt` fails with a `workspace_not_trusted` structured error, the CLI's own
stderr will contain a `"...this workspace has not been trusted"` message - seed trust
via `ensureWorkspaceTrusted(workFolder)` (invoked automatically at
register_member/update_member and on every `compose_permissions` call once
apra-fleet-eft.40.2 wires it in), then retry.
