# Missing-permissions self-heal (Deploy / Integ Test / Regression Test)

## Problem

A sprint checkout's Claude Code permission grants live per-checkout, in files
that are gitignored by design (`.claude/settings.local.json`). A fresh
checkout -- or one that was never composed for -- can hit its runbook's own
`## Permissions` Step-0 gate and block the phase before it runs a single
command. Historically this required a human to notice the block, run
`compose_permissions` by hand, and re-trigger the sprint, burning the cycle
that hit it.

This mechanism closes that loop automatically for the three runbook-driven
phases (Deploy, Integration Test, Regression Test), while keeping the
existing hard rule that a sprint must never grant its own permissions from
inside member-side work.

## Design: structured signal, not prose-sniffing

Each of the three phases' output schemas carries an optional `blockedReason`
field. The only value it currently takes is `missing_permissions`, meaning
"I could not do my work because a Bash prefix my own runbook declares was
not granted to me." Because this is a structured schema field rather than a
free-text pattern match, the orchestrator's heal-trigger check is exact.

## The `permissions-composer` role

`permissions-composer` is a small, **orchestrator-side-only** role -- it is
never dispatched to a member and never talks to a member's shell beyond what
the `compose_permissions` MCP tool does internally. Its tool access is
limited to `Read` and `compose_permissions`; it cannot deploy, run tests, or
hand-edit any settings file.

Its job is a fully-specified extraction with no judgment calls:
1. Map the calling phase name to its runbook (`deploy.md`,
   `integ-test-playbook.md`, `regression-test-playbook.md`).
2. Read that runbook's `## Permissions` section and extract exactly the
   `Bash(...)` prefixes it declares -- never inferred, widened, or
   supplemented.
3. Call `compose_permissions` once, in reactive grant mode, passing the
   calling phase's role so the per-role bounds check (below) applies.
4. Report `composed`, `grantedPrefixes`, and `terminalFailure` (null on
   success). A `NEVER_AUTO_GRANT` denylist rejection is always terminal --
   the composer never retries with a narrower prefix or attempts another
   grant channel.

Because the work is a bounded read-and-call with no exploration, it runs on
the cheap model tier alongside similarly mechanical fixed-role dispatches
(e.g. streak assignment).

## Orchestrator-side heal-and-retry

The orchestrator (`runner.js`) has one shared heal helper used by all three
phases. When a phase's result carries `blockedReason: 'missing_permissions'`:

1. Dispatch `permissions-composer` once for that phase's role/member.
2. If it grants successfully, re-run the **exact original dispatch closure**
   (not a hand-copied approximation of it) once.
3. Feed the retried result back through the same helper, so a *second*
   consecutive `missing_permissions` in the same cycle/phase is treated as
   terminal and surfaces through the phase's normal failure path -- this
   guards against a heal-retry-fail loop. A later cycle still gets its own
   fresh heal attempt, since a genuinely new permission need in a later
   cycle is not the loop being guarded against.
4. A terminal composer outcome, or a composer dispatch that itself errors,
   never converts into a thrown sprint abort -- the original phase failure
   propagates unchanged (with the terminal reason appended to its notes),
   so the phase fails for real exactly as it would have without this
   mechanism.

This mirrors two patterns already established elsewhere in the runner: the
per-phase max-turns resume ladder (dispatch, inspect, re-dispatch once with
the fault addressed), and `execute-prompt.ts`'s trust-heal-once gate (heal
once, retry once, treat a repeat as terminal).

## Relationship to the per-role bounds mechanism

`compose_permissions` grant requests can now carry a `role`. When they do,
the tool checks each newly requested permission against that role's bounds
file (`skills/fleet/profiles/bounds-<role>.json` -- see
`skills/fleet/permissions.md` for the full bounds-file format and
audit-flag semantics). This is informational-only: an out-of-bounds
permission is still granted exactly as requested, but its ledger entry is
flagged `outOfBounds: true` / `requestedByRole: "<role>"` for later audit.
Bounds can never widen `NEVER_AUTO_GRANT` -- that denylist is checked first,
unconditionally, before any bounds lookup.

`permissions-composer` always passes the calling phase's role on its grant
call, which is what lets an operator later audit whether a self-heal grant
stayed inside that role's expected scope, without the composer needing to
implement any bounds logic itself.

## Non-goals / relationship to the broader missing-grant design

This mechanism is deliberately narrow: it only fires for the three
runbook-driven phases, only on the exact `missing_permissions` structured
signal, and only reads prefixes a runbook already declares -- it does not
attempt to infer a needed grant from a raw CLI refusal, classify permission
failures by remediation owner, or propose a playbook diff for human review.
A more general design covering those cases (reverse-extracting grants from
provider refusal text, playbook-permission evolution via reviewed diffs, a
unified `grantsNeeded` vocabulary across providers) is tracked separately
and remains unimplemented; nothing in that broader design conflicts with
this narrower, already-shipped mechanism, and the two can coexist.
