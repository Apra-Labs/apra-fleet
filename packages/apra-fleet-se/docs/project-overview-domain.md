# Project-overview domain: bind/unbind, checkout, health, git drawer, export/import

This document describes the domain logic layered on top of the project store
described in `docs/project-store.md`: binding fleet members to a console
project, adding a new checkout on a machine, the health panel, the per-member
git drawer, and a project export/import CLI. All of it is domain logic and
JSON routes -- the console UI that renders it is a separate concern.

The route modules exist and are internally wired to each other (the git and
health routes are registered from inside the project-CRUD route
registrar), but nothing in this domain mounts itself into the supervisor's
boot path on its own -- that remains a separate wiring step owned elsewhere.
Read `docs/project-store.md`'s "Current status" section for what "not yet
mounted" means in practice.

## Module shape and collaborators

Every exported function in this domain takes its collaborators explicitly as
its first argument -- `{db, client}` where `db` is the open store handle and
`client` is a fleet MCP client -- rather than reaching for module-level
state or a module-level connection. This keeps every module a pure function
of its inputs: routes pass the request-scoped pair through, and tests pass
fakes with no reset hook needed between cases.

The modules are peers, not a layered stack, and deliberately import from each
other read-only to avoid both duplicate logic and merge conflicts between
lanes that had to land concurrently:

- `checkout.mjs` and `health.mjs` both import shared constants and helpers
  (`OWNER_PACKAGE`, `BEADS_DIR_ENV`, `ProjectBindError`, `bindMember`,
  `parseMemberList`) from `projects.mjs`, never duplicating them.
- `health.mjs` imports its quoting helpers (`quoteArg`, `isPosixMemberShell`,
  `shellMetaCharError`) from `checkout.mjs` rather than keeping a second
  copy -- there is exactly one quoting-and-shell-branch helper in this
  domain, and every command-string call site uses it.
- The git-drawer route module and `health.mjs` form a module cycle
  (`health.mjs` imports `probeBeadsRemote` from the project routes module,
  which in turn mounts the git routes, which import `runHealth` from
  `health.mjs`). This is a deliberately accepted cycle: every binding
  involved is a hoisted function declaration, none of which is invoked
  during any of the three modules' own top-level evaluation -- only once all
  three have finished loading. A cycle built from hoisted, lazily-invoked
  function declarations is safe; the same cycle built from anything
  evaluated at module-load time (a class field initializer, a top-level
  `const` computed by calling into the cycle) would not be.

## Bind / unbind / refresh a member (screen S5, wireframe W2)

Binding a member to a project does three things, in order, and the ordering
is itself a design decision:

1. Stamp an owner tag on the member (`{package: OWNER_PACKAGE, ref:
   projectId}`).
2. Merge (never replace) `BEADS_DIR` into the member's env.
3. Probe the member's git state and cache the result.

The owner tag is the actual "this member belongs to this project" fact; the
env write and the probe are conveniences layered on top of it. Because of
that, **a failure in step 2 or 3 never unwinds step 1** -- rolling back an
already-applied owner tag because a follow-on env write failed would strand
the member in a state that is neither cleanly bound nor cleanly unbound, and
the rollback (an owner clear) could itself fail. Instead, a degraded step 2
or 3 surfaces as a `warnings` entry in both the bind response and the cached
row's own status, so a later read (that never saw the original response)
still shows the operator what's wrong.

The env write is a merge, not a replacement, because the underlying
member-update primitive has REPLACE semantics on its `env` field: writing
`{BEADS_DIR: ...}` alone would silently drop every other env key the
operator had set. The member's current env must be read fresh immediately
before every write for this reason.

Re-binding a member already bound to the *same* project is idempotent (all
three steps re-run; the owner-set is a no-op server-side). Re-pointing a
member owned by a *different* project is refused outright -- one project
never silently steals another's member.

Unbinding is the mirror image: clear the owner tag, remove only the
`BEADS_DIR` key from env (every other operator-set key survives), then drop
the cached row -- in that order, so a refused unbind (the member is held by
something else) never leaves the store's cached row deleted out from under a
member that is, in fact, still bound.

A member with no checkout still gets a cached row (every checkout column
null) so "bound but no checkout yet" is representable and distinct from
"never probed" -- this is what lets the overview screen and the git drawer
answer the question at all rather than treating both states as absence of
data.

### The overview read model

The overview groups a project's bound members by the normalized origin of
their checkout (`origin_slug`) rather than by any operator-declared "this
project's repo" field, because the store has no such field: a project's
members are free to check out different repos (or different remotes of the
same repo), and grouping by what was actually observed is the only source of
truth that can't drift from reality.

The read model degrades gracefully rather than failing outright: if the live
member registry can't be read, the live-only columns (owner, env, VCS token
expiry) come back null instead of 500ing the whole panel -- the cached
columns alone still render something useful. The project's backlog member
(the member that owns its beads database) always appears somewhere in the
model, even if it was never bound or probed, so the screen can never
silently omit the one member the project cannot function without.

The overview reads the cache only; it never probes live. A caller that wants
fresh data asks for it explicitly (a refresh flag), which is what keeps "show
me what we know" cheap by default and turns a network round trip into an
opt-in action rather than an implicit cost of every read.

## Adding a checkout on a machine (DQ-16 naming, acceptance row A10)

The "add checkout" flow puts a *new* checkout of a project's repo onto a
machine that already has a sibling member registered on it -- e.g. a second
worktree, or a fresh clone for a different role. It is a five-step flow
(clone, register the new member, bind it, and two optional provisioning
steps for VCS/LLM auth and permissions), and every step is individually
idempotent: running the whole flow twice is a no-op the second time, and a
dirty or foreign-origin checkout is refused outright and never touched.
Running it again after a partial or full prior success reports every
already-satisfied step as skipped, with zero mutating calls made -- this is
the acceptance-row A10 guarantee, and it is what makes "just run it again"
a safe operator response to an interrupted or uncertain-outcome first
attempt.

Four of the five steps got their own fresh-read idempotency probe (a read of
the target member's own registry record) so a re-run reports them skipped
too, matching the mandatory first three. The permissions-composition step
has no such probe: nothing in the member registry today records "permissions
were already composed for this member," so that step still issues a real
call on every re-run until such a signal exists to read defensively.

Suggested checkout member names follow a fixed shape:
`<project>-<machine>-<origin-short>[-<roleHint>]`, built by normalizing each
component independently (lowercase, collapse any run of unsafe characters to
a single dash, trim leading/trailing dashes) so an unsafe character in one
component never bleeds a stray dash into a neighboring one. This is only a
suggestion -- the caller may override it, and an existing member is never
renamed to match it.

## Health panel (doc s3.1 S5) and the git drawer (S10, wireframe W3)

The health panel is eight independent, deliberately near-pure checks, each
taking already-fetched inputs (a project row, a cached git-probe row, a
registry record, an already-unwrapped command result) and returning either
one `{id, level, scope, message}` result or nothing at all. Checks that only
ever report an anomaly (a dirty member, a stale probe, an expiring VCS
token) return nothing for a clean/fresh/token-less subject -- a clean member
contributes no row, matching a design that explicitly wants silence for the
common case rather than a wall of "OK" rows to scan past. Exactly one
function in this module does I/O: it gathers every check's inputs and then
calls the checks synchronously, keeping the checks themselves trivially
testable without a live client or store.

The git drawer for one member reads the same cached probe row the overview
reads, optionally re-probing first when the caller asks for a refresh. A
member with no checkout gets a response carrying only its identity/VCS
fields and an explicit "no git checkout" marker rather than error or omit
the row -- the drawer's contract is to always answer, distinguishing "bound,
no checkout" from every other state the same way the overview does.

Both the health panel and the git drawer group members by the same
origin-slug logic the overview uses, sharing the grouping/dirty-bible
helpers rather than each re-deriving "which members share a repo" its own,
potentially-drifting way. This is why "is this member's checkout part of a
real group" is answered consistently everywhere it's asked: there is one
grouping function, not three that happen to agree today.

## Command-string quoting: reject at the edge, then quote unconditionally

Every command string this domain sends to a member is built from two
layers, both mandatory, applied to every caller-supplied value that reaches
a shell command (a checkout directory, a beads directory, a git origin URL,
a beads remote):

1. **Reject at the edge.** Every such value is screened for shell
   metacharacters before it is used, and the whole request is refused
   (naming the offending field and character) if one is found.
2. **Quote unconditionally.** The value is then run through one quoting
   helper that *never* returns a value verbatim -- even a value with no
   metacharacter at all comes back quoted, so no future call site can grow
   an unquoted interpolation by simply forgetting the screening step.

The quoting helper branches on the *target member's registered shell*
rather than assuming POSIX: a POSIX member gets single-quote wrapping with
the `'\''` break-out convention; a PowerShell member gets single-quote
wrapping with `''` doubling. Using the POSIX escape on a PowerShell member
mis-escapes the value -- this is why the branch exists, not just single-quote
wrapping unconditionally. The predicate for "is this member's shell POSIX"
is deliberately re-implemented locally in this package (mirroring the
canonical predicate that lives in the CLI-facing package) rather than
imported, because there is no compile-time link between the two packages;
this makes it a value worth keeping in sync by convention, not a link that
enforces itself.

This two-layer policy is hardening, not a fix for a reachable privilege
escalation: these routes sit behind the same bearer-token boundary as
direct command execution, and a caller who could reach this domain's routes
could already run arbitrary commands another way. The value is defense in
depth and a guard against a *future* regression, not closing an open
exploit.

The same reasoning applies to values that are not caller-supplied on a given
request but were never independently validated either (a project's stored
beads directory, a member's own `BEADS_DIR` env value read back and
reinterpolated into a health check's command) -- those are screened and
quoted on their way into a command string too, turning an invalid stored
value into that check's own failure result rather than a malformed or
dangerous command sent to a member.

## Export/import CLI (DQ-3: export, not a second source of truth)

The export/import CLI treats the store as the single source of truth and
the exported JSON as a portable snapshot of it, not an independent copy that
could drift and be reconciled later. Import is refused outright -- before
any row is touched -- whenever doing so would rewrite a project that a live
run currently holds a member against. The refusal check is deliberately
broader than "does the import file mention a held member": it also covers
members the *target* store's own resident view of the project already has
bound, even when the import file itself is silent about them (for example,
a member bound after the export was taken, or dropped from a hand-edited
export). Checking only the file's own contents would let an import silently
rewrite a project out from under a sprint that is running against it right
now.

A project's original creation timestamp survives an export/import
round-trip by being carried explicitly in the export payload and restored
on import when creating a fresh row, rather than being re-stamped to "now."
The HTTP create route for the same underlying field independently strips
any client-supplied value for it, so the only way to set a non-current
creation timestamp is through this restore path, not through the API -- an
operator cannot spoof a project's apparent age by crafting a create request.

Exit codes are a deliberate, stable three-way contract: a usage error
(missing required arguments, invalid flags) is distinct from an operational
error (an unknown project, a malformed file), which is distinct from an
import refused because of a live run. A caller scripting around this CLI can
therefore distinguish "I gave it bad arguments" from "the operation itself
was refused" without parsing output text.

## Trade-offs and open questions worth knowing about

- **The owner-package identifier this domain stamps on a bound member's
  owner tag was chosen from among several candidate names in play across
  different planning documents.** The constant was reconciled to match the
  one name that was actually independently landed and readable at the time
  (a workflow-package manifest id), specifically because it was the only
  candidate backed by a real, checkable source rather than a name that only
  existed in planning prose. This is recorded as an open question in the
  code itself and needs re-verification once a second, independently-landed
  source for the same identifier exists -- if that source turns out to
  register a different id, every already-written owner tag becomes
  unreadable on the registration side until reconciled.
- **A project's beads-remote probe interpolates an operator-supplied remote
  into a shell command run on a member.** The probe now goes through the
  same reject-then-quote policy described above, which closes the direct
  injection vector; the residual risk is scoped to whatever the operator
  who supplies the remote is trusted to type, not to an arbitrary
  unauthenticated caller.
- **Static guarding against a shell-injection regression currently exists
  for `checkout.mjs` and `health.mjs` (each has a test that statically scans
  its own source for a raw, unquoted interpolation) but not yet for the
  route modules or the export/import CLI** -- including the one route
  module where a real injection defect was previously found and fixed. That
  route module currently has only behavioral test coverage for the fix, not
  a static guard against reintroducing the same shape of bug. Extending the
  static scan to the remaining command-string call sites in this domain (or
  enrolling those files in whatever project-wide guarded-module list
  already exists for a different subsystem) closes this gap.
- **The HTTP routes in this domain have been verified at the unit level
  only** -- every route test runs against a mocked store and a mocked fleet
  client, never against a real running supervisor over HTTP. Nothing in
  this domain has yet exercised a bind, an unbind, a checkout, a health
  check, or the git drawer against a live, deployed instance end to end.
  This is a coverage gap worth closing before this domain is exposed to a
  real operator, not a design decision.
