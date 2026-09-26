# Scoped in-cycle replan: findings threading, and the planner's KB contract

Two small, related prompt-contract fixes: the scoped replan dispatch now
actually carries the evidence it claims to carry, and role prompts no longer
promise a KB interaction path that a dispatched member cannot perform.

## Scoped in-cycle replan: threading reviewer findings into the prompt

### The design

When a reviewer reopens a bead with a `replanIds` flag, the engine treats
that as "the acceptance criteria themselves are defective, not just the
implementation" and, on the first develop round with such a bead, dispatches
a planner pass scoped to exactly that bead's subtree (plus a scoped
plan-review of the result) rather than waiting for the next cycle's full
planner. This in-cycle detour consumes one develop round, which is what
bounds a replan<->develop ping-pong to the existing round cap.

The replan prompt tells the planner to read the reviewer's findings below it.
For that instruction to be true, the findings that triggered the replan have
to actually be in the prompt. The source of those findings is a per-bead
map of reviewer verdict notes populated when a bead is reopened; the replan
phase reads that map read-only (it never mutates it) and renders one section
per flagged bead, in bead-id order, filtering out any bead whose reviewer
notes were blank.

### Invariants

- **Findings are size-bounded.** A deterministic cap (`REPLAN_FINDINGS_MAX_LENGTH`,
  4000 characters) truncates any single findings block, appending a visible
  marker that states both the original length and the cap. A caller can
  always tell truncation happened by reading the prompt; nothing is silently
  dropped.
- **The instruction and the content travel together.** The "read the
  reviewer findings below" sentence in the prompt is emitted if and only if
  there is at least one non-blank findings section to point at. A replan with
  no findings (or only blank ones) gets a prompt with neither the sentence
  nor an empty findings block -- there is no state where the planner is told
  to read something that is not there.
- **Every flagged bead is guaranteed to have an entry in the source map** by
  construction: the reviewer-verdict fold-in only admits a `replanIds` id
  that was also actually reopened, and the reopen path that sets the map
  entry runs for every bead it reopens. The remaining "no findings" case is
  therefore always a genuinely blank verdict, not a missing map entry --
  which is why the phase can filter on blank-string alone rather than
  needing to distinguish "absent" from "blank".

### Why this is scoped, not the general "planner gets sprint history" feature

This fix threads the *specific* findings that triggered *this* replan into
*this* scoped prompt. It does not give the planner access to broader sprint
history, prior-cycle feedback, or cross-bead context -- that is separate,
larger design work. Conflating the two would have made a narrow, testable
prompt-contract bug into an open-ended design question.

## The planner's KB contract: say only what a dispatched member can do

### The problem this closes

Several role prompts (roles whose KB context arrives via engine-injected
"wrapper" text rather than a prompt-builder-composed block, and which have no
`kb-apply` post-result step) told the dispatched member to call fleet KB MCP
tools and to report new knowledge through a `kb_captures` output field. On a
dispatched member neither instruction can be honored:

- Dispatched members run with the fleet MCP server disabled in their
  composed permission config, so the KB tools are unreachable regardless of
  what the prompt asks for.
- A role with no `kb-apply` post-result step has nothing downstream that
  reads a `kb_captures` field from its output even if the member produced
  one -- the engine already injects the KB context these roles need directly
  into the dispatch prompt (the `kbInjection: 'wrapper'` mode), so there was
  never a gap for tool calls to fill.

The result was every affected dispatch spending turns on a "required" step
it structurally could not perform, while being told its output mattered when
nothing downstream consumed it.

### The fix

For every role whose policy row is `kbInjection: 'wrapper'` with no
`kb-apply` post-result step, the role prompt's Step 0 now:

- Leads with the engine-injected KB context block already present in the
  dispatch prompt (the heading text is matched verbatim against the
  block-building code, so the prompt and the actual injected text cannot
  drift silently), and tells the member to use that context directly.
- Marks any KB tool call as bonus-only, never required.
- Says nothing about a `kb_captures` output field, since nothing downstream
  applies it for these roles.

A role whose policy row DOES have a `kb-apply` post-result step (doer,
reviewer-family roles) is unaffected: those roles compose their own KB block
via the prompt-builder path and their captures genuinely flow into the KB
through `kb-apply`, so their prompts continue to ask for `kb_captures`
truthfully.

### Invariant for future role additions

Before adding a KB-tool-calls-required or `kb_captures`-required instruction
to any role prompt, check that role's policy row: if `kbInjection` is
`'wrapper'` and `postResult` does not include `'kb-apply'`, that instruction
will be false for every dispatch of that role. The generic check is
mechanical (enumerate `kbInjection: 'wrapper'` rows without `kb-apply` from
the role-policy table, assert none of their prompts require KB tool calls or
promise to read `kb_captures`) and should be re-run whenever a role's policy
row or its prompt changes, rather than re-derived by hand each time.
