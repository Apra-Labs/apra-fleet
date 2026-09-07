# Role-Owned Agent Schemas (Design and Rationale)

Status: implemented. This document records the design that the role-contract
layering across `packages/apra-fleet-se/apra-pm` (the agent-role definitions consumed by
fleet members), `packages/apra-fleet-se/fleet-sprint/contracts.mjs` (auto-sprint's
application-layer adapter), and `packages/apra-fleet-workflow/src/workflow/index.mjs`'s
`agent()` schema handling now follows, plus the reasoning that produced it. Code in all
three places cross-references the section numbers below, so they are stable.

Only the third component lives in this package, and its share of the design is
documentation-only: `agent()`'s runtime is untouched by this design, and the
`AgentOptions.schema` jsdoc in `index.mjs` carries the cross-reference.

## The design in one paragraph

Each agent role owns its own contract. `apra-pm` ships a real JSON Schema file per role and
direction -- `agents/schemas/<role>-output.json` and `agents/schemas/<role>-input.json` --
next to the role's `agents/<role>.md` prose. Every caller that wants structured output
**reads** those files rather than re-authoring a parallel schema; `contracts.mjs` is the
reader/re-exporter for auto-sprint, with a `$id`-major-version pin that fails loudly at
module load if a package update changes a contract. Input schemas are never shown to the
LLM: they are a caller-side pre-flight check run before any dispatch. Where a schema is also
present in the dispatch prompt, the personas declare that prompt-side schema authoritative,
so a model shown two statements of the same contract has a deterministic tiebreak.

## Problem Statement (why this design exists)

`packages/apra-fleet-se/apra-pm` is a generic, reusable agent-role package. Its `agents/*.md`
files are consumed by at least three distinct callers:

1. **auto-sprint** (`packages/apra-fleet-se/fleet-sprint/runner.js`) via the
   fleet -- `agent(prompt, { agentType: 'reviewer', ... })`.
2. **The manual pm skill** (`packages/apra-fleet-se/apra-pm/skills/pm/SKILL.md`) -- a human or
   Claude Code orchestrator session dispatching the same roles as local
   subagents.
3. **Any workflow script** written against `apra-fleet-workflow`.

Two problems drove the design. First, a layering inversion: role definitions had begun
citing `contracts.mjs` -- an application-layer module -- as the frame of reference for a
role's output contract. The OS must not know about the application. Second, and more
serious: the same role could have its output shape specified in **two independent channels**
(the role's own `.md` persona and the caller's `agent(..., { schema })` option), with nothing
guaranteeing the two agree. When they disagree, the LLM must make a non-deterministic choice
between two contracts -- and there were live, already-drifted triplicate copies (section 2.4)
proving this was not hypothetical.

---

## 1. The layering rule

An `agents/*.md` role definition and its sibling schema files reference nothing outside
`apra-pm`. No application path (`packages/apra-fleet-se/...`), no application symbol name, no
caller-specific module. `apra-pm` is PR'd upstream to `Apra-Labs/apra-pm` and consumed by
non-fleet callers; any such reference is dangling for them.

### 1.1 Role definitions stay caller-agnostic

Concretely, `agents/planner.md` describes planner's contract on its own terms rather than by
pointing at an application module's exports. Planner's real product is the beads DAG (issues,
acceptance criteria, model-tier metadata, dependency edges) that plan-reviewer then evaluates;
its own `planner-output.json` is a thin routable report over that work (`status`, `notes`, the
`featureIds`/`taskIds` it touched), which replaced an earlier free-prose "confirm with any text
when done" dispatch.

The check that keeps this true is a grep of `agents/` for caller names (`auto-sprint`,
`contracts.mjs`, `apra-fleet-se`, `apra-fleet-workflow`, `runner.js`).

### 1.2 `skills/pm/*` and the intra-repo auto-sprint

`apra-pm` ships its own workflow at `.claude/workflows/auto-sprint.js`. Most `skills/pm`
mentions of "auto-sprint" refer to that sibling file, not to `packages/apra-fleet-se` --
same-repo coupling, not a cross-repo layering violation. The name collision with
`apra-fleet-se/fleet-sprint` invites confusion, so the distinction is worth keeping in mind
when reading those files.

The rule that applies intra-repo too: a role's output shape is defined by the role's own
contract, never by a workflow's private schema constant. `skills/pm/cost.md` describes the
`taskAssignments` shape by pointing at `agents/schemas/plan-reviewer-output.json`, not at a
workflow-private `PLAN_REVIEW_SCHEMA`.

---

## 2. The double-specification mechanism, concretely

### 2.1 How a role `.md` reaches the LLM

Role-to-member binding is real and specific, not hypothetical:

- `apra-fleet`'s installer (`src/cli/install.ts`) copies
  `packages/apra-fleet-se/apra-pm/agents/*.md` to the provider-specific agents directory on
  the member machine (`~/.claude/agents/` for Claude, `~/.gemini/antigravity-cli/agents/`
  for AGY, etc. -- see `src/cli/config.ts`).
- `execute_prompt` (`src/tools/execute-prompt.ts`) takes an optional `agent` string. For
  Claude it invokes `claude --agent <name>` (`src/providers/claude.ts`,
  `src/os/windows.ts`); the named `.md` file **is the member-side persona/system prompt**
  for that dispatch. The call is rejected if the file is absent on the member.
- The workflow layer's `agent()` passes `opts.agentType` through as this `agent` field.

### 2.2 How the workflow's `schema:` option reaches the LLM

In the same `agent()` call:

- `opts.schema` is compiled with ajv (an invalid schema throws before any dispatch).
- The schema is **appended to the user prompt as text**:
  `"Only provide your response strictly as per this JSON schema:\n<JSON>"`.
- The reply is validated client-side against `opts.schema` only
  (`extractStructuredOutput`): fenced ```json blocks first, then brace-matched
  candidates; the first candidate that parses AND validates wins.
- On failure, a bounded repair loop (default 2 repairs) re-dispatches the SAME member with
  original prompt + invalid output + ajv errors; exhaustion throws `AgentOutputError`.

### 2.3 So which reading of "double specification" is real?

Both, in a layered way:

- **Reading (b) -- persona vs. call-site -- is the structural risk.** Every role `.md` bakes
  an "Output schema" section into the member's system prompt. When `runner.js` also passes
  `schema: contracts.SCHEMAS.<x>` on the same dispatch, each dispatch carries two schema
  statements: one in the system prompt (the persona) and one appended to the user prompt.
  Only the call-site one is validated.
- **Reading (a) -- two contradictory prompt-text schemas -- is what the member actually
  experiences** whenever (b)'s two sources drift, because the persona is prompt context too.
  The model must pick one.

The design's answer is to make both statements derive from one file, so "double
specification" collapses into double *statement of the same schema* -- harmless
reinforcement -- with a documented precedence clause as a belt for any residual drift.

### 2.4 The drift this replaced

Before role-owned schema files existed, each role contract had three independent copies:
`apra-pm`'s own `.claude/workflows/auto-sprint.js` inline schemas, `contracts.mjs`'s
hand-copied literals, and each `.md`'s Output-schema prose. They had already drifted -- the
reviewer verdict enum was `'CHANGES NEEDED'` (space) in one and `'CHANGES_NEEDED'`
(underscore) in the other two; doer's status enum, its required `closedIds`, and the integ
report's `passed`/`bugsFiled` were present in some copies and not others.

The concrete failure mode: the reviewer persona says return `CHANGES_NEEDED` with
`reopenIds`; a stale appended schema says `CHANGES NEEDED` with neither. If the model follows
its persona, ajv fails the enum check, the repair loop burns 1-2 extra paid dispatches, and
may still exhaust into a thrown `AgentOutputError` that kills the sprint. If it follows the
appended schema, the persona contract is silently dead and the orchestration semantics built
on `reopenIds` get a shape they cannot act on. Either way the choice is non-deterministic per
dispatch.

A related subtlety the design fixes: prose "Output schema" blocks are easy to write as
**pseudo-JSON exemplars** (`"verdict": "APPROVED | CHANGES_NEEDED"` -- a pipe inside a
string), which are neither valid JSON Schema nor valid example instances. A literal-minded
model can emit the pipe string verbatim. Hence the rule in section 4 that a `.md`'s example
block must be a valid *instance*, with the machine contract living in the sibling file.

---

## 3. Options considered

### Option A: schema lives only at the call site

Agent defs stay pure behavioral prose with zero schema content; every caller
defines its own schema.

- Pro: zero references anywhere in apra-pm; workflow mechanism unchanged;
  trivially avoids persona-vs-call-site contradiction (persona says nothing).
- Con (disqualifying): the output shape is NOT a caller detail -- it is part
  of the role's behavioral contract. `reviewer`'s "never mutate beads;
  return `reopenIds` and let the orchestrator apply transitions" is
  inseparable from its output shape; the manual pm skill's orchestration
  depends on that exact shape with no ajv layer to enforce it. Stripping
  schemas from the defs leaves the manual path contract-less and guarantees N
  caller copies. A caller-only design institutionalizes the drift.
- Con: the persona would still have to describe its fields in prose for the
  role to function, so the double-specification risk survives in a weaker,
  harder-to-diff form.

### Option B: schema is an owned property of the role (chosen, with a machine-readable twist)

The role def declares its own output contract, caller-agnostically. Callers
that want structured output **derive their schema from the role's own
declaration** instead of defining a parallel one.

- Pro: matches reality -- the schemas in contracts.mjs were reverse-engineered
  *from* the `.md` prose in the first place. Ownership follows authorship.
- Pro: one physical source per contract; drift between auto-sprint, the pm
  skill, and any future caller becomes impossible rather than merely
  discouraged.
- Pro: the manual pm skill keeps a real contract with zero extra machinery --
  the persona itself carries it.
- Con solved by the twist: a fenced JSON block in markdown is not importable
  by code. The fix is to ship the schema as a **real JSON Schema file next to
  the agent defs inside apra-pm** (`agents/schemas/<role>-output.json`), with
  the `.md` embedding the human-readable example and pointing at its sibling
  file. This is the load-bearing refinement over naive Option B.

### Option C: a shared app-agnostic contracts package both sides depend on

- Pro: acknowledges the right insight -- there must be one shared source that
  neither layer reaches *up* for.
- Con: apra-pm already IS the shared, app-agnostic package every caller
  depends on. A third package/repo separates the schema from the role prose
  it must stay in lockstep with, reintroducing drift (now between the `.md`
  and the external schema file) plus cross-repo release coordination, for no
  benefit. Option C's insight is fully satisfied by locating the schema files
  *inside* apra-pm -- which is Option B as refined above.

### Interaction rule for `agent()` (how `schema:` and a role-owned schema coexist)

- **`agent()` auto-adopts the role's schema when none is passed**: not
  realizable. `agentType` is an opaque string to the workflow layer, and the
  role `.md` lives on the *member* machine (section 2.1), which the
  orchestrator-side `agent()` cannot read. Building a resolver would also
  make the generic workflow layer depend on apra-pm -- a new layering
  violation in the opposite direction.
- **`agent()` fails loud on conflict**: same problem -- it cannot see the
  member-side persona to detect a conflict.
- **Single source + documented precedence (chosen)**: `agent()` stays
  mechanically unchanged. The rule is enforced where knowledge exists: the
  *application* (runner.js via contracts.mjs) sources its `schema:` from
  the role's own file. As a belt for the residual window where a stale caller
  drifts, each `.md` carries an explicit precedence clause: a JSON schema
  included in the dispatch prompt is authoritative. That makes the model's
  choice deterministic even under drift, and it picks the only channel that is
  actually validated.

---

## 4. The design as implemented

**Role-owned, machine-readable output schemas, shipped by apra-pm, consumed
by every caller; dispatch-prompt schema declared authoritative in the persona
itself.** Concretely:

1. **apra-pm ships `agents/schemas/<role>-output.json`** -- one real JSON Schema
   file per role that has a structured output. Each file carries
   `"$id": "apra-pm/<role>-output@1"` (major version in the id) plus a
   top-level `"version"` field. These files are versioned, reviewed, and
   released with the role prose they sit next to. `apra-fleet`'s
   `src/cli/install.ts` installs the whole `agents/schemas/` directory onto a
   member alongside `agents/*.md`.
2. **Each role `.md`'s "Output schema" section carries**: (a) a valid example
   instance (real JSON, not `"A | B"` pseudo-JSON), (b) a pointer to its
   sibling `agents/schemas/<role>-output.json` as the canonical machine contract,
   and (c) two standing clauses:
   - *Precedence*: "If your dispatch prompt includes a JSON schema
     instruction, that schema is authoritative -- respond with exactly that
     JSON and nothing else. It is expected to match this contract; if it
     differs, follow the dispatch prompt."
   - *Graceful degradation*: "If dispatched without a schema instruction
     (e.g. informal/manual use), report the same decision fields, in this
     JSON shape if the caller is an orchestrator, or as prose if you are
     answering a human directly." This keeps roles smart about both textual
     and structured use: JSON is emitted when a schema is in play or an
     orchestrator is reading; plain text otherwise. Agents also treat their
     *inputs* as possibly structured or textual -- the `wrapUntrustedBlock`
     fencing from contracts.mjs covers the untrusted-input side.
3. **`contracts.mjs` is auto-sprint's thin adapter, not the canonical
   source.** It keeps everything genuinely application-level
   (`ROLES`, `normalizeRole`/`validateRole`, `wrapUntrustedBlock`,
   `appendSchemaInstruction`, and `finalVerdict` -- which correctly has no
   role file because it is the orchestrator's own synthesized gate). The role
   output schemas are LOADED from
   `packages/apra-fleet-se/apra-pm/agents/schemas/<role>-output.json` at module init and
   re-exported under the existing names, so the runner's schema-passing call
   sites are unaffected. A version-pin check (`assertVersionPin`) throws at
   load if a vendored schema's `$id` major version is not the expected one --
   so a package update that changes a contract fails loudly instead of
   drifting silently. Inline literals remain only as a fallback for the case
   where the vendored directory is absent entirely. Dependency direction is
   application -> apra-pm only; the OS does not know the application exists.
4. **`agent()` in `apra-fleet-workflow` is unchanged at runtime.** The
   mechanism (compile, append, validate, bounded repair) is already right and
   already single-schema. Its `AgentOptions.schema` jsdoc states the rule:
   when `agentType` names a role that publishes its own output contract,
   callers must pass that role's published schema (via their adapter), never a
   parallel definition; the dispatch-time schema is the one validated and is
   authoritative at the member per the persona's precedence clause.
5. **Drift guards** (the versioning story):
   - apra-pm's own `.claude/workflows/auto-sprint.js` no longer hand-writes its
     role schemas: its `REVIEW_SCHEMA`, `PLAN_REVIEW_SCHEMA`,
     `DOER_STATUS_SCHEMA`, `INTEG_RUN_SCHEMA`, `CI_SCHEMA` and `HARVEST_SCHEMA`
     are generated from `agents/schemas/*.json` by
     `scripts/gen-auto-sprint-schemas.mjs`, inside a marked
     `ROLE_SCHEMAS_GENERATED` block. Workflow-private schemas that are not role
     contracts (`SETUP_SCHEMA`, `SHELL_OUTPUTS_SCHEMA`,
     `BEADS_BLOCKERS_SCHEMA`, `READY_STREAKS_SCHEMA`) rightly stay inline --
     they are call-site-owned, which is exactly the boundary this design
     draws: *role* contracts belong to the role; *orchestration* contracts
     belong to the orchestrator.
   - An apra-fleet-se test loads, compiles, and version-pins the vendored files,
     so a package bump that drifts a contract fails CI.

Why this is the durable choice: it puts each contract where its behavioral
meaning lives, makes every consumer a *reader* of one file instead of a
*re-author*, is realizable with the actual role-binding mechanics (member-side
persona files installed from apra-pm; opaque `agentType` at the workflow
layer), requires zero changes to the workflow engine's runtime behavior, and
converts the dangerous two-channel ambiguity into deliberate redundancy of a
single source with a deterministic tiebreak.

---

## 5. Where each piece lives

### 5.1 In apra-pm

- `agents/<role>.md`: valid example instance, sibling-file pointer, precedence
  clause, graceful-degradation clause (section 4 item 2). No application paths
  or symbol names.
- `agents/schemas/<role>-output.json` and `agents/schemas/<role>-input.json`,
  each with `"$schema"` (draft-07), `"$id": "apra-pm/<role>-<direction>@<major>"`,
  a top-level `"version"`, and a `description` naming the step of the role's
  `.md` whose prose it mirrors. A role carries only the directions that apply
  to it: planner and kb-reconciler have an output schema but no input schema,
  because no caller assembles a required dispatch context for them.
- `.claude/workflows/auto-sprint.js`'s role schemas are generated from those
  files (`scripts/gen-auto-sprint-schemas.mjs`) rather than hand-copied.

### 5.2 In contracts.mjs

- A loader over `packages/apra-fleet-se/apra-pm/agents/schemas/*.json` plus the
  version pin, behind the existing export names -- `SCHEMAS`, `VALIDATORS`,
  `validateVerdict` and the individual `*Verdict`/`*Report` constants keep the
  same names and the same ajv-compatible shapes, so runner call sites are
  untouched.
- `ROLES`, the role helpers, and `finalVerdict` stay application-owned.
- The inline literals remain only as the fallback for a checkout without the
  vendored directory.

### 5.3 In `apra-fleet-workflow`

No runtime behavior of `agent()` depends on this design. The
`AgentOptions.schema` jsdoc documents the single-source + precedence contract
(section 4 item 4) and points here.

### 5.4 In the runner

All `agent(..., { agentType, schema })` calls take `schema` from
`contracts.SCHEMAS.<name>` exclusively. A role schema written inline in
runner.js is a bug: it reintroduces the copy this design exists to remove.

## Benefits

1. Layering restored: apra-pm references nothing outside itself; dependency
   arrows all point application -> platform.
2. Double specification becomes single-source redundancy with a
   deterministic tiebreak -- no more coin-flip between contradictory schemas,
   no repair-loop burn from enum drift.
3. auto-sprint, the manual pm skill, and apra-pm's own workflow cannot drift
   apart: they read the same files, and version pins turn any future contract
   change into a loud CI failure on both sides.
4. Graceful degradation is preserved and written down in the personas:
   structured JSON when a schema is in play, prose for humans.
5. The workflow engine stays generic and untouched -- the design lands entirely
   in the two layers that own the knowledge.

---

## 6. Role-owned input schemas (pre-dispatch validation)

The symmetric half of the design, for the *input* direction. It is a *cleaner*
case than output schemas, not a harder one -- for a structural reason worth
stating precisely.

### 6.1 Why inputs are not subject to the double-specification danger

Output schemas are dangerous when unowned because the **LLM** must resolve a
conflict between two schema statements it is shown (the persona's and the
call site's) -- see section 2. Inputs have no such actor: the input values
are assembled entirely by the *caller* (`runner.js`, a workflow script, or a
human) and simply inserted into the prompt. There is only one party, and it
either supplied the right shape or it didn't. No model-side ambiguity is
possible. So the urgency driving section 4 (stop a coin-flip the LLM makes)
does not apply here -- but a different, still-real problem does.

### 6.2 The problem: a deterministically-checkable property left to LLM judgment

Every role def carries an "Inputs" section with a **prose** "missing-input
behavior" clause. For example:

- `harvester.md`: requires `analysisArtifactFile`, `analysisText`,
  `costAnalysis` (verbatim pre-computed content), `base-branch`, `branch`.
  "If ... not supplied, do NOT fabricate ... Stop and return `status:
  'FAILED'` with `notes` naming exactly which input was missing."
- `reviewer.md`: requires `base-branch`, `branch`. "If ... not supplied (or
  does not exist), do not guess a branch name. Return `verdict:
  'CHANGES_NEEDED'` ..."
- `doer.md`: requires `branch`. "If ... not supplied, do not guess or work
  on whatever branch happens to be checked out. Return `status: 'BLOCKED'`
  ..."

This is *correct* as a safety net -- it prevents the dangerous failure mode
(an agent silently guessing a branch or fabricating an analysis block). But as
the *primary* mechanism it delegates a checkable fact ("is
`analysisArtifactFile` present and non-empty?") to LLM discretion, and only
discovers the gap **after** a paid fleet dispatch. In the harvester case,
catching a missing `costAnalysis` that way burns a full dispatch merely to
receive a structured "FAILED, you forgot X" reply that a plain object-key
check produces for free, locally, before any network call.

### 6.3 Role-owned input schemas, caller-side pre-flight gate

Section 4's design, extended symmetrically:

1. **apra-pm ships `agents/schemas/<role>-input.json`** alongside each
   role's `agents/schemas/<role>-output.json` -- two sibling files per
   role, one per direction, rather than a single `{"input": {...},
   "output": {...}}` file. Same versioning convention (`$id`, `version`) as
   section 4 item 1.
2. **The schema describes required context keys/types only** -- it is
   never appended to the prompt and never shown to the LLM. It is consumed
   exclusively by whichever caller assembles the dispatch context
   (`runner.js` via `contracts.mjs`'s `validateRoleInput` today; a workflow
   script tomorrow; the manual pm skill has no code path to run this check
   and is unaffected).
3. **The caller validates its assembled context against the role's input
   schema BEFORE calling `agent()`.** On failure: abort locally, zero fleet
   dispatch, zero cost, fully deterministic -- no LLM judgment involved in
   detecting the gap at all.
4. **The persona's prose "missing-input behavior" clause stays, unchanged,
   as defense-in-depth** for the one path that has no pre-flight
   validator: a human or ad-hoc caller dispatching the role directly
   without going through a schema-aware adapter. It is not dead weight --
   it is exactly the safety net for the un-validated path.
5. **No change to `agent()`'s runtime**, same as the output-schema half
   (section 5.3): this is entirely caller-side, so the generic workflow
   engine remains untouched.

### 6.4 Where this matters most

Ranked by how much a caller-side gate saves: `harvester` (4 required values,
including two verbatim-content blocks that are the most expensive to silently
omit) > `reviewer`/`doer`/`deployer` (1-2 required strings each, still worth
the free check) > `ci-watcher`/`integ-test-runner`/`plan-reviewer`
(lighter-weight, lower priority but the same pattern for consistency).

### 6.5 Adding a role

A new role adds both sibling schema files in the same change as its
`agents/<role>.md`, and its expected `$id` major version to the pin tables in
`contracts.mjs` -- the version-pin check refuses a schema whose role it has no
expected major version for, rather than trusting it silently.
