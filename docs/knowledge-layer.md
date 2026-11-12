# Knowledge Layer

The Knowledge Layer gives every agent a persistent, structured memory across
sessions. Instead of re-reading the same files at the start of each run, an
agent primes its session from the KB and only reads files that have changed.

---

## Architecture Overview

The layer has two planes:

```
+---------------------------+      +---------------------------+
|   KB Service (Memory)     |      |  Codebase Plane (GitNexus)|
|                           |      |                           |
|  MemoryProvider interface |      |  AST-level codebase graph |
|  - SqliteProvider (local) |      |  - symbol definitions     |
|  - HttpKbProvider (http)  |      |  - call graphs            |
|                           |      |  - file impact analysis   |
|  16 kb_* MCP tools:       |      |  MCP server: npx gitnexus |
|  kb_capture  kb_query     |      |  Fleet proxies 7 of its   |
|  kb_context  kb_invalidate|      |  tools: code_graph,       |
|  kb_session_prime         |      |  code_impact, code_query, |
|  kb_promote  kb_harvest   |      |  code_context, code_map,  |
|  kb_setup    kb_export    |      |  code_flow, code_tests    |
|  kb_import   kb_list      |      |                           |
|  kb_stats    kb_feedback  |      |                           |
|  kb_freshness_sweep       |      |                           |
|  kb_reconcile_prefilter   |      |                           |
|  kb_resolve_contradiction |      |                           |
+---------------------------+      +---------------------------+
            |                                   |
            +-------------- LLM --------------- +
                      (orchestrates both planes)
```

**KB Service (Memory plane)**: stores learned knowledge -- context-cache entries,
learnings, runbooks, and knowledge -- in a SQLite database. The `MemoryProvider`
interface lets the backend be swapped with no code change.

**Codebase Plane (GitNexus)**: an AST-level graph of the repository. Provides
structural context that the KB does not store: symbol definitions, call graphs,
file impact chains. GitNexus is an MCP server the LLM calls directly.

The two planes are **independent**. `kb_session_prime` returns a list of
`recommended_gitnexus_calls` that the LLM should dispatch after priming the KB.
Neither plane calls the other -- the LLM orchestrates both.

---

## MemoryProvider Abstraction

All KB tools operate through the `MemoryProvider` interface
(`src/services/knowledge/types.ts`):

```typescript
interface MemoryProvider {
  init(): Promise<void>;
  capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }>;
  query(opts: QueryOptions): Promise<KBResult>;
  context(files: string[]): Promise<FileContextResult[]>;
  invalidate(files: string[]): Promise<{ invalidated: number }>;
  getLinked(id: string): Promise<KBEntry[]>;
  prime(opts: PrimeOptions): Promise<PrimedContext>;
  promote(id: string, reason?: string): Promise<...>;
  sync(opts?: SyncOptions): Promise<SyncResult>;
}
```

Two concrete implementations exist:

| Provider | Module | Use case |
|----------|--------|----------|
| `SqliteProvider` | `src/services/knowledge/sqlite-provider.ts` | Default. Local SQLite, zero config. |
| `HttpKbProvider` | `src/services/knowledge/http-provider.ts` | Shared central server for a team. |

`getKbProviders(repoPath)` (`src/services/knowledge/kb-providers.ts`) is the
single accessor every KB tool goes through to reach a provider. It is the only
place in the codebase that resolves a repo to its database -- there is no
second entry point. Run `kb_setup` to write the local config. That config is
install-wide: one `FLEET_DIR/knowledge/config.json` selects the provider for
every repo this fleet install serves (`kb_setup` only places the
git hook), even though each repo's entries stay in their own KB -- see below.

---

## Per-repo KB isolation

The fleet server is one long-lived process that serves many members working
in many different repos, so nothing about the server's own working directory
can identify which repo a given tool call is about. No `kb_*` tool takes a
scope argument. Instead the KB a call reads or writes is derived from **who
is calling** -- the calling session's "self" (below).

**The removed scope keys are refused, not ignored.** Before the redesign every
`kb_*` tool took `repo_path` and `repo_remote_url` (`kb_stats` and `kb_import`
also took `repo`). An MCP server built from a zod shape strips undeclared
keys before the handler runs, so simply deleting them would have silently
re-pointed an existing caller at a different KB. Instead every `kb_*` input
schema still declares the three keys, described as `REMOVED`
(`KB_REMOVED_SCOPE_KEYS_SHAPE`, `src/services/knowledge/kb-removed-scope-keys.ts`),
and the `kb_*` tool wrapper in `src/services/tool-registry.ts` refuses any call
carrying one (any value but absent/undefined) with `E-SCOPE-KEY-REMOVED`
before any KB is resolved or opened. The message names every removed key
present and what replaces it (nothing: drop it -- a member session acts on
its registered work folder, a remote member's KB identity is its registered
origin remote, and a FULL session acts on its first client root inside a git
repository with an origin, or the server's working folder when the client offers
no roots;
`kb_import` keeps `path` for naming a bible file).

- **Member session** (`?member=<uuid>` or a member JWT): the member's
  registered work folder. The session's member id travels from the HTTP
  transport to the handler through an `AsyncLocalStorage` lane
  (`src/services/tool-scope.ts`), so handlers never receive it as a parameter.
- **Full session** (no member identity): the MCP client's roots
  (`roots/list`). The first offered root inside a git repository with an
  origin remote wins, and stands for that repository's top level, so a client
  opened in a subfolder is scoped to the repository -- for both `kb_*` and
  `code_*`, so one session never scopes its kb and code tools to two different
  repositories. The fleet server's own working folder (`process.cwd()`) is used
  only when the client offers no roots (it lacks the `roots` capability or
  returns an empty list). When roots are offered and none qualifies the call is
  refused, never answered from the server folder, which may be an unrelated
  repository. That includes roots that are not folders on the server's host: a
  remote HTTP client's roots are paths on its own machine, so such a client calls
  from a member session instead.
  A server auto-started with an
  unrelated working folder (e.g. a system directory) therefore works from any
  client opened in a repository.

  Roots are fetched once per session, on its first `kb_*`/`code_*` call,
  through that call's own request (`src/services/session-roots.ts`), cached,
  and refetched after `notifications/roots/list_changed`. A failed or
  timed-out fetch is not "no roots": the call is refused with
  `E-SELF-NO-WORKFOLDER` naming the failure, nothing is read or written, and
  the next call asks again. The selection is made once per call (`resolveSelfSession()`,
  memoized in the tool-call context) and shared by kb (self) and code (self).
  A member session never reads roots.

  **Extension for `code_*` only** (not part of the base rule): a code index
  needs no origin remote, so when roots are offered and NONE is in a git
  repository with an origin, `code_*` falls back to the first offered root in a
  git repository. `kb_*` calls in that session fail with
  `E-SELF-NO-REMOTE` naming that no offered root has an origin remote, so kb
  and code still never resolve to two different repositories.

  When neither works, the error names the missing piece: roots were offered
  but none is a folder on this host (`E-SELF-NO-WORKFOLDER`), none is in a git
  repository (`E-SELF-NOT-A-REPO`), or none has an origin (`E-SELF-NO-REMOTE`, kb
  only), asking for the roots failed (`E-SELF-NO-WORKFOLDER`), or the client offered no
  roots and the server folder is not a git repository / has no origin
  ("This is a FULL session (no member identity) and the client offered no MCP
  roots, so its scope is the fleet server's own working folder, ...").

`resolveSelfAnchor()` (`src/services/knowledge/kb-self.ts`) performs the
resolution and `getSelfKbProviders()` feeds the result to `getKbProviders`.
KB identity comes from the folder's origin remote, so a folder that is
missing, not a git repository, or without an origin remote is refused with a
typed error carrying a one-line remediation, never silently mapped to a
directory-name or `default` KB:

| Code | Meaning | Remediation (member session) |
|------|---------|------------------------------|
| `E-SELF-NO-WORKFOLDER` | the work folder is unset, missing or not a directory | create the folder, or re-register the member with an existing work folder (`register_member` / `update_member`) |
| `E-SELF-NOT-A-REPO` | the folder is not a git repository | run `git init` (or clone the project) there and add an origin remote |
| `E-SELF-NO-REMOTE` | no origin remote (or, for a remote member, no single known origin URL) | run `git remote add origin <url>` there; for a remote member, record the origin on the member (`update_member git_repos: ["<origin url>"]`) or call from a session on the member's own host |

For a FULL session on the server-folder path every remediation leads with the
same fixes: open the client in the intended repository (a client that offers
MCP roots), restart the fleet server with its working folder set to it, or
call from a member session of a member registered on it (then, as applicable,
make that folder a git repository with an origin remote). The error text is
`<code>: <problem> Remediation: <fix>`, one line.

**Remote members.** A remote member's work folder is a path on another host,
so git cannot be shelled out for it. Its KB identity is the single origin URL
recorded on the member (`knownRepoRemoteUrl`, set via `update_member
git_repos`), and the folder is passed through verbatim as the anchor. KB
tool calls for such members are executed on the member itself (see
[Member-session tool calls](#member-session-tool-calls)).

**In-process callers may pass an explicit anchor.** Callers that already know
exactly which repo they mean (the `execute_prompt` post-dispatch harvest, the
`kb commit` CLI) pass a `KbAnchor` as the handler's *second* argument. It is
not part of any tool input schema, so no MCP client can supply it.

Every `kb_*` tool description carries a shared note (`KB_SELF_NOTE`) stating
that scope is the calling session's own KB, that the removed scope keys fail
with `E-SCOPE-KEY-REMOVED`, and listing the three self-resolution error codes.

**Provider caching is keyed by (slug, repoPath), not slug alone.** Two callers
that resolve to the same project slug but different anchors get distinct
provider instances, each anchored at its own `repoPath`. `repoPath` is
load-bearing: it is the root the capture basis check and the freshness
re-hash resolve relative `source_files` against. Keying on slug alone let the
first caller fix the anchor for everyone. Concurrent calls for the identical
pair still share one provider. The global KB has exactly one instance and its
own single-slot cache.

**Slug resolution must not confuse "no auth" with "no host".** The slugifier
strips a userinfo prefix from HTTPS remotes (`user@` in
`https://user@host/...`) but must bound that strip to the authority section
of the URL; an unbounded strip on a plain HTTPS remote consumes the rest of
the string and collapses the slug to empty. Plain-HTTPS and SSH remotes for
the same repository must slugify to the same value.

**A non-existent anchor is never replaced by `process.cwd()`.**
`getKbProviders(cwd, remoteUrl)` uses `process.cwd()` only when `cwd` is
omitted entirely; an explicit `cwd` that does not exist on this host (the
normal case for a remote member) is used as-is. Because such an anchor cannot
verify anything about this host's tree, `SqliteProvider` suppresses freshness
verdicts entirely when its anchor is missing (`anchorIsMissing()`), at both
prime and sweep: otherwise every relative basis path would fail to resolve
and the whole batch would be marked stale against a tree never checked.
Suppression is all-or-nothing per call. Capture needs no equivalent guard:
`assertCheckableBasis` already fails closed. `kb_export` and `kb_import` need
a real local directory (to write or locate the bible file), so they still
validate the resolved folder and fail hard rather than degrade.

**The single-accessor invariant is enforced textually, not structurally.** A
source-level guard checks that no code path calls the deleted service-style
accessor or `getKbProviders()` with no argument. It cannot catch a
*different* route to a provider, such as constructing a provider class
directly with no explicit path -- that still falls back to `process.cwd()`.
Any new provider-construction site must take an explicit repo path from its
caller; do not rely on the guard test alone.

### Read defaults

`kb_query`, `kb_list` and `kb_session_prime` default to CONFIRMED, undisputed
entries only. `confidence` is a list input, so a caller wanting other tiers
names them explicitly; internal callers that need UNVERIFIED or INFERRED
entries (e.g. reconcile and prime paths) pass an explicit list. `flagged_only`
is exempt from the default because its purpose is to surface disputed entries.

**`kb_list` also accepts the legacy single-tier string.** Before the redesign
`kb_list`'s `confidence` was one tier as a string (`"INFERRED"`); it is now a
list. Both forms are accepted: a string is read as the one-element list, so
`{ confidence: "INFERRED" }` and `{ confidence: ["INFERRED"] }` return the
same result (and, being an explicit tier, both opt out of the dispute filter).

**`kb_context` defaults to CONFIRMED + INFERRED (decision).** Its default
tier set is `["CONFIRMED","INFERRED"]`, undisputed (`KB_CONTEXT_DEFAULT_CONFIDENCE`,
`src/tools/kb-context.ts`, pinned by `tests/knowledge/kb-confidence-default.test.ts`).
`kb_context` answers only "is my cached summary of this file still current?",
and a context-cache entry's freshness is decided mechanically by its content
hash against the file on disk -- not by trust in its claims. `kb_capture`
stores at most INFERRED and context-cache entries are rarely promoted, so the
CONFIRMED-only default reported almost every file missing. UNVERIFIED
(harvest output) stays opt-in. In a MEMBER session the default read merges
the member's checkout bible (CONFIRMED) with the member's own
CONFIRMED/INFERRED captures from the per-repo DB (tagged
`member:<caller uuid>`), so it never exposes another member's captures; its
global-KB fallback stays CONFIRMED-only. An explicit confidence list is split
the same way for `kb_query`, `kb_list`, `kb_context` and `kb_session_prime`:
CONFIRMED from the checkout bible, INFERRED/UNVERIFIED only from the member's
own captures, merged for a mixed request.

**Mixed-tier split read (invariants).** The split lives in one helper
(`getMemberSplitRead` / `mergeSplitById`, `src/services/knowledge/kb-self.ts`)
shared by all four read tools. It applies only to a member session whose tier
list names CONFIRMED plus at least one other tier. FULL sessions, explicit-anchor
callers, CONFIRMED-only reads and reads naming only non-CONFIRMED tiers keep
their previous path. The CONFIRMED half is the checkout bible plus the untagged
global KB; the other half is the per-repo DB and global KB filtered to
`member:<caller uuid>` and asks for every requested tier, CONFIRMED included,
so the member's own capture promoted to CONFIRMED in the per-repo DB is
returned before it reaches the bible. Results merge by id and the bible copy wins on a
duplicate. Under the http project provider the split still applies, with the
KB server in place of the per-repo DB: the own half is the server, owner-tagged
(checked by fleet on the entry tags the server returns). The CONFIRMED half is
the KB server too, for every read tool (`kb_query`, `kb_session_prime`,
`kb_context`, `kb_list`): the bible is not used under http. A mixed read over http therefore has the same shape as over SQLite
and never shows another member's unconfirmed captures. One difference follows
from the store, not the split: on the server the member's own promoted capture
is part of the CONFIRMED set, so it arrives in the CONFIRMED half (and counts
toward `kb_session_prime`'s cold-seed threshold). Any other non-sqlite per-repo
KB is refused with a typed error naming the tool. Known limits: with a `limit`, a mixed `kb_list` sorts by id before
limiting, so it is not guaranteed to be a superset of the CONFIRMED-only list at
the same limit (`kb_query` keeps the bible half first). The tool descriptions, the memory-contract bindings and spec, and a
wording test must all describe this scope together.

### Member-session tool calls

A member session sees a reduced tool list. The allowlist lives in one
dependency-free module (`src/services/member-tool-allowlist.ts`) and is an
explicit list (`MEMBER_BASE_TOOLS`), not a `kb_`/`code_` prefix rule: every
`code_*` tool, `version`, `report_status`, `session_stats`, and the `kb_*`
tools that do not mint CONFIRMED or administer the KB. A newly registered
`kb_`/`code_` tool is NOT member-visible until it is added there on purpose.
Enforcement is deny-by-omission: the tool registry's proxy simply does not
register tools outside the scope for that session (calling one is an
unknown-tool error), and an unregistered `?member=` id is rejected with 403
by the HTTP transport. The `agy` provider's member tool lists and the Claude
deny rules are derived from the same allowlist.

The KB write policy for member sessions:

| Tool | Member session |
|------|----------------|
| `kb_setup` | never (it writes the install-wide provider config and stores credentials) |
| `kb_export` | never (it auto-commits into the work tree) |
| `kb_promote`, `kb_resolve_contradiction`, `kb_reconcile_prefilter` | only the kb_maintainer session (they mint CONFIRMED) |
| `kb_import` | yes; but an explicit `path` (other than the session's own `.fleet/kb-canonical.json`) needs the kb_maintainer grant, else it is refused with `E-KB-MAINTAINER-REQUIRED`; without the grant the own bible is read as committed at `HEAD` (never the work-tree file), with no committed copy nothing is imported (`E-KB-MAINTAINER-REQUIRED`), and a committed bible whose git blob id the maintainer side never recorded (via `kb_bible_commit` or a FULL / kb_maintainer `kb_import`) is refused the same way with nothing imported (see kb-trust-model.md) |
| `kb_invalidate` | yes; but without the kb_maintainer grant it never retires a CONFIRMED entry (by `ids` or `files`) -- those ids are left untouched and listed in `refused` |
| `kb_capture` | yes; but without the kb_maintainer grant `supersedes` never retires a CONFIRMED entry -- the capture links to it (`refines`, both live) and lists it in `refused` |
| every other `kb_*` (incl. `kb_bible_commit`) | yes |

The kb_maintainer session is a member session the sprint engine opens with
its kb_maintainer grant: `origin=engine&kb_maintainer=1` on the member URL
(`connectFleetMember(id, { origin: 'engine', kbMaintainer: true })` locally,
`apra-fleet call --kb-maintainer` on a remote member). The engine opens it
only for the member it chose as a repository's kb_maintainer, to apply the
reviewer's promotions and the bible commit there. `kb_maintainer=1` without
`origin=engine` is ignored. Agent sessions on a member -- including on the
maintainer -- use the plain `?member=<uuid>` entry, so they never see
`kb_promote`, `kb_resolve_contradiction` or `kb_reconcile_prefilter`: a role reports promotions in its
output and the engine applies them. The grant is an unauthenticated loopback
URL parameter like `?member=` itself: it keeps agent sessions off the
CONFIRMED-minting tools, it is not a security boundary against a local
process, which can always open a FULL session. A FULL session (no member
identity) sees every tool.

The per-folder MCP entry that gives a member this scoped session, and its
install/verification flow, are described in
[member-fleet-mcp-wiring.md](member-fleet-mcp-wiring.md); code tool readiness in
[code-index-readiness.md](code-index-readiness.md).

Per-member call counts: the server counts every `kb_*` and `code_*` call
made from a MEMBER session against that member's uuid, aggregated across all
of its sessions, in memory (`src/services/member-call-counts.ts`, recorded in
the tool registry's shared handler wrapper). `session_stats` returns
`{ member_id, since, kb, code, total, tools }` for the calling member (a FULL
session must pass `member_id`). Sessions opened with `origin=engine` on the
MCP URL -- set only by the engine's `memberCall` (via
`connectFleetMember(id, { origin: 'engine' })`) and the `apra-fleet call`
verb -- are not counted, so the engine's own reads (including the
`session_stats` snapshots it takes around each dispatch) never inflate a
member's numbers. `since` is the counter start (server process start); a
change between two snapshots means the server restarted.

The `apra-fleet call` CLI verb (`src/cli/call.ts`) lets a process on a member
host call a tool as that member: arguments come from a file only (never the
command line) and failures are typed errors. The engine's `memberCall`
helper runs a local member's call in-process and a remote member's call by
`send_files` of the args file plus `execute_command` of the verb, using a
charset-validated command string; it is the path all engine KB calls take.
The client's `connectFleetMember` and `close()` release the session with an
HTTP `DELETE`. Consequences: a remote member needs `apra-fleet` installed and
registered on it (see `apra-fleet install --member`) or its KB calls fail
(logged as non-fatal), and each remote KB call costs one file transfer plus
one command execution -- captures are not batched. The args file is staged
under `.apra-call/` in the member's work folder, which sits inside its git
checkout, so the engine must never leave it behind as untracked content:
before the first send to a member it appends `.apra-call/` to the checkout's
git exclude file (resolved with `git rev-parse --git-path info/exclude`, so
subdirectories and linked worktrees work; idempotent; a no-op outside a git
repo), and after every call, whatever its outcome, it deletes the args file.
A failed exclude or delete is logged and never masks the call's own result.
Both operations are built per member shell (POSIX and PowerShell
`-EncodedCommand`) from strictly validated relative paths that are rejected,
never escaped. This adds one to two extra command round trips per remote call.
Short-lived tool-only
member sessions register in the session registry when no live channel
session exists, so they can briefly appear as the member's online session.

---

## Trust model (enforced)

Every entry carries a confidence tier and moves up a mostly-one-way ladder:

```
UNVERIFIED  ->  INFERRED  ->  CONFIRMED
```

Exactly one rung of that ladder is also reversible: `kb_demote` lowers a
CONFIRMED entry back to INFERRED (never a ladder in its own direction, and
never below INFERRED) -- see
[kb-trust-model.md](kb-trust-model.md#kb_demote-is-the-only-way-back-down-and-only-one-rung)
for the full rule, the one case it is for, who can demote what, and the bible
tombstone mechanism that carries a demotion across clones.

- `UNVERIFIED` -- extracted but unchecked (auto-harvested from a transcript, a
  raw session insight). Lowest trust.
- `INFERRED` -- verified by reading source, or captured deliberately. Default,
  and the ceiling for `kb_capture`.
- `CONFIRMED` -- the reviewer approved the code the entry describes. Highest.

**The clamp is enforced at two layers.** `kb_capture` clamps any incoming
`CONFIRMED` down to `INFERRED` in the tool handler (returning
`confidence_clamped: true` and appending a note to content -- the user-facing
signal; the flag is also true for a user-directive, which is stored UNVERIFIED
as a pending proposal, and in general whenever stored confidence differs from
requested). But the HTTP route `POST /api/kb/capture` calls `provider.capture()`
directly and bypasses the handler, so the same clamp is ALSO enforced inside
`SqliteProvider.capture()` -- the choke point every route shares. The handler
clamp is UX; the provider clamp is enforcement. No route can mint `CONFIRMED`
through capture.

**`kb_promote` is the sole path to `CONFIRMED`.** It steps an entry up exactly
one rung and appends the reason as an evidence trail. The workflow is therefore
always capture-at-INFERRED, then promote-after-review.

**User directives are the one exemption, and they are quarantined.** A
`type='user-directive'` entry (a standing instruction: "always do X", "we
decided Z") is the only type that can hold `CONFIRMED` without promotion. But
the directive gate in `capture()` forces every incoming directive to a pending
proposal first -- UNVERIFIED + `flagged_for_review` + tag `directive:pending` +
scope `project`, never surfaced by default retrieval. Activation is CLI-only
(`apra-fleet kb approve-directive`); no MCP/HTTP route and no bible import can
activate a directive. This is the unforgeable tier.

The two capture-level exemptions to the clamp are: (1) `kb_promote` (a separate
method, not capture), and (2) import mode inside `capture()` for the bible
channel -- an INTERNAL parameter that no deserialized route can set (the HTTP
route passes exactly one argument; the MCP handler builds input from zod-parsed
fields). `capture()` additionally NORMALIZES the `source` field: a
caller-supplied `source='import'` or `'promotion'` arriving via a deserialized
body is overwritten unless the internal import mode is actually engaged, so
forged trusted-channel provenance is impossible.

See [kb-trust-model.md](kb-trust-model.md) for the ladder in full.

---

## The canonical bible

The SQLite database is one developer's private, warm working memory. The
**canonical bible** is the team's shared, git-native slice of it:

- `kb_export` merges `CONFIRMED`, non-superseded, non-stale PROJECT entries
  into `<repo>/.fleet/kb-canonical.json`, additively. An entry qualifies only
  when every file it cites has a recorded per-file hash (`source_file_hashes`)
  matching that file's content at the repo's HEAD commit (the git blob id of
  `HEAD:<path>`, the same digest `git hash-object` stored at capture); an
  empty basis or a file absent at HEAD excludes it. Uncommitted edits in the
  work tree never change the verdict, and a folder that is not a git work
  tree is refused (no fallback to hashing disk).
  `kb_bible_commit` applies the same rule. `kb_export` is purely additive:
  entries already in the bible are never removed or rewritten (the bible
  entry wins on an id clash); when nothing new qualifies the file is left
  byte-identical and nothing is committed.
- `kb_bible_commit` additionally removes bible entries that the maintainer's
  KB holds as superseded or invalidated, and lists each removal in both its
  response and the commit message. Removals therefore land only when the
  engine runs a commit round; a round with no new confirmations is skipped, so
  a removal waits for the next promotion round.
- Format v3: each entry carries a stable field set -- `{id, type, title,
  summary, symbols, source_files, source_file_hashes, confidence,
  updated_at}` -- id-sorted for meaningful diffs and ASCII-escaped so it
  honours the repo's ASCII-only rule. `source_file_hashes` is the stored
  basis, so freshness travels with the knowledge across clones. Both writers
  refuse duplicate ids. `kb_import` keeps a carried basis verbatim; v1/v2
  entries get a local freshness-only basis (`local_basis_only`) hashed from
  the importing clone, so they still go stale when code drifts, but it is
  never exported or used for admission, so they cannot be re-admitted until
  recaptured.
- A folder that is not a git work tree fails with `E-BIBLE-BASIS-NOT-GIT`. An
  entry citing no files is skipped as `no_source_files` (distinct from
  `basis_mismatch`); the engine keeps `basis_mismatch` ids queued for a
  bounded number of rounds because a transient mismatch can clear.
- With `scope='global'` it exports the GLOBAL KB to
  `.fleet/kb-canonical-global.json` (committed in the platform repo so the
  installer can distribute team-wide conventions).
- **Cold-seed:** when a KB is nearly empty (`kb_session_prime` under
  `COLD_KB_MAX=3`), prime reads the bible for OUTPUT only to warm the session.
  Cold-seed never writes the database and never activates a directive; the write
  path into a warm KB is `kb_import` (see below).

Member sessions read the bible through an in-memory view, and sprint writes are routed through one maintainer per repository that commits each round with `kb_bible_commit`; see [kb-member-view-and-maintainer.md](kb-member-view-and-maintainer.md). Both `kb_bible_commit` and `kb_export` (scope=project) admit an entry only through the same basis predicate: every cited source file must still hash to its recorded basis, otherwise `kb_bible_commit` skips the id with reason `basis_mismatch`.

### Why the DB is central and the bible is in-repo

The SQLite database is the source of truth deliberately, and the bible is a
projection of it, for a merge-cost reason. A binary SQLite file committed to git
would make branch merges painful -- two branches writing rows produce an opaque
binary conflict git cannot resolve, and the file churns on every read
(use-count bumps, freshness bits). The bible is instead a git-native, diffable,
per-project JSON artifact: a text file that merges like source, reviews like
source, and carries only the durable, CONFIRMED slice. Branch confusion -- the
bible on branch B describing files as they are on B -- is handled AFTER the
merge by `kb_import` (write the merged bible into the local DB) and
`freshnessSweep` + the reconcile flow (re-hash against the merged worktree so
wrong-branch claims go stale and contradictions are arbitrated). See
[kb-reconcile-architecture.md](kb-reconcile-architecture.md).

### Auto-commit at export

`kb_export` COMMITS the bible itself after writing it, so the reviewer-verdict
-> promote -> export chain reaches git with zero manual steps. This is code, not
agent discretion (the KB Agent is MCP-only and has no git access). The commit
is deliberately narrow:

- **Dedicated identity** `pm-kb <kb@pm.local>` -- distinct from the human author
  and from the KB Agent's git-less session.
- **Pathspec-only:** `git add <bible-path>` then `git commit -- <bible-path>`,
  so unrelated staged or dirty working-tree state is never swept in.
- **Content-gated:** it commits only when `git status --porcelain` shows the
  bible actually changed; re-exporting an identical bible is a no-op.
- **Non-fatal:** any git failure (not a repo, no git binary, hook rejects, index
  lock) is logged and swallowed -- the export already succeeded.
- **Off-switch:** `{ "bible": { "autoCommit": false } }` in the KB config
  disables it. A missing config or a config with no `bible` section degrades to
  the default (ON). A *malformed* config degrades to OFF -- "I could not read
  your settings" must not be the moment the tool starts committing for you.
- **Shrink guard:** the auto-commit is skipped (the file is still written) when an export would shrink the bible, unless `bible.autoCommit` is explicitly true. Because
  project-scope export is additive and never drops entries, the guard can now
  only trigger for `scope='global'`, which is unchanged.
- **No push.** The commit rides the branch's existing push flow; `kb_export`
  never pushes.

---

## Bidirectional staleness

A `context-cache` entry stores a per-file hash basis (`source_file_hashes`, a
JSON map) at capture time. Staleness is detected by re-hashing that basis
against the current worktree -- not by any git event -- so it is correct across
branch switches and rebases.

- **At prime,** `checkFreshness()` re-hashes the primed candidate set in BOTH
  directions: mark `stale=1` on basis mismatch, and clear `stale=0` where the
  entry is revivable and its full basis matches again.
- **`freshnessSweep()`** runs the same predicate over ALL entries with a
  non-empty basis (one bounded batched hash). It is the branch-switch REVIVAL
  surface, because prime's candidate set excludes stale rows by definition --
  prime alone can never revive a staled entry. The sweep is invoked by
  `kb_import` and `/pm kb-reconcile` (and standalone as `kb_freshness_sweep`),
  never wired into per-prime. It returns `{checked, staled, unstaled}`.
  `freshnessSweep(root?)` defaults an omitted `root` to the provider's own
  `repoPath` anchor -- the same root `checkFreshness` always re-hashes
  against -- so a bare `kb_freshness_sweep` call (which passes no root) can no
  longer contradict what prime just decided for the same entry. `kb_import`
  still passes an explicit `root` (its own `--repo`) when sweeping a specific
  repo. A `root`/anchor that does not exist on this host yields no verdict at
  all, per the anchor rule above.

**The revival predicate (`freshnessRevivable`).** `stale=1` is set by four
distinct actors, and only ONE population may be revived -- freshness mismatch.
An entry is revivable only when all hold:

```
stale = 1
AND superseded_at IS NULL              (not retired by an explicit supersede)
AND flagged_for_review = 0             (not a live feedback downvote)
AND content_hash != 'invalidated'      (not explicitly invalidated)
AND content has no "[feedback ..." marker  (durable downvote record)
AND the full stored basis re-hashes to a match
```

The two content-based conjuncts are the durable discriminators: a
feedback-downvoted entry must stay retired even if a later flow clears its flag
bit (the `[feedback ...]` marker survives), and an explicitly invalidated entry
must never auto-revive. This predicate is implemented ONCE and reused by
`checkFreshness()`, `freshnessSweep()`, and the reconcile winner path.

---

## Branch-merge reconcile

When branches merge, learnings must merge too, and contradictions are decided
by the merged code. That flow -- `kb_import` (write path) ->
`kb_freshness_sweep` -> `kb_reconcile_prefilter` -> reconciler agent ->
`kb_export` -- and its single `resolveContradiction` write path are documented
separately in
[kb-reconcile-architecture.md](kb-reconcile-architecture.md). The PM entry
point is `/pm kb-reconcile`.

---

## Setup Guide

### 1. Quick start (SQLite, local)

No setup required. Each repo's KB initializes automatically on first use at:
```
~/.apra-fleet/data/knowledge/<project-slug>/kb.sqlite
```

Staleness needs no git hook: `context-cache` entries store a per-file hash
basis and are re-checked by content hash at prime (and by `freshnessSweep`),
so changes are detected across commits, branch switches, and rebases alike --
see [Bidirectional staleness](#bidirectional-staleness) above. Running
`kb_setup` writes the provider config (and, for teams, encrypts the remote
token); it is optional for the local SQLite default. Run it from a FULL
session (the orchestrator or the CLI): a member session is never served
`kb_setup` -- see [Member-session tool calls](#member-session-tool-calls).

### 2. Central server (HTTP, team-shared)

On the server machine, generate a token and start the server:

```bash
node dist/index.js kb-server --generate-token
# Prints: KB server token: <64-hex-chars>
node dist/index.js kb-server
# Prints: KB server listening on port 7878
```

On each client machine, configure the provider. This is per fleet install,
not per repo: every repo that install serves switches to the central server.

```
kb_setup with provider=http, remote=http://<host>:7878, token=<token>
```

Or equivalently via CLI:

```bash
node dist/index.js kb-server --port 7878
```

The client writes this to `~/.apra-fleet/data/knowledge/config.json`:

```json
{
  "provider": "http",
  "url": "http://<host>:7878",
  "token_encrypted": "<AES-256-GCM ciphertext>"
}
```

The token is stored AES-256-GCM encrypted. It is never written in plaintext.

#### Named credentials and refreshers

For servers whose token expires (for example a short-lived OAuth access token), store
the token as a fleet secret and give `kb_setup` the placeholder instead of the
value. The value of `token` is exactly the placeholder:

```
apra-fleet secret --set KB_TOKEN --persist -y      # the secret must exist first
kb_setup with provider=http, remote=https://<host>, token={{secret.KB_TOKEN}}
```

The config then stores only the reference (`token_ref`), never a token. The
secret is looked up on every request, so a refreshed value is used by the next
KB call with no restart of the fleet server or any provider.

Secrets are per host today: each host that runs the fleet server needs the
secret and a refresher. With fleet.apralabs.com, all members of a fleet share
secrets through the cloud workspace.

**Per-host refreshers.** `apra-fleet secret --set NAME --persist -y` reads the
new value from stdin, so a refresher is a token command piped into it. Azure
example:

```bash
az account get-access-token --resource <app-id-uri> --query accessToken -o tsv | apra-fleet secret --set KB_TOKEN --persist -y
```

Run it on a schedule shorter than the token lifetime (for a 60 minute token,
every 30 minutes or less), so one failed run still leaves a valid token.

- Linux cron: `*/30 * * * * az account get-access-token --resource <app-id-uri> --query accessToken -o tsv | apra-fleet secret --set KB_TOKEN --persist -y`
  (or a systemd timer with `OnUnitActiveSec=30min` running the same command).
- Windows Task Scheduler: a task running every 30 minutes with action
  `powershell.exe` and arguments
  `-NoProfile -Command "az account get-access-token --resource <app-id-uri> --query accessToken -o tsv | apra-fleet secret --set KB_TOKEN --persist -y"`.
- macOS: a launchd agent with `StartInterval` 1800 running the same command
  through `/bin/sh -c`.

**Failure behaviour.** When the secret is missing, expired or unreadable, or
the server answers 401 twice (the request, then one retry after re-reading the
secret), the KB call fails with `E-KB-HTTP-AUTH` naming the secret and the
reason. Captures, invalidates and feedback are queued offline and sent once
the secret is accepted; the queue is kept, not dropped. Member reads of CONFIRMED entries
are still served from the checkout bible. After a refresh nothing needs
restarting.

**fleet_status.** With the http provider, `fleet_status` shows a
`kb credential:` line: `secret NAME | resolves: ok|missing|expired|unreadable |
last written | token expiry (JWT exp, or none) | last ok call | last rejected
call`. `unreadable` means the credential store could not be read or the value
could not be decrypted.
For a literal token the line says it cannot be refreshed without re-running
`kb_setup`, and gives the commands to switch to a named secret.

**Test and stand-in servers.** `kb-server --token-file <path>` reads the server
token from a file (instead of `--generate-token`; the two cannot be combined)
and re-reads it about every 250 ms, so rotating the file takes effect without
a restart. A failed re-read keeps the last good token.

`request_timeout_ms` (integer, 1000-120000, default 5000) sets the socket idle
timeout for each request to the KB server, for servers that need longer than
the default:

```
kb_setup with provider=http, remote=https://<host>, token=<token>, request_timeout_ms=15000
```

kb_setup refuses a value outside that range, or a non-integer, before writing
anything. The value is stored as `request_timeout_ms` in the config and kept
across later `kb_setup` runs that do not pass it. If the config is edited by
hand to a value outside that range or a non-integer, the reader uses the 5000
default instead and logs a warning naming the key, the bad value and the
default; it does not fail, so the config keeps working.

A request whose socket is idle for longer than the timeout fails with code
`ETIMEDOUT` and a message naming the timeout in ms; like any
unreachable-server error, that queues a capture or invalidate offline and
falls back to the local store for reads.

It is a socket idle timeout, not a per-request deadline:

- The timer restarts whenever data arrives, so a server that keeps sending
  bytes slowly can take longer than the value without timing out.
- When writes are queued offline, capture, query, context, invalidate and
  prime first try to flush them, and the flush attempt has the same timeout. Against an unresponsive server a call can
  therefore wait up to about twice the value: one timeout for the flush, one
  for the call itself.

Routes the http provider uses (all except `/health` need the bearer token).
Another server can stand in for `kb-server` by serving the same routes:

| Route | Used for |
|---|---|
| `POST /api/kb/capture` | kb_capture |
| `GET /api/kb/query` (`query`, `type`, `tag`, `limit`, `l1_only`, `confidence`, `exclude_disputed`, `include_stale`, `include_superseded`, `flagged_only`, `fts_terms`, `ids`) | kb_query, and the member own-scope lookup (`tag=member:<uuid>`); entries must carry their `tags`. `flagged_only=true` lists only contradiction-flagged entries. `fts_terms` is a JSON array of strings (URL-encoded, e.g. `fts_terms=["Gearwheel","ratio"]`) OR-joined as one FTS match (kb_session_prime's neighbour query). `ids` is a JSON array of entry ids for an exact-id lookup (kb_query's L2 fetch; kb_query keeps only the requested ids). A `fts_terms` or `ids` value that is not a JSON array of strings answers 400 `BAD_REQUEST` |
| `GET /api/kb/list` (`tag`, `confidence`, `type`, `module`, `symbol`, `exclude_disputed`, `include_stale`, `limit`; no-bump read, entries carry their `tags`) | kb_list, and the member own-scope filter of `kb_context` and `kb_session_prime` reads (never `kb_promote`). A 404 from it surfaces as `E-KB-HTTP-UNSUPPORTED` |
| `GET /api/kb/context` (`files` comma-separated, required; `confidence` comma-separated; `exclude_disputed`; `tag`) | kb_context. `tag=member:<uuid>` is the member own-scope: each file's newest entry is chosen among the entries carrying that tag, not the newest overall |
| `POST /api/kb/prime` | kb_session_prime |
| `POST /api/kb/invalidate` (`{files}`) | kb_invalidate with files |
| `POST /api/kb/promote` (`{id, reason}` -> `{id, previous_confidence, new_confidence}`; 404 unknown id, 422 refused) | kb_promote |
| `POST /api/kb/demote` (`{id, reason, evidence_files}` -> `{id, previous_confidence, new_confidence}`; optional, not served by the bundled `kb-server`) | kb_demote, and the gate for a MEMBER `kb_query` `own_scope` read |

### 3. GitNexus (optional, codebase plane)

Install GitNexus as an MCP server in `.mcp.json` (already done if you used the
Knowledge Layer setup):

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus", "mcp"]
    }
  }
}
```

Build the initial graph through the fleet, not by hand: member init and the
`code_reindex` tool run `npx gitnexus@>=1.6.5 analyze --index-only --force` (the
pinned minimum version; `--index-only` keeps the run from writing into the
target repo, and `--force` makes it a full rebuild: gitnexus 1.6.12's
incremental analyze can overwrite thousands of unchanged symbol rows, which then
answer "not found"). Do not run a plain `gitnexus analyze` in a target repo.

Verify by calling `context` with a symbol name in Claude Code.
`kb_session_prime` degrades gracefully when GitNexus is absent.

### 4. Keeping the KB in sync with git

There is no post-commit hook driving KB state. Two mechanisms keep the KB and
git aligned, both described in the architecture sections above:

- **Staleness is hash-based, not hook-based.** `context-cache` entries store a
  per-file hash basis and are re-checked at prime and by `freshnessSweep`. This
  detects changes regardless of how they arrived (commit, branch switch,
  rebase, or an uncommitted edit), which a commit-triggered hook could not.
  See [Bidirectional staleness](#bidirectional-staleness).
- **The bible reaches git via `kb_export`'s auto-commit**, not a hook -- a
  narrow, pathspec-only commit under the `pm-kb` identity, content-gated,
  non-fatal, with a config off-switch. See
  [Auto-commit at export](#auto-commit-at-export).

(`kb_setup` still writes a legacy `post-commit` invalidation hook, but it is
not load-bearing. The hook directory is resolved by asking git
(`git rev-parse --git-path hooks`), never by assuming `<repo>/.git/hooks`, so
it works when the repo folder is a linked worktree (where `.git` is a file) and
honours `core.hooksPath`. If git cannot resolve the directory, `kb_setup`
fails with an error naming the repo path. `kb_setup` never overwrites a hook
it did not write: it writes only when no `post-commit` exists or the existing
one is a regular file carrying the `# apra-fleet KB invalidation hook` marker.
Any other `post-commit` (e.g. a tracked husky or `.githooks/` hook, or a
symlink) is left untouched and reported as the step `Skipped git hook:
existing post-commit at <path> is not ours`. When the resolved directory is
outside both the worktree and the git common dir -- typically a machine-global
`core.hooksPath` shared by other repos -- `kb_setup` skips the hook with a
step and does not create the directory. The hook itself calls a repo-relative
`node dist/index.js` path and swallows all errors, so it is effectively inert
outside the apra-fleet source tree. Hash-based freshness is the mechanism to
rely on.)

### 5. KB tool profiles (which kb_* tools interactive sessions see)

An interactive session that only reads and captures does not need every
`kb_*` tool in its tool list. The install-wide KB tool profile trims that
list:

| Profile | `kb_*` tools a FULL session lists |
|---|---|
| `full` (default; also what no setting means) | every `kb_*` tool |
| `developer` | `kb_session_prime`, `kb_query`, `kb_context`, `kb_capture`, `kb_feedback` |
| `custom` | exactly the registered `kb_*` names you list |

Set it with the CLI or with `kb_setup`:

```
apra-fleet kb profile developer
apra-fleet kb profile custom kb_query,kb_capture,kb_setup
apra-fleet kb profile            # print the current profile
apra-fleet kb profile full       # back to every kb_* tool
```

`kb_setup` takes `tool_profile` (`full` | `developer` | `custom`) and, for
`custom`, `tool_profile_tools`; a profile-only call needs no
provider/remote/token and leaves those settings as they were. Both are stored
in `knowledge/config.json` as `tool_profile` / `tool_profile_tools`. An
unknown `custom` name is refused with an error naming it and listing the
valid names, and nothing is written.

- **Install-wide.** One setting per fleet install, like the provider config.
- **FULL sessions only.** Member sessions and every sprint role keep their
  own allowlists (including the engine's kb_maintainer session and its
  `kb_promote` / `kb_resolve_contradiction` / `kb_demote`), whatever the
  profile. Non-kb tools, `code_*` included, are never filtered.
- **Takes effect on reconnect.** The profile is read when a session
  registers its tools; an open session keeps its list until it reconnects.
- **Not a security boundary.** It is a usability control: a hidden tool is
  just not listed, and any local process can change the profile back.
- **PM skills need more than `developer` lists.** `kb-review` needs `kb_list`
  and `kb_promote`, `kb-reconcile` also needs `kb_import`, `kb_export`,
  `kb_resolve_contradiction`, `kb_reconcile_prefilter` and
  `kb_freshness_sweep`, and `knowledge-agent` needs `kb_harvest`. All of these
  are hidden under `developer` and the skills then fail with "tool not found".
  Before running one, switch back with `apra-fleet kb profile full` and
  reconnect. An entry flagged with `kb_feedback` stays unresolved until then.
- **Getting back.** `developer` hides `kb_setup`, so use the CLI:
  `apra-fleet kb profile full`.
- **A hand-edited invalid profile.** The session gets every `kb_*` tool, and
  `fleet_status` shows a line (`kbHealth.toolProfileWarning` in JSON) naming
  the bad value and the fix; the server log has it too. If `config.json` itself
  cannot be parsed, fix it by hand: `apra-fleet kb profile` refuses to write
  over it, because a rewrite would lose the remote url and token.

---

## Usage Guide

### Session prime workflow

At the start of every session, call `kb_session_prime` with the task description
and the files you expect to touch:

```
kb_session_prime with task="add rate limiting to kb-server", hint_files=["src/commands/kb-server.ts"], hint_symbols=["startKbServer"]
```

The tool returns:
- `session_warm`: `true` if all hint_files have fresh KB entries
- `stale_files`: list of files the agent MUST read (changed since last capture)
- `fresh_summaries`: cached summaries for files that have not changed
- `top_entries`: relevant learnings from the KB
- `recommended_gitnexus_calls`: GitNexus tool calls to dispatch next

If `session_warm=true` and `stale_files=[]`, the agent can skip reading those
files and work from KB summaries directly. Token cost: ~60-100 tokens per file
(summary only) vs. reading the full file.

### Capture guide

After reading or writing a file, call `kb_capture` to store what you learned:

```
kb_capture with type="context-cache", title="kb-server.ts: HTTP entry point", summary="Starts an HTTP server on port 7878 using node:http. Bearer token auth. Rate limiting: 100 req/min per IP (in-memory token bucket). No external deps.", content="...", source_files=["src/commands/kb-server.ts"]
```

Content types:
- `context-cache` -- one file's content/structure. Staleness checked on prime.
- `learning` -- something you discovered while working (bugs, gotchas).
- `knowledge` -- architectural facts, design decisions.
- `runbook` -- step-by-step procedures.

The AUDN system deduplicates automatically:
- `add` -- new entry stored
- `none` -- exact duplicate, existing entry returned
- `update` -- same-topic predecessor linked (refines; both entries stay live unless `supersedes` is passed explicitly)
- `flagged` -- contradiction detected, both entries flagged for human review

### When to promote

Entries start at `INFERRED` confidence. The reviewer promotes verified facts:

```
kb_promote with id="<entry-id>", reason="Confirmed correct after code review"
```

Confidence ladder: `UNVERIFIED` -> `INFERRED` -> `CONFIRMED`

`CONFIRMED` entries are never auto-deleted by the dream cycle.

### Dream cycle

The KB Agent (dispatched by the PM) runs a dream cycle to maintain quality:
1. Dedup pass: find near-duplicate entries and supersede older ones.
2. Contradiction scan: flag entries with contradiction keywords.
3. Salience prune: mark old, low-use entries as superseded.
4. Stale link repair: re-wire links for entries with changed source_files.

The dream cycle is not triggered automatically. Dispatch it when the KB grows
large or after a major refactor.

---

## Provider Swap

Switch providers without code changes by rewriting config.json. The switch
applies to every repo the fleet install serves; there is no per-repo provider.

### SQLite (default)

```json
{ "provider": "sqlite" }
```

All data is local. No token. `kb_sync` is a no-op.

### HTTP (central server)

```json
{
  "provider": "http",
  "url": "http://<host>:7878",
  "token_encrypted": "<ciphertext from kb_setup>"
}
```

Run `kb_setup` with `remote` and `token` to write this. Do not write
`token_encrypted` by hand.

With the http provider, `kb_feedback` is sent to the server as
`POST /api/kb/feedback` with body `{id, reason, role}` and returns the
server's answer unchanged; the client never sets confidence. While the server
is unreachable the feedback is queued offline with captures and invalidates
and the tool fails with `E-KB-HTTP-UNREACHABLE`, whose message says it was
queued. The bundled `kb-server` command
serves that route: it validates the role like the tool does, marks the entry
stale and flagged without touching confidence, and answers an unknown id with
HTTP 404 and code `ENTRY_NOT_FOUND`.

With a named secret the config holds a reference instead of a ciphertext:

```json
{
  "provider": "http",
  "url": "https://<host>",
  "token_ref": "{{secret.KB_TOKEN}}"
}
```

Write it with `kb_setup ... token={{secret.KB_TOKEN}}`; see
[Named credentials and refreshers](#named-credentials-and-refreshers).

#### MemoryProvider operations

Every method in the `MemoryProvider` interface is classified as one of:
- **remote** -- calls the HTTP server. On a connection error a write is
  queued and the call throws `E-KB-HTTP-UNREACHABLE` (saying it was queued);
  a read throws `E-KB-HTTP-UNREACHABLE`. Nothing is ever answered from a
  local store or the checkout bible: the server is the source of truth.
- **local** -- no remote route; answers without any local store.
- **unsupported** -- returns a documented refusal or throws a typed error.

The provider holds no local store at all.

| Method | Classification | Notes |
|--------|---|---|
| init | local | Nothing to open. |
| capture | remote | Posts entry to server. On connection error, queued in memory (max 1000) and thrown as `E-KB-HTTP-UNREACHABLE`; queue flushed on reconnect. |
| query | remote | Retrieves entries from server. On connection error, `E-KB-HTTP-UNREACHABLE`. |
| context | remote | Retrieves file context from server. On connection error, `E-KB-HTTP-UNREACHABLE`. |
| invalidate | remote | Invalidates files on server. On connection error, queued in memory and thrown as `E-KB-HTTP-UNREACHABLE`; queue flushed on reconnect. |
| discard | unsupported | Throws E-KB-HTTP-UNSUPPORTED (id-level discard not supported). Use kb_invalidate with files instead. |
| getLinked | local | No remote route: returns no linked entries. |
| prime | remote | Retrieves primed context from server. On connection error, `E-KB-HTTP-UNREACHABLE`. `kb_session_prime` does not cold-seed from the checkout bible under http. |
| promote | remote | POST /api/kb/promote with `{id, reason}`. No offline queue on connection error (the id only exists on the server): `E-KB-HTTP-UNREACHABLE` naming the server URL. Sent by id with no list lookup first: the server refuses an unknown, superseded or out-of-scope id itself. The bundled `kb-server` answers an unknown id 404 with code `ENTRY_NOT_FOUND`; any 404 rejects as `Entry not found: <id>` followed by the server's answer; any other refusal (non-2xx, including problem+json) rejects with the HTTP status plus the server's text and code. |
| feedback | remote | POST /api/kb/feedback with `{id, reason, role}`; returns the server response unchanged. On connection error (or E-KB-HTTP-AUTH) queued offline with captures and invalidates, and the error is thrown. |
| demote | remote (optional route) | POST /api/kb/demote with `{id, reason, evidence_files}` -> `{id, previous_confidence, new_confidence}`, sent by id only when `GET /api/kb/capabilities` lists `demote`; otherwise (or on a 404/501 from the route) `E-KB-HTTP-UNSUPPORTED` naming the route, and nothing is changed. The server enforces which ids the caller may demote; a 404 whose body code says the entry is unknown rejects as `Entry not found: <id>`. A MEMBER `kb_query` `own_scope` read (which exists to find what may be demoted) is refused the same way when the server does not list `demote`. |
| sync | unsupported | Returns {synced: false} (no remote sync over http). |
| stats | unsupported | Returns supported:false with empty results (stats not supported over http). |
| touch | local | No remote route: records nothing (returns 0); the per-repo DB is not written. |
| relatedClaims | local | No remote route: returns no related claims (`related_claims` is empty). |

**Capabilities**: `GET /api/kb/capabilities` (same auth and `X-KB-Project`
check as every route) answers `{contract, routes, branch_aware}`. capture,
query and promote are required; context, prime, invalidate, feedback, list and
demote are optional. The provider reads it once per connection (again after
the server was unreachable, or after the read itself failed); it is not
re-read between two successful calls, so a server upgraded in place keeps
the route set read before until the next connection error or fleet restart. It never calls a route the answer does not list:
the tool fails with `E-KB-HTTP-UNSUPPORTED` naming the route. A server without
the capabilities route is assumed to serve every route but demote. Any other
failed capabilities read is typed: a 5xx or 429 is `E-KB-HTTP-UNREACHABLE`
(writes are queued), another status but 401 and a 409 project mismatch is
`E-KB-HTTP-UNSUPPORTED` naming the capabilities read; queued writes are kept
while it fails (and when a replayed write is answered a 5xx or 429) and sent
once it answers. A queued write is dropped only for its own fault (route not
listed, or refused by the server), with a logged warning. A 404 or 501
from an optional route is also `E-KB-HTTP-UNSUPPORTED` (a 404 whose body code is
`ENTRY_NOT_FOUND` / `E-ENTRY-NOT-FOUND` stays "entry not found"). The bundled
`kb-server` serves every route but demote, `branch_aware: false`; it lists
`list` and `feedback` only over a local SQLite KB, the only routes it cannot
serve otherwise. Contract:
`memory-contract/v1/spec.md` section 2.9.1.

**Named-secret token**: with `token_ref`, the secret is looked up on every
request; a 401 re-reads it and retries once, then throws `E-KB-HTTP-AUTH`.
A capture or invalidate that hits it stays in the offline queue.

**Queue overflow**: if 1000 pending writes accumulate, the oldest is dropped
and a warning is printed to stderr. **Process exit**: if the queue is non-empty
on exit, a warning is emitted.

#### Bible commit under HTTP

`kb_bible_commit` is not supported over the HTTP KB provider. When called, it
returns `bible_skipped: true` with reason `KB_BIBLE_COMMIT_HTTP_SKIP_REASON`
(`src/tools/kb-bible-commit.ts`). The sprint round logs one skip line and
continues without error.

Design notes:

- The guard is a soft skip, not an error: a non-SQLite project is not misconfigured,
  it simply has no local bible to commit. The skip returns before any KB write or
  git commit; the sprint client drops its queued confirmations, skip rounds and
  retirements for that round and does not push or run the publication check.
- Id-level `discard` is the opposite: it throws a typed error rather than
  skipping, because silently ignoring a discard would leave a wrong entry live
  on the shared server. The refusal names `kb_invalidate` with files as the
  supported alternative.
- `memory-contract/v1` spec prose and conformance fixtures cover both
  `bible_skipped` and `E-KB-HTTP-UNSUPPORTED`.

#### Promote and member recall under HTTP

- `kb_promote` stays gated to the `kb_maintainer` grant but no longer needs a
  SQLite project: under http it calls the provider's `promote` directly, by
  id, with no list lookup first (a KB server need not implement the optional
  `GET /api/kb/list` route). Fleet does not check the member's owner tag for it: the
  KB server decides which ids a caller may promote and refuses an unknown,
  superseded or out-of-scope id itself. The bundled `kb-server` answers an
  unknown id with 404 and code `ENTRY_NOT_FOUND`, the code a server must use
  on an optional id route such as demote. Any 404 from promote surfaces as
  `Entry not found: <id>` with the server's answer; any other refusal carries
  its HTTP status and the server's text and code. Against the bundled
  `kb-server`, which has no per-member scope, a member can promote any id that
  server holds.
- HTTP mode does not use the bible: the KB server is the source of truth.
  Member reads of every tier (`kb_query`, `kb_session_prime`, `kb_context`,
  `kb_list`, `kb_stats`) go to the http provider
  (`src/services/knowledge/kb-self.ts`); `kb_session_prime` does not cold-seed
  from the checkout bible; `kb_import` imports nothing and answers
  `bible_skipped: true` (so the sprint start imports nothing); and
  `kb_bible_commit` answers `bible_skipped: true`.
- Exception: a member `kb_query({flagged_only: true})` is refused under http
  with `E-KB-HTTP-UNSUPPORTED`. A flagged listing carries no owner tag, so on
  the server it would show other members' entries, and the bible is not used.
  A non-member flagged read goes to the server: the provider sends
  `flagged_only=true`, `kb-server`'s `GET /api/kb/query` honours it, and
  `kb_query` re-applies the flagged filter to whatever the server returns.
- Server down: every call fails with `E-KB-HTTP-UNREACHABLE` (writes are queued
  first and say so). Nothing is answered from the checkout bible or the
  per-repo database; a token the server refuses is `E-KB-HTTP-AUTH`.
- Every request carries the project slug in `X-KB-Project`. `kb-server` serves
  one project and answers any other (or a missing header) with 409 naming
  both slugs, surfaced as `E-KB-HTTP-PROJECT-MISMATCH`, never as a fallback
  to the local store.
- Upgrade `kb-server` and its clients together. A v0.4.4 client sends no
  `X-KB-Project` header, so a current `kb-server` answers it with 409
  `E-KB-HTTP-PROJECT-MISMATCH` on every call; a current client against an older
  server that lacks `GET /api/kb/list` gets `E-KB-HTTP-UNSUPPORTED` from kb_list.
- Invariant: promote has no offline queue or local fallback, since the entry id
  only exists on the server. A malformed or non-JSON error body still surfaces as
  a thrown error rather than a silent success.
- `kb_bible_commit` under http reports the `entry_count` of the existing bible
  file (read without touching the KB) and logs, rather than throws, when the
  bible is unreadable.

#### How-to: Point fleet at a central KB server

To redirect every repo on a fleet install to a central KB server (fleet's own
`kb-server`, or any server that implements the same HTTP routes), configure
the HTTP provider from a FULL session (orchestrator or local CLI). The setting
is install-wide (one config file covers every repo the install serves), but a
`kb-server` serves ONE project: requests carry their repo's project slug
(`X-KB-Project`), and a repo whose slug differs from the server's gets
`E-KB-HTTP-PROJECT-MISMATCH` on every call. Use the http provider on an
install that serves that one repo.

**Command:**

```
kb_setup with provider='http', remote='<server-url>', token='<bearer-token>'
```

**Setup steps:**

1. Obtain the server URL and a bearer token from the central KB server's
   operator. For fleet's own `node dist/index.js kb-server`, the token comes
   from `--generate-token` (see [Central server](#2-central-server-http-team-shared)).

2. On each client machine (one per fleet install), call the `kb_setup` MCP tool
   from a FULL session (orchestrator or local session) with the server URL and
   token. That includes every member host: a member's kb tools run on its own
   host and read that host's config, so a member host without it keeps using
   SQLite. The tool encrypts the token into the fleet config at
   `~/.apra-fleet/data/knowledge/config.json`. `kb_setup` is MCP-only: there is
   no `kb-setup` CLI command.

3. The repo on that fleet install whose project the server serves now reads
   and writes its KB to the central server. To switch back to local SQLite, call `kb_setup` with
   `provider='sqlite'`.

**Scope**: the provider setting is install-wide, not per-repo or per-sprint. All
members on the fleet install see the same server.

**Deployment advice**: run the central server and client setup on an isolated
fleet install first, not your live install, because every repo served by that
install starts reading and writing the server immediately. Verify the flow
works before scaling to production.

**Authentication**: only `Authorization: Bearer <token>` is sent in HTTP
headers; the token is the sole credential the server sees. Member own-scope
for reads is enforced by fleet: MEMBER reads of INFERRED or UNVERIFIED keep
only entries carrying the caller's tag (member:<uuid>), which needs the server
to return each entry's tags (untagged entries are dropped from those reads).
A MEMBER kb_promote is sent by id with no lookup first; which ids the caller
may promote is the server's decision, and its refusal is surfaced.

**Capabilities over HTTP**: see the [MemoryProvider operations](#memoryprovider-operations)
table above. In summary:
- **Supported**: `kb_capture`, `kb_query`, `kb_context`, `kb_invalidate` with
  `files` (queued offline on connection error), `kb_feedback` (queued offline
  on connection error; refused in a MEMBER session), `kb_promote` (server-side
  only, fails on connection error with no fallback), and the member-session read
  tools (`kb_query`, `kb_session_prime`, `kb_context`, `kb_list`), answered by
  the server for every tier with fleet re-checking member own-scope.
- **Optional routes**, used only when `GET /api/kb/capabilities` lists them
  (otherwise `E-KB-HTTP-UNSUPPORTED` naming the route): context (`kb_context`),
  prime (`kb_session_prime`), invalidate, feedback, list (`kb_list`) and demote
  (`kb_demote`, and a MEMBER `kb_query` `own_scope` read). The bundled
  `kb-server` serves all but demote.
- **Not supported**: `kb_stats` reports `supported: false`; `kb_import` and
  `kb_bible_commit` answer `bible_skipped: true`; id-level `kb_invalidate` by
  `ids` and a MEMBER `kb_query` `flagged_only` read throw
  `E-KB-HTTP-UNSUPPORTED` (use `kb_invalidate` with `files` instead of `ids`).

**Repository headers**: kb_* tools take no repository argument, but fleet
passes the repository it resolved for the calling session to the provider,
and `HttpKbProvider` sends it on every request (queued writes included) as
`X-Repository` (the normalised origin remote, `host/path`: no scheme, no
credentials, no trailing `.git`; Azure DevOps remotes folded to
`dev.azure.com/<org>/<project>/_git/<repo>`) and `X-Repository-Commit` (the
local folder's HEAD sha, omitted when it cannot be read, e.g. for a remote
member's folder) and `X-Repository-Branch` (the local folder's checked-out
branch from `git symbolic-ref --quiet HEAD` with `refs/heads/` stripped,
characters outside printable ASCII percent-encoded as UTF-8; omitted on a
detached HEAD, when HEAD is not under `refs/heads/`, for a remote member's
folder, when git fails or times out, or when the encoded
value is longer than 255 characters). Commit and branch are each cached for
5 seconds, so a branch switch shows within that time. A shared server can use them to keep repositories apart; a
server may ignore them. No local path is ever sent, and nothing goes in the
URL. A remote whose host does not parse as a hostname sends no header at all.
The commit is best effort: a queued write replayed later carries the HEAD at
replay time, not at capture time. With a named-secret token the secret is
looked up first, so a missing secret fails before the commit or branch is
read; the one 401 retry re-reads the secret but resends the same repository
headers (same commit and branch),
and a replayed queued write gets both the current secret and its provider's
repository headers.

### Future: Postgres

To add a Postgres backend, implement `MemoryProvider` in a new class and update
`createKbProvidersForSlug` (`src/services/knowledge/kb-providers.ts`) to
instantiate it when `config.provider === 'postgres'`. No KB tool changes are
required.

---

## KB Agent

The KB Agent is a fleet member whose role is CURATING the knowledge base -- not
authoring it. Knowledge enters the KB in-flight: the working agent captures at
the moment of discovery (`kb_capture` with descriptive tags, e.g. a sprint and
phase label), so entries land as they are learned rather than in a single
post-hoc pass. Auto-harvest backstops this by scanning the transcript when a
prompt completes, so nothing discovered mid-session is lost even if the agent
forgot to capture it.

The KB Agent then curates that raw stream: it promotes entries the reviewer
confirmed (`kb_promote`), dedups and reconciles, exports the bible, and runs the
branch-merge reconcile flow. It is dispatched by the PM after each sprint phase.

Skills file: `skills/fleet/knowledge-agent.md`

### Dispatch

```
/pm dispatch knowledge-agent to <member> for harvest and dream cycle
```

Or on-demand:

```
execute_prompt to <member>: "You are the KB Agent. Run kb_harvest on the last session transcript, then run a dedup pass on the KB."
```

### What it does

1. **Harvest**: scans the session transcript for learning patterns, captures
   UNVERIFIED entries via AUDN.
2. **Promote**: promotes entries the reviewer confirmed.
3. **Dream cycle**: dedup, contradiction scan, salience prune, stale link repair.

### Auto-harvest

`kb_harvest` fires automatically (fire-and-forget) when `execute_prompt`
completes successfully. The PM does not need to dispatch it manually.
`execute_prompt` passes the dispatched member's own working folder as an
explicit in-process `KbAnchor`, so the harvested learnings land in the KB for the repo the work
actually happened in rather than whichever repo the fleet server process
happens to be running from -- see [Per-repo KB isolation](#per-repo-kb-isolation)
for the routing rule. This is the
only fully automatic KB writer; every other write path is a deliberate tool
call from an agent, scoped to that agent's own session folder.

---

## Troubleshooting

### GitNexus graph stale

**Symptom**: `kb_session_prime` returns empty `recommended_gitnexus_calls` or
GitNexus tools return outdated results after a refactor.

**Fix**: rebuild the graph with the `code_reindex` tool (it runs
`npx gitnexus@>=1.6.5 analyze --index-only --force`). Do not run a plain
`gitnexus analyze` in a target repo.

Run this after large refactors or after renaming many files. Every fleet run
is a full rebuild (`--force`): parser output for unchanged files is replayed
from gitnexus's parse cache, but the graph DB is rebuilt, because an
incremental top-up can corrupt unchanged symbol rows.

### SQLite lock errors (SQLITE_BUSY)

**Symptom**: `SQLITE_BUSY: database is locked` in KB tool output.

**Cause**: multiple agent sessions writing simultaneously. WAL mode allows
concurrent reads but serializes writes.

**Fix**: the SQLite provider is configured with `busy_timeout=5000` (5 seconds).
If errors persist, only one agent should write at a time. Consider the HTTP
provider for multi-agent setups.

### Stale entries not reviving after a branch switch

**Symptom**: switching back to a branch whose files are unchanged still shows
its `context-cache` entries as stale.

**Cause**: `kb_session_prime` cannot revive stale entries -- its candidate set
excludes stale rows by definition. Revival only happens in a full-KB sweep.

**Fix**: run `kb_freshness_sweep` (or `/pm kb-reconcile`, which runs it as part
of the ladder). It re-hashes every entry's basis against the current worktree
and revives freshness-staled entries whose files match again. Superseded,
feedback-downvoted, and invalidated entries stay retired by design -- see
[Bidirectional staleness](#bidirectional-staleness).

### Offline queue warning on exit

**Symptom**: at process exit you see:
```
[KB] WARNING: offline queue has N unsaved operations (captures, invalidations, feedback). They never reached the KB server and the queue is lost when this process exits. Repeat them once the KB server is reachable.
```

**Cause**: the HTTP KB server was unreachable while captures, invalidations or feedback were made. The
queue is in-memory and not persisted.

**Recovery**: start the KB server and repeat the lost calls. Invalidations and
feedback can only be repeated: `kb_harvest` extracts learnings from a session
transcript and cannot restore them. For captures, on an install whose KB tool
profile lists it, you can also run:
```
kb_harvest with session_output="<paste session transcript>"
```

AUDN deduplication ensures entries from the harvest do not create duplicates
if some were already sent before the server went offline.

### Token rejected (401)

**Symptom**: KB server returns 401 for all requests.

**Literal token**: the token in the client config must match the server's
token. Regenerate on the server:
```bash
node dist/index.js kb-server --generate-token
```

Then re-run `kb_setup` on each client with the new token.

**Named secret** (`token={{secret.NAME}}`): the error is `E-KB-HTTP-AUTH` and
names the secret and the reason (`missing`, `expired`, `unreadable` or
`rejected`). Refresh the secret on this host; no restart is needed:
```bash
apra-fleet secret --set NAME --persist -y
```
Check `fleet_status` for the `kb credential:` line (resolves, last written,
last ok/rejected call). If it shows `resolves: ok` and a `last rejected call`
time later than the `last ok call` time (or the error reason is `rejected`),
the secret exists but the server no longer accepts its value, so the refresher
is stale or the server token was rotated. `resolves: unreadable` means the
credential store itself could not be read or decrypted. See [Named credentials](#named-credentials-and-refreshers).
