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
origin remote, and a FULL session acts on the server's working folder;
`kb_import` keeps `path` for naming a bible file).

- **Member session** (`?member=<uuid>` or a member JWT): the member's
  registered work folder. The session's member id travels from the HTTP
  transport to the handler through an `AsyncLocalStorage` lane
  (`src/services/tool-scope.ts`), so handlers never receive it as a parameter.
- **Full session** (no member identity): the fleet server's own working
  folder (`process.cwd()` of the server process). An HTTP server cannot see a
  client's cwd, so there is no separate "self" for local non-member callers:
  a FULL session started from any client directory still reads and writes
  the KB of the repository the SERVER was started in. When that folder cannot
  carry a KB identity, the self-resolution error says exactly that -- "This is
  a FULL session (no member identity), so its KB is the fleet server's own
  working folder, not the calling client's directory; '<folder>' is not a git
  repository" (or "has no origin remote") -- and names both fixes: restart
  the fleet server with its working folder set to the intended repository, or
  call from a member session (`?member=<id>`) of a member registered on it.

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

For a FULL session every remediation leads with the same fix: restart the
fleet server with its working folder set to the intended repository, or call
from a member session of a member registered on it (then, as applicable,
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
global-KB fallback stays CONFIRMED-only.

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

Every entry carries a confidence tier and moves up a one-way ladder:

```
UNVERIFIED  ->  INFERRED  ->  CONFIRMED
```

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

No setup required. The KB initializes automatically on first use at:
```
~/.apra-fleet/data/knowledge/kb.sqlite
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
`code_reindex` tool run `npx gitnexus@>=1.6.5 analyze --index-only` (the pinned
minimum version; `--index-only` keeps the run from writing into the target
repo). Do not run a plain `gitnexus analyze` in a target repo.

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

(`kb_setup` still writes a legacy `.git/hooks/post-commit` invalidation hook,
but it is not load-bearing: it calls a repo-relative `node dist/index.js` path
and swallows all errors, so it is effectively inert outside the apra-fleet
source tree. Hash-based freshness is the mechanism to rely on.)

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

#### MemoryProvider operations

Every method in the `MemoryProvider` interface is classified as one of:
- **remote** -- calls the HTTP server; on connection error, may queue (writes)
  or fall back to local store (reads).
- **local-fallback** -- delegates to the local SQLite fallback store.
- **unsupported** -- returns a documented refusal or throws a typed error.

| Method | Classification | Notes |
|--------|---|---|
| init | local-fallback | Initializes the local fallback store. |
| capture | remote | Posts entry to server. On connection error, queued in memory (max 1000); queue flushed on reconnect. |
| query | remote | Retrieves entries from server. On connection error, falls back to local store. |
| context | remote | Retrieves file context from server. On connection error, falls back to local store. |
| invalidate | remote | Invalidates files on server. On connection error, queued in memory; queue flushed on reconnect. |
| discard | unsupported | Throws E-KB-HTTP-UNSUPPORTED (id-level discard not supported). Use kb_invalidate with files instead. |
| getLinked | local-fallback | Retrieves linked entries from local fallback store. |
| prime | remote | Retrieves primed context from server. On connection error, falls back to local store. |
| promote | remote | POST /api/kb/promote with `{id, reason}`. No local fallback and no offline queue on connection error (the id only exists on the server): a connection error rejects naming the server URL. A refusal (non-2xx, including problem+json) rejects with the HTTP status plus the server's title/code. |
| sync | unsupported | Returns {synced: false} (no remote sync over http). |
| stats | unsupported | Returns supported:false with empty results (stats not supported over http). |
| touch | local-fallback | Records entry access in local fallback store (telemetry only). |
| relatedClaims | local-fallback | Retrieves related entries from local fallback store (graph queries only). |

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
  SQLite project: under http it calls the provider's `promote` directly. An
  owner tag is applied only on the SQLite path, so member sessions on http
  still reach the server.
- Member reads of every tier (`kb_query`, `kb_session_prime`, `kb_context`) are
  routed to the http provider (`serverRecall` in `src/tools/kb-self.ts`), because
  the server, not a local store, holds the confirmed entries. `kb_list` and
  `kb_stats` are unchanged.
- Invariant: promote has no offline queue or local fallback, since the entry id
  only exists on the server. A malformed or non-JSON error body still surfaces as
  a thrown error rather than a silent success.
- `kb_bible_commit` under http reports the `entry_count` of the existing bible
  file (read without touching the KB) and logs, rather than throws, when the
  bible is unreadable.

#### How-to: Point fleet at a central MemorEYES server

To redirect every repo on a fleet install to a central KB server (like
MemorEYES), configure the HTTP provider from a FULL session (orchestrator or
local CLI). This setting is install-wide: one config file covers every repo
served by the fleet install, though each repo retains its own KB database.

**Command:**

```
kb_setup with provider='http', remote='<server-url>', token='<bearer-token>'
```

**Setup steps:**

1. Obtain the server URL and a bearer token from the central KB server's
   operator (for MemorEYES, the token is issued by that service). Fleet's own
   `node dist/index.js kb-server` (with `--generate-token`) is a separate,
   fleet-hosted server, relevant only if you run that one.

2. On each client machine (one per fleet install), call the `kb_setup` MCP tool
   from a FULL session (orchestrator or local session) with the server URL and
   token. The tool encrypts the token into the fleet config at
   `~/.apra-fleet/data/knowledge/config.json`. `kb_setup` is MCP-only: there is
   no `kb-setup` CLI command.

3. Every repo on that fleet install now reads and writes its KB to the central
   server. To switch back to local SQLite, call `kb_setup` with
   `provider='sqlite'`.

**Scope**: the provider setting is install-wide, not per-repo or per-sprint. All
members on the fleet install see the same server.

**Deployment advice**: run the central server and client setup on an isolated
fleet install first, not your live install, because every repo served by that
install starts reading and writing the server immediately. Verify the flow
works before scaling to production.

**Authentication**: only `Authorization: Bearer <token>` is sent in HTTP
headers. Member own-scope tags and ownership checks are not enforced server-side
yet; the token is the sole credential.

**Capabilities over HTTP**: see the [MemoryProvider operations](#memoryprovider-operations)
table above. In summary:
- **Supported**: `kb_capture`, `kb_query`, `kb_context`, `kb_invalidate` (with
  offline queueing on connection error), `kb_promote` (server-side only,
  fails on connection error with no fallback), and member-session read tools
  (`kb_query`, `kb_session_prime`, `kb_context` via the `serverRecall` path).
- **Not supported**: `kb_bible_commit` returns `bible_skipped` instead of
  committing; id-level `kb_invalidate` by `ids` throws
  `E-KB-HTTP-UNSUPPORTED` (use `kb_invalidate` with `files` instead).

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
`npx gitnexus@>=1.6.5 analyze --index-only`). Do not run a plain
`gitnexus analyze` in a target repo.

Run this after large refactors or after renaming many files. The graph update
is incremental on subsequent runs.

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
[KB] WARNING: offline queue has N unsaved captures. Reconnect to the KB server and run kb_harvest to recover from the session transcript.
```

**Cause**: the HTTP KB server was unreachable while captures were made. The
queue is in-memory and not persisted.

**Recovery**: start the KB server, then run:
```
kb_harvest with session_output="<paste session transcript>"
```

AUDN deduplication ensures entries from the harvest do not create duplicates
if some were already sent before the server went offline.

### Token rejected (401)

**Symptom**: KB server returns 401 for all requests.

**Fix**: the token in the client config must match the server's token. Regenerate
on the server:
```bash
node dist/index.js kb-server --generate-token
```

Then re-run `kb_setup` on each client with the new token.
