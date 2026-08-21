# memory-contract/v1 -- Specification

Status: skeleton created by T1.3.1 (provider-method section authored by T1.3.1).
This file has exactly two writers by design (see README.md's ownership note in
`tests/GENERATOR-DECISION.md`): T1.3.1 owns "Envelope" and "Provider methods"
below; T1.3.2 owns "Error model". Both live in lane `t1-contract-docs` so no
third writer is ever added without a re-plan. RESERVED sections are placeholders
for later tasks (T2, T3) and must not be filled in from this lane.

Trust-relevant behavior is POINTED AT here, not restated: each pointer below
names the invariant and where the enforcing code lives, and defers the full
rule text to the RESERVED "Invariants (T2)" subsections that own it, or to
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

## 3. Error model (RESERVED -- owner: T1.3.2)

Placeholder. T1.3.2 (error taxonomy with stable machine codes, `taxonomy.json`)
appends this section. Do not fill it in or restructure it from this lane task.

## 4. Invariants (T2, RESERVED)

Placeholder umbrella for the six sections named below. Each is the spec.md
home that an `x-invariant` id in `schemas/*.json` (see
`tests/GENERATOR-DECISION.md` section 4) or a `see_also` pointer in
`methods.json` resolves to. T2 owns writing the actual invariant rule text into
these subsections; this task creates them empty/titled only, per the hand-off
list in `tests/GENERATOR-DECISION.md` section 4 ("no invariant points anywhere
else").

### 4.1 Scope resolution and repo aliasing

RESERVED for T2. (INV-05, INV-06)

### 4.2 Capture provenance and confidence clamp

RESERVED for T2. (INV-02, INV-07)

### 4.3 Directive quarantine

RESERVED for T2. (INV-03)

### 4.4 Superseding and AUDN matching

RESERVED for T2. (INV-04)

### 4.5 Freshness and content hashing

RESERVED for T2. (INV-01)

### 4.6 Query modes

RESERVED for T2. (INV-08, INV-09)

## 5. Envelope extensions (T3, RESERVED)

Placeholder. Extensions to the section 1 envelope (e.g. a provider-agnostic
error envelope, `structuredContent` adoption) land here. Do not fill it in or
restructure it from this lane task.
