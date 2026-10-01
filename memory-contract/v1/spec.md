# memory-contract/v1 -- Specification

Status: skeleton created by T1.3.1 (provider-method section authored by T1.3.1);
section 4 ("Invariants") authored by T2.
This file has exactly two writers by design for sections 1-3 (see README.md's
ownership note in `tests/GENERATOR-DECISION.md`): T1.3.1 owns "Envelope" and
"Provider methods" below; T1.3.2 owns "Error model". Both live in lane
`t1-contract-docs` so no third writer is ever added to those sections without
a re-plan. The RESERVED section 5 is a placeholder for a later task (T3) and
must not be filled in from this lane.

Trust-relevant behavior is POINTED AT here, not restated: each pointer below
names the invariant and where the enforcing code lives, and defers the full
rule text to the "Invariants" subsections that own it, or to
`methods.json`/`INVENTORY.md` where the mechanism is already documented in
full. Do not copy invariant prose between this file, `methods.json`, and
`INVENTORY.md` -- one sentence, one home.

## 1. Envelope

Every one of the 23 tools (16 `kb_*`, 7 `code_*`) is registered through the
shared `wrapTool` helper (`src/services/tool-registry.ts`), so every response is
wrapped in the same minimal text-content envelope, current fields only:

```
ToolTextResponse = { content: [ { type: "text", text: string } ] }
```

- `content` is always a single-element array; `text` is the JSON-stringified
  handler payload -- so every response is JSON-parseable in practice even
  though no tool declares a response zod schema (`INVENTORY.md` section 3).
- No tool in this surface returns `structuredContent`; that channel is unused
  here (`wrapTool` only forwards it when the handler returns
  `{text, structuredContent}`, and all 23 handlers return a bare `string`).
- **The published schemas are deliberately WIDER than the reachable shape, and
  that is not a contradiction of the two statements above.** Every
  `schemas/*.response.json` permits `content` to hold 1-3 items, allows an
  optional `annotations` object on each item, and allows an optional
  `structuredContent` -- because the schema documents `wrapTool`'s general
  contract, not the subset these 23 handlers happen to reach. The narrower
  claims above are REACHABILITY findings about this surface: all 23 handlers
  return a bare `string`, so `wrapTool` emits exactly one text item and never
  populates `structuredContent`. A consumer MUST validate against the schema,
  which accepts everything `wrapTool` can emit; a consumer that hard-codes the
  single-element shape from this prose alone would be stricter than the
  contract and would break if a handler later returned
  `{text, structuredContent}`. If that ever happens it is an envelope
  extension, not a schema change -- see section 5.
- On top of the envelope, a response body is either:
  - **Body known** -- the text envelope plus a documented `parsed` object, for
    all 16 `kb_*` tools (`schemas/kb_*.response.json`).
  - **Body opaque** -- the text envelope only, with `parsed` typed as
    unconstrained JSON, for all 7 `code_*` tools (`schemas/code_*.response.json`).
    This is a deliberate permissive schema (see `methods.json`'s
    `code_intelligence_methods`), not a gap to be filled by guessing the
    provider payload.

Extensions to this envelope (e.g. `structuredContent` becoming used, or a
provider-agnostic error envelope) are out of scope here -- see "Envelope
extensions (T3, RESERVED)" below.

## 2. Provider methods

Rendered from, and checked against, `methods.json` in this directory.
`methods.json` is the source of truth for purpose, request/response schema
refs, side-effect class, idempotency and error codes; this section names every
method it contains and nothing else, so the two never drift silently out of
sync.

### 2.1 `MemoryProvider` interface methods (`methods.json` ids P-1..P-12)

`init`, `capture`, `query`, `context`, `invalidate`, `getLinked`, `prime`,
`promote`, `sync`, `stats`, `touch`, `relatedClaims`.

Side-effect classes used across this set: `append` (`init`, `query`, `sync`,
`touch`), `trust-mutating` (`capture`, `invalidate`, `promote`), `pure read`
(`context`, `getLinked`, `prime`, `stats`, `relatedClaims`). See
`methods.json`'s `side_effect_class_definitions` for what each class means; no
method in this surface is classified `consent-gated` on its own (the
consent-gated CLI-only surface -- `approveDirective`, `rejectDirective`,
`addDirective` -- is not tool-reachable; see `methods.json`'s `not_in_scope`).

### 2.2 Undeclared members reached by tools but absent from `MemoryProvider` (`methods.json` ids X-1..X-6, plus the X-7 property)

`list`, `feedback`, `freshnessSweep`, `resolveContradiction`,
`reconcilePrefilter`, `hasEntry` (methods), and `repoPath` (property, not a
method -- listed in `methods.json`'s `properties` array, not its `methods`
array, and not counted against "every method has an entry").

A binding generated only against the declared `MemoryProvider` interface is
INCOMPLETE without this set (`INVENTORY.md` section 4.2).

### 2.3 `CodeIntelligenceProvider` interface methods (`methods.json` ids C-1..C-7)

`graph`, `impact`, `query`, `context`, `map`, `flow`, `tests`. All seven are
pure proxies to the active provider (`codebase-memory`, `gitnexus`, or `none`)
and are classified `pure read` here at the fleet boundary; the ACTIVE PROVIDER
owns the real effect and idempotency of its own payload (`INVENTORY.md`
section 4.3).

### 2.4 Every kb_* call is scoped to the calling session (KB constraint)

No `kb_*` tool takes a repo/scope argument. The KB a call reads/writes is the
calling session's own: a member session resolves its registered work folder,
any other session the fleet server's working folder. A folder that cannot
carry a KB identity is refused before the provider is reached
(`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`, `E-SELF-NO-REMOTE`). A remote
member's folder lives on another host: the read tools carry it verbatim and
tolerate the missing anchor, while the writing tools (`kb_export`,
`kb_import`) refuse with `E-REPO-PATH-INVALID`. This is recorded in
`methods.json`'s `_meta.kb_self_resolution` and per tool in each method
entry's `tools[].anchor_validation` field.

### 2.5 Every code_* call is scoped to the calling session (code constraint)

No `code_*` tool takes a repo/scope argument either. The repo a call is about
is resolved exactly as for `kb_*` (section 2.4): a member session's registered
work folder, any other session the fleet server's working folder. A local
folder that is missing or is not a git repository is refused before the
provider is reached (`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`); unlike
`kb_*`, no origin remote is required, because a code index is keyed by folder,
not by KB identity. A member session never falls back to the server folder.
A remote member's folder lives on another host and is passed to the provider
verbatim. The resolved folder is what the provider receives as its repo, what
usage telemetry records, and (for `code_context`) whose KB enriches the result.
Owned by `resolveCodeSelf()` in `src/tools/code-intelligence.ts`, over the
shared `resolveSelfSession()` / `validateSelfRepoFolder()` in
`src/services/knowledge/kb-self.ts`. Fixtures
`code_query/refusal-self-no-workfolder` and `code_map/refusal-self-not-a-repo`
pin the two refusals; every `code_*` happy fixture runs as the `CODE` member
session.

## 3. Error model

`taxonomy.json` in this directory is the source of truth: a CLOSED set of
machine codes, each carrying a code string, a meaning, its raising methods and
a `retryable` flag. This section explains the shape of that set and points at
it; it deliberately does not restate any individual code's meaning, and it adds
no code that is not in `taxonomy.json`.

### 3.1 Groups

Codes are partitioned into seven groups -- exactly one group per code:
`validation`, `admission`, `authority`, `governance`, `conflict`, `not_found`,
`provider_internal`. See `taxonomy.json`'s `_meta.group_definitions` for what
each group admits. Two boundaries are worth naming because they are easy to get
backwards:

- `validation` vs `provider_internal`: a refusal decided from the caller's
  input alone before any provider exists is validation, even when it is raised
  by a tool that is about to talk to a provider. This is the recorded decision
  for `E-REPO-PATH-INVALID` (see its `group_decision` field). The self-resolution (`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`, `E-SELF-NO-REMOTE`)
  codes are the converse: no request field is wrong (there is no scope field),
  the session's resolved KB configuration cannot serve the call, so they are
  `provider_internal` (see their `group_decision` fields).
- `authority` vs `governance`: authority refuses an attempt to write trust
  above the INFERRED ceiling; governance refuses an attempt to retire,
  override, or activate an entry regardless of tier.

### 3.2 Not every documented outcome is an error

`taxonomy.json`'s `non_error_outcomes` array lists paths that a throw-site scan
or a naive reading of `INVENTORY.md` section 5 would mistake for errors and that
deliberately get NO code, each with its reason. They fall into three kinds:

- **The requested call succeeded with a documented adjustment** -- the
  confidence clamp, the AUDN `none` (dedup) decision, and the AUDN `flagged`
  (contradiction) decision. Each is reported in a named response field, so a
  caller can already see exactly what happened.
- **A read tolerated a missing anchor** -- a remote member session's folder,
  carried verbatim. The writing branch of that same one policy does refuse, and
  that branch is the one with a code.
- **A failure was degraded into an answer** -- the `code_*` adapters' offline
  and missing-index results, the swallowed bible read, the emptied
  `related_claims`, the unknown author role, and a provider reporting stats as
  unsupported.

### 3.3 No code in v1 is retryable

Every entry carries `retryable: false`. This is a finding, not a default: the
transient-failure paths in this surface never propagate to the caller as errors
-- they are converted into structured results at the provider boundary (third
kind in 3.2) -- so v1 has no retry-with-backoff class at all. `retryable` means
"retrying the identical request unchanged can succeed"; fixing a path or
supplying a missing reason is a new request, not a retry.

### 3.4 Silent refusals are named but not projectable

Each code also carries `surfaced`: `thrown`, `response-field`, or `silent`. The
`silent` ones are real refusals with no distinguishable signal today -- the
requested effect did not happen and the response looks like an ordinary
success. They are named in the taxonomy precisely because they are the easiest
refusals in the surface to miss. Per `_meta.projection_rule`, a `silent` code
must NOT be projected into a wire error enum: the server never emits it, so a
consumer branching on it would branch on something unreachable.

### 3.5 Directive activation is absent, not refused

Activating a captured `user-directive` is CLI-only, and no server code path for
it may exist. The quarantine is therefore expressed by ABSENCE: no consumer of
this contract may emit a path, an operation, a code, or a schema shape for
approving, rejecting or activating a directive -- not even one that always
refuses, because a documented-but-forbidden route is still a route. The codes
belonging to those CLI-only operations are held in `taxonomy.json`'s
`excluded_from_closed_set` block, outside every group, with the reason.

What IS published is the `governance` group's refusals of activation ATTEMPTS
made through routes that genuinely exist (capture quarantine, promote,
contradiction resolution). Those are answers this server really gives, and
hiding them would misdescribe live behavior. The invariant rule text for the
quarantine itself lives in "Directive quarantine" below (T2).

## 4. Invariants

Six subsections, each the spec.md home that an `x-invariant` id in
`schemas/*.json` (see `tests/GENERATOR-DECISION.md` section 4) or a
`see_also` pointer in `methods.json` resolves to -- per the hand-off list in
`tests/GENERATOR-DECISION.md` section 4 ("no invariant points anywhere
else").

### 4.1 Scope resolution and repo aliasing

**THE RULE.** No `kb_*` request carries a scope field: a binding MUST NOT
declare `repo`, `repo_path` or `repo_remote_url` on any `kb_*` request. A
provider MUST resolve the KB from the CALLING SESSION -- a member session's
registered work folder, otherwise the server's own working folder -- and MUST
refuse a folder that cannot carry a KB identity with the matching typed code
(`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`, `E-SELF-NO-REMOTE`), each with a
one-line remediation, rather than degrading to a directory-name or `default`
KB. `kb_import`'s `path` names a bible file and MUST NOT select which KB is
written. `kb_setup` installs its hook into the session's folder and writes one
global config; when the folder cannot carry a KB identity it skips the hook
and reports the typed reason rather than refusing. (INV-05, INV-06)

**THE PROOF.** `src/services/knowledge/kb-self.ts` owns the resolution:
`resolveSelfAnchor()` reads the session member id (`getSessionMemberId()`,
`src/services/tool-scope.ts`), looks the member up in the registry and
validates its folder (`validateSelfFolder()`: exists, `git rev-parse` succeeds,
`git remote get-url origin` succeeds); with no member identity it validates
`process.cwd()`. Every `kb_*` handler calls it (`getSelfKbProviders()` or
`resolveKbAnchor()`), and none of `src/tools/kb-*.ts` declares a scope field.
A remote member (agentType not local) cannot be checked on this host, so its
KB identity is its single known origin remote (`knownRepoRemoteUrl`) and the
folder is passed verbatim; `kb_session_prime` and `kb_stats` tolerate that
missing anchor (`taxonomy.json` non_error_outcomes
`N-ANCHOR-VERBATIM-MISSING`), while `kb_export` and `kb_import` refuse with
`E-REPO-PATH-INVALID` (`requireLocalFolder`). In-process callers that already
know the repo (the post-dispatch harvest in `src/tools/execute-prompt.ts`, the
`kb commit` / `kb import` CLIs) pass an explicit anchor as the handler's second
argument, which no MCP request can carry.
`src/services/knowledge/kb-providers.ts` caches provider instances by
`providerKey(slug, repoPath)`, NUL-joined -- deliberately NOT slug alone, so
two anchors resolving to the same project slug but different folders get
distinct basis-hash roots rather than sharing the first caller's.

**THE OBLIGATION.** A generated binding MUST NOT reintroduce a scope field on
any `kb_*` request; scope is a property of the session, not of the call. An
implementation MUST derive KB identity from the resolved folder's origin
remote and MUST surface the three self-resolution (`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`, `E-SELF-NO-REMOTE`) codes rather than guessing. Any
provider-instance cache MUST key on the (slug, repoPath) pair, not slug
alone. An implementation MUST preserve which tools refuse versus tolerate an
unreachable remote folder -- read tools tolerate, writing tools refuse.

**THE TEST HOOK.** The round-trip harness dispatches every fixture as a
registered member session (`tests/roundtrip-harness.mjs` `ENVIRONMENT.sessions`)
and carries one refusal fixture per self-resolution (`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`, `E-SELF-NO-REMOTE`) code
(`kb_query/refusal-self-no-workfolder`, `kb_stats/refusal-self-not-a-repo`,
`kb_list/refusal-self-no-remote`); the request schemas' `additionalProperties:
false` rejects a scope field before dispatch. The (slug, repoPath)
cache-keying invariant is `tests/DEGRADATION.md` D-2.

### 4.2 Capture provenance and confidence clamp

**THE RULE.** A provider MUST cap confidence at INFERRED on an ordinary
capture: an incoming `confidence: CONFIRMED` MUST be downgraded to INFERRED,
MUST set `confidence_clamped: true` in the `kb_capture` response, and MUST
append a bracketed note to the stored content. More generally,
`confidence_clamped` MUST be `true` exactly when the stored confidence differs
from the requested one (absent means INFERRED) -- so a `user-directive`,
quarantined to UNVERIFIED by 4.3, also reports `true`, while it does NOT get
the bracketed note (the note names kb_promote, which is not its remedy). CONFIRMED MAY be minted by the
promotion path (`kb_promote`) and MAY additionally survive on a dedicated
bible-import path, because that path is a separately-trusted, human-reviewed
channel -- but that exemption MUST be reachable only through an internal,
non-serializable flag, never a field a caller can set on the request body. A
closed Author enum MUST gate `role` server-side even though the request
schema leaves it open; any value outside it, including an absent hint, MUST
be stamped as the literal `unknown`. `source` derivation is a handler-level
guarantee, not a provider-level one: on the `kb_capture` tool path `source`
MUST be derived from the validated role and type and MUST NOT be read from
the request; at the provider choke point a caller-supplied `source` is
otherwise persisted VERBATIM, except that the two privileged values
`'import'` and `'promotion'` MUST be forced to `'unknown'` outside import
mode, because those two mark a trusted-channel provenance and a forged one
would let an audit keyed on `source='import'` trust a row it should not.
Admission -- whether an entry cites a checkable basis at all -- is a distinct gate
enforced at the same provider entry point, not part of this clamp, but this
is the invariant 4.3 defers it to for the directive case: a directive citing
zero files is exempt (4.3's basis exemption), but a directive citing files
that do not resolve is refused the same as any other type
(`E-BASIS-MISSING-FILES`; a non-directive citing zero files is refused under
`E-NO-BASIS`, admission group). (INV-02, INV-07)

**THE PROOF.** The request schema still accepts `CONFIRMED` as an input value
(`src/tools/kb-capture.ts:39-40`) -- that is the trap: honoring it verbatim is
schema-faithful but non-conforming. The clamp exists at two sites with
DIFFERENT scopes. The tool handler, `src/tools/kb-capture.ts:99-107`,
downgrades `confidence`, sets `confidence_clamped`, and appends
`'\n\n[confidence clamped: CONFIRMED requires kb_promote]'` to content for
every `type` except `user-directive` (whose quarantine to UNVERIFIED is
applied next, in the same handler), then derives `confidence_clamped` from
stored-vs-requested confidence, so both downgrades report it -- and only for
calls that reach this handler (the `kb_capture` MCP tool; `kb_harvest`,
`kb_import`, and the HTTP route never populate `confidence_clamped` at all).
The provider choke point, `src/services/knowledge/sqlite-provider.ts:889-895`,
re-enforces the downgrade for every route that reaches `capture()` --
`kb_capture`, `kb_harvest`, `kb_import`, and the HTTP `/api/kb/capture` route,
which calls `provider.capture()` directly and bypasses the tool handler
entirely (comment at `:845-855` names this explicitly) -- but its condition,
`!opts?.importMode && input.type !== 'user-directive' && input.confidence ===
'CONFIRMED'` (`:889`), carries two exemptions the handler does not have.
`type === 'user-directive'` is excluded because the directive gate
(`:806-818`) has already forced that entry's confidence to UNVERIFIED before
this check runs, overriding whatever the handler set. `!opts?.importMode` is
excluded because a bible import keeps its stored confidence, including
CONFIRMED (comment `:877-886`): the bible is a git-reviewed, human-merged
artifact, and re-clamping would demote a whole team's already-earned trust on
every import. `importMode` is the SECOND parameter of `capture()`, never a
field of the deserialized request body, so no caller reaching `capture()`
through a route can set it (`:878-881`). Provenance: `AUTHOR_VALUES`
(`src/tools/kb-capture.ts:11`) and `validateAuthor`
(`src/tools/kb-capture.ts:16-21`) gate `role` against the closed set `doer,
reviewer, planner, plan-reviewer, kb-agent, kb-reconciler, harvest, pm, user`;
anything else, or an absent hint, returns the literal `'unknown'`. `source` is
computed at `src/tools/kb-capture.ts:117-122` from the validated `author` and
`type` -- `'user-directive'` for a directive, `'review'` when `author ===
'reviewer'`, else `'session'` -- and is never read from `input` ON THIS PATH.
The provider choke point does not repeat that derivation: `insertEntry()`
persists `input.source` VERBATIM (comment at
`src/services/knowledge/sqlite-provider.ts:862-863`), and the only
normalization applied is at `:873-875` -- a caller-supplied `source` of
`'import'` or `'promotion'` is overwritten with `'unknown'` when
`!opts?.importMode`, because those two values mark trusted-channel provenance
(`'import'` from `kb_import`, `'promotion'` stamped only by `promote()`) and a
forged one would let an audit keyed on `source='import'` trust a row it
should not; every other caller-supplied value survives into storage
unchanged. The HTTP `/api/kb/capture` route reaches this unguarded: it parses
the request body straight into `KBEntryInput` and calls
`provider.capture(input)` (`src/commands/kb-server.ts:138-142`), never
touching the handler that derives `source`. Admission is
a separate check at the same provider entry point (`assertCheckableBasis`,
`src/services/knowledge/sqlite-provider.ts:843`, body at `:334-356`): the
zero-files half exempts `type === 'user-directive'` (`:337-338`, returns
early), but the unresolvable-files half (`:347-355`) has no type exemption
and still refuses a directive whose cited files do not exist.

**THE OBLIGATION.** A second implementation MUST enforce the clamp at its
provider-level capture entry point, not only in a request handler: trusting a
client-declared CONFIRMED does not conform, because any route that reaches
storage without passing through the handler would otherwise mint CONFIRMED
directly. Only two categories may keep an incoming CONFIRMED at that entry
point: a value written by the promotion path itself, and a bible import
running under an internal, non-forgeable import flag. `type='user-directive'`
MUST NOT be coded as a third, independent exemption; it is unaffected only
because the directive gate runs first and already forced it to UNVERIFIED, and
an implementation MUST preserve that ordering rather than special-casing
directives in the clamp condition itself. It MUST close the Author enum
server-side despite the open schema field. It MUST derive `source` from
validated role/type on the handler path, but MUST NOT assume a
caller-supplied `source` is trustworthy on any route that reaches the
provider directly -- that guarantee is handler-level, not provider-level, the
same shape as `confidence_clamped` (handler-only) and `content_hash`
(HTTP-caller-settable, 4.5). It MUST reproduce the privileged-value defense
at the provider boundary itself, forcing a caller-supplied `'import'` or
`'promotion'` to `'unknown'` outside import mode, rather than relying on a
request schema to omit a `source` field. Rejecting an entry that cites no
source files (`E-NO-BASIS`, non-directive only), or one whose cited files do not resolve
in the worktree (`E-BASIS-MISSING-FILES`, every type including directives),
is admission's rule, not this clamp's -- but a conforming implementation MUST
still enforce both halves at this same entry point, since 4.3's directive
exemption is only the zero-files half and depends on the unresolvable-files
half still applying.

**THE TEST HOOK.** `clamp` -- for `kb_capture`, assert a request carrying
`confidence: CONFIRMED` returns `confidence_clamped: true`, including for a
`user-directive`; for every
non-import, non-directive route (`kb_capture`, `kb_harvest`, the HTTP capture
route), assert the entry reads back at INFERRED regardless of what the
response body reported; separately assert a bible import retains CONFIRMED
untouched.

### 4.3 Directive quarantine

**THE RULE.** A provider MUST accept a `type='user-directive'` capture and
MUST store it as a pending proposal rather than as requested: confidence
forced to UNVERIFIED, `flagged_for_review` set, a `directive:pending` tag
added, and `scope` forced to `project` whatever scope was asked for. A
provider MUST NOT surface that transformation as a refusal, and MUST NOT
offer any operation that activates a directive. Admission still applies
independently: a directive citing files that do not resolve in the worktree
is refused under `E-BASIS-MISSING-FILES`, which is 4.2's rule and not this
one. (INV-03)

**THE PROOF.** One block at the provider entry point does all four:
`src/services/knowledge/sqlite-provider.ts:806-818` -- `confidence:
'UNVERIFIED'` (`:813`), `flagged_for_review: true` (`:814`), `scope:
'project'` (`:815`), and `directive:pending` appended when not already
present (`:807-810`). It rewrites `input` and falls through; it never throws,
so the call returns an id, and the HTTP capture route reaching that same code
answers `201` (`src/commands/kb-server.ts:136-143`, provider call at `:142`).
The refusing siblings of this one policy are separate sites that DO throw:
`kb_promote` at `sqlite-provider.ts:1353-1357` and contradiction resolution
at `sqlite-provider.ts:1569-1571`
(`E-PROMOTE-REFUSED-DIRECTIVE`, `E-RESOLVE-DIRECTIVE-PAIR`). The basis
exemption above is only the empty-basis half: `assertCheckableBasis`
returns early for a directive at `sqlite-provider.ts:337-338`, nested inside
the zero-files branch, so the unresolvable-files throw at `:347-355` still
reaches it.

**THE OBLIGATION.** A second implementation MUST enforce this at its
provider-level capture entry point, NOT in a request handler. Three of this
kernel's four capture call sites -- `src/tools/kb-harvest.ts:148`,
`src/tools/kb-import.ts:224`, and the HTTP route above -- never pass through
`src/tools/kb-capture.ts`, so a handler-level check is bypassed by most
capture traffic; the scope force at `src/tools/kb-capture.ts:74` is redundant
UX copy, not the enforcement point. It MUST NOT report the transformation as
a failure. That is the trap: quarantine reads like a refusal and is not one,
so projecting `E-DIRECTIVE-QUARANTINE` onto the wire yields a server that
rejects a capture this kernel accepts.

**THE POLICY.** Directive activation is human-only, permanently. No server
route will ever activate a captured directive; activation lives only on the
CLI (`methods.json`'s `not_in_scope` set), which is structurally a human-only
surface. The guarantee is the ABSENCE of the capability, not a guarded
version of it, and absence is strictly stronger than any authenticated route
could be: a route that always refuses still has a handler to reach, a
credential to steal and an authorization check to get wrong. There is nothing
here to compromise because there is nothing here. An implementation MUST NOT
add such a route, not even a refusing one (see 3.5).

**THE TEST HOOK.** `directive-smuggling-impossible` -- capture a
`user-directive` through every capture path, assert each call SUCCEEDS (an
id, or the path's own success counter), then read the entry back and assert
UNVERIFIED, flagged,
`directive:pending`, project scope. The read-back is load-bearing: the
capture response exposes none of the forced fields, so the effect is
observable only through a later `kb_list` (`tests/DEGRADATION.md` D-8).

### 4.4 Superseding and AUDN matching

**THE RULE.** A `supersedes` id on a capture MUST retire the named entry ONLY
IF AUDN independently matches that entry as a same-topic candidate for the
new one -- same `type`, overlapping `symbols` AND overlapping `source_files`
-- and MUST NOT retire it merely because the caller named it. When the named
id fails that match, the request MUST be treated as if `supersedes` had not
been given at all: the capture still proceeds to whatever ordinary AUDN
outcome the candidate pool otherwise produces. A provider MUST NOT retire, or
otherwise mutate via `supersedes`, a candidate that is an ACTIVE user-directive
(`type='user-directive'` AND `confidence='CONFIRMED'`) -- this guard applies
regardless of whether the caller named that entry explicitly or AUDN would
have matched it implicitly. Neither refusal MUST be surfaced on the wire: both
are `surfaced: "silent"` in the taxonomy, so the capture response reports only
the ordinary `audn_decision` the fallthrough produced, never a distinguishing
signal that a supersede was requested and ignored. (INV-04)

**THE PROOF.** The explicit-supersede branch,
`src/services/knowledge/audn.ts:145-157`, looks up `input.supersedes` among
the candidates and requires ALL of: `c.id === input.supersedes`, `symbolsOverlap`
(`:148`), `c.type === input.type` (`:150`), and `filesOverlap` (`:151`) -- an
AND across every predicate, not an OR; the prompt describing this rule to
that effect is confirmed by the code. The same line also excludes an ACTIVE
directive from ever being `target` (`:149`,
`!(c.type === 'user-directive' && c.confidence === 'CONFIRMED')`). When no
candidate satisfies all four, `target` is `undefined` and the `if
(input.supersedes)` block (`:145-157`) falls through with no side effect at
all -- `input.supersedes` is never referenced again in the function, so
execution continues into the exact-content pre-pass (`:159-183`) and the main
candidate loop (`:185-239`) exactly as if the field had been absent. That
fallthrough can itself resolve to `none`, `flagged`, an `update` against a
DIFFERENT candidate, or `null` (a plain `add`) -- none of which reports that
the named supersede was ignored. When a match IS found,
`src/services/knowledge/sqlite-provider.ts:704-718` (`evaluateAudn`'s EXPLICIT
branch) runs `UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?`
against the matched id before inserting the new row; the sibling IMPLICIT
branch three lines later, `:719-729` (same type, overlapping symbol and file,
but `input.supersedes` absent or not the matched id), inserts the new row and
links it to the old one with a `refines` edge instead -- both rows stay live.
The ACTIVE-directive guard is enforced a second time, independently, in the
main loop at `src/services/knowledge/audn.ts:224`
(`if (candidate.type === 'user-directive' && candidate.confidence ===
'CONFIRMED') continue;`), which skips the update/supersede path for that
candidate whether or not it was named by `supersedes` -- the candidate
degrades to `flagged` if a contradiction signal was present, or is skipped
entirely. The only route to an ACTIVE (CONFIRMED) user-directive is
`approveDirective`, a CLI-only method never reachable from `capture()`
(4.3); no capture path can mint or promote one, which is why this guard can
only ever fire against a directive that was activated by a human, out of
band. Both refusals are recorded, `surfaced: "silent"`, in
`taxonomy.json`'s governance group as `E-SUPERSEDE-CONSENT-MISSING`
(`:215-226`) and `E-ACTIVE-DIRECTIVE-SUPERSEDE-GUARD` (`:227-239`).

**THE OBLIGATION.** A second implementation MUST require independent,
system-decided agreement -- same type, symbol overlap, AND file overlap --
before retiring anything named by `supersedes`; it MUST NOT treat
`supersedes` as a direct delete-by-id, no matter how plausible the caller's
claim looks. It MUST NOT invent a response field, error code, or wire enum
value to report either refusal -- not the general consent-missing case, and
not the ACTIVE-directive case -- because doing so would make the
implementation refuse or signal where this kernel silently proceeds, which is
itself a non-conforming behavior change. A consumer MUST NOT infer that a
requested supersession occurred from a successful response: `audn_decision`
describes what AUDN actually decided for the NEW entry, not whether the named
OLD entry was retired. This is a different surprise than 4.3's quarantine:
quarantine is a capture that succeeds and stores a TRANSFORMED entry (the
directive itself is rewritten before storage); a silent supersede refusal is
a capture that succeeds, stores the new entry UNCHANGED, and simply drops the
requested SIDE EFFECT of retiring another row. Both are "success with a
surprise," but only quarantine changes what was stored -- this one changes
what else did not happen.

**THE TEST HOOK.** `supersession` -- for the general case: capture an entry,
then a second capture naming it via `supersedes` with matching type/symbols/
files, and read the FIRST entry back to assert `superseded_at` is now set (the
capture response alone cannot show this); separately, capture with a
`supersedes` id that fails the match (wrong type, or no file overlap), and
read that named entry back to assert it is UNCHANGED regardless of what
`audn_decision` reported. For the ACTIVE-directive branch specifically, no
tool call can construct a CONFIRMED user-directive to supersede in the first
place (activation is CLI-only, 4.3), so that half of the guard is a named,
unreachable gap rather than a case the round-trip harness can exercise --
`tests/DEGRADATION.md` D-9.

### 4.5 Freshness and content hashing

**THE RULE.** An implementation that computes a whole-file `content_hash` for
a capture MUST do so only when `type = 'context-cache'` AND `source_file` is
present; for every other type, or when `source_file` is absent, it MUST NOT
raise an error -- it MUST silently store no hash. That whole-file
`content_hash` is a DIFFERENT value
from the per-entry freshness basis, `source_file_hashes`: a provider MUST
compute that basis at its capture entry point for every entry that cites
`source_files`, independent of `type`, because it is what the freshness sweep
actually reads -- a sweep wired off `content_hash` instead does not conform.
A provider exposing a freshness sweep MUST report `{checked, staled,
unstaled}`, MUST both stale entries on a basis mismatch AND revive
previously-staled entries on a full basis match (bidirectional, not
stale-only), and MUST yield no verdict when an anchor it was explicitly given
does not exist on the current host. An implementation with no anchor
configured at all is not bound by that withholding rule -- it MAY resolve
basis paths against its own working directory instead. (INV-01)

**THE PROOF.** The hashing gate is `src/tools/kb-capture.ts:58` -- `if
(input.type === 'context-cache' && input.source_file)` -- guarding
`computeFileHash` at `:59-64`; when the condition is false, `content_hash`
stays the initialized empty string (`:55`) and is persisted as-is
(`src/services/knowledge/sqlite-provider.ts:265`, `input.content_hash ?? ''`),
with no error path anywhere in between. `capture()` itself never computes
`content_hash` -- it only persists whatever value `input` already carries.
`kb_harvest` and `kb_import` both pass it explicitly as `''`
(`src/tools/kb-harvest.ts:132`, `src/tools/kb-import.ts:206`), so neither ever
sets a real hash. The HTTP `/api/kb/capture` route is the exception: it
parses the request body straight into `KBEntryInput` and passes it to
`provider.capture()` unfiltered (`src/commands/kb-server.ts:138-142`), so an
HTTP caller supplying its own `content_hash` field has it persisted verbatim,
bypassing the `kb-capture.ts:58` gate entirely -- the gate is a `kb_capture`-
handler convenience, not an enforced invariant of `capture()` itself. The
freshness basis is a different value, computed unconditionally by
`capture()` itself at `src/services/knowledge/sqlite-provider.ts:902`
(`computeSourceFileHashes`; comment `:899-901`: "capture() is the single
choke point every caller ... goes through, so every entry gets a hash basis
here regardless of type") -- this is what `freshnessSweep` reads, never
`content_hash` (comment at `:464`: "NOT content_hash, which is only ever set
for context-cache entries"). `freshnessSweep` (`:586-652`) returns exactly
`{checked, staled, unstaled}` (`:651`), where `checked` counts entries with a
non-empty, parseable stored basis (`:622-624`). Staling and reviving share
one predicate pair: `basisFullyMatches` (`:437-448`, full-basis-only -- an
empty basis or any single non-matching file never matches) decides the
mismatch/match, and `freshnessRevivable` (`:417-428`, excludes superseded,
feedback-flagged, `content_hash='invalidated'`, or durable-downvote-marked
entries) gates which matches are allowed to revive. The anchor check,
`anchorIsMissing` (`:325-327`, `anchor !== undefined && !fs.existsSync(anchor)`),
only withholds a verdict when an anchor IS resolved (an explicit `root`
argument, or the provider's own configured `repoPath`) and that path does not
exist on disk (`:588`); when no anchor is configured at all -- `root` omitted
and the provider has no `repoPath`, the shared global KB's case --
`anchorIsMissing` returns false and the sweep proceeds, resolving relative
basis paths against the process's own working directory (`:618`,
`computeFileHashBatch([...fileSet], anchor ? { cwd: anchor } : undefined)`;
comment `:583-585` names this the prior "implicit-cwd" behaviour, kept
deliberately for that case). `src/tools/kb-invalidate.ts` drives explicit
invalidation: the provider's `invalidate()` marks context-cache entries stale
by setting `content_hash = 'invalidated'` for files named in a commit
(`src/services/knowledge/sqlite-provider.ts:1119-1139`, the SET clause at
`:1137`); the git hook that calls it is installed by
`installKbPostCommitHook` (`src/tools/kb-invalidate.ts:25-32`), which
`kb-setup.ts` invokes for the calling session's own folder when it carries a
KB identity and has a `.git` directory (see 4.1).

**THE OBLIGATION.** A second implementation MUST reproduce the silence, on
the route that computes `content_hash` at all (`kb_capture`):
`type='context-cache'` without `source_file` is a valid, successful capture
that stores no `content_hash`, not an error. This hashing gate MUST NOT be
conflated with the freshness basis -- `source_file_hashes`
MUST be computed for every entry that cites `source_files`, regardless of
`type` and regardless of whether `content_hash` was ever set. Freshness MUST be
genuinely bidirectional -- an implementation that only stales and never
revives does not conform -- and revival MUST require a FULL match of the
stored basis (every cited file, not a majority) AND that the entry is not
separately retired (superseded, flagged, or invalidated). An implementation
MUST withhold a verdict when a specifically-configured anchor does not exist
on the current host, but MAY fall back to an implicit working directory when
no anchor was configured at all; collapsing that distinction into "always
withhold" or "always fall back" does not conform.

**THE TEST HOOK.** `freshness` -- capture an entry with a resolvable basis,
mutate a cited file to force a mismatch and assert `staled` includes it,
restore the file and assert a later sweep's `unstaled` revives it, repeat
against a superseded/flagged/invalidated entry and assert it stays retired
despite a full basis match, then assert a sweep against a configured-but-
nonexistent anchor returns `{0, 0, 0}` while an unconfigured anchor still
proceeds.

### 4.6 Query modes

**THE RULE.** `kb_query` MUST return exactly one of two mutually exclusive
response shapes, selected by the request: when `flagged_only: true`, the
response MUST be `{flagged_entries, total, note}`; otherwise it MUST be
`{l1_results, l2_expanded, related_claims?}`. At least one of `query`, `tag`,
or `flagged_only` MUST be supplied; a provider MUST refuse a request carrying
none of the three. A consumer MUST treat this section's response shapes, and
every other `kb_*` response shape, as a DIFFERENT KIND of claim than the
request shapes documented elsewhere in this spec: they are OBSERVED, not
derived from an enforced schema, because no tool in this surface declares
one. (INV-08, INV-09)

**THE PROOF.** The selector guard is `src/tools/kb-query.ts:33-35`: `if
(!input.query && !input.flagged_only && !input.tag) throw new Error(...)`.
This is a documented, coded throw, not an undocumented one: `taxonomy.json`
carries it as `E-QUERY-NO-SELECTOR` (groups.validation, source cited at
`src/tools/kb-query.ts:34`, `surfaced: "thrown"`, raised pre-provider by
`kb_query`/P-3). The `flagged_only` branch (`src/tools/kb-query.ts:39-66`)
merges project and global flagged results and returns `{flagged_entries,
total, note}` (`:59-65`); the default branch (`:68-126`) merges L1/L2
project and global results and returns `{l1_results, l2_expanded,
...(expand_related ? {related_claims} : {})}` (`:122-126`) -- `related_claims`
is itself conditional on `expand_related`, so even the non-flagged shape is
not fixed-key. `schemas/kb_query.response.json` models both branches as an
`anyOf` of two object schemas under `parsed` (`:58-104`), tagged
`x-invariant: ["INV-09", "INV-08"]` (`:4-7`) -- the schema faithfully carries
both observed shapes, but nothing in `src/tools/kb-query.ts` or
`src/services/tool-registry.ts` (`wrapTool`, which only ever wraps a bare
returned `string` into the text envelope) checks the stringified body against
that schema at runtime. `INVENTORY.md` section 3 states the meta-fact
directly (`:102`, "NO tool in this surface declares a response zod schema").
The discriminator loss is a separate, related finding: `tests/GENERATOR-
DECISION.md`'s D1 row records that the generator emits `anyOf`, not `oneOf`,
for a discriminated response union, because "an OpenAPI 3.1 `discriminator`
requires `oneOf`, so the mapping from discriminant value to branch is not
machine-readable in the emitted schema" (tagged `x-invariant: INV-09`) --
`kb_query.response.json`'s own two-branch `parsed` union is exactly this
shape: `anyOf`, no `discriminator` keyword, nothing to dispatch on
mechanically besides re-deriving `flagged_only` from the request that
produced the response.

**THE OBLIGATION.** A second implementation MUST preserve the two-shape
split keyed on `flagged_only` and MUST NOT merge them into one
always-present superset response; each branch is closed
(`additionalProperties: false` per branch, `schemas/kb_query.response.json:80`,
`:101`). It MUST refuse when none of `query`/`tag`/`flagged_only` is present;
the taxonomy already names this refusal (`E-QUERY-NO-SELECTOR`), so a
conforming implementation has no discretion to silently default to "list
everything" instead. A consumer or generated binding MUST NOT treat any
response schema in this section, or elsewhere in this contract, as
authoritative for what the server will keep returning: because no handler is
checked against a declared response schema, a field can be added, renamed,
or dropped from a `parsed` body with no generator or test failure at the
layer that catches request drift. This is a strictly weaker guarantee than
the request side, where drift against the zod the code actually runs is what
the generator is built to catch -- and a consumer MUST dispatch on response
shape using ITS OWN request (did it send `flagged_only`?), never by
attempting discriminator-style dispatch against the emitted schema, since the
emitted `anyOf` carries no machine-readable discriminant mapping.

**TRUST FILTERS.** The default (non-`flagged_only`) branch accepts two
optional filters: `confidence`, a non-empty allow-list of tiers
(`CONFIRMED`/`INFERRED`/`UNVERIFIED`), and `exclude_disputed`, which drops any
entry on either side of an unresolved contradiction (`flagged_for_review`
true, or `contradiction_of` set). When supplied, an implementation MUST apply
them to every entry the response carries -- `l1_results`, `l2_expanded` AND
`related_claims` -- so a filtered caller is never handed an excluded entry
through the graph expansion instead. When `confidence` is
absent the default is `["CONFIRMED"]` with `exclude_disputed` true: INFERRED,
UNVERIFIED and disputed entries are returned only when the caller lists the
tiers explicitly (an explicit `confidence` defaults `exclude_disputed` to
false). The same default applies to `kb_list` (whose `confidence` is an array
of tiers), `kb_session_prime` and `kb_context` (both accept the same optional
`confidence` array). The `flagged_only` branch ignores both
(listing disputed entries is its purpose). An implementation backed by a
store that cannot filter MUST filter the merged result itself before
responding (`src/tools/kb-query.ts` `passesTrustFilter` does this on top of
the sqlite provider's SQL filter). Test hook: the `kb_query`
`happy-confirmed-only` fixture and `tests/knowledge/kb-query-trust-filter.test.ts`.

**THE TEST HOOK.** The selector guard and both response shapes are checked
by the round-trip harness at the request/happy-path level
(`tests/roundtrip-harness.mjs`'s `kb_query` `happy` and
`refusal-no-selector` cases). INV-09's epistemic-status claim itself -- that
the response contract is observed rather than enforced -- is not
mechanically checkable; see `tests/DEGRADATION.md` D-4, which records the
same root fact (`parsed` is a consumer-side decode of `wrapTool`'s text
envelope, never a schema-checked wire field) for the whole surface.

## 5. Envelope extensions (T3, RESERVED)

Placeholder. Extensions to the section 1 envelope (e.g. a provider-agnostic
error envelope, `structuredContent` adoption) land here. Do not fill it in or
restructure it from this lane task.
