# ADR: TaskDBModule -- backend-neutral interface contract and second-backend scoping

**Status:** Accepted (design; implementation tracked under apra-fleet-417.2.x)
**Date:** 2026-08-03
**Issues:** apra-fleet-417 (epic), apra-fleet-417.1 (this ADR), apra-fleet-417.2.1 (landed module), apra-fleet-647.1 (sibling VCSModule epic this mirrors)

## Context

apra-fleet-647.1 (VCSModule) scoped multi-provider support from day one: GitHubVCS
and GenericGitVCS ship as concrete implementations, AzureDevOpsVCS / BitbucketVCS /
GitLabVCS are named follow-ons, and the epic carries an explicit acceptance
criterion that adding a new provider requires touching no file under
`packages/apra-fleet-se/fleet-sprint/`. That criterion is enforced in code by the
provider registry at `packages/apra-fleet-se/fleet-sprint/vcs-providers/index.mjs`,
whose header states: "ADDING A PROVIDER IS: write one file next to this one
exporting a descriptor of the shape documented in ./generic-git.mjs, then add it to
BUILT_IN_PROVIDERS below."

apra-fleet-417 (TaskDBModule) had no equivalent. Its design is already
purpose-based (`ensureReady` / `refreshView` / `syncBefore` / `syncAfter` / `flush`
/ `repair` / `status`) and Dolt-specific internals are meant to be hidden behind
that skin per the operator's skin-gut guidance -- but nothing on 417 enumerated a
second concrete backend (Jira, Azure Boards, generic git-issues), nor an explicit
interface-independent-of-Dolt-vocabulary contract of the kind 647.1 has. A search
of the beads DB for Jira / Azure DevOps / task-tracker beads returned zero hits.

This ADR equalizes that asymmetry. It is a design artifact only: it changes no
code, and in particular does not edit `runner.js`.

**Filename note (read this before implementing).** apra-fleet-417's notes propose
`task-db-sync.mjs` exporting `createTaskDbSync(deps)`. What actually landed
(commits 1734bfb, 4d39090) is `packages/apra-fleet-se/fleet-sprint/dolt-sync.mjs`
exporting the `DoltSync` object. The real path is `dolt-sync.mjs`; 417.2.x should
follow the file that exists, not the file the notes predicted. Under the decision
below, that file is understood as *the Dolt/beads adapter*, and the neutral
interface it satisfies is the TaskDBModule contract named here.

---

## Decision 1: option (b) -- named interface contract, no stub second backend yet

apra-fleet-417.1 offered two options: (a) land a second, even-stub concrete TaskDB
implementation now, mirroring GenericGitVCS's role for 647.1, or (b) at minimum
record an explicit acceptance criterion and a named, backend-neutral interface
contract so a future Jira / Azure-Boards / generic-git-issues implementation is a
matter of writing one new concrete module.

**We choose (b).** Rationale: the two epics are at different maturity points and a
stub bought at this moment would be an unfalsifiable one. 647.1's GenericGitVCS is
load-bearing today -- it is dispatched at runtime by `classifyFailure()` through a
registry that already exists, so it *proves* the seam by being exercised. The
TaskDB seam has no registry and no dispatch point yet: `dolt-sync.mjs` landed as an
explicitly no-behavior-change consolidation, and the degraded-path / ledger
semantics that give the interface its shape (`refreshView`'s inconclusive result,
`flush`'s dirty-clone retry, `repair`'s ladder) are still being built under
417.2.x/417.3.x. A stub JiraTaskDB written against a not-yet-final interface would
be dead code that nothing calls, that no test can meaningfully assert against, and
that would need rewriting the moment the ledger contract settles -- the opposite of
the evidence a second implementation is supposed to provide. Instead we fix the
vocabulary and the extensibility criterion now, while the interface is still cheap
to name correctly, and defer the concrete second backend to the point where the
registry seam exists to plug it into (see Decision 4). Nothing in this decision is
one-way: option (a) remains available and its cost does not grow, because the
contract it would implement is written down here.

---

## Decision 2: the TaskDBModule interface, in backend-neutral vocabulary

The contract below is the TaskDBModule interface. **No `dolt` term appears in any
interface method name or parameter name.** "Dolt", "beads", "bd", "issues table",
"remote", "pull" and "push" are vocabulary of *one adapter* and must not leak into
the contract.

| Method | Parameters | Returns | Meaning (backend-neutral) |
|---|---|---|---|
| `ensureReady()` | none | `{ ready, degraded? }` | Sprint-start gate. Bring the local view of the task store into a usable state before any work is dispatched. The one method permitted to refuse to start. |
| `refreshView(opts)` | `{ purpose }` | `{ fresh, degraded? }` | Make the local view current before the orchestrator reads task state. Never throws; `fresh:false` means reads are possibly stale, so callers treat verification as INCONCLUSIVE rather than failed. |
| `syncBefore(worker, opts)` | `worker`, `{ skipRefresh, readinessGate }` | `{ ok, degraded? }` | Freshen the view owned by `worker` before it is read from or dispatched. Never throws. |
| `syncAfter(worker, opts)` | `worker`, `{ mutatedItemIds }` | `{ published, degraded? }` | Publish the task mutations `worker` made, serialized against concurrent writers, with one bounded reconcile. Never throws. |
| `flush()` | none | `{ published, degradations[] }` | End-of-run: attempt publication for every view still marked unpublished, then return the degradation report the terminal summary is built from. |
| `repair(worker)` | `worker` | `{ repaired, escalation? }` | Explicit remediation entry point: recovery ladder plus credential re-provisioning. Called by operators/tools and by `ensureReady()`; never inline from a per-operation sync path. |
| `status(worker)` | `worker` | ledger snapshot | Read-only probe. Issues no backend command and never throws. |

Failure taxonomy carried in `degraded.kind` (also backend-neutral, and the direct
analogue of 647.1's `classifyFailure()` kind set):
`transient`, `auth`, `conflict-resolvable`, `conflict-unresolvable`,
`store-unreachable`, `no-store`, `coordination-unavailable`, `unknown`.
A `capabilities()`-style descriptor (647.1's other half) declares which of these a
backend can ever produce, plus the booleans `wholeStatePublish`, `supportsRepair`,
`supportsCoordinationLock` -- so callers ask the backend what it can do instead of
assuming Dolt semantics.

### Renames this contract requires

Two parameter spellings in apra-fleet-417's proposed shape are backend-flavored and
are corrected here, because a neutral method name with a backend-flavored parameter
is not a neutral interface:

| 417 notes | This contract | Why |
|---|---|---|
| `syncBefore(member, { skipPull })` | `syncBefore(worker, { skipRefresh })` | "pull" is git/Dolt vocabulary; a Jira adapter has nothing to pull. |
| `syncAfter(member, { mutatedBeads })` | `syncAfter(worker, { mutatedItemIds })` | "beads" is the current backend's product name. |
| `syncBefore(member, { healthGate })` | `syncBefore(worker, { readinessGate })` | Aligns with `ensureReady()`; "health gate" is beads-DB-specific phrasing. |

### Interface versus adapter: what the landed module already says

`dolt-sync.mjs` is the **Dolt/beads adapter**, not the interface. Its
Dolt-vocabulary exports -- `classifyDoltFailure`, `doltPullBefore`,
`doltPushAfter`, `preflightBeadsHealthGate`, `extractDoltRemoteUrl`, and the
`DoltSync` object name itself -- are adapter internals and are *not* part of the
TaskDBModule contract. The module header already draws exactly this line, and this
ADR adopts it verbatim as the interface/adapter split:

> "runner.js keeps only purpose-level calls (syncBefore / syncAfter / status); the
> mechanics live here."

and

> "The lower-level primitives (doltPullBefore / preflightBeadsHealthGate /
> doltPushAfter / classifyDoltFailure / extract*) stay exported because the unit
> suites drive them directly and 417.2.2 migrates call sites onto the purpose-based
> API incrementally; they are IMPLEMENTATION DETAIL of the three entry points
> above, not a second supported surface."

A reviewer grepping `dolt-sync.mjs` will therefore find `dolt` in exported symbol
names. That does not violate this ADR: the criterion is that no `dolt` term appears
in the *interface* method or parameter names, and the interface is the seven-method
table above. Enforcement is the guard test described in Decision 4, which pins the
caller-visible surface, not the adapter's internals.

---

## Decision 3: the named second backend candidate, method by method

**Jira** is the primary named second-backend candidate; generic git-issues (issues
as files in the repo) is the secondary. Jira is chosen for the design walk-through
precisely because it is the hostile case: it is a remote-first API with no local
clone, therefore no whole-state publish, no divergence, and no merge conflict. If
the contract survives Jira, it is not Dolt-shaped.

| Method | What a JiraTaskDB must implement | What a GenericGitIssuesTaskDB must implement |
|---|---|---|
| `ensureReady()` | Validate base URL, project key and credentials with one cheap authenticated call (e.g. fetch the project). Returns `ready:true`, or `degraded.kind:'auth'` / `'store-unreachable'`. No local state to reconcile. | Clone/fetch the issues repo; ensure the working tree is clean. Can return `conflict-*`. |
| `refreshView({purpose})` | No-op that returns `{ fresh: true }`: every read is a live API call, so the view is never stale. May optionally invalidate a request cache. Returns `degraded.kind:'transient'` on a 5xx/timeout. | `git fetch` + fast-forward; `fresh:false` on failure. |
| `syncBefore(worker, {skipRefresh})` | No-op returning `{ ok: true }` -- workers read Jira directly, there is no per-worker clone to freshen. `skipRefresh` is honored trivially. | Fetch into the worker's checkout. |
| `syncAfter(worker, {mutatedItemIds})` | The substantive method. Apply each mutation as a REST transition/update call against the ids in `mutatedItemIds`; retry `transient` with backoff; on 401/403 re-provision the credential once and retry; on 409 re-read the issue and re-apply (Jira's optimistic-concurrency analogue of reconcile). Never throws; partial failure marks those ids unpublished in the ledger. | Commit and push; on non-fast-forward, rebase once and re-push -- `conflict-resolvable`, escalating to `conflict-unresolvable`. |
| `flush()` | Retry only the item ids still marked unpublished. There is no whole-state publish, so unlike the Dolt adapter a later success does NOT implicitly carry earlier failures -- the ledger must be per-item. This is why `mutatedItemIds` is in the contract at all, and why `capabilities().wholeStatePublish` exists. | Single push publishes all pending commits; `wholeStatePublish: true`. |
| `repair(worker)` | Reduces to credential re-provisioning plus a connectivity re-test; there is no recovery ladder because there is no local wedged state. Returns `repaired:true/false`, never an escalation dump. | Re-clone the issues repo (the Path-B analogue). |
| `status(worker)` | Return the ledger snapshot plus last known API reachability. Issues no network call. | Same, plus working-tree cleanliness. |
| `capabilities()` | `{ wholeStatePublish: false, supportsRepair: 'auth-only', supportsCoordinationLock: false, kinds: ['transient','auth','store-unreachable','unknown'] }` -- `conflict-resolvable`, `conflict-unresolvable`, `no-store` and `coordination-unavailable` are unreachable for this backend. | `{ wholeStatePublish: true, supportsRepair: true, supportsCoordinationLock: false, kinds: [all] }` |

The exercise surfaces exactly one place the Dolt adapter's physics had leaked into
417's design -- the "a failed publish needs no queue, because the next successful
whole-DB push carries it" reasoning. That is a Dolt property, not a contract
property. The contract therefore takes `mutatedItemIds` and keeps a per-item
ledger; the Dolt adapter is free to ignore the ids and rely on whole-state publish,
declaring `wholeStatePublish: true`.

---

## Decision 4: the extensibility acceptance criterion (the 647.1 equivalent)

The criterion, stated explicitly and adopted as an acceptance criterion of
apra-fleet-417:

> adding a new task-tracking backend requires touching no file under
> packages/apra-fleet-se/fleet-sprint/ other than adding one new concrete module.

Mechanically this means, mirroring `vcs-providers/index.mjs`: a
`task-db-backends/` directory holding one file per backend (the existing Dolt/beads
adapter being the first, re-exported from `dolt-sync.mjs`), a manifest module with
an explicit static import list -- not a directory scan, because this package is
bundled into a single executable by `npm run build:binary` and a runtime `readdir`
of the source tree does not exist there -- and a runtime `registerTaskDbBackend()`
for out-of-tree and test backends. Adding a backend is then: write one file
exporting the seven-method descriptor above, and add one line to the manifest.
Selecting one is a configuration/registry resolution, never an edit to `runner.js`,
which under the 417 design contains zero backend literals.

Enforcement, mirroring 417's no-new-call-sites guard: a static guard test asserts
that `runner.js` references only the neutral method names on the module handle, and
that no file outside the backend's own module spawns that backend's commands. That
guard is what makes this criterion testable rather than aspirational; it lands with
the registry, under 417.2.x. Until the registry exists, this criterion is a
design-time obligation on 417.2.x, not a claim about today's tree.

---

## Consequences

- 417.2.x builds the module against the neutral names and parameter spellings in
  Decision 2, including the three renames.
- The Dolt vocabulary in `dolt-sync.mjs` is confined to the adapter and may not
  appear in the caller-visible surface.
- The concrete second backend (option (a)) is deferred, not dropped: it becomes a
  one-file task once the `task-db-backends/` registry lands.
- If a future backend cannot be expressed in the seven methods above, that is a
  contract bug and this ADR is amended -- the backend is not special-cased in
  `runner.js`.
