# Memory Contract v1: Inventory Findings and Invariants

This note captures durable findings from inventorying the existing MCP
knowledge-tool surface (`kb_*` and `code_*` tools) as the source of truth for
the memory-contract/v1 skeleton (schemas, method contract, error taxonomy,
round-trip validation). The detailed per-tool tables live in
`memory-contract/v1/INVENTORY.md`; this file records the rationale and
invariants that a table alone does not carry.

## Arbitrate tool count from the registry, not from planning prose

Planning documents and code can disagree on how many tools exist. Do not
trust either number without re-deriving it from `src/services/tool-registry.ts`
(or equivalent registration point) -- that is the actual contract surface a
client will see. Treat any prior count in a plan, proposal, or KB note as a
hint to re-verify, not a fact to propagate into schemas, fixtures, or parity
tests.

## The two MemoryProvider implementations are not interchangeable at the edges

`SqliteProvider` and `HttpKbProvider` both implement the `MemoryProvider`
interface, but two divergences sit outside that interface and will break a
generated binding that assumes polymorphism:

- Teardown method names differ: `SqliteProvider.close()` vs.
  `HttpKbProvider.dispose()`. A generated client cannot call teardown
  polymorphically across both without an adapter layer that normalizes the
  name.
- `SqliteProvider.capture(input, opts?: CaptureOpts)` accepts an extra
  options parameter that the `MemoryProvider` interface signature and
  `HttpKbProvider.capture` do not have.

Any contract-generation step that walks the interface alone will miss both;
they must be enumerated explicitly.

## A remote (HTTP) query is strictly weaker than an in-process query, in two independent stages

`QueryOptions` (`src/services/knowledge/types.ts`) declares 13 optional
filter fields; `HttpKbProvider.query` (`src/services/knowledge/http-provider.ts`)
forwards only 6 of them; the in-tree `/api/kb/query` handler
(`src/commands/kb-server.ts`) reads only 4 of what was forwarded. The two
narrowings are independent and compose: a caller going through the HTTP
provider against that handler ends up with 4 effective filters, not 13, not
6. Any contract or SLA that says "query supports filter X" must state which
access path (in-process `SqliteProvider`, in-process `HttpKbProvider`, or a
live remote query through the handler) that claim holds for -- it is not
uniform across the three.

One filter field in particular, `fts_terms`, is dropped from the transport
surface *by design*: `types.ts` declares it internal-only, structurally
excluded from the request schema and the HTTP surface, and it is reachable
only by in-process callers that hold a provider reference directly --
`kb_session_prime` passes `fts_terms` when querying both the global and
project scope providers before any HTTP boundary is crossed, and
`SqliteProvider` honors it via `orJoinFtsTerms`. Treat this as a documented
mechanism, not a bug to fix by wiring it through the HTTP schema and server
handler -- forwarding it would be the wrong remedy, not the right one.

## A sweep root default living inside the provider is not the same as the caller passing an anchor

Where a tool's stated contract is "operates against this repo's path," verify
by checking what the call site actually passes, not by trusting a docstring
or a prior note about it. Concretely: `kb_freshness_sweep`
(`src/tools/kb-freshness-sweep.ts`) calls `providers.project.freshnessSweep()`
with no argument -- `repoPath` is named only in a comment at that call site.
The real anchoring happens via that no-argument call, whose default resolves
inside the provider implementation, so the effective binding point is the
provider's internal default, not the caller's `repoPath` variable. This is
easy to get backwards when skimming, and worth re-checking directly against
the call site any time an inventory or contract doc (or a prior KB entry)
asserts which side owns anchoring -- an earlier note claiming the caller
anchors the sweep root this way did not hold up against the actual call
site.

## Guard export-style writes by comparing the identity set, not size

The beads issue export (`bd export -o .beads/issues.jsonl`, invoked from
`auto-sprint.js` and then `git add`-ed automatically) must be guarded against
silently replacing the committed issue-id set with a different, unrelated
one. A size or line-count based check is not sufficient: a replacement
export can grow in total lines while still dropping the majority of
previously-committed ids and adding a disjoint set of foreign ones -- that is
exactly the failure mode observed and fixed. The guard (in
`export-shrink-guard.mjs`) instead compares the *set of ids* between the
committed file and the new export and refuses (or requires an explicit
opt-in) whenever the new export would drop ids present in the committed
file. This mirrors an existing precedent in `src/tools/kb-export.ts`, where a
shrinking knowledge-bible export similarly requires an explicit opt-in
rather than proceeding silently.

## Local and CI test runners must reach the same suites

Where a workflow's CI definition invokes a test suite via an explicit
`--prefix` (because the suite's package intentionally is not registered in
the root npm workspaces array, to avoid churning the lockfile), the local
"run everything" script must mirror that same explicit invocation. Otherwise
a contributor validating a change locally gets a false "all green" while CI
alone discovers a real regression -- and any local guard the excluded suite
was supposed to provide (including regression checks for previously-fixed
bugs) is silently skipped outside CI.

## Subprocess-spawning tests need per-test timeouts sized to real subprocess cost, not the framework default

Tests that spawn a real child process (git clone, a shell/PowerShell
invocation, an external CLI init) reliably pass in isolation but flake under
a fully parallel test-suite run purely from host contention -- the work
itself is unchanged, only wall-clock availability is. The fix is a per-test
(or per-file) timeout override sized to realistic subprocess cost under load,
not a global timeout bump and not skipping the test. A test whose assertion
is otherwise sound should not be weakened or skipped to paper over this; it
should be given a timeout that reflects what it actually needs to do.

## OS-assigned ports can land in a client-enforced "blocked port" list

A server that lets the OS assign an ephemeral listening port can still fail
client connections if the assigned port happens to fall in undici's (the
WHATWG-fetch implementation's) hardcoded blocked-port list (ports
historically reserved for other protocols). This is more likely on a host
whose OS-configured dynamic port range starts low enough to overlap that
list -- observed concretely on a host whose Windows dynamic port range
starts at 1024, overlapping several blocked ports. The port itself is not
read prematurely: `server.address()` already resolves the real bound port by
the time the listen callback fires, so that is not the bug. The fix, in
`listenOnPort` (`src/services/http-transport.ts`), is to detect that the
freshly bound port is on the blocked list and close-and-relisten on a fresh
OS-assigned port (`listen(0)`) until a non-blocked one is obtained.
