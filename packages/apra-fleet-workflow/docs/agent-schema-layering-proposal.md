# Proposal: Role-Owned Output Schemas (Agent-Def Layering Fix)

Status: PROPOSED -- awaiting user approval before any implementation.
Affects: `vendor/apra-pm` (agent defs, unpushed `apra-fleet-unw.13` work),
`packages/apra-fleet-se/auto-sprint/contracts.mjs` (`apra-fleet-unw.12`),
`packages/apra-fleet-workflow/src/workflow/index.mjs` `agent()` schema handling,
and the planned runner wiring in `apra-fleet-unw.15/16/17`.

## Problem Statement

`vendor/apra-pm` is a generic, reusable agent-role package. Its `agents/*.md`
files are consumed by at least three distinct callers:

1. **auto-sprint** (`packages/apra-fleet-se/auto-sprint/runner.js`) via the
   fleet -- `agent(prompt, { agentType: 'reviewer', ... })`.
2. **The manual pm skill** (`vendor/apra-pm/skills/pm/SKILL.md`) -- a human or
   Claude Code orchestrator session dispatching the same roles as local
   subagents.
3. **Any future workflow script** written against `apra-fleet-workflow`.

The just-completed (local-only, unpushed) `apra-fleet-unw.13` work added
"Output schema" sections to each role def, and in `planner.md` referenced
`packages/apra-fleet-se/auto-sprint/contracts.mjs` -- an application-layer
module -- as the frame of reference for the role's output contract. That is a
layering inversion: the OS must not know about the application. It also
crystallized a second, pre-existing tension: the same role can now have its
output shape specified in **two independent channels** (the role's own `.md`
persona and the caller's `agent(..., { schema })` option), and nothing
guarantees the two agree. When they disagree, the LLM must make a
non-deterministic choice between two contracts -- and we found live,
already-drifted triplicate copies (see section 3) proving this is not
hypothetical.

This proposal audits every violation, explains the exact collision mechanics,
and recommends a single durable design: **role-owned, machine-readable schemas
shipped inside apra-pm itself**, with all callers deriving from that one
source and a documented precedence rule for the prompt channel.

---

## 1. Audit: application-layer references in `vendor/apra-pm`

Audited state: worktree `C:\akhil\git\wt-unw13\vendor\apra-pm`, branch
`tmp/unw13-vendor-agent-defs` (commits `5c5fed9`, `a125810` -- the unpushed
unw.13 work), all 8 `agents/*.md` files plus `skills/pm/*`.

### 1.1 True cross-repo layering violations (must fix before upstream PR)

| File | Location | Text | Why it is a violation |
| --- | --- | --- | --- |
| `agents/planner.md` | "Output schema" section, lines 116-120 (added by unw.13 commit `5c5fed9`) | "`planner` has no structured verdict schema in `packages/apra-fleet-se/auto-sprint/contracts.mjs` -- unlike the other seven roles ..." and "... via its `planReviewerVerdict` schema" | References a path that exists only in the `apra-fleet` repo. Once this file is PR'd upstream to `Apra-Labs/apra-pm`, the path is dangling for every non-fleet consumer. `planReviewerVerdict` is a `contracts.mjs` export identifier, i.e. an application symbol name leaked into the generic layer. Also asserts (falsely, from apra-pm's own perspective) that "the other seven roles" have their schema defined in an external application module. |

This is the **only** cross-repo reference in the eight `agents/*.md` files.
The other seven roles' unw.13 "Output schema" sections are self-contained
inline JSON blocks with no caller references -- verified by grep for
`auto-sprint`, `contracts.mjs`, `apra-fleet-se`, `apra-fleet-workflow`,
`runner.js` across all of `agents/` (case-insensitive). The user's instinct
("I see this broken in planner.md so look for the same symptom everywhere")
was right to demand the sweep; the sweep result is: one instance in
`agents/`, plus the `skills/pm` items below.

### 1.2 `skills/pm/*` references to "auto-sprint" -- mostly intra-repo, one smell

Important nuance: apra-pm **ships its own legacy auto-sprint workflow** at
`.claude/workflows/auto-sprint.js` (inside the apra-pm repo). Most
`skills/pm` mentions of "auto-sprint" refer to that sibling file, not to
`packages/apra-fleet-se`. Those are same-repo coupling, not cross-repo
layering violations -- but they are catalogued here because (a) the name
collision with `apra-fleet-se/auto-sprint` invites exactly the confusion this
epic is untangling, and (b) one of them names a workflow-private schema
constant as the reference for a role contract, which violates role ownership
even intra-repo:

| File | Location | Text | Classification |
| --- | --- | --- | --- |
| `skills/pm/cost.md` | line 4 | "same pure JavaScript functions as the auto-sprint workflow" | Intra-repo (deliberate shared cost engine). OK. |
| `skills/pm/cost.md` | lines 11-16 | "`install.mjs` extracts the pure functions from `auto-sprint.js` ... copied to `~/.claude/workflows/auto-sprint.js` so the `/auto-sprint` workflow works natively" | Intra-repo install machinery. OK. |
| `skills/pm/cost.md` | lines 46, 53 | calibration.json "shared between auto-sprint and pm"; `TIER_TO_MODEL` lives "inside `auto-sprint.js`" | Intra-repo. OK. |
| `skills/pm/cost.md` | line 94 | "The `taskAssignments` array shape (matches auto-sprint's `PLAN_REVIEW_SCHEMA`)" | **Smell**: defines a role output shape by pointing at a workflow's private constant instead of the role's own contract. Should point at the plan-reviewer role schema (section 4). |
| `skills/pm/cost.md` | line 131 | "same `appendNewEntries` pattern as auto-sprint" | Intra-repo. OK. |
| `skills/pm/SKILL.md` | line 391 | "extracting pure functions from auto-sprint.js" (index pointer to cost.md) | Intra-repo. OK. |
| `skills/pm/sprint.md` | lines 198-199 | "`computeSprintAnalysis`, `buildSprintSummary`, and `computeUpdatedCalibration` from auto-sprint.js" | Intra-repo. OK. |

Bottom line: the layering violation proper is one sentence in `planner.md`,
introduced by the unpushed unw.13 work, plus one role-ownership smell in
`cost.md:94`. Both are cheap to fix textually -- but fixing only the text
without deciding *where the schema canonically lives* just moves the drift
problem around, which is what the rest of this proposal addresses.

---

## 2. The double-specification mechanism, concretely

### 2.1 How a role `.md` reaches the LLM

Role-to-member binding is real and specific, not hypothetical:

- `apra-fleet`'s installer (`src/cli/install.ts`, lines ~129-139) copies
  `vendor/apra-pm/agents/*.md` to the provider-specific agents directory on
  the member machine (`~/.claude/agents/` for Claude, `~/.gemini/agents/`
  for Gemini, etc. -- see `src/cli/config.ts`).
- `execute_prompt` (`src/tools/execute-prompt.ts`, lines 47-58) takes an
  optional `agent` string. For Claude it invokes `claude --agent <name>`
  (`src/providers/claude.ts:49`, `src/os/windows.ts:120-122`); the named
  `.md` file **is the member-side persona/system prompt** for that dispatch.
  The call is rejected if the file is absent on the member.
- The workflow layer's `agent()` (`packages/apra-fleet-workflow/src/workflow/
  index.mjs:411`) passes `opts.agentType` through as this `agent` field
  (line 487).

### 2.2 How the workflow's `schema:` option reaches the LLM

In the same `agent()` call (post-unw.8, current merged code):

- `opts.schema` is compiled with ajv (line 422-429; invalid schema throws).
- The schema is **appended to the user prompt as text** (lines 431-433):
  `"Only provide your response strictly as per this JSON schema:\n<JSON>"`.
- The reply is validated client-side against `opts.schema` only
  (`extractStructuredOutput`, line 544): fenced ```json blocks preferred,
  then brace-matched candidates; first candidate that parses AND validates
  wins.
- On failure, a bounded repair loop (default 2 repairs, line 448)
  re-dispatches the SAME member with original prompt + invalid output + ajv
  errors; exhaustion throws `AgentOutputError`.

### 2.3 So which reading of "double specification" is real?

Both, in a layered way:

- **Reading (b) -- persona vs. call-site -- is the structural risk.** After
  unw.13, every role `.md` bakes an "Output schema" JSON block into the
  member's system prompt. When unw.15/16/17 wire `runner.js` to pass
  `schema: contracts.SCHEMAS.<x>` (per docs/plan.md, the W4 dispatches
  "embed the verdict schema ... inline in every prompt (the shim)"), each
  dispatch will carry two schema statements: one in the system prompt (the
  persona) and one appended to the user prompt. They are maintained in two
  different repos with no mechanical link. Only the call-site one is
  validated.
- **Reading (a) -- two contradictory prompt-text schemas -- is what the
  member actually experiences** whenever (b)'s two sources drift, because
  the persona is prompt context too. The model must pick one.

### 2.4 This is already live, not future risk

apra-pm's own shipped `.claude/workflows/auto-sprint.js` already dispatches
with BOTH `agentType:` and `schema:` (e.g. lines 1441, 1549, 1601, 1790).
Its inline schemas have **already drifted** from both `contracts.mjs` and the
unw.13 `.md` blocks -- there are now THREE independent copies of each role
contract:

| Contract | legacy `apra-pm/.claude/workflows/auto-sprint.js` | `contracts.mjs` (unw.12) | unw.13 `.md` Output schema |
| --- | --- | --- | --- |
| reviewer verdict enum | `'CHANGES NEEDED'` (space) | `'CHANGES_NEEDED'` (underscore) | `'CHANGES_NEEDED'` |
| reviewer fields | `verdict`, `notes` only | + required `reopenIds`, `newTasks` | + `reopenIds`, `newTasks` |
| doer status enum | `['VERIFY']` only | `['VERIFY', 'BLOCKED']` + required `closedIds` | `VERIFY \| BLOCKED` + `closedIds` |
| integ report | no `passed`/`bugsFiled` | required `passed`, `bugsFiled` | `passed`, `bugsFiled` |

Concrete failure once unw.13's defs are installed on members while the legacy
workflow (or any stale caller) still runs: the reviewer persona says return
`CHANGES_NEEDED` with `reopenIds`; the appended legacy schema says
`CHANGES NEEDED` with neither. If the model follows its persona, ajv fails
the enum check, the repair loop burns 1-2 extra paid dispatches, and may
still exhaust into a thrown `AgentOutputError` that kills the sprint. If it
follows the appended schema, the persona contract is silently dead and the
orchestration semantics that SKILL.md builds on `reopenIds` (R10, Develop
exit condition) get a shape they cannot act on. Either way the choice is
non-deterministic per dispatch -- exactly the danger the user named.

One subtlety that matters for the design: the unw.13 `.md` blocks are
**pseudo-JSON exemplars** (`"verdict": "APPROVED | CHANGES_NEEDED"` -- a pipe
inside a string), not valid JSON Schema and not valid example instances. A
literal-minded model can emit the pipe string verbatim; today only the
call-site ajv pass would catch that.

---

## 3. Options considered

### Option A: schema lives only at the call site

Agent defs stay pure behavioral prose with zero schema content; every caller
defines its own schema (contracts.mjs for auto-sprint, ad-hoc `schema:` for
scripts, nothing for humans).

- Pro: zero references anywhere in apra-pm; workflow mechanism unchanged;
  trivially avoids persona-vs-call-site contradiction (persona says nothing).
- Con (disqualifying): the output shape is NOT a caller detail -- it is part
  of the role's behavioral contract. `reviewer`'s "never mutate beads;
  return `reopenIds` and let the orchestrator apply transitions" is
  inseparable from its output shape; the manual pm skill's orchestration
  (SKILL.md lines 26-33, 104-108, R10) depends on that exact shape with no
  ajv layer to enforce it. Stripping schemas from the defs leaves the manual
  path contract-less and guarantees N caller copies -- we already have three
  copies and they have already drifted (section 2.4). A caller-only design
  institutionalizes the drift.
- Con: the persona would still have to describe its fields in prose for the
  role to function, so the double-specification risk survives in a weaker,
  harder-to-diff form.

### Option B: schema is an owned property of the role (recommended, with a machine-readable twist)

The role def declares its own output contract, caller-agnostically. Callers
that want structured output **derive their schema from the role's own
declaration** instead of defining a parallel one.

- Pro: matches reality -- the schemas in contracts.mjs were reverse-engineered
  *from* the `.md` prose in the first place (its own comments say each schema
  is "cross-checked against its role's prose contract"). Ownership follows
  authorship.
- Pro: one physical source per contract; drift between auto-sprint, the pm
  skill, and any future caller becomes impossible rather than merely
  discouraged.
- Pro: the manual pm skill keeps a real contract with zero extra machinery --
  the persona itself carries it.
- Con to solve: a fenced JSON block in markdown is not importable by code.
  The fix is to ship the schema as a **real JSON Schema file next to the
  agent defs inside apra-pm** (`agents/schemas/<role>.json`), with the `.md`
  embedding the human-readable example and pointing at its sibling file.
  This is the load-bearing refinement over naive Option B.

### Option C: a shared app-agnostic contracts package both sides depend on

- Pro: acknowledges the right insight -- there must be one shared source that
  neither layer reaches *up* for.
- Con: apra-pm already IS the shared, app-agnostic package every caller
  depends on. A third package/repo separates the schema from the role prose
  it must stay in lockstep with, reintroducing drift (now between the `.md`
  and the external schema file) plus cross-repo release coordination, for no
  benefit. Option C's insight is fully satisfied by locating the schema files
  *inside* apra-pm -- which is Option B as refined above.

### Interaction-rule sub-options for `agent()` (how `schema:` and a role-owned schema coexist)

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
  *application* (runner.js via contracts.mjs) must source its `schema:` from
  the role's own file, so the two channels are byte-derived from one source
  and "double specification" collapses into double *statement of the same
  schema* -- harmless reinforcement. As a belt for the residual window where
  a stale caller drifts (old auto-sprint.js against new defs), each `.md`
  carries an explicit precedence clause: a JSON schema included in the
  dispatch prompt is authoritative. That makes the model's choice
  deterministic even under drift, and it picks the only channel that is
  actually validated.

---

## 4. Recommendation

**Role-owned, machine-readable output schemas, shipped by apra-pm, consumed
by every caller; dispatch-prompt schema declared authoritative in the persona
itself.** Concretely:

1. **apra-pm ships `agents/schemas/<role>.json`** -- one real JSON Schema
   file per role that has a structured output (plan-reviewer, doer, reviewer,
   deployer, integ-test-runner, ci-watcher, harvester; planner deliberately
   has none -- its output is the beads DAG). Each file carries
   `"$id": "apra-pm/<role>-output@1"` (major version in the id) plus a
   top-level `"version"` field. These files are versioned, reviewed, and
   released with the role prose they sit next to. `install.mjs` and
   `apra-fleet`'s `src/cli/install.ts` install them alongside `agents/*.md`.
2. **Each role `.md`'s "Output schema" section becomes**: (a) a valid example
   instance (real JSON, not `"A | B"` pseudo-JSON), (b) a pointer to its
   sibling `agents/schemas/<role>.json` as the canonical machine contract,
   and (c) two standing clauses:
   - *Precedence*: "If your dispatch prompt includes a JSON schema
     instruction, that schema is authoritative -- respond with exactly that
     JSON and nothing else. It is expected to match this contract; if it
     differs, follow the dispatch prompt."
   - *Graceful degradation*: "If dispatched without a schema instruction
     (e.g. informal/manual use), report the same decision fields, in this
     JSON shape if the caller is an orchestrator, or as prose if you are
     answering a human directly." This keeps the user's "smart about both
     textual and structured" property: JSON is emitted when a schema is in
     play or an orchestrator is reading; plain text otherwise. Agents must
     also continue to treat their *inputs* as possibly structured or
     textual -- the `wrapUntrustedBlock` fencing from contracts.mjs already
     covers the untrusted-input side and is unaffected.
3. **`contracts.mjs` is reframed as auto-sprint's thin adapter, not the
   canonical source.** It keeps everything genuinely application-level
   (`ROLES`, `normalizeRole`/`validateRole`, `wrapUntrustedBlock`,
   `appendSchemaInstruction`, and `finalVerdict` -- which correctly has no
   role file because it is the orchestrator's own synthesized gate). The
   seven hand-copied role schemas are replaced by loading
   `vendor/apra-pm/agents/schemas/*.json` at module init, re-exported under
   the existing names so unw.15/16/17 wiring is unaffected. A version-pin
   check throws at load if a vendored schema's `$id` major version is not
   the expected one -- so a submodule bump that changes a contract fails
   loudly in CI instead of drifting silently. Dependency direction is now
   application -> apra-pm only. Correct layering; the OS no longer knows the
   application exists.
4. **`agent()` in `apra-fleet-workflow` changes only in documentation.** The
   mechanism (compile, append, validate, bounded repair) is already right and
   already single-schema. Add to the `AgentOptions.schema` jsdoc: when
   `agentType` names a role that publishes its own output contract, callers
   must pass that role's published schema (via their adapter), never a
   parallel definition; the dispatch-time schema is the one validated and is
   authoritative at the member per the persona's precedence clause.
5. **Drift guards** (the versioning story):
   - apra-pm CI: validate each `.md`'s example instance against its sibling
     schema file (catches prose/schema divergence at the source).
   - apra-pm's own legacy `.claude/workflows/auto-sprint.js` migrates its
     inline role schemas (`REVIEW_SCHEMA`, `PLAN_REVIEW_SCHEMA`,
     `DOER_STATUS_SCHEMA`, `INTEG_RUN_SCHEMA`, `CI_SCHEMA`,
     `HARVEST_SCHEMA`) to require the schema files (same repo, plain
     `require`/read), fixing the `'CHANGES NEEDED'`-vs-`'CHANGES_NEEDED'`
     fork as a side effect. Workflow-private schemas that are not role
     contracts (`SETUP_SCHEMA`, `SHELL_OUTPUTS_SCHEMA`,
     `BEADS_BLOCKERS_SCHEMA`, `READY_STREAKS_SCHEMA`) rightly stay inline --
     they are call-site-owned, which is exactly the boundary this design
     draws: *role* contracts belong to the role; *orchestration* contracts
     belong to the orchestrator.
   - apra-fleet-se test: contracts.mjs loads, compiles, and version-pins the
     vendored files (fails on submodule bump drift).
   - `cost.md:94` re-points from "auto-sprint's `PLAN_REVIEW_SCHEMA`" to
     "the plan-reviewer role schema (`agents/schemas/plan-reviewer.json`)".

Why this is the durable choice: it puts each contract where its behavioral
meaning lives, makes every consumer a *reader* of one file instead of a
*re-author*, is realizable with the actual role-binding mechanics (member-side
persona files installed from apra-pm; opaque `agentType` at the workflow
layer), requires zero changes to the workflow engine's runtime behavior, and
converts the dangerous two-channel ambiguity into deliberate redundancy of a
single source with a deterministic tiebreak.

---

## 5. Migration sketch (for future beads issues -- no changes made here)

### 5.1 Rework the unpushed unw.13 branch (`tmp/unw13-vendor-agent-defs`) BEFORE any upstream PR

The branch as it stands **contains the layering violation and must not be
pushed upstream as-is.**

- `agents/planner.md`: delete the `contracts.mjs`/`apra-fleet-se` sentence.
  Replace with: "planner has no structured output contract -- its output IS
  the beads DAG (issues, acceptance criteria, model-tier metadata, dep
  edges), which plan-reviewer evaluates against its own Output schema."
- All seven other `agents/*.md`: convert pseudo-JSON blocks to valid example
  instances; add the sibling-file pointer, precedence clause, and
  graceful-degradation clause (section 4.2).
- Add `agents/schemas/*.json` (7 files) with `$id`/version; content =
  today's contracts.mjs shapes (which unw.13 already aligned the prose to).
- Update `install.mjs` (and mirror in apra-fleet `src/cli/install.ts`) to
  install `agents/schemas/`.
- Migrate `.claude/workflows/auto-sprint.js` inline role schemas to read the
  files; fix `cost.md:94`; add the example-validates-against-schema CI check.
- Then: upstream PR to `Apra-Labs/apra-pm`, submodule bump per docs/plan.md.

### 5.2 Reframe contracts.mjs (small diff, not a rewrite)

- Replace the seven schema literals with a loader over
  `vendor/apra-pm/agents/schemas/*.json` + version pin; keep export names,
  `SCHEMAS`, `VALIDATORS`, `validateVerdict` signatures identical.
- Keep `ROLES`, helpers, and `finalVerdict` as-is (application-owned).
- Delete the now-satisfied DIVERGENCE NOTEs (the unw.13 prose already
  adopted those shapes); add the drift-pin test.
- Until the submodule bump lands, the literals can remain as a fallback
  behind the loader so unw.15/16/17 are not blocked (mirrors plan.md's
  existing "shim" stance).

### 5.3 `apra-fleet-workflow` `agent()`

- No runtime change. Jsdoc addition on `AgentOptions.schema` documenting the
  single-source + precedence contract (section 4.4).

### 5.4 Runner wiring (folds into unw.15/16/17 as already planned)

- All `agent(..., { agentType, schema })` calls take `schema` from
  `contracts.SCHEMAS.<name>` exclusively; a lint-ish unit test asserts
  runner.js contains no inline role-schema literals.

## Benefits

1. Layering restored: apra-pm references nothing outside itself; dependency
   arrows all point application -> platform.
2. Double specification becomes single-source redundancy with a
   deterministic tiebreak -- no more coin-flip between contradictory schemas,
   no repair-loop burn from enum drift.
3. auto-sprint, the manual pm skill, and the legacy apra-pm workflow can no
   longer drift apart: they read the same seven files, and version pins turn
   any future contract change into a loud CI failure on both sides.
4. Graceful degradation is preserved and now written down in the personas:
   structured JSON when a schema is in play, prose for humans.
5. The workflow engine stays generic and untouched -- the fix lands entirely
   in the two layers that own the knowledge.
