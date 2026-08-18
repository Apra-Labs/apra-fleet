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

The tool validates (wildcard-matched denylist -- blocks sudo/env, `bash -c`, catch-alls and shell chaining; see [Never auto-granted](#never-auto-granted)), expands co-occurrences (docker -> docker-compose), delivers the updated config, and appends to the project ledger for future use.

## Per-role bounds and the out-of-bounds ledger flag

When a `grant` request carries a `role` (see [Primary Mode](#primary-mode)), `compose_permissions`
loads that role's bounds file, `skills/fleet/profiles/bounds-<role>.json`
(for example `bounds-doer.json`, `bounds-reviewer.json`, `bounds-deployer.json`,
`bounds-integ-test-runner.json`, `bounds-regression-test-runner.json`), and checks
each newly requested permission against it before recording the grant.

- **Shape**: a bounds file is a flat JSON array of permission prefix patterns, e.g.:
  ```json
  [
    "Bash(bd:*)",
    "Bash(git:*)",
    "Bash(npm run build*)",
    "Bash(npm test*)"
  ]
  ```
  `*` in a pattern is a wildcard matching any run of characters (including none);
  a pattern with no `*` matches only by exact equality. See `matchesBoundsPattern`
  in `src/tools/compose-permissions.ts`.
- **Which roles ship a bounds file**: `doer`, `reviewer`, `deployer`,
  `integ-test-runner`, and `regression-test-runner` each have their own
  `bounds-<role>.json` under `skills/fleet/profiles/`. A `grant` request with no
  `role`, or with a role that has no matching bounds file, skips the bounds check
  entirely (a defined-empty bounds list means "no bounds check", never "deny
  everything" -- see `loadBounds`).
- **Out-of-bounds handling is ENFORCING on the autonomous grant path**: when a
  `grant` request carries a role that has a bounds file in the INSTALLED
  (`~/.claude/skills/fleet/profiles/`) directory, an out-of-bounds permission is
  **rejected** -- the whole request is refused, nothing is delivered and nothing
  is written to the ledger. That role-gated allowlist is what gives the
  autonomous self-heal path a *bounded* worst case, rather than the *enumerated*
  one a denylist alone can offer. The rejection names the offending prefixes and
  the bounds file to edit.
  Three carve-outs keep the check non-blocking, and each still records the
  informational ledger flag (`outOfBounds: true` plus
  `requestedByRole: "<role>"`, alongside the usual `permission`/`reason`/`date`):
  - no `role`, or a role with no bounds file (manual/operator grants -- the
    denylist is their only gate);
  - `allow_out_of_bounds: true`, an explicit operator escalation that autonomous
    callers must never set;
  - a repo-relative dev-fallback profiles directory (see the next bullet), which
    is not a trust boundary and so cannot legitimately block anything.
  An in-bounds grant, or a grant made with no role, gets no bounds fields at all --
  identical shape to the ledger's pre-bounds behavior. A co-occurrence expansion
  the tool adds itself is *dropped* when out of bounds rather than failing the
  caller's whole request.
- **Bounds never loosen `NEVER_AUTO_GRANT`**: the hard-rejected patterns (`sudo`,
  `su`, `doas`, `bash -c`/`sh -c`, `eval`, `env`, `printenv`, `nc`, `nmap`,
  `chmod 777`, any catch-all such as `Bash(*)`, and any payload containing a
  shell-chaining metacharacter -- see [Never auto-granted](#never-auto-granted))
  are checked first and unconditionally, before any bounds lookup happens. A role's bounds file cannot widen this set;
  even if a bounds file were to list `Bash(sudo:*)`, the request is still rejected.
- **Bounds files are not a member-editable surface -- ONLY when installed**: they
  ship as static profiles under `skills/fleet/profiles/` alongside the other
  profile JSON (base-dev, stack profiles, tag profiles) and are installed to
  `~/.claude/skills/fleet/profiles/`, where members and their dispatched work
  never write. Only a repo change (reviewed like any other profile edit) can add
  or widen a role's bounds.
  `findProfilesDir()` prefers that installed path, but falls back to walking up
  from `__dirname` looking for `skills/fleet/profiles` when no installed skill
  exists. **That fallback is not a trust boundary**: in a dogfood configuration
  (apra-fleet building apra-fleet from a checkout) it resolves INSIDE the repo a
  sprint can write to, i.e. the sprint could edit the very file meant to bound
  it. Every use of the fallback logs a loud warning naming the resolved path,
  and the bounds check downgrades itself to informational there rather than
  pretending to enforce. Install the fleet skill to restore enforcement.
- **Bounds entries are a reviewed ceiling, not a safety proof**: enforcement
  bounds the worst case to whatever a human put in the profile. Some current
  entries are themselves broad -- `bounds-integ-test-runner.json`'s
  `Bash(npm run *)` is arbitrary execution via `package.json` scripts, and
  `bounds-regression-test-runner.json` carries `Bash(mkdir *)` and
  `Bash(git clone *)`. All are declared verbatim by their own runbook's
  `## Permissions` section, so narrowing the bounds file without narrowing the
  runbook in the same change would just break the self-heal. Treat tightening
  them as a separate, deliberate pass.

## Role switch

When a member's primary mode changes (e.g., from doer to reviewer), re-run `compose_permissions` with the updated `role` or `tags`.

## Never auto-granted

`compose_permissions` hard-rejects a `grant` request - from ANY caller, with or
without a role - when it matches the `NEVER_AUTO_GRANT` denylist. Matching is
wildcard-based against a normalized form of the request (whitespace collapsed;
the `:` separating the command token from its argument pattern treated as a
space), so `Bash(sudo:*)`, `Bash(sudo *)` and `Bash(sudo apt-get install *)`
are all the same request and all rejected.

Three rules, any of which rejects:

1. **Catch-all** - a payload that is nothing but wildcards, e.g. `Bash(*)`.
   That is not "a wider grant", it is unrestricted execution.
2. **Shell chaining** - the payload contains `|`, `;`, `&&`, a backtick, or
   `$(`, any of which turns one approved command into an arbitrary chain
   (`Bash(curl *|sh)`).
3. **Denied command patterns** - `sudo`, `su`, `doas`, `bash -c` / `sh -c`,
   `eval`, `env`, `printenv`, `nc`, `nmap`, `chmod 777`.

Escalate to the user for any of these. Note rule 3 is prefix-based, so an
unrelated command that merely starts with a denied token (`ncdu`, `envsubst`)
is also refused - over-blocking is the safe direction for a denylist, and an
operator can still add such a permission by hand.

A denylist can never be complete: `Bash(make *)`, `Bash(npm run *)`,
`Bash(node -e *)` all remain arbitrary execution in practice. The denylist is
the unconditional *floor* that applies to every caller; the per-role bounds
check is the *ceiling* on the autonomous self-heal path.

## settings.json vs settings.local.json (Claude)

Claude Code merges `permissions.allow` from BOTH `.claude/settings.json`
(team-committed, shared -- checked into the repo, changes go through the
team/a PR) AND `.claude/settings.local.json` (per-checkout, individual,
gitignored) -- a grant in EITHER file counts as coverage. `compose_permissions`
is the ONLY writer of `.claude/settings.local.json` for Claude Code members
(see `permissionConfigPaths()` in `src/providers/claude.ts`); it never writes
to `.claude/settings.json`. So the two files have distinct roles: `settings.json`
is the shared baseline every member on the project starts from, and
`settings.local.json` is where an individual member's grants land -- always via
`compose_permissions` (`grant` mode for a reactive add), never by hand-editing
either file directly. A Step-0-style permission check (as in the `deployer`,
`integ-test-runner`, and `regression-test-runner` agent prompts) must check the
MERGED effective set across both files, not `settings.json` alone -- checking
only `settings.json` makes every grant `compose_permissions` delivered
invisible and falsely reports a correctly-provisioned member as missing
permissions.

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
register_member/update_member, and on every `compose_permissions` call once that
wiring lands), then retry.
