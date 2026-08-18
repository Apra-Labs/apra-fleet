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

## Where the grant comes from: the BASE branch, not the working tree

The governing invariant behind every constraint here is: **a member must never
be able to escalate its own permissions.**

An earlier version of this mechanism satisfied that only on paper. It
dispatched a small `permissions-composer` LLM agent that read the failing
phase's runbook out of the ORCHESTRATOR'S WORKING TREE -- which the sprint's
own git-sync bracket had just pulled this sprint's doer commits into -- and
then self-reported which prefixes it had granted. Both halves were holes:

- The grant source was member-writable. A doer could append a
  `Bash(bash -c *)` line to `deploy.md`'s `## Permissions`, commit it to the
  sprint branch, and the next `missing_permissions` failure would grant it
  with no human involved.
- Nothing verified the self-report. The report is produced AFTER the tool call
  already landed, so post-hoc checking of it cannot constrain the side effect
  it describes.

Both are now structurally impossible rather than checked for:

1. **The runbook is read from `origin/<base_branch>`** -- `git fetch origin
   <base_branch>` followed by `git show origin/<base_branch>:<runbook>` on the
   orchestrator member. The base branch is by definition the human-reviewed,
   merged line, which is exactly what this document used to *claim* ("a
   reviewed, committed runbook") without enforcing. The sprint branch's copy is
   never consulted.
2. **There is no LLM in the grant path.** The runner parses the
   `## Permissions` section and calls `compose_permissions` itself, through the
   MCP `callTool` connection already wired into the sprint. There is no
   self-report to verify because there is no agent. The `permissions-composer`
   persona, its output schema and its model-tier entry have all been deleted.

### The runbook contract

Role to runbook, unchanged:

| role | runbook |
| --- | --- |
| `deployer` | `deploy.md` |
| `integ-test-runner` | `integ-test-playbook.md` |
| `regression-test-runner` | `regression-test-playbook.md` |

Inside that file's `## Permissions` section, a prefix is DECLARED by being a
markdown list item whose first backticked token is a well-formed
`Tool(payload)` string, optionally followed by prose:

```
## Permissions

Commands below require these prefixes in .claude/settings.json:
- `Bash(npm ci)`
- `Bash(npm run build)` -- also covers build:binary, see Deploy below
```

Only list items count. This matters: these sections also contain explanatory
prose that mentions prefixes as examples (`regression-test-playbook.md` says
"a broader prefix entry counts as coverage -- e.g. `Bash(git:*)` covers
`git clone`"), and a naive "every backticked `Bash(...)` in the section" scan
would grant those too. The section ends at the next `#`/`##` heading.

The parser **fails closed**: a missing runbook, a missing `## Permissions`
section, or a section with no parseable list entries yields an empty list,
which the heal treats as "nothing to grant" and terminates on. It never
improvises a prefix list.

## Known, intentional failure mode

A permission need introduced BY THIS SPRINT -- a doer adds a build step and
correctly documents its new prefix in the same PR -- is not in the base branch,
so it does **not** self-heal. The phase fails for real and a human reviews the
PR.

This is correct, not a regression. A sprint must not be able to authorize its
own new permission, and this is the exact seam where a human belongs. It is
logged distinguishably so an operator can tell it apart from a plain missing
grant:

```
Deploy: requested prefix not present in base-branch runbook -- not auto-granted:
[Bash(docker compose*)]. origin/main:deploy.md declares only [...]. A permission
need introduced within this sprint must be reviewed into main by a human before
it can self-heal; this is intentional, not a bug.
```

The fix is a one-line runbook change merged to the base branch through normal
review -- then the next sprint heals automatically.

## Orchestrator-side heal-and-retry

The orchestrator (`runner.js`) has one shared heal helper used by all three
phases. When a phase's result carries `blockedReason: 'missing_permissions'`:

1. Read the failing phase's runbook from `origin/<base_branch>` and parse its
   `## Permissions` list entries.
2. Call `compose_permissions` once, in reactive grant mode, with exactly those
   prefixes, the failing phase's `role` (so the per-role bounds check applies),
   the target member, and a `grant_reason` naming the base-branch source.
3. Inspect the tool's own return string. Anything that is not an explicit
   success is terminal -- failing closed is the only safe default for a string
   the runner did not author.
4. On success, re-run the **exact original dispatch closure** (not a
   hand-copied approximation of it) once.
5. Feed the retried result back through the same helper, so a *second*
   consecutive `missing_permissions` in the same cycle/phase is treated as
   terminal and surfaces through the phase's normal failure path -- this
   guards against a heal-retry-fail loop. A later cycle still gets its own
   fresh heal attempt, since a genuinely new permission need in a later
   cycle is not the loop being guarded against.
6. EVERY terminal outcome -- a denylist or out-of-bounds rejection, an
   unreadable base-branch runbook, an empty `## Permissions` section, a
   missing MCP connection, a thrown tool error -- propagates the original
   phase failure unchanged (with the reason appended to its notes/summary),
   never a thrown sprint abort. The phase fails for real exactly as it would
   have without this mechanism.

This mirrors two patterns already established elsewhere in the runner: the
per-phase max-turns resume ladder (dispatch, inspect, re-dispatch once with
the fault addressed), and `execute-prompt.ts`'s trust-heal-once gate (heal
once, retry once, treat a repeat as terminal).

Note there is no git-sync bracket around the heal any more. The old composer
dispatch needed one because it read the working tree; reading from
`origin/<base_branch>` is precisely what makes that unnecessary -- and
freshening the working tree would defeat the point.

## Relationship to the per-role bounds mechanism

`compose_permissions` grant requests carry a `role`, and the runner always
supplies the failing phase's role. When a role has a bounds file
(`skills/fleet/profiles/bounds-<role>.json` -- see
`skills/fleet/permissions.md` for the format), the tool checks each newly
requested permission against it.

Today this is informational-only: an out-of-bounds permission is still granted
exactly as requested, but its ledger entry is flagged `outOfBounds: true` /
`requestedByRole: "<role>"` for later audit.

Bounds can never widen `NEVER_AUTO_GRANT`; that denylist (wildcard-matched, see
`skills/fleet/permissions.md`) is checked first and unconditionally, for every
caller, before any bounds lookup.

## Non-goals / relationship to the broader missing-grant design

This mechanism is deliberately narrow: it only fires for the three
runbook-driven phases, only on the exact `missing_permissions` structured
signal, and only grants prefixes the BASE BRANCH's runbook already declares --
it does not attempt to infer a needed grant from a raw CLI refusal, classify
permission failures by remediation owner, or propose a playbook diff for human
review. A more general design covering those cases (reverse-extracting grants
from provider refusal text, playbook-permission evolution via reviewed diffs, a
unified `grantsNeeded` vocabulary across providers) is tracked separately
and remains unimplemented; nothing in that broader design conflicts with
this narrower, already-shipped mechanism, and the two can coexist.
