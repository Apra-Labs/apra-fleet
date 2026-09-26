<!-- llm-context: This document describes the provider-conditional body-block mechanism in the agent transform pipeline -- how role-prompt PROSE (not just frontmatter tools:) is made provider-aware, and why two independent implementations of it exist and must be kept in sync. -->
<!-- keywords: agent-transform, conditional markers, if-tool, else-tool, end-tool, resolveConditionalBody, transformAgentForAgy, transformAgentForOpenCode, transformAgentForClaude, agyToolMap, OPENCODE_NATIVE_TOOLS, split-brain -->
<!-- see-also: ../generic-engine-boundary.md, ../agy-safety-rationalization.md, ./auto-sprint-install.md -->

# Provider-Conditional Body Blocks in Role Prompts

## Problem this solves

The agent transform pipeline maps each Claude-format tool name in a role prompt's
frontmatter `tools:` list to whatever the target provider can express (or drops it
if there is no equivalent). That only fixes the frontmatter. The prompt's own prose
routinely instructs the agent to call a specific tool by name (e.g. "Run ToolSearch
with query ..."). If frontmatter drops a tool but the body still tells the agent to
call it, the installed agent is instructed to use a tool it does not have -- at
best a wasted turn, at worst a hallucinated call or a hard error.

## Mechanism: HTML-comment conditional markers

Role prompt source files may contain:

```
<!-- if-tool: SomeTool -->
...prose that only makes sense when the agent has SomeTool...
<!-- else-tool: SomeTool -->
...provider-neutral fallback prose...
<!-- end-tool: SomeTool -->
```

Resolution, per install target:
- tool available -> keep the if-branch, drop the else-branch, drop the markers
- tool unavailable -> keep the else-branch, drop the if-branch, drop the markers
- the else-branch is optional; an if/end pair with no else simply deletes the
  block when the tool is unavailable

Blocks nest and repeat. An inner block resolves into its enclosing branch before
that branch is chosen or discarded, so prose inside a discarded outer branch
disappears along with its nested markers.

Markers are HTML comments so they render invisibly in plain markdown and are
inert to any reader that ignores them. They live in the prose body only --
frontmatter itself carries no markers.

**Malformed markers are a hard install-time error, not a warning.** Unclosed,
unmatched (`else-tool`/`end-tool` with no open `if-tool`), mismatched (nested
markers closing out of order), and duplicate `else-tool` are all rejected with
the offending filename. A half-rendered prompt shipping silently is judged worse
than an install that stops and says which file is broken.

## Availability, per provider

Availability is a predicate `(toolName) -> boolean` built from two sets:
- **declared**: the tools the *source* (Claude-format) frontmatter lists for
  this agent, or "everything" if the file declares none or uses a `*` wildcard
- **supported**: the tools this provider's install path can express at all, or
  "everything" for the Claude/raw path

A tool is available only if both agree.

- **Claude/raw path**: supported = null (no restriction); the tool map is the
  identity map over whatever the source frontmatter declares. Markers still
  have to be stripped on this path even though nothing else changes -- the
  Claude installer used to be a pure passthrough for agent files, and that
  passthrough is exactly what let ToolSearch prose leak through unfiltered to
  every non-Claude provider before this mechanism existed.
- **agy (Antigravity)**: supported = the keys of the Claude-name -> Antigravity-tool-id
  map (`agyToolMap`). A tool with no entry in that map is dropped from
  `tools:` in the rewritten frontmatter, and its prose (marked with that same
  tool name) resolves to the else-branch.
- **OpenCode**: supported = a fixed native-tool list (`OPENCODE_NATIVE_TOOLS`).
  OpenCode's transform emits no `tools:` line at all (it grants its built-ins
  and gates dangerous ones through a permission map instead), so there is no
  emitted frontmatter to read availability back off -- the native list has to
  be stated explicitly rather than derived.
- Files with no frontmatter at all (schemas, shared partials) still pass
  through marker resolution with `declared = null`, so a marker added to one
  of those trees in the future is never accidentally missed.

## Known gaps in the marker syntax (not yet enforced)

The mechanism above describes intended behavior; two edge cases in the
current marker regex are not yet guarded, so authors of role-prompt source
files must avoid them by convention until an enforcement test lands:

- **A marker must occupy a line of its own.** The regex that matches markers
  tolerates leading whitespace but not an inline marker sharing a line with
  prose. `pre <!-- if-tool: X -->mid<!-- end-tool: X --> post` resolves (on a
  provider without `X`) to `prepost` -- the marker consumes the boundary
  whitespace and silently joins two words that were never meant to touch.
- **Markers are resolved even inside fenced code blocks.** There is no
  fence-awareness in the resolver, so a code fence that quotes the marker
  syntax itself (e.g. to document the mechanism inside a role prompt body)
  gets its contents resolved like any other text -- an if/end pair for an
  unavailable tool collapses to an empty fence. This mechanism therefore
  cannot be demonstrated or quoted verbatim inside a role prompt's own body;
  put syntax examples only in files (like this one) that never go through
  `resolveConditionalBody`.

## Two independent implementations -- and why

`src/cli/agent-transform.ts` is the canonical implementation, used by the
top-level `apra-fleet install` CLI. `packages/apra-fleet-se/apra-pm/install.mjs`
carries a **hand-copied duplicate** of the marker regex, `resolveConditionalBody`,
`toolAvailability`, `readFrontmatterTools`, `agyToolMap`, `OPENCODE_NATIVE_TOOLS`,
`transformAgentForAgy`, and `transformAgentForOpenCode`.

This duplication is deliberate, not an oversight: `apra-pm/install.mjs` is
intentionally NOT an npm workspace (adding it would churn `package-lock.json`
for no packaging benefit), so it cannot `import` from `src/cli/agent-transform.ts`.
The two implementations are a shared contract, not shared code, and a drift
between them is a split-brain bug class -- a prompt that resolves correctly
through one installer and ships raw markers (or a wrongly-chosen branch)
through the other.

**Automated guard coverage is partial.** A test asserts `agyToolMap` and
`OPENCODE_NATIVE_TOOLS` stay byte-identical between the two files, so drift in
those two literal tables fails a suite immediately. The rest of the duplicated
surface -- `CONDITIONAL_MARKER_RE`, `resolveConditionalBody`,
`toolAvailability`, `readFrontmatterTools`, `transformAgentForAgy`,
`transformAgentForOpenCode` -- has no automated guard; keeping those six in
sync is a manual discipline backed only by a comment at the top of
`src/cli/agent-transform.ts` listing everything the other file duplicates.
Anyone changing the resolution algorithm itself (not just a tool-name mapping)
must edit both files by hand.

## What still ships raw markers if you get this wrong

Any asset tree that is copied without being routed through
`resolveConditionalBody` (or its `apra-pm/install.mjs` equivalent) will ship
literal `<!-- if-tool: ... -->` comments into the installed output. Both the
top-level installer and the apra-pm installer route every agent file through
resolution, and both also route the adjacent non-agent asset trees (JSON
schemas, shared markdown partials) through the same resolver even though those
trees hold no markers today -- so a marker added to either tree later can never
silently leak through untransformed.

## Static vs. end-to-end verification

A test suite proves the *string transform* is correct: given a role prompt
with markers and a declared/dropped tool set, the installed output contains no
surviving markers and no reference to a tool the transform dropped from its
own frontmatter, on every non-Claude provider path. This is necessary but not
sufficient. It does not prove that an actual sprint, running against a real
non-Claude provider, completes a review cycle without an executor-construction
error or a call to a tool the provider does not have -- that requires installing
from the branch under test (a stale install proves nothing, since the
transform runs at install time) and running a real sprint against that
provider, then checking the resulting transcripts. Static verification alone
repeats the failure mode of an earlier fix that corrected only the frontmatter
and left the same class of bug alive in prose; treat "tests pass" and
"a live sprint on the target provider completed cleanly" as two separate,
both-required claims whenever this mechanism is extended to a new provider or
a new tool mapping.
