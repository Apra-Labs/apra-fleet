# Requirements -- README final sprint (items 10 + 11)

Continue on branch `docs/llms-txt-index` (PR #272), HEAD fefc919. New commit
on top. ASCII only (pre-commit hook -- use `--`, straight quotes, no
em-dashes, no emoji). README.md is embedded in `llms-full.txt`: after editing
README.md, regenerate `llms-full.txt` with `node scripts/gen-llms-full.mjs`
and commit it.

All wording below is APPROVED by the user -- apply it VERBATIM. Do not
rephrase, expand, or "improve" it.

## Item 11 -- Substrate reframe

### 11-A. Hero paragraph 1

Replace the FIRST paragraph of the hero (the one starting "Apra Fleet is an
open-source MCP server that turns AI coding agents ...") with EXACTLY:

  Apra Fleet is an open-source **MCP server** that turns AI agents (Claude
  Code, Gemini, Codex, Copilot) into a coordinated team instead of a lone
  assistant. Any job that needs more than one agent -- software sprints,
  customer-support triage, cost and operations-efficiency analysis,
  infrastructure surveys -- becomes a fleet you direct in plain conversation.
  Need more horsepower? Fleet reaches across every machine on your network
  over SSH -- no dashboards, no orchestration YAML.

### 11-B. PM-framing block

At the TOP of the "## The PM skill" section (as its first paragraph, before
the existing "The Project Manager skill is installed by default ..."
sentence), insert EXACTLY this paragraph:

  The **PM skill** is Fleet's reference workflow for **software development**
  -- it ships today, fully built out. It is one skill on a general
  substrate: the same primitives -- members, tasks, git/SSH transport,
  doer-reviewer pairing -- coordinate agents for support triage, cost
  analysis, ops surveys, or any multi-agent job. PM is the worked example;
  the platform is the point.

### 11-C. Use Cases section

In the "## Use cases" section, REPLACE the single bullet:
  "- Non-coding ops: log triage, patch fan-out, infrastructure surveys."
with these THREE bullets (verbatim):
  - Customer-support triage: agents classify, draft replies, and escalate
    tickets in parallel.
  - Cost and operations-efficiency analysis: fan out data gathering across
    sources, consolidate findings.
  - Infrastructure surveys, log triage, and patch fan-out across many
    machines.

### 11-D. Hero heading

In the hero heading line (currently "### One goal. A team of AI agents that
plan, build, review each other's work, and run across every machine you
own."), change "plan, build, review each other's work" to
"plan, execute, and review each other's work". Leave the rest of the line
unchanged.

## Item 10 -- Token measurement paragraph

In the "## Cost" section, add the following paragraph VERBATIM. Place it
after the two-bullet list ("Shell over prompts" / "Smart sessions") and
before the closing "Setup is a one-time cost ..." sentence:

  **Token spend is measured, not estimated.** Fleet records token usage per
  member and per role -- PM, doer, reviewer -- so a team can see and analyze
  where their spend actually goes. Fleet's end-to-end CI suite exercises this
  in full: a complete reviewed sprint -- discover issues, plan, doer-reviewer
  loop, PR raised with green CI -- emits a per-role token breakdown (in one
  such run: PM ~6K, doer ~191K, reviewer ~19K, ~215K total). Those toy-repo
  figures are not a benchmark -- they show the measurement method works end
  to end. The point is the instrument: Fleet makes token cost something you
  can attribute and reason about, not guess at.

## Task -- after edits

1. Regenerate `llms-full.txt` (`node scripts/gen-llms-full.mjs`).
2. Run `npm test` and `npm run build` -- both must pass.
3. Confirm no markdown links broke.
4. Commit README.md + regenerated `llms-full.txt` with an ASCII-only
   message, then `git push origin docs/llms-txt-index`.

## Acceptance criteria

- Items 11-A, 11-B, 11-C, 11-D and item 10 applied to README.md exactly as
  the verbatim text above. No other README content changed.
- `llms-full.txt` regenerated (zero diff vs generator); npm test + build
  pass; no broken links; ASCII only.
