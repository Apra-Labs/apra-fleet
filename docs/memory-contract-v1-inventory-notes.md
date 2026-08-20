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

- Teardown method names differ (one implementation names it one way, the
  other names it differently). A generated client cannot call teardown
  polymorphically across both without an adapter layer that normalizes the
  name.
- One implementation's `capture` accepts an extra options parameter that the
  interface signature and the other implementation do not have.

Any contract-generation step that walks the interface alone will miss both;
they must be enumerated explicitly.

## A remote (HTTP) query is strictly weaker than an in-process query, in two independent stages

`QueryOptions` declares more optional filter fields than the HTTP client
forwards, and the server-side query handler reads fewer fields still than the
client forwards. The two narrowings are independent and compose: a caller
going through the HTTP provider and the in-tree query endpoint ends up with
noticeably fewer effective filters than a caller holding a direct
`SqliteProvider` reference. Any contract or SLA that says "query supports
filter X" must state which access path (in-process vs. remote) that claim
holds for -- it is not uniform across the two.

One filter field in particular (full-text-search terms) is dropped from the
transport surface *by design*: it is declared internal-only and is reachable
only by in-process callers that hold a provider reference directly (e.g. a
session-priming tool that queries global and project scope providers before
any HTTP boundary is crossed). Treat this as a documented mechanism, not a
bug to fix by wiring it through the HTTP schema and server handler -- forwarding
it would be the wrong remedy, not the right one.

## A sweep root default living inside the provider is not the same as the caller passing an anchor

Where a tool's stated contract is "operates against this repo's path," verify
by checking what the call site actually passes, not by trusting a docstring
or a prior note about it. A caller that names a path only in a comment, while
the real anchoring happens via a no-argument call whose default resolves
inside the provider implementation, means the effective binding point is the
provider's default, not whatever the caller's local variable is named after.
This is easy to get backwards when skimming, and worth re-checking directly
against the call site any time an inventory or contract doc asserts which
side owns anchoring.

## Guard export-style writes by comparing the identity set, not size

A local worktracker export that writes into a repo-committed file (id-based
records, not raw text) must be guarded against silently replacing the
committed record set with a different, unrelated one. A size or line-count
based check is not sufficient: a replacement export can grow in total lines
while still dropping the majority of previously-committed ids and adding a
disjoint set of foreign ones. The correct guard compares the *set of ids*
between the committed file and the new export and refuses (or requires an
explicit opt-in) whenever the new export would drop ids present in the
committed file. This mirrors an existing precedent elsewhere in the knowledge
layer, where a shrinking write requires an explicit opt-in rather than
proceeding silently.

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
client connections if the assigned port happens to fall in a fetch
implementation's hardcoded blocked-port list (ports historically reserved for
other protocols). This is more likely on a host whose OS-configured dynamic
port range starts low enough to overlap that list. The fix is not to read the
bound port earlier (the port is already correctly resolved by the time the
listen callback fires) -- it is to detect that the freshly bound port is on
the blocked list and close-and-relisten on a fresh OS-assigned port until a
non-blocked one is obtained.
