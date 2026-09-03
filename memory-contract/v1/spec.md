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

### 2.4 Repo-path validation is not uniform across tools (KB constraint)

Some tools that route to the same provider method validate `repo_path` against
the real filesystem and refuse before the provider is ever reached
(`kb_export`, `kb_import` -- `E-REPO-PATH-INVALID`); others pass `repo_path`
through verbatim and tolerate a missing anchor (`kb_session_prime`,
`kb_stats`, and every other `kb_*` tool). This is recorded per affected method,
per tool, in `methods.json`'s `_meta.kb_constraint_repo_path_validation` and in
each affected method entry's `tools[].repo_path_validation` field -- not
flattened into one blanket statement here, because `list` and `capture` are
each reached by tools on both sides of the split.

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
  for `E-REPO-PATH-INVALID` (see its `group_decision` field).
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
- **A read tolerated a missing anchor** -- the verbatim `repo_path`
  passthrough. The writing branch of that same one policy does refuse, and that
  branch is the one with a code.
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

**THE RULE.** Wherever a tool exposes both `repo` and `repo_path` as scope
inputs for the same call, a provider MUST resolve the effective repo path as
`input.repo ?? input.repo_path`, with `repo` taking precedence. A generated
binding MUST carry BOTH field names into its request shape for `kb_import`
and `kb_stats`; it MUST NOT keep only one, because zod strips an unrecognized
key silently rather than rejecting it -- a binding that drops one name does
not fail the call, it silently degrades to reading the wrong repo (or none),
and reports an EMPTY or ZEROED knowledge base instead of an error. `kb_setup`'s
`repo_path` MUST NOT be read as a scope-resolution input by any consumer: it
carries no project-KB scope semantics at all. (INV-05, INV-06)

**THE PROOF.** `kb_import` declares both fields (`src/tools/kb-import.ts:39-40`
`repo`, `:48-49` `repo_path`, described as an alias "ignored when repo is
also supplied") and resolves `input.repo ?? input.repo_path` at
`src/tools/kb-import.ts:137`. `kb_stats` does the same: both fields at
`src/tools/kb-stats.ts:18-19` and `:27-28`, resolved at
`src/tools/kb-stats.ts:50`. The shared `kbScopeFields` spread
(`src/services/knowledge/kb-scope-input.ts:8-11`) supplies only
`repo_remote_url` -- `repo_path` itself is declared individually per tool
(e.g. `src/tools/kb-list.ts:12`, `kb-context.ts:8`, `kb-invalidate.ts:10`),
not by the shared spread; `INVENTORY.md`'s line describing `kbScopeFields` as
where both names "come from" (section 2.1) is imprecise on this point, though
its `kb_setup`-exclusion and alias-pair claims both verify against source.
`src/services/knowledge/kb-providers.ts` caches provider instances by
`providerKey(slug, repoPath)` (`:59-61`), NUL-joined and used as the map key
at `:88` -- deliberately NOT slug alone, per the comment at `:49-56`, so two
callers resolving to the same project slug but different repo paths get
distinct anchors rather than sharing the first caller's. `kb-setup.ts:8-17`
does not spread `kbScopeFields`; its `repo_path` (`:9-10`) is used only to
build `gitDir` and call `installKbPostCommitHook` (`:28-31`, the hook 4.5
already covers), and the tool writes ONE config to a module-level
`KB_CONFIG_PATH` (`:22`, `:55`) with no slug or repo dimension at all.
Validation differs per tool on this same field: `kb_import` and `kb_export`
validate `repo`/`repo_path` against the real filesystem and refuse before a
provider exists (`E-REPO-PATH-INVALID`, `taxonomy.json` groups.validation,
raised at `src/tools/kb-import.ts:75`); `kb_stats` passes its resolved value
straight into `getKbProviders` verbatim (`src/tools/kb-stats.ts:65-68`) and
only runs a filesystem check separately, and non-fatally, for the
bible-drift read (`:86`); `kb_session_prime` is the other verbatim-passthrough
tool named in `taxonomy.json`'s `_meta.anchor_policy_note`. Both are read-only,
so an unreachable anchor degrades to "no knowledge here yet" rather than a
refusal (`taxonomy.json` non_error_outcomes `N-ANCHOR-VERBATIM-MISSING`,
`_meta.anchor_policy_note`).

**THE OBLIGATION.** A generated binding for `kb_import` or `kb_stats` MUST
expose both `repo` and `repo_path` as independent request fields, with `repo`
taking precedence when both are supplied -- omitting either name is not a
safe simplification. A binding or second implementation MUST NOT infer
project-KB scope-resolution behavior for `kb_setup` merely because it has a
`repo_path` field; that field's only effect is locating a `.git` directory
for hook installation. Any provider-instance cache MUST key on the (slug,
repoPath) pair, not slug alone, or two callers sharing a slug but not a repo
path will silently share one anchor and one basis-hash root. An
implementation MUST preserve which tools validate-and-refuse versus
pass-through-and-tolerate on this field -- turning `kb_stats`/
`kb_session_prime` into validators would push callers toward omitting
`repo_path` altogether, which is the one thing the passthrough design exists
to avoid.

**THE TEST HOOK.** No assertion in the conformance list matches this
directly. The round-trip harness exercises `kb_import`/`kb_stats`/`kb_setup`
happy-path fixtures (`tests/roundtrip-harness.mjs`) at the request-schema
level, but has no dedicated alias-precedence assertion; the `repo_path`-
vs-filesystem gap is `tests/DEGRADATION.md` D-1 and the (slug, repoPath)
cache-keying invariant is `tests/DEGRADATION.md` D-2.

### 4.2 Capture provenance and confidence clamp

**THE RULE.** A provider MUST cap confidence at INFERRED on an ordinary
capture: an incoming `confidence: CONFIRMED` MUST be downgraded to INFERRED,
MUST set `confidence_clamped: true` in the `kb_capture` response, and MUST
append a bracketed note to the stored content. CONFIRMED MAY be minted by the
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
`'\n\n[confidence clamped: CONFIRMED requires kb_promote]'` to content --
unconditionally, for every `type` including `user-directive`, and only for
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
`confidence: CONFIRMED` returns `confidence_clamped: true`; for every
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
`kb-setup.ts:31` invokes when `repo_path` is supplied -- hook installation is
the only thing that `repo_path` argument does in `kb-setup.ts` (see 4.1).

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
